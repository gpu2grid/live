"""
server.py 

Runs a simulation between AI datacenter workloads and an electrical grid (IEEE 13-bus OpenDSS model).

Uses GPU power traces and  workloads to model howAI inference/training affects grid voltage and stability over time.
"""




from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
import subprocess, tempfile, os, uvicorn, threading, math, json, hashlib, sys, pickle

import pandas as pd
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from fastapi import WebSocket, WebSocketDisconnect
from openg2g.controller.ofo import OFOBatchSizeController, OFOConfig, LogisticModelStore


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
from openg2g.controller.base import Controller
from openg2g.datacenter.base import LLMBatchSizeControlledDatacenter, LLMDatacenterState
from openg2g.clock import SimulationClock
from openg2g.controller.base import Controller
from openg2g.datacenter.base import LLMBatchSizeControlledDatacenter, LLMDatacenterState
from openg2g.datacenter.command import DatacenterCommand, SetBatchSize
from openg2g.events import EventEmitter
from openg2g.grid.command import GridCommand
from openg2g.grid.opendss import OpenDSSGrid

import logging

logger = logging.getLogger(__name__)

_INTERNAL_BUSES = {"814r", "852r", "sourcebus"}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)

import asyncio, time
from concurrent.futures import ProcessPoolExecutor

from topology_coords import load_all_coords, get_lines_from_dss, CANVAS
from generate_heatmap import generate_heatmap

EXAMPLES_DIR = Path(__file__).parent / "examples"


_TOPO_COORDS: dict = {}
_TOPO_LINES:  dict = {}
_TOPO_MASTERS: dict = {} 

def _init_topology_data():
    global _TOPO_COORDS, _TOPO_LINES, _TOPO_MASTERS
    _TOPO_COORDS = load_all_coords(EXAMPLES_DIR)

    topologies = ['ieee13', 'ieee34', 'ieee123']

    for topo in topologies:
        coords = _TOPO_COORDS.get(topo, {})
        topo_dir = EXAMPLES_DIR / topo

        if not topo_dir.exists():
            logger.warning(f"[topology] Directory missing: {topo_dir}")
            _TOPO_LINES[topo] = []
            continue

        dss_files = list(topo_dir.glob("*.dss"))
        master_path = None

        for f in dss_files:
            fname = f.name.lower()
            if "master" in fname or "ckt" in fname or "bus" in fname:
                master_path = f
                break

        if not master_path and dss_files:
            master_path = dss_files[0]

        if not master_path:
            logger.warning(f"[topology] No .dss files found in {topo_dir}")
            _TOPO_LINES[topo] = []
            continue

        logger.info(f"[topology] Found master file for {topo}: {master_path.name}")
        _TOPO_MASTERS[topo] = (topo_dir, master_path.name)
        lines = get_lines_from_dss(coords, master_path)

        if not lines:
            combined_lines = []
            seen_lines = set()
            for dss_file in dss_files:
                try:
                    ext_lines = get_lines_from_dss(coords, dss_file)
                    for l in ext_lines:
                        edge_key = tuple(sorted([l[0].lower(), l[1].lower()]))
                        if edge_key not in seen_lines:
                            seen_lines.add(edge_key)
                            combined_lines.append(l)
                except Exception:
                    continue
            lines = combined_lines

        _TOPO_LINES[topo] = lines
        logger.info(f"[topology] {topo}: {len(_TOPO_LINES[topo])} lines loaded")


_init_topology_data()  

_pool        = ProcessPoolExecutor(max_workers=2)
_start_time  = time.time()

DSS_DIR     = Path(__file__).parent / "examples/ieee13"
DSS_MASTER  = "IEEE13Nodeckt.dss"
CONFIG_PATH = Path(__file__).parent / "examples/offline/config.json"

BUS_INDEX_TO_NAME = {
    1:"650", 2:"632", 3:"633", 4:"645", 5:"646", 6:"671",
    7:"684", 8:"611", 9:"634", 10:"675", 11:"652", 12:"680", 13:"692",
}
BUSES_ORDERED = [BUS_INDEX_TO_NAME[i] for i in range(1, 14)]

def _get_topo_buses(topology: str) -> list[str]:
    topo = topology.lower()
    if topo == "ieee13":
        return BUSES_ORDERED
    coords = _TOPO_COORDS.get(topo, {})
    return [b for b in coords.keys() if b.lower() not in _INTERNAL_BUSES]

_config_raw = json.loads(CONFIG_PATH.read_text())
_MODELS     = tuple(InferenceModelSpec(**m) for m in _config_raw["models"])
_DC_CONFIG = DatacenterConfig(gpus_per_server=8, base_kw_per_phase=5.0)  # was 500.0

if _config_raw.get("data_dir"):
    _DATA_DIR = Path(_config_raw["data_dir"])
else:
    _DATA_DIR = Path(__file__).parent / "data/specs"

_TRACES_SUMMARY_PATH = _DATA_DIR / "traces_summary.csv"
_traces_df: pd.DataFrame | None = None

_LOGISTIC_STORE: LogisticModelStore | None = None

def _get_logistic_store() -> LogisticModelStore:
    global _LOGISTIC_STORE
    if _LOGISTIC_STORE is None:
        _LOGISTIC_STORE = LogisticModelStore.ensure(_DATA_DIR / "specs", _MODELS)
    return _LOGISTIC_STORE


_RL_DIR = Path(__file__).parent / "examples" / "rl_controller"
if str(_RL_DIR) not in sys.path:
    sys.path.insert(0, str(_RL_DIR))

from env import ObservationConfig as _PPOObservationConfig  

try:
    from env import build_observation as _ppo_free_build_observation 
except ImportError:
    _ppo_free_build_observation = None

_RL_OUTPUTS_DIR = Path(__file__).parent / "examples" / "rl_controller" / "outputs"


def _ppo_checkpoint_paths(topology: str) -> tuple[Path, Path]:
    """Resolve (model.zip, vecnormalize.pkl) for a topology's trained PPO run.

    Matches train_ppo.py's documented output layout:
    examples/rl_controller/outputs/<system>/ppo/ppo_model.zip
    """
    ppo_dir = _RL_OUTPUTS_DIR / topology.lower() / "ppo"
    return ppo_dir / "ppo_model.zip", ppo_dir / "ppo_model_vecnormalize.pkl"


@dataclass
class PPOControllerConfig:
    model_path: str
    vecnormalize_path: Optional[str] = None
    v_min: float = 0.95
    v_max: float = 1.05
    deterministic: bool = True


_PPO_MODEL_CACHE: dict[str, tuple] = {}


def _get_ppo_model(config: PPOControllerConfig):
    """Process-wide cache so a checkpoint isn't reloaded on every WS request."""
    key = f"{config.model_path}|{config.vecnormalize_path}"
    if key not in _PPO_MODEL_CACHE:
        from stable_baselines3 import PPO
        model = PPO.load(config.model_path, device="auto")
        vecnorm_stats = None
        if config.vecnormalize_path and Path(config.vecnormalize_path).exists():
            with open(config.vecnormalize_path, "rb") as fh:
                vecnorm_stats = pickle.load(fh)
        _PPO_MODEL_CACHE[key] = (model, vecnorm_stats)
    return _PPO_MODEL_CACHE[key]



class PPOBatchSizeController(Controller[LLMBatchSizeControlledDatacenter, OpenDSSGrid]):
    def __init__(self, inference_models, datacenter, grid, config: PPOControllerConfig,
                 dt_s: Fraction, initial_batch_sizes: dict[str, int] | None = None, zone_summary=None,
    bus_phase_groups=None,):
        self.inference_models = inference_models
        self.datacenter = datacenter
        self.grid = grid
        self.config = config
        self._dt_s = dt_s
        self.model_labels = [m.model_label for m in inference_models]
        self._model, self._vecnorm = _get_ppo_model(config)

        self._feasible: dict[str, list[int]] = {
            m.model_label: sorted(getattr(m, "feasible_batch_sizes", []) or [])
            for m in inference_models
        }
        self._initial_batch_sizes = dict(initial_batch_sizes or {})
        self._current_bs: dict[str, int] = {}
        self._replica_counts = {m.model_label: getattr(m, "initial_replicas", 1) for m in inference_models}
        self.zone_summary = zone_summary
        self.bus_phase_groups = bus_phase_groups
        self._obs_config = None
        self._control_step_count = 0

        self._init_batch_sizes()
        

    def _init_batch_sizes(self) -> None:
        self._current_bs = dict(self._initial_batch_sizes)
        for m in self.inference_models:
            feas = self._feasible[m.model_label]
            self._current_bs.setdefault(m.model_label, feas[len(feas) // 2] if feas else 1)

    @property
    def dt_s(self) -> Fraction:
        return self._dt_s

    def reset(self) -> None:
        self._init_batch_sizes()
        self._obs_config = None
        self._control_step_count = 0

    def _ensure_obs_config(self):
        if self._obs_config is None:
            self._obs_config = _PPOObservationConfig.from_multi_site(
            site_specs={"site0": tuple(self.inference_models)},
            site_replica_counts={"site0": self._replica_counts},
            n_bus_phases=len(getattr(self.grid, "v_index", []) or []),
            initial_batch_sizes=self._current_bs,
            zone_summary=self.zone_summary,
            bus_phase_groups=self.bus_phase_groups,
            v_min=self.config.v_min,
            v_max=self.config.v_max,
        )

    def _build_observation(self):
        import numpy as np
        if _ppo_free_build_observation is None:
            raise RuntimeError(
                "env.py's build_observation() could not be imported — check "
                "_RL_DIR / sys.path setup near the top of server.py."
            )
        obs = _ppo_free_build_observation(
            grid=self.grid,
            datacenter=self.datacenter,
            obs_config=self._obs_config,
            prev_batch=self._current_bs,
        )
        obs = np.asarray(obs, dtype=np.float32).reshape(1, -1)
        if self._vecnorm is not None:
            expected_dim = self._vecnorm.obs_rms.mean.shape[0]
            
            if obs.shape[1] < expected_dim:
                pad = expected_dim - obs.shape[1]
                obs = np.pad(
                    obs,
                    ((0,0),(0,pad)),
                    mode="constant"
                )
                logger.warning(
                    "Padded PPO observation from %d -> %d",
                    obs.shape[1]-pad,
                    expected_dim,
                )

            elif obs.shape[1] > expected_dim:
                obs = obs[:, :expected_dim]
                logger.warning(
                    "Truncated PPO observation from %d -> %d",
                    obs.shape[1],
                    expected_dim,
                )
        return obs

    def _decode_action(self, action) -> dict[str, int]:
        import numpy as np
        action = np.asarray(action).reshape(-1)
        for i, label in enumerate(self.model_labels):
            feasible = self._feasible[label]
            if not feasible:
                continue
            delta = int(action[i]) - 1  
            cur = self._current_bs[label]
            idx = feasible.index(cur) if cur in feasible else len(feasible) // 2
            self._current_bs[label] = feasible[max(0, min(len(feasible) - 1, idx + delta))]
        return dict(self._current_bs)

    def step(
        self,
        clock: SimulationClock,
        events: EventEmitter,
    ) -> list[DatacenterCommand | GridCommand]:
        self._ensure_obs_config()
        obs = self._build_observation()
        action, _ = self._model.predict(obs, deterministic=self.config.deterministic)
        batch_next = self._decode_action(action)

        self._control_step_count += 1
        logger.debug(
            "PPO step %d (t=%.1f s): batch=%s",
            self._control_step_count,
            clock.time_s,
            batch_next,
        )
        events.emit(
            "controller.ppo.step",
            {"batch_size_by_model": batch_next},
        )
        return [SetBatchSize(batch_size_by_model=batch_next, target=self.datacenter)]

    @property
    def batch_size_by_model(self) -> dict[str, int]:
        return dict(self._current_bs)
TAP_STEP = 0.00625

INITIAL_TAPS = TapPosition(
    a=1.0 + 14 * TAP_STEP,
    b=1.0 +  6 * TAP_STEP,
    c=1.0 + 15 * TAP_STEP,
)


TAP_CHANGE_SCHEDULE = (
    TapPosition(
        a=1.0 + 16 * TAP_STEP,
        b=1.0 +  6 * TAP_STEP,
        c=1.0 + 17 * TAP_STEP,
    ).at(t=75)
    | TapPosition(
        a=1.0 + 10 * TAP_STEP,
        b=1.0 +  6 * TAP_STEP,
        c=1.0 + 10 * TAP_STEP,
    ).at(t=200)
)


INITIAL_TAPS_BY_TOPO = {
    "ieee13": TapPosition(
        a=1.0 + 14 * TAP_STEP,
        b=1.0 +  6 * TAP_STEP,
        c=1.0 + 15 * TAP_STEP,
    ),
    "ieee34": TapPosition(regulators={
        "creg1a": 1.0, "creg1b": 1.0, "creg1c": 1.0,
        "creg2a": 1.0, "creg2b": 1.0, "creg2c": 1.0,
    }),
    "ieee123": TapPosition(regulators={
        "creg1a": 1.0,
        "creg2a": 1.0,
        "creg3a": 1.0, "creg3c": 1.0,
        "creg4a": 1.0, "creg4b": 1.0, "creg4c": 1.0,
    }),
}







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
        raise ValueError(f"No trace found for model={model_label}")
    trace_file = _DATA_DIR / row.iloc[0]["trace_file"]
    trace_df   = pd.read_csv(trace_file)
    power_W    = trace_df["power_total_W"].tolist()
    return [p * num_replicas for p in power_W]

_load_traces_index()


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
            .ramp_to(reduced_replicas, t_start=min(150.0, duration_s * 0.50), t_end=min(220.0, duration_s * 0.73))
        )

    workload = OfflineWorkload(
        inference_data=inference_data,
        replica_schedules=replica_schedules,
        training=TrainingRun(n_gpus=max(1, int(24 * scale)), trace=training_trace, target_peak_W_per_gpu=400.0).at(t_start=t0, t_end=t1),
    )
    return OfflineDatacenter(
        _DC_CONFIG, workload, dt_s=Fraction(1, 10), seed=0, name="baseline", total_gpu_capacity=1000,
        power_augmentation=PowerAugmentationConfig(amplitude_scale_range=(0.88, 1.12), noise_fraction=0.04),
    )


"""
 Build datacenter workload from  GPU  trace.
Returns (datacenter, raw_power_W_list) 
  
  """
  
def _build_dc_from_real_trace(model_label: str, num_gpus: int, max_num_seqs: int,
                              num_replicas: int, duration_s: int) -> tuple[OfflineDatacenter, list[float]]:
    power_W = _get_trace_power(model_label, num_gpus, max_num_seqs, num_replicas)
    target_steps = int(duration_s / 0.1)
    if len(power_W) < target_steps:
        repeats = math.ceil(target_steps / len(power_W))
        power_W = (power_W * repeats)[:target_steps]
    else:
        power_W = power_W[:target_steps]

    model_tuple = tuple(m for m in _MODELS if m.model_label == model_label)
    inference_data = InferenceData.load(_DATA_DIR, model_tuple)

  
    workload = OfflineWorkload(
        inference_data=inference_data,
        replica_schedules={model_label: ReplicaSchedule(initial=num_replicas)},
        initial_batch_sizes={model_label: max_num_seqs},
    )
    actual_gpu_count = num_replicas * num_gpus
    
    
    gpu_capacity     = max(1000, actual_gpu_count * 2)

    dc = OfflineDatacenter(
        _DC_CONFIG, workload, dt_s=Fraction(1, 10), seed=0, name=model_label.replace(".", "-"), total_gpu_capacity=gpu_capacity,
        power_augmentation=PowerAugmentationConfig(amplitude_scale_range=(1.0, 1.0), noise_fraction=0.0),
    )
    return dc, power_W



"""Create IEEE 13-bus grid with datacenter connection."""
def _build_grid(tap_pu: float, dc_bus: str, topology: str = "ieee13") -> OpenDSSGrid:
    topo = topology.lower()
    if topo in _TOPO_MASTERS:
        case_dir, master_file = _TOPO_MASTERS[topo]
    else:
        case_dir, master_file = EXAMPLES_DIR / "ieee13", "IEEE13Nodeckt.dss"

    initial_taps = INITIAL_TAPS_BY_TOPO.get(topo, INITIAL_TAPS_BY_TOPO["ieee13"])

    old_dir = os.getcwd()
    os.chdir(case_dir)
    try:
        grid = OpenDSSGrid(
            dss_case_dir=str(case_dir),
            dss_master_file=master_file,
            dt_s=Fraction(1),
            source_pu=tap_pu,
            initial_tap_position=initial_taps,
        )
    finally:
        os.chdir(old_dir)
    return grid


"""Run  datacenter + grid simulation."""
def _run(dc, grid, tap_pu, dc_bus, duration_s, control_mode: str = "baseline",
         active_model_labels: tuple[str, ...] | None = None,
         initial_batch_sizes: dict[str, int] | None = None,
         topology: str = "ieee13",
         zone_summary=None,
         bus_phase_groups=None):

    grid.attach_dc(dc, bus=dc_bus, connection_type="wye", power_factor=_DC_CONFIG.power_factor)

    controllers = []
    if control_mode == "ofo":
        active_models = tuple(m for m in _MODELS if m.model_label in (active_model_labels or ()))
        if not active_models:
            raise ValueError(
                f"OFO mode requires at least one of _MODELS to match the running "
                f"datacenter's model(s); got active_model_labels={active_model_labels!r}"
            )
        controllers.append(
            OFOBatchSizeController(
                inference_models=active_models,      
                datacenter=dc,
                grid=grid,
                models=_get_logistic_store(),
                config=OFOConfig(),
                dt_s=Fraction(1),
                initial_batch_sizes=initial_batch_sizes,
                
            )
        )
    elif control_mode == "tap_schedule":
        controllers.append(TapScheduleController(schedule=TAP_CHANGE_SCHEDULE, dt_s=Fraction(1)))
    elif control_mode == "ppo":
        active_models = tuple(m for m in _MODELS if m.model_label in (active_model_labels or ()))
        if not active_models:
            raise ValueError(
                f"PPO mode requires at least one of _MODELS to match the running "
                f"datacenter's model(s); got active_model_labels={active_model_labels!r}"
            )
        model_path, vecnorm_path = _ppo_checkpoint_paths(topology)
        if not model_path.exists():
            raise FileNotFoundError(
                f"No trained PPO checkpoint at {model_path}. Train one first with "
                f"`python examples/rl_controller/train_ppo.py --system {topology}`."
            )
        controllers.append(
            PPOBatchSizeController(
                inference_models=active_models,
                datacenter=dc,
                grid=grid,
                config=PPOControllerConfig(
                    model_path=str(model_path),
                    vecnormalize_path=str(vecnorm_path) if vecnorm_path.exists() else None,
                ),
                dt_s=Fraction(1),
                initial_batch_sizes=initial_batch_sizes,
                zone_summary=zone_summary,
                bus_phase_groups=bus_phase_groups,
            )
        )

    coord = Coordinator(
        datacenters=[dc], grid=grid,
        controllers=controllers,
        total_duration_s=duration_s,
    )
    return coord.run()


"""
    Runs one full simulation job (datacenter + grid) in a worker process
    and returns results for the API.
    """
    
def _run_full(req_dict: dict) -> dict:
    topo = req_dict.get("topology", "ieee13").lower()
    buses = _get_topo_buses(topo)

    target_idx = req_dict["targetBus"] - 1
    if 0 <= target_idx < len(buses):
        dc_bus = buses[target_idx]
    else:
        dc_bus = buses[0] if buses else "671"

    replicas = max(1, req_dict["numReplicas"])
    control_mode = req_dict.get("controlMode", "baseline")
    if req_dict.get("ofoEnabled"):
        control_mode = "ofo"
    if req_dict.get("ppoEnabled"):
        control_mode = "ppo"

    dc, raw_power_W = _build_dc_from_real_trace(
        model_label  = req_dict["modelLabel"], num_gpus = req_dict["numGpus"],
        max_num_seqs = req_dict["maxNumSeqs"], num_replicas = replicas, duration_s = req_dict["durationS"],
    )
    grid = _build_grid(req_dict["substationVoltage"], dc_bus, topo)
    log  = _run(
    dc,
    grid,
    req_dict["substationVoltage"],
    dc_bus,
    req_dict["durationS"],
    control_mode=control_mode,
    active_model_labels=(req_dict["modelLabel"],),
    initial_batch_sizes={
        req_dict["modelLabel"]: req_dict["maxNumSeqs"]
    },
    topology=topo,
    zone_summary=None,
    bus_phase_groups=None,
)

    step       = max(1, req_dict["sampleInterval"])
    gs_sampled = log.grid_states[::step]
    t_sampled  = list(log.time_s[::step])
    dc_states  = log.dc_states

    results = []
    for i, (t, gs) in enumerate(zip(t_sampled, gs_sampled)):
        vs   = _voltages(gs, topo)
        dc_i = min(range(len(dc_states)), key=lambda j: abs(dc_states[j].time_s - t))
        ds   = dc_states[dc_i]
        kw   = float((ds.power_w.a + ds.power_w.b + ds.power_w.c) / 1000)

        if math.isnan(kw): kw = 0.0
        trace_idx = min(int(t / 0.1), len(raw_power_W) - 1) if raw_power_W else 0
        raw_kw    = raw_power_W[trace_idx] / 1000.0 if raw_power_W else kw

        target_v = vs[target_idx] if 0 <= target_idx < len(vs) else (vs[0] if vs else 1.0)

        results.append({
            "time":               float(t),
            "gpu_power_W":        kw * 1000,
            "gpu_power_kW":       kw,
            "gpu_power_raw_kW":   raw_kw,
            "gpu_reactive_kVAR":  kw * 0.329,
            "active_gpus":        replicas * req_dict["numGpus"],
            "voltages":           vs,
            "min_voltage":        min(vs) if vs else 1.0,
            "max_voltage":        max(vs) if vs else 1.0,
            "target_bus_voltage": target_v,
            "total_load_kW":      kw,
            "batch_size_by_model": dict(getattr(ds, "batch_size_by_model", {}) or {}),
        })

    return {
        "numSamples": len(results), "targetBus": req_dict["targetBus"],
        "modelLabel": req_dict["modelLabel"], "numGpus": req_dict["numGpus"],
        "maxNumSeqs": req_dict["maxNumSeqs"], "numReplicas": replicas,
        "controlMode": control_mode,
        "duration": float(max(r["time"] for r in results) if results else 0),
        "minVoltage": float(min(r["min_voltage"] for r in results) if results else 1.0),
        "maxVoltage": float(max(r["max_voltage"] for r in results) if results else 1.0),
        "avgGpuPower": float(sum(r["gpu_power_W"] for r in results) / len(results) if results else 0),
        "peakGpuPower": float(max(r["gpu_power_W"] for r in results) if results else 0),
        "timeSeries": results,
    }
    
    
    
"""Get per-bus voltage (worst phase per bus)."""
def _voltages(gs, topology: str = "ieee13") -> list[float]:
    result = []
    buses = _get_topo_buses(topology)
    for name in buses:
        try:
            tp   = gs.voltages[name]
            vals = [float(v) for v in [tp.a, tp.b, tp.c] if not math.isnan(float(v)) and 0.5 < float(v) < 1.5]
            result.append(min(vals) if vals else None)
        except Exception:
            result.append(None)
    known  = [v for v in result if v is not None]
    avg    = sum(known) / len(known) if known else 1.0
    return [v if v is not None else avg for v in result]


# ── FastAPI────────────────────────────────────────────────────────────────
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

class PowerflowRequest(BaseModel):
    substationVoltage: float = 1.05
    numBuses:          int   = 13
    baseVoltage:       float = 4.16
    targetBus:         int   = 0
    topology:          str   = "ieee13"

class LLMImpactRequest(BaseModel):
    targetBus:            int   = 9
    sampleInterval:       int   = 1
    substationVoltage:    float = 1.05
    modelLabel:           str   = "Llama-3.1-8B"
    numGpus:              int   = 1
    maxNumSeqs:           int   = 128
    numReplicas:          int   = 1
    durationS:            int   = 300
    topology:             str   = "ieee13"
    controlMode:          str   = "baseline"
    ofoEnabled:           bool  = False
    ppoEnabled:           bool  = False

class HeatmapRequest(BaseModel):
    voltages:      list[float]
    dataCenterBus: Optional[int]  = None
    dataCenterBusName: Optional[str] = None
    topology:      str            = 'ieee13'
    busNames:      Optional[list[str]] = None

@app.get("/api/health")
def health():
    return {"status": "ok", "data_ready": _DATA_DIR.exists()}


"""Return available traces"""
@app.get("/api/traces")
def list_traces():
    df = _load_traces_index()
    if df.empty: return {"traces": [], "models": [], "trainingAvailable": False}
    traces = df[["model_label","num_gpus","max_num_seqs"]].to_dict("records")
    models = [{"modelLabel": label, "numGpus": int(grp["num_gpus"].iloc[0]), "batchSizes": sorted(grp["max_num_seqs"].tolist())} for label, grp in df.groupby("model_label")]
    return {"traces": traces, "models": models, "trainingAvailable": (_DATA_DIR / "training_trace.csv").exists(), "dataDir": str(_DATA_DIR)}


"""Baseline grid simulation, no workload"""
@app.post("/api/powerflow")
async def powerflow(req: PowerflowRequest):
    topo = req.topology.lower()
    logger.info(f"Powerflow request topo={topo} v={req.substationVoltage}")

    if topo == "ieee13":
        try:
            df = _load_traces_index()
            if df.empty:
                grid = _build_grid(req.substationVoltage, "671", topo)
                grid.dss.text(f"vsource.source.pu={req.substationVoltage}")
                grid.dss.solution.solve()
                class DummyGridState:
                    def __init__(self, dss_instance):
                        self.voltages = {}
                        for name in BUSES_ORDERED:
                            dss_instance.circuit.set_active_bus(name)
                            v_pu = dss_instance.bus.pu_voltages
                            class PhaseVoltages:
                                a = v_pu[0] if len(v_pu) > 0 else 1.0
                                b = v_pu[2] if len(v_pu) > 2 else 1.0
                                c = v_pu[4] if len(v_pu) > 4 else 1.0
                            self.voltages[name] = PhaseVoltages()
                vs = _voltages(DummyGridState(grid.dss), topo)
            else:
                dc   = _build_dc(scale=0.001, duration_s=5)
                grid = _build_grid(req.substationVoltage, "671", topo)
                log  = _run(dc, grid, req.substationVoltage, "671", 5)
                vs   = _voltages(log.grid_states[-1], topo)

            return {
    "buses": [{"id": i + 1, "name": BUSES_ORDERED[i], "voltage": v,
               "activePower": 0.0, "reactivePower": 0.0} for i, v in enumerate(vs)],
    "lines": _TOPO_LINES.get('ieee13', []),
}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    coords = _TOPO_COORDS.get(topo, {})
    if not coords:
        raise HTTPException(status_code=404, detail=f"Unknown topology: {topo}")

    bus_list = [b for b in coords.keys() if b.lower() not in _INTERNAL_BUSES]
    n = len(bus_list)
    buses_out = []
    for i, name in enumerate(bus_list):
        drop = (i / max(n - 1, 1)) * 0.04
        v    = round(req.substationVoltage - drop, 4)
        buses_out.append({"id": i + 1, "name": name, "voltage": v, "activePower": 0.0, "reactivePower": 0.0})

    lines_out = _TOPO_LINES.get(topo, [])
    logger.info(f"Powerflow stub {topo}: {len(buses_out)} buses, {len(lines_out)} lines returned")
    return {"buses": buses_out, "lines": lines_out}


def _serialize_tick(tick, req_dict: dict, raw_power_W: list[float]) -> dict:
    t = tick.t_s
    voltages = None
    min_v = max_v = target_v = None
    topo = req_dict.get("topology", "ieee13").lower()
    if tick.grid_state is not None:
        voltages = _voltages(tick.grid_state, topo)
        min_v = min(voltages)
        max_v = max(voltages)
        target_idx = req_dict["targetBus"] - 1
        target_v = voltages[target_idx] if 0 <= target_idx < len(voltages) else 1.0

    kw = 0.0
    batch_by_model: dict[str, int] = {}
    for dc_name, ds in tick.dc_states.items():
        pw = ds.power_w
        kw += float((pw.a + pw.b + pw.c) / 1000)
        if hasattr(ds, "batch_size_by_model"):
            batch_by_model.update(ds.batch_size_by_model)
    if math.isnan(kw): kw = 0.0

    trace_idx = min(int(t / 0.1), len(raw_power_W) - 1) if raw_power_W else 0
    raw_kw = raw_power_W[trace_idx] / 1000.0 if raw_power_W else kw
    events = [{"type": e.event_type, "data": e.data} for e in tick.sim_events]

    return {
        "time": float(t), "gpu_power_kW": kw, "gpu_power_raw_kW": raw_kw,
        "active_gpus": req_dict["numReplicas"] * req_dict["numGpus"], "batch_by_model": batch_by_model,
        "voltages": voltages, "min_voltage": min_v, "max_voltage": max_v, "target_bus_voltage": target_v, "sim_events": events,
    }

@app.websocket("/ws/sim-stream")
async def sim_stream(ws: WebSocket):
    await ws.accept()
    try:
        req_dict = await ws.receive_json()
        req = LLMImpactRequest(**req_dict)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_pool, _run_full, req.dict())
        for row in result["timeSeries"]:
            await ws.send_json(row)
        await ws.send_json({"done": True})
    except WebSocketDisconnect:
        logger.info("WS client disconnected")
    except Exception as e:
        logger.exception("WS stream failed")
        try: await ws.send_json({"error": str(e)})
        except Exception: pass


@app.post("/api/heatmap")
async def heatmap(req: HeatmapRequest):
    topo    = req.topology.lower()
    coords  = _TOPO_COORDS.get(topo, {})
    lines   = _TOPO_LINES.get(topo, [])
    cw, ch  = CANVAS.get(topo, (900, 750))

    if req.busNames:
        bus_names = req.busNames
    elif topo == 'ieee13':
        bus_names = BUSES_ORDERED
    else:
        bus_names = [str(i + 1) for i in range(len(req.voltages))]

    if len(req.voltages) != len(bus_names):
        raise HTTPException(400, f"voltages length {len(req.voltages)} != bus_names length {len(bus_names)}")

    dc_bus: str | None = None
    if req.dataCenterBusName:
        dc_bus = req.dataCenterBusName.lower()
    elif req.dataCenterBus and topo == 'ieee13':
        idx = req.dataCenterBus - 1
        if 0 <= idx < len(bus_names):
            dc_bus = bus_names[idx].lower()

    substation_bus = bus_names[0] if bus_names else '650'

    with tempfile.NamedTemporaryFile(suffix=".svg", delete=False) as f:
        out = f.name

    try:
        generate_heatmap(
            voltages       = req.voltages,
            bus_names      = bus_names,
            coords         = coords,
            lines          = lines,
            output_path    = out,
            canvas_w       = cw,
            canvas_h       = ch,
            dc_bus         = dc_bus,
            substation_bus = substation_bus,
            topology       = topo,
        )
        svg = open(out, "rb").read()
    finally:
        if os.path.exists(out):
            os.unlink(out)

    return Response(content=svg, media_type="image/svg+xml")


@app.get("/api/topology/{topo}/buses")
async def topology_buses(topo: str):
    coords = _TOPO_COORDS.get(topo.lower(), {})
    return {
        "topology": topo,
        "buses": list(coords.keys()),
        "coords": {k: list(v) for k, v in coords.items()},
    }

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8080, workers=1, ws_ping_interval=None)