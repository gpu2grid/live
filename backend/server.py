"""
server.py 

Runs a simulation between AI datacenter workloads and an electrical grid (IEEE 13-bus OpenDSS model).

Uses GPU power traces and  workloads to model howAI inference/training affects grid voltage and stability over time.
"""



from fractions import Fraction
from pathlib import Path
import subprocess, tempfile, os, uvicorn, threading, math, json, hashlib

import pandas as pd
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from fastapi import WebSocket, WebSocketDisconnect


from  openg2g.coordinator import Coordinator

from openg2g.datacenter.config import (
    DatacenterConfig,
    InferenceModelSpec,
    PowerAugmentationConfig,
    TrainingRun,
    ReplicaSchedule,
)

from  openg2g.datacenter.offline import OfflineDatacenter, OfflineWorkload
from openg2g.datacenter.workloads.inference import InferenceData
from  openg2g.datacenter.workloads.training import TrainingTrace, TrainingTraceParams
from  openg2g.grid.opendss import OpenDSSGrid
from  openg2g.grid.config import TapPosition
from  openg2g.controller.tap_schedule import TapScheduleController
from  openg2g.metrics.voltage import compute_allbus_voltage_stats

import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)



import asyncio, time
from concurrent.futures import ProcessPoolExecutor

import json


#currently set to 2 for free tier at hf
_pool        = ProcessPoolExecutor(max_workers=2)  

_start_time  = time.time()



DSS_DIR     = Path(__file__).parent / "examples/ieee13"
DSS_MASTER  = "IEEE13Nodeckt.dss"
CONFIG_PATH = Path(__file__).parent / "examples/offline/config.json"


# Maps IEEE 13-bus indices to OpenDSS bus names
BUS_INDEX_TO_NAME = {
    1:"650", 2:"632", 3:"633", 4:"645", 5:"646", 6:"671",
    7:"684", 8:"611", 9:"634", 10:"675", 11:"652", 12:"680", 13:"692",
}
BUSES_ORDERED = [BUS_INDEX_TO_NAME[i] for i in range(1, 14)]


#read files 
_config_raw = json.loads(CONFIG_PATH.read_text())
_MODELS     = tuple(InferenceModelSpec(**m) for m in _config_raw["models"])
_DC_CONFIG  = DatacenterConfig(gpus_per_server=8, base_kw_per_phase=500.0)


if _config_raw.get("data_dir"):
    _DATA_DIR = Path(_config_raw["data_dir"])
else:
    _DATA_DIR = Path(__file__).parent / "data/specs"
    
   
# Load traces_summary.csv once at startup so we can quickly look up trace files
_TRACES_SUMMARY_PATH = _DATA_DIR / "traces_summary.csv"

#Cached dataframe of available GPU power traces
_traces_df: pd.DataFrame | None = None


TAP_STEP = 0.00625
INITIAL_TAPS = TapPosition(
    a=1.0 + 14 * TAP_STEP,
    b=1.0 +  6 * TAP_STEP,
    c=1.0 + 15 * TAP_STEP,
)

# Rescaled to fit in 300s window (original is 3600s, we compress ~12x)
TAP_CHANGE_SCHEDULE = (
    TapPosition(
        a=1.0 + 16 * TAP_STEP,
        b=1.0 +  6 * TAP_STEP,
        c=1.0 + 17 * TAP_STEP,
    ).at(t=75)   # was 1500s → 75s at 12x compression
    | TapPosition(
        a=1.0 + 10 * TAP_STEP,
        b=1.0 +  6 * TAP_STEP,
        c=1.0 + 10 * TAP_STEP,
    ).at(t=200)  # was 3300s → 200s at 12x compression
)


"""
Load trace index CSV and cache it.
"""
def _load_traces_index() -> pd.DataFrame:
    global _traces_df
    if _traces_df is None:
        if _TRACES_SUMMARY_PATH.exists():
            _traces_df = pd.read_csv(_TRACES_SUMMARY_PATH)
        else:
            _traces_df = pd.DataFrame(columns=["model_label","num_gpus","max_num_seqs","trace_file"])
    return _traces_df


"""
Lookup GPU power trace and scale by replica count.
Returns a list of per-timestep total power values in watts.

"""
def _get_trace_power(model_label: str, num_gpus: int, max_num_seqs: int,
                     num_replicas: int = 1) -> list[float]:
    
    df = _load_traces_index()
    row = df[
        (df["model_label"] == model_label) &
        (df["num_gpus"]    == num_gpus) &
        (df["max_num_seqs"]== max_num_seqs)
    ]
    if row.empty:
        raise ValueError(
            f"No trace found for model={model_label} num_gpus={num_gpus} "
            f"max_num_seqs={max_num_seqs}. "
            f"Available: {df[['model_label','num_gpus','max_num_seqs']].to_dict('records')}"
        )
    trace_file = _DATA_DIR / row.iloc[0]["trace_file"]
    trace_df   = pd.read_csv(trace_file)
 
    power_W    = trace_df["power_total_W"].tolist()
    return [p * num_replicas for p in power_W]


logger.info(f"Data dir: {_DATA_DIR} exists={_DATA_DIR.exists()}")
_load_traces_index()  # load at startup


"""Datacenter workload (baseline)"""
def _build_dc(scale: float = 1.0, duration_s: int = 300) -> OfflineDatacenter:

    df = _load_traces_index()
    first_row = df.iloc[0]
    
    first_model = tuple(m for m in _MODELS if m.model_label == first_row["model_label"])
    inference_data = InferenceData.load(_DATA_DIR, first_model)

    training_trace = TrainingTrace.ensure(
        _DATA_DIR / "training_trace.csv",
        TrainingTraceParams(),
    )

    t0 = min(40.0, duration_s * 0.13)
    t1 = min(140.0, duration_s * 0.47)

    replica_schedules = {}

    for m in _MODELS:

        initial_replicas = max(1, int(scale * 8))

        reduced_replicas = max(1, int(initial_replicas * 0.25))

        replica_schedules[m.model_label] = (
            ReplicaSchedule(initial=initial_replicas)
            .ramp_to(
                reduced_replicas,
                t_start=min(150.0, duration_s * 0.50),
                t_end=min(220.0, duration_s * 0.73),
            )
        )

    workload = OfflineWorkload(
        inference_data=inference_data,
        replica_schedules=replica_schedules,

        training=TrainingRun(
            n_gpus=max(1, int(24 * scale)),
            trace=training_trace,
            target_peak_W_per_gpu=400.0,
        ).at(
            t_start=t0,
            t_end=t1,
        ),
    )

    return OfflineDatacenter(
    _DC_CONFIG,
    workload,
    dt_s=Fraction(1, 10),
    seed=0,
    name="baseline",
    total_gpu_capacity=1000,
    power_augmentation=PowerAugmentationConfig(
        amplitude_scale_range=(0.88, 1.12),
        noise_fraction=0.04,
    ),
)


"""
 Build datacenter workload from  GPU  trace.
Returns (datacenter, raw_power_W_list) 
  
  """
def _build_dc_from_real_trace(
    model_label: str,
    num_gpus: int,
    max_num_seqs: int,
    num_replicas: int,
    duration_s: int,
) -> tuple[OfflineDatacenter, list[float]]:

    power_W = _get_trace_power(model_label, num_gpus, max_num_seqs, num_replicas)

    target_steps = int(duration_s / 0.1)
    if len(power_W) < target_steps:
        repeats = math.ceil(target_steps / len(power_W))
        power_W = (power_W * repeats)[:target_steps]
    else:
        power_W = power_W[:target_steps]

    df = _load_traces_index()
    row = df[df["model_label"] == model_label].iloc[0]

    model_tuple = tuple(m for m in _MODELS if m.model_label == model_label)
    inference_data = InferenceData.load(_DATA_DIR, model_tuple)

    workload = OfflineWorkload(
        inference_data=inference_data,
        replica_schedules={
            model_label: ReplicaSchedule(initial=num_replicas)
        },
    )

    # ← compute actual GPU count and add headroom
    actual_gpu_count = num_replicas * num_gpus
    gpu_capacity     = max(1000, actual_gpu_count * 2)

    dc = OfflineDatacenter(
        _DC_CONFIG, workload, dt_s=Fraction(1, 10), seed=0,
        name=model_label.replace(".", "-"),
        total_gpu_capacity=gpu_capacity,   # ← was hardcoded 1000
        power_augmentation=PowerAugmentationConfig(
            amplitude_scale_range=(1.0, 1.0),
            noise_fraction=0.0,
        ),
    )
    return dc, power_W

"""Create IEEE 13-bus grid with datacenter connection."""
def _build_grid(tap_pu: float, dc_bus: str) -> OpenDSSGrid:
    return OpenDSSGrid(
        dss_case_dir=str(DSS_DIR),
        dss_master_file=DSS_MASTER,
        dt_s=Fraction(1),
        source_pu=tap_pu,
        initial_tap_position=INITIAL_TAPS,  
    )



def _make_tap(v: float):
    return TapPosition(a=v, b=v, c=v).at(t=0)

"""Run  datacenter + grid simulation."""
def _run(dc, grid, tap_pu, dc_bus, duration_s):
    grid.attach_dc(dc, bus=dc_bus, connection_type="wye", power_factor=_DC_CONFIG.power_factor)
    coord = Coordinator(
        datacenters=[dc],
        grid=grid,
        controllers=[TapScheduleController(
            schedule=TAP_CHANGE_SCHEDULE,  # ← real schedule
            dt_s=Fraction(1)
        )],
        total_duration_s=duration_s,
    )
    return coord.run()

"""
    Runs one full simulation job (datacenter + grid) in a worker process
    and returns results for the API.
    """
def _run_full(req_dict: dict) -> dict:


    dc_bus   = BUS_INDEX_TO_NAME.get(req_dict["targetBus"], "671")
    replicas = max(1, req_dict["numReplicas"])

    dc, raw_power_W = _build_dc_from_real_trace(
        model_label  = req_dict["modelLabel"],
        num_gpus     = req_dict["numGpus"],
        max_num_seqs = req_dict["maxNumSeqs"],
        num_replicas = replicas,
        duration_s   = req_dict["durationS"],
    )
    grid = _build_grid(req_dict["substationVoltage"], dc_bus)
    log  = _run(dc, grid, req_dict["substationVoltage"], dc_bus, req_dict["durationS"])

    step       = max(1, req_dict["sampleInterval"])
    gs_sampled = log.grid_states[::step]
    t_sampled  = list(log.time_s[::step])
    dc_states  = log.dc_states

    results = []
    for i, (t, gs) in enumerate(zip(t_sampled, gs_sampled)):
        vs   = _voltages(gs)
        dc_i = min(range(len(dc_states)), key=lambda j: abs(dc_states[j].time_s - t))
        ds   = dc_states[dc_i]
        kw   = float((ds.power_w.a + ds.power_w.b + ds.power_w.c) / 1000)
        
        
        if math.isnan(kw): kw = 0.0
        trace_idx = min(int(t / 0.1), len(raw_power_W) - 1) if raw_power_W else 0
        raw_kw    = raw_power_W[trace_idx] / 1000.0 if raw_power_W else kw
        results.append({
            "time":               float(t),
            "gpu_power_W":        kw * 1000,
            "gpu_power_kW":       kw,
            "gpu_power_raw_kW":   raw_kw,
            "gpu_reactive_kVAR":  kw * 0.329,
            "active_gpus":        replicas * req_dict["numGpus"],
            "voltages":           vs,
            "min_voltage":        min(vs),
            "max_voltage":        max(vs),
            "target_bus_voltage": vs[req_dict["targetBus"] - 1],
            "total_load_kW":      kw,
        })

    return {
        "numSamples":   len(results),
        "targetBus":    req_dict["targetBus"],
        "modelLabel":   req_dict["modelLabel"],
        "numGpus":      req_dict["numGpus"],
        
        
        "maxNumSeqs":   req_dict["maxNumSeqs"],
        "numReplicas":  replicas,
        "duration":     float(max(r["time"] for r in results) if results else 0),
        "minVoltage":   float(min(r["min_voltage"] for r in results) if results else 1.0),
        "maxVoltage":   float(max(r["max_voltage"] for r in results) if results else 1.0),
        "avgGpuPower":  float(sum(r["gpu_power_W"] for r in results) / len(results) if results else 0),
        "peakGpuPower": float(max(r["gpu_power_W"] for r in results) if results else 0),
        "timeSeries":   results,
    }
    
    
    

"""Get per-bus voltage (worst phase per bus)."""
def _voltages(gs) -> list[float]:
    result = []
    none_count = 0
    for name in BUSES_ORDERED:
        try:
            tp   = gs.voltages[name]
            vals = [float(v) for v in [tp.a, tp.b, tp.c]
                    if not math.isnan(float(v)) and 0.5 < float(v) < 1.5]
            result.append(min(vals) if vals else None)
        except Exception as e:
            logger.debug(f"Bus {name} voltage unavailable: {e}")
            result.append(None)
    
    none_count = sum(1 for v in result if v is None)
    if none_count > 3:
        logger.warning(f"OpenDSS convergence failure: {none_count}/13 buses returned None")
    
    known  = [v for v in result if v is not None]
    avg    = sum(known) / len(known) if known else 1.0
    return [v if v is not None else avg for v in result]


# ── FastAPI────────────────────────────────────────────────────────────────

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)



class PowerflowRequest(BaseModel):
    substationVoltage: float = 1.05
    numBuses:          int   = 13
    baseVoltage:       float = 4.16
    targetBus:         int   = 0

class LLMImpactRequest(BaseModel):
    targetBus:            int   = 9
    sampleInterval:       int   = 1
    substationVoltage:    float = 1.05
    modelLabel:           str   = "Llama-3.1-8B"
    numGpus:              int   = 1
    maxNumSeqs:           int   = 128
    numReplicas:          int   = 1   
    durationS:            int   = 300

class HeatmapRequest(BaseModel):
    voltages:      list[float]
    dataCenterBus: Optional[int] = None


@app.get("/api/health")
def health():
    return {"status": "ok", "data_ready": _DATA_DIR.exists(),
            "message": "gpu2grid OpenDSS server"}




    
    


"""Return available traces"""
@app.get("/api/traces")
def list_traces():
   
    df = _load_traces_index()
    if df.empty:
        return {"traces": [], "models": [], "trainingAvailable": False}

    traces = df[["model_label","num_gpus","max_num_seqs"]].to_dict("records")

    models = []
    for model_label, group in df.groupby("model_label"):
        models.append({
            "modelLabel": model_label,
            "numGpus":    int(group["num_gpus"].iloc[0]),
            "batchSizes": sorted(group["max_num_seqs"].tolist()),
        })

    training_available = (_DATA_DIR / "training_trace.csv").exists()

    return {
        "traces":            traces,
        "models":            models,
        "trainingAvailable": training_available,
        "dataDir":           str(_DATA_DIR),
    }


"""Baseline grid simulation, no workload"""
@app.post("/api/powerflow")
async def powerflow(req: PowerflowRequest):
    logger.info(f"Powerflow request v={req.substationVoltage}")
    try:
        dc   = _build_dc(scale=0.001, duration_s=5)
        grid = _build_grid(req.substationVoltage, "671")
        log  = _run(dc, grid, req.substationVoltage, "671", 5)
        vs = _voltages(log.grid_states[-1])
        logger.info(f"Powerflow result min={min(vs):.4f} max={max(vs):.4f}")
        return {"buses": [{"id": i+1, "voltage": v, "activePower": 0.0,
                            "reactivePower": 0.0} for i, v in enumerate(vs)],
                "lines": []}
    except Exception as e:
        logger.exception("Powerflow failed")
        raise HTTPException(status_code=500, detail=str(e))



"""Simulate AI workload impact on grid using GPU traces."""
@app.post("/api/llm-impact")
async def llm_impact(req: LLMImpactRequest):
    logger.info(f"Simulation request: {req.modelLabel} bus={req.targetBus}")

    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_pool, _run_full, req.dict())
        return result

    except Exception as e:
        logger.exception("Simulation failed")
        raise HTTPException(status_code=500, detail=str(e))



@app.post("/api/heatmap")
async def heatmap(req: HeatmapRequest):
    if len(req.voltages) != 13:
        raise HTTPException(400, f"Need 13 voltages, got {len(req.voltages)}")
    script = str(Path(__file__).parent / "generate_heatmap.py")
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        out = f.name
    subprocess.run(
        ["python3", script, out] + [str(v) for v in req.voltages] +
        ([str(req.dataCenterBus)] if req.dataCenterBus else []),
        check=True,
    )
    png = open(out, "rb").read()
    os.unlink(out)
    return Response(content=png, media_type="image/png")


    
    
    
    
def _serialize_tick(tick, req_dict: dict, raw_power_W: list[float]) -> dict:
    """Serialize one TickOutput to a small JSON-safe dict for the frontend."""
    t = tick.t_s

    # Grid voltages (may be None if grid didn't tick this step)
    voltages = None
    min_v = max_v = target_v = None
    if tick.grid_state is not None:
        voltages = _voltages(tick.grid_state)
        min_v = min(voltages)
        max_v = max(voltages)
        target_v = voltages[req_dict["targetBus"] - 1]

    # DC power (sum all sites)
    kw = 0.0
    batch_by_model: dict[str, int] = {}
    for dc_name, ds in tick.dc_states.items():
        pw = ds.power_w
        kw += float((pw.a + pw.b + pw.c) / 1000)
        if hasattr(ds, "batch_size_by_model"):
            batch_by_model.update(ds.batch_size_by_model)
    if math.isnan(kw):
        kw = 0.0

    trace_idx = min(int(t / 0.1), len(raw_power_W) - 1) if raw_power_W else 0
    raw_kw = raw_power_W[trace_idx] / 1000.0 if raw_power_W else kw

    events = [{"type": e.event_type, "data": e.data} for e in tick.sim_events]

    return {
        "time":               float(t),
        "gpu_power_kW":       kw,
        "gpu_power_raw_kW":   raw_kw,
        "active_gpus":        req_dict["numReplicas"] * req_dict["numGpus"],
        "batch_by_model":     batch_by_model,
        "voltages":           voltages,
        "min_voltage":        min_v,
        "max_voltage":        max_v,
        "target_bus_voltage": target_v,
        "sim_events":         events,
    }


def _run_streaming(req_dict: dict):
    """Generator: builds coordinator and yields serialized tick dicts."""
    dc_bus   = BUS_INDEX_TO_NAME.get(req_dict["targetBus"], "671")
    replicas = max(1, req_dict["numReplicas"])

    dc, raw_power_W = _build_dc_from_real_trace(
        model_label  = req_dict["modelLabel"],
        num_gpus     = req_dict["numGpus"],
        max_num_seqs = req_dict["maxNumSeqs"],
        num_replicas = replicas,
        duration_s   = req_dict["durationS"],
    )
    grid = _build_grid(req_dict["substationVoltage"], dc_bus)
    grid.attach_dc(dc, bus=dc_bus, connection_type="wye",
                   power_factor=_DC_CONFIG.power_factor)

    coord = Coordinator(
        datacenters=[dc],
        grid=grid,
        
        controllers=[TapScheduleController(
                schedule=TAP_CHANGE_SCHEDULE,  
            dt_s=Fraction(1),
        )],
        total_duration_s=req_dict["durationS"],
    )

    step     = max(1, req_dict["sampleInterval"])
    tick_num = 0
    try:
        for tick in coord.run_iter():
            if tick_num % step == 0:
                yield _serialize_tick(tick, req_dict, raw_power_W)
            tick_num += 1
    finally:
        coord.stop()

@app.websocket("/ws/sim-stream")
async def sim_stream(ws: WebSocket):
    await ws.accept()
    try:
        req_dict = await ws.receive_json()
        req = LLMImpactRequest(**req_dict)
        logger.info(f"WS stream: {req.modelLabel} bus={req.targetBus}")

        # Run full simulation in process pool (separate process = safe for OpenDSS)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_pool, _run_full, req.dict())

        # Stream results tick by tick from the completed result
        for row in result["timeSeries"]:
            await ws.send_json(row)

        await ws.send_json({"done": True})

    except WebSocketDisconnect:
        logger.info("WS client disconnected")
    except Exception as e:
        logger.exception("WS stream failed")
        try:
            await ws.send_json({"error": str(e)})
        except Exception:
            pass
if __name__ == "__main__":
    logger.info("=" * 70)
    logger.info(f"Data dir: {_DATA_DIR} ready={_DATA_DIR.exists()}")
    df = _load_traces_index()
    if not df.empty:
        models = df["model_label"].unique().tolist()
        logger.info(f"Models: {models}")
        logger.info(f"Traces: {len(df)} configurations")
    logger.info("=" * 70)
    uvicorn.run("server:app", host="0.0.0.0", port=8080, workers=1, log_level="info", ws_ping_interval=None)
