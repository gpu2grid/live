"""
server.py 

Runs a simulation between AI datacenter workloads and an electrical grid (IEEE 13-bus OpenDSS model).

Uses GPU power traces and  workloads to model howAI inference/training affects grid voltage and stability over time.
"""


from __future__ import annotations
from fractions import Fraction
from pathlib import Path
import subprocess, tempfile, os, uvicorn, threading, math, json, hashlib

import pandas as pd
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional


from  openg2g.coordinator import Coordinator

from  openg2g.datacenter.config import (
    DatacenterConfig, InferenceModelSpec,
    PowerAugmentationConfig, InferenceRamp, TrainingRun,
)
from  openg2g.datacenter.offline import OfflineDatacenter, OfflineWorkload
from  openg2g.datacenter.workloads.inference import InferenceData, MLEnergySource
from  openg2g.datacenter.workloads.training import TrainingTrace, TrainingTraceParams
from  openg2g.grid.opendss import OpenDSSGrid
from  openg2g.grid.config import TapPosition
from  openg2g.controller.tap_schedule import TapScheduleController
from  openg2g.metrics.voltage import compute_allbus_voltage_stats

#run one simulation at a time
dss_lock = threading.Lock()

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
_SOURCES    = {s["model_label"]: MLEnergySource(**s) for s in _config_raw["data_sources"]}
_DC_CONFIG  = DatacenterConfig(gpus_per_server=8, base_kw_per_phase=500.0)

if _config_raw.get("data_dir"):
    _DATA_DIR = Path(_config_raw["data_dir"])
else:
    blob      = json.dumps(sorted(_config_raw["data_sources"],
                                  key=lambda s: s["model_label"]),
                           sort_keys=True).encode()
    _DATA_DIR = Path(__file__).parent / "data/offline" / hashlib.sha256(blob).hexdigest()[:16]

# Load traces_summary.csv once at startup so we can quickly look up trace files
_TRACES_SUMMARY_PATH = _DATA_DIR / "traces_summary.csv"

#Cached dataframe of available GPU power traces
_traces_df: pd.DataFrame | None = None


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


print(f"  [startup] data dir: {_DATA_DIR}  exists={_DATA_DIR.exists()}")
_load_traces_index()  # load at startup


"""Datacenter workload (baseline)"""
def _build_dc(scale: float = 1.0, duration_s: int = 300) -> OfflineDatacenter:
    scaled_models = tuple(
        InferenceModelSpec(
            model_label        = m.model_label,
            num_replicas       = max(1, int(m.num_replicas * scale)),
            gpus_per_replica   = m.gpus_per_replica,
            initial_batch_size = m.initial_batch_size,
            itl_deadline_s     = m.itl_deadline_s,
        ) for m in _MODELS
    )
    inference_data = InferenceData.ensure(_DATA_DIR, scaled_models, _SOURCES, dt_s=0.1)
    training_trace = TrainingTrace.ensure(
        _DATA_DIR / "training_trace.csv", TrainingTraceParams()
    )
    t0 = min(40.0,  duration_s * 0.13)
    t1 = min(140.0, duration_s * 0.47)
    t2 = min(150.0, duration_s * 0.50)
    t3 = min(220.0, duration_s * 0.73)

    workload = OfflineWorkload(
        inference_data  = inference_data,
        training        = TrainingRun(
            n_gpus               = max(1, int(24 * scale)),
            trace                = training_trace,
            target_peak_W_per_gpu= 400.0,
        ).at(t_start=t0, t_end=t1),
        inference_ramps = InferenceRamp(
            target=min(1.0, 0.25 * scale)
        ).at(t_start=t2, t_end=t3),
    )
    return OfflineDatacenter(
        _DC_CONFIG, workload, dt_s=Fraction(1, 10), seed=0,
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

    # Trim or repeat trace to match requested duration at dt=0.1s
    target_steps = int(duration_s / 0.1)
    if len(power_W) < target_steps:
        # Repeat trace to fill duration
        repeats = math.ceil(target_steps / len(power_W))
        power_W = (power_W * repeats)[:target_steps]
    else:
        power_W = power_W[:target_steps]

    # Build InferenceData with a single model replica matching the trace GPUs
    model_spec = InferenceModelSpec(
        model_label        = model_label,
        num_replicas       = num_replicas,
        gpus_per_replica   = num_gpus,
        initial_batch_size = max_num_seqs,
        itl_deadline_s     = 0.08,
    )
    source = _SOURCES.get(model_label)
    if source is None:
        # Fall back to first available source if model not in config
        source = next(iter(_SOURCES.values()))

    inference_data = InferenceData.ensure(
        _DATA_DIR, (model_spec,), {model_label: source}, dt_s=0.1
    )

    workload = OfflineWorkload(inference_data=inference_data)

    dc = OfflineDatacenter(
        _DC_CONFIG, workload, dt_s=Fraction(1, 10), seed=0,
        power_augmentation=PowerAugmentationConfig(
            amplitude_scale_range=(1.0, 1.0),  # no augmentation — use real trace as-is
            noise_fraction=0.0,
        ),
    )
    return dc, power_W



"""Create IEEE 13-bus grid with datacenter connection."""
def _build_grid(tap_pu: float, dc_bus: str) -> OpenDSSGrid:
    return OpenDSSGrid(
        dss_case_dir=str(DSS_DIR), dss_master_file=DSS_MASTER,
        dc_bus=dc_bus, dc_bus_kv=4.16,
        power_factor=_DC_CONFIG.power_factor,
        dt_s=Fraction(1), connection_type="wye",
    )



def _make_tap(v: float):
    return TapPosition(a=v, b=v, c=v).at(t=0)

"""Run  datacenter + grid simulation."""
def _run(dc, grid, tap_pu, dc_bus, duration_s):
    
    #run one simulation at time 
    
    with dss_lock:
        coord = Coordinator(
            datacenter=dc, grid=grid,
             controllers=[TapScheduleController(
                schedule=_make_tap(tap_pu), dt_s=Fraction(1)
            )],
            total_duration_s=duration_s,
            dc_bus=dc_bus,
        )
        return coord.run()

"""Get per-bus voltage (worst phase per bus)."""
def _voltages(gs, debug=False) -> list[float]:
    result = []
    for name in BUSES_ORDERED:
        try:
            tp   = gs.voltages[name]
            vals = [float(v) for v in [tp.a, tp.b, tp.c]
                    if not math.isnan(float(v)) and 0.5 < float(v) < 1.5]
            result.append(min(vals) if vals else None)
        except Exception:
            result.append(None)
    known = [v for v in result if v is not None]
    avg   = sum(known) / len(known) if known else 1.0
    result = [v if v is not None else avg for v in result]
    if debug:
        print(f"  [V] {[round(v,4) for v in result]}")
    return result


# ── FastAPI────────────────────────────────────────────────────────────────

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://gpu2grid.io"],
    allow_credentials=True,
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

    # Group by model for convenient frontend rendering
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
    print(f"\n📊 Powerflow v={req.substationVoltage}")
    try:
        dc   = _build_dc(scale=0.001, duration_s=5)
        grid = _build_grid(req.substationVoltage, "671")
        log  = _run(dc, grid, req.substationVoltage, "671", 5)
        vs   = _voltages(log.grid_states[-1], debug=True)
        print(f"✅ min={min(vs):.4f}  max={max(vs):.4f}")
        return {"buses": [{"id": i+1, "voltage": v, "activePower": 0.0,
                            "reactivePower": 0.0} for i, v in enumerate(vs)],
                "lines": []}
    except Exception as e:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))



"""Simulate AI workload impact on grid using GPU traces."""
@app.post("/api/llm-impact")
async def llm_impact(req: LLMImpactRequest):
    # 1. Map target bus index to OpenDSS bus name
    dc_bus = BUS_INDEX_TO_NAME.get(req.targetBus, "671")
    
    # 2. Use the exact replica count from the frontend
    replicas = max(1, req.numReplicas)

    print(f"\n🤖 LLM Impact Simulation")
    print(f"   Bus: {req.targetBus} ({dc_bus}) | Model: {req.modelLabel}")
    print(f"   Config: {req.numGpus} GPUs/replica | {req.maxNumSeqs} Seq Len")
    print(f"   Replicas: {replicas} | Substation V: {req.substationVoltage}")

    try:
        # 3. build dc from real trace
        dc, raw_power_W = _build_dc_from_real_trace(
            model_label  = req.modelLabel,
            num_gpus     = req.numGpus,
            max_num_seqs = req.maxNumSeqs,
            num_replicas = replicas,
            duration_s   = req.durationS,
        )

        # 4. Run the grid simulation
        grid = _build_grid(req.substationVoltage, dc_bus)
        log  = _run(dc, grid, req.substationVoltage, dc_bus, req.durationS)

        # 5. Process results for frontebd
        step = max(1, req.sampleInterval)
        gs_sampled = log.grid_states[::step]
        t_sampled  = list(log.time_s[::step])
        dc_states  = log.dc_states

        results = []
        for i, (t, gs) in enumerate(zip(t_sampled, gs_sampled)):
            vs = _voltages(gs, debug=(i == 0))
            
            # Match grid time to DC power state
            dc_i = min(range(len(dc_states)), key=lambda j: abs(dc_states[j].time_s - t))
            ds   = dc_states[dc_i]
            
            # Sum power across phases A, B, C (convert Watts to kW)
            kw = float((ds.power_w.a + ds.power_w.b + ds.power_w.c) / 1000)
            if math.isnan(kw): kw = 0.0

            # Match with the raw trace index for display
            trace_idx = min(int(t / 0.1), len(raw_power_W) - 1) if raw_power_W else 0
            raw_kw    = raw_power_W[trace_idx] / 1000.0 if raw_power_W else kw

            results.append({
                "time":               float(t),
                "gpu_power_W":        kw * 1000,
                "gpu_power_kW":       kw,
                "gpu_power_raw_kW":   raw_kw,
                "gpu_reactive_kVAR":  kw * 0.329,
                "active_gpus":        replicas * req.numGpus,
                "voltages":           vs,
                "min_voltage":        min(vs),
                "max_voltage":        max(vs),
                "target_bus_voltage": vs[req.targetBus - 1],
                "total_load_kW":      kw,
            })

        # 6. Return standard response
        return {
            "numSamples":    len(results),
            "targetBus":     req.targetBus,
            "modelLabel":    req.modelLabel,
            "numGpus":       req.numGpus,
            "maxNumSeqs":    req.maxNumSeqs,
            "numReplicas":   replicas,
            "duration":      float(max(r["time"] for r in results) if results else 0),
            "minVoltage":    float(min(r["min_voltage"] for r in results) if results else 1.0),
            "maxVoltage":    float(max(r["max_voltage"] for r in results) if results else 1.0),
            "avgGpuPower":   float(sum(r["gpu_power_W"] for r in results) / len(results) if results else 0),
            "peakGpuPower":  float(max(r["gpu_power_W"] for r in results) if results else 0),
            "timeSeries":    results,
        }

    except Exception as e:
        import traceback
        traceback.print_exc()
        # Very important: if the model_label doesn't match the CSV names, 
        # _get_trace_power will raise a ValueError. This catch will show you why.
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


if __name__ == "__main__":
    print("\n" + "="*70)
    print("="*70)
    print(f"   Data:   {_DATA_DIR}  ready={_DATA_DIR.exists()}")
    df = _load_traces_index()
    if not df.empty:
        models = df["model_label"].unique().tolist()
        print(f"   Models: {models}")
        print(f"   Traces: {len(df)} configurations")
    print("="*70 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")