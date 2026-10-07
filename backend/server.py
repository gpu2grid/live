"""
server.py 

Runs a simulation between AI datacenter workloads and an electrical grid (IEEE 13-bus OpenDSS model).

Uses GPU power traces and  workloads to model howAI inference/training affects grid voltage and stability over time.
"""


from bisect import bisect_left
from functools import lru_cache
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
import os, math, json, sys, pickle, tempfile, asyncio, time, logging
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from typing import Optional

import pandas as pd
import uvicorn
from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from openg2g.controller.ofo import OFOBatchSizeController, OFOConfig, LogisticModelStore
from openg2g.coordinator import Coordinator
from openg2g.datacenter.config import (
    DatacenterConfig,
    InferenceModelSpec,
    PowerAugmentationConfig,
    TrainingRun,
    ReplicaSchedule,
)
from openg2g.datacenter.offline import OfflineDatacenter, OfflineWorkload
from openg2g.datacenter.workloads.inference import InferenceData
from openg2g.datacenter.workloads.training import TrainingTrace, TrainingTraceParams
from openg2g.grid.opendss import OpenDSSGrid
from openg2g.grid.config import TapPosition
from openg2g.grid.command import GridCommand
from openg2g.controller.tap_schedule import TapScheduleController
from openg2g.controller.base import Controller
from openg2g.metrics.voltage import compute_allbus_voltage_stats
from openg2g.datacenter.base import LLMBatchSizeControlledDatacenter
from openg2g.datacenter.command import DatacenterCommand, SetBatchSize
from openg2g.clock import SimulationClock
from openg2g.events import EventEmitter

from topology_coords import load_all_coords, get_lines_from_dss, CANVAS
from generate_heatmap import generate_heatmap

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)

PAPER_MODE = os.environ.get("PAPER_MODE", "0") == "1"

_INTERNAL_BUSES = {"814r", "852r", "sourcebus"}

EXAMPLES_DIR = Path(__file__).parent / "examples"

_TOPO_COORDS: dict = {}
_TOPO_LINES: dict = {}
_TOPO_MASTERS: dict = {}


def _init_topology_data():
    global _TOPO_COORDS, _TOPO_LINES, _TOPO_MASTERS
    _TOPO_COORDS = load_all_coords(EXAMPLES_DIR)

    for topo in ["ieee13", "ieee34", "ieee123"]:
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
            combined_lines, seen_lines = [], set()
            for dss_file in dss_files:
                try:
                    for l in get_lines_from_dss(coords, dss_file):
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

_pool = ProcessPoolExecutor(max_workers=2)
_start_time = time.time()

DSS_DIR = Path(__file__).parent / "examples/ieee13"
DSS_MASTER = "IEEE13Nodeckt.dss"
CONFIG_PATH = Path(__file__).parent / "examples/offline/config.json"

BUS_INDEX_TO_NAME = {
    1: "650", 2: "632", 3: "633", 4: "645", 5: "646", 6: "671",
    7: "684", 8: "611", 9: "634", 10: "675", 11: "652", 12: "680", 13: "692",
}
BUSES_ORDERED = [BUS_INDEX_TO_NAME[i] for i in range(1, 14)]


def _get_topo_buses(topology: str) -> list[str]:
    topo = topology.lower()
    if topo == "ieee13":
        return BUSES_ORDERED
    coords = _TOPO_COORDS.get(topo, {})
    return [b for b in coords.keys() if b.lower() not in _INTERNAL_BUSES]


_config_raw = json.loads(CONFIG_PATH.read_text())
_MODELS = tuple(InferenceModelSpec(**m) for m in _config_raw["models"])

_DC_CONFIG_NOLOAD = DatacenterConfig(gpus_per_server=8, base_kw_per_phase=0.001)
_DC_CONFIG = DatacenterConfig(gpus_per_server=8, base_kw_per_phase=500.0)


def _dc_config(base_kw_per_phase: float) -> DatacenterConfig:
    """Per-request DC config so the fixed (non-GPU) base load is adjustable."""
    return DatacenterConfig(gpus_per_server=8, base_kw_per_phase=base_kw_per_phase)


if _config_raw.get("data_dir"):
    _DATA_DIR = Path(_config_raw["data_dir"])
else:
    _DATA_DIR = Path(__file__).parent / "data/specs"

_TRACES_SUMMARY_PATH = _DATA_DIR / "traces_summary.csv"
_traces_df: pd.DataFrame | None = None

_LOGISTIC_STORE: LogisticModelStore | None = None


def _get_logistic_store() -> LogisticModelStore:
    """FIX-4: _DATA_DIR already defaults to data/specs; only descend into a
    'specs' subfolder if it really exists, otherwise use _DATA_DIR itself."""
    global _LOGISTIC_STORE
    if _LOGISTIC_STORE is None:
        specs_dir = _DATA_DIR / "specs"
        if not specs_dir.exists():
            specs_dir = _DATA_DIR
        _LOGISTIC_STORE = LogisticModelStore.ensure(specs_dir, _MODELS)
    return _LOGISTIC_STORE



@dataclass
class PPOControllerConfig:
    model_path: str
    vecnormalize_path: Optional[str] = None
    v_min: float = 0.95
    v_max: float = 1.05
    deterministic: bool = True

'''
_PPO_MODEL_CACHE: dict[str, tuple] = {}


def _get_ppo_model(config: PPOControllerConfig):
    """Process-wide cache so a checkpoint isn't reloaded on every request."""
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
                 bus_phase_groups=None, replica_counts: dict[str, int] | None = None):
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
        # Real replica counts so the active/max replicas feature matches training.
        self._replica_counts = replica_counts or {
            m.model_label: getattr(m, "initial_replicas", 1) for m in inference_models
        }
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
            # Fail loudly: silently padding/truncating feeds the policy garbage.
            if obs.shape[1] != expected_dim:
                cfg = self._obs_config
                raise ValueError(
                    f"PPO obs_dim mismatch: built {obs.shape[1]} "
                    f"(= n_bus_phases {cfg.n_bus_phases} + 3 global + 5 x {cfg.n_models} models), "
                    f"checkpoint expects {expected_dim}. The checkpoint was trained on 5 models and a "
                    f"32-slot grid; start the server with TRAINED_SCENARIO=1 to run that exact setup."
                )
            if getattr(self._vecnorm, "norm_obs", True):
                rms = self._vecnorm.obs_rms
                obs = np.clip(
                    (obs - rms.mean) / np.sqrt(rms.var + self._vecnorm.epsilon),
                    -self._vecnorm.clip_obs, self._vecnorm.clip_obs,
                ).astype(np.float32)
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

    def step(self, clock: SimulationClock, events: EventEmitter) -> list[DatacenterCommand | GridCommand]:
        self._ensure_obs_config()
        obs = self._build_observation()
        action, _ = self._model.predict(obs, deterministic=self.config.deterministic)
        if self._control_step_count < 5:
            logger.info("PPO step %d: obs_dim=%d action=%s current_bs=%s",
                        self._control_step_count, obs.shape[1], action, self._current_bs)
        batch_next = self._decode_action(action)
        self._control_step_count += 1
        logger.debug("PPO step %d (t=%.1f s): batch=%s", self._control_step_count, clock.time_s, batch_next)
        events.emit("controller.ppo.step", {"batch_size_by_model": batch_next})
        return [SetBatchSize(batch_size_by_model=batch_next, target=self.datacenter)]

    @property
    def batch_size_by_model(self) -> dict[str, int]:
        return dict(self._current_bs)
'''


TAP_STEP = 0.00625

TAP_CHANGE_SCHEDULE = (
    TapPosition(
        a=1.0 + 16 * TAP_STEP, b=1.0 + 6 * TAP_STEP, c=1.0 + 17 * TAP_STEP,
    ).at(t=75)
    | TapPosition(
        a=1.0 + 10 * TAP_STEP, b=1.0 + 6 * TAP_STEP, c=1.0 + 10 * TAP_STEP,
    ).at(t=200)
)


IEEE13_TAP_STEPS = tuple(int(x) for x in os.environ.get("IEEE13_TAPS", "7,6,7").split(","))

INITIAL_TAPS_BY_TOPO = {
    "ieee13": TapPosition(
        a=1.0 + IEEE13_TAP_STEPS[0] * TAP_STEP,
        b=1.0 + IEEE13_TAP_STEPS[1] * TAP_STEP,
        c=1.0 + IEEE13_TAP_STEPS[2] * TAP_STEP,
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


# ── Traces ────────────────────────────────────────────────────────────────
def _load_traces_index() -> pd.DataFrame:
    """Load trace index CSV and cache it."""
    global _traces_df
    if _traces_df is None:
        if _TRACES_SUMMARY_PATH.exists():
            _traces_df = pd.read_csv(_TRACES_SUMMARY_PATH)
        else:
            _traces_df = pd.DataFrame(columns=["model_label", "num_gpus", "max_num_seqs", "trace_file"])
    return _traces_df


def _get_trace_power(model_label: str, num_gpus: int, max_num_seqs: int,
                     num_replicas: int = 1) -> list[float]:
    """Look up a GPU power trace and scale by replica count (watts per timestep)."""
    df = _load_traces_index()
    row = df[
        (df["model_label"] == model_label) &
        (df["num_gpus"] == num_gpus) &
        (df["max_num_seqs"] == max_num_seqs)
    ]
    if row.empty:
        raise ValueError(f"No trace found for model={model_label}")
    trace_file = _DATA_DIR / row.iloc[0]["trace_file"]
    trace_df = pd.read_csv(trace_file)
    return [p * num_replicas for p in trace_df["power_total_W"].tolist()]


_load_traces_index()


def _build_dc(scale: float = 1.0, duration_s: int = 300) -> OfflineDatacenter:
    """Datacenter workload (baseline, used by /api/powerflow)."""
    df = _load_traces_index()
    first_row = df.iloc[0]
    first_model = tuple(m for m in _MODELS if m.model_label == first_row["model_label"])
    inference_data = InferenceData.load(_DATA_DIR, first_model)

    training_trace = TrainingTrace.ensure(_DATA_DIR / "training_trace.csv", TrainingTraceParams())
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
        training=TrainingRun(n_gpus=max(1, int(24 * scale)), trace=training_trace,
                             target_peak_W_per_gpu=400.0).at(t_start=t0, t_end=t1),
    )
    return OfflineDatacenter(
        _DC_CONFIG_NOLOAD, workload, dt_s=Fraction(1, 10), seed=0, name="baseline", total_gpu_capacity=1000,
        power_augmentation=PowerAugmentationConfig(amplitude_scale_range=(0.88, 1.12), noise_fraction=0.04),
    )


def _build_dc_from_real_trace(model_label: str, num_gpus: int, max_num_seqs: int,
                              num_replicas: int, duration_s: int,
                              base_kw_per_phase: float = 500.0,
                              paper_scenario: bool = False,
                              training_gpus: int = 2400) -> tuple[OfflineDatacenter, list[float]]:
    """Build a datacenter from a real GPU trace. Returns (datacenter, raw_power_W_list)."""
    power_W = _get_trace_power(model_label, num_gpus, max_num_seqs, num_replicas)
    target_steps = int(duration_s / 0.1)
    if len(power_W) < target_steps:
        repeats = math.ceil(target_steps / len(power_W))
        power_W = (power_W * repeats)[:target_steps]
    else:
        power_W = power_W[:target_steps]

    model_tuple = tuple(m for m in _MODELS if m.model_label == model_label)
    inference_data = InferenceData.load(_DATA_DIR, model_tuple)

    actual_gpu_count = num_replicas * num_gpus
    workload_kwargs = dict(
        inference_data=inference_data,
        replica_schedules={model_label: ReplicaSchedule(initial=num_replicas)},
        initial_batch_sizes={model_label: max_num_seqs},
    )
    train_gpus = 0

    if paper_scenario:
        
        def _at(t_paper_s: float) -> float:
            return t_paper_s / 3600.0 * duration_s

        train_gpus = max(0, int(training_gpus))
        workload_kwargs["replica_schedules"] = {
            model_label: ReplicaSchedule(initial=num_replicas).ramp_to(
                max(1, int(round(num_replicas * 0.5))), t_start=_at(2500.0), t_end=_at(3000.0)
            )
        }
        if train_gpus > 0:
            training_trace = TrainingTrace.ensure(_DATA_DIR / "training_trace.csv", TrainingTraceParams())
            workload_kwargs["training"] = TrainingRun(
                n_gpus=train_gpus, trace=training_trace, target_peak_W_per_gpu=400.0
            ).at(t_start=_at(1000.0), t_end=_at(2000.0))

    workload = OfflineWorkload(**workload_kwargs)
    gpu_capacity = max(1000, (actual_gpu_count + train_gpus) * 2)

    dc = OfflineDatacenter(
        _dc_config(base_kw_per_phase), workload, dt_s=Fraction(1, 10), seed=0,
        name=model_label.replace(".", "-"), total_gpu_capacity=gpu_capacity,
        power_augmentation=PowerAugmentationConfig(amplitude_scale_range=(1.0, 1.0), noise_fraction=0.0),
    )
    return dc, power_W


def _build_grid(tap_pu: float, dc_bus: str, topology: str = "ieee13") -> OpenDSSGrid:
    """Create the OpenDSS grid for a topology."""
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


class _LoggedOFO(OFOBatchSizeController):
    """OFO with per-step diagnostics (voltage extremes over ALL bus-phases,
    duals, latency, batch in log2 space: 9.0 == 512)."""

    def step(self, clock, events):
        cmds = super().step(clock, events)
        n = self._control_step_count
        if n <= 20 or n % 10 == 0:
            try:
                v = self._grid.voltages_vector()
                v = v[(v > 0.5) & (v < 1.5)]
                v_info = "v_min=%.4f v_max=%.4f n_over_1.05=%d n_under_0.95=%d" % (
                    float(v.min()), float(v.max()),
                    int((v > 1.05).sum()), int((v < 0.95).sum()))
                vd = self._voltage_dual
                d_info = "over_dual_max=%.3g under_dual_max=%.3g" % (
                    float(vd.dual_overvoltage.max()), float(vd.dual_undervoltage.max()))
            except Exception as e:  # diagnostics must never break the run
                v_info, d_info = "v=n/a (%s)" % e, ""
            itl = dict(getattr(self._datacenter.state, "observed_itl_s_by_model", {}) or {})
            logger.info("OFO step=%d t=%.0fs log2_batch=%s | itl_s=%s deadline_s=%s latency_dual=%s | %s | %s",
                        n, clock.time_s,
                        self._optimizer.log_batch_size_by_model,
                        itl, self._itl_deadline_by_model, self._latency_dual_by_model,
                        v_info, d_info)
        return cmds


def _run(dc, grid, tap_pu, dc_bus, duration_s, control_mode: str = "baseline",
         active_model_labels: tuple[str, ...] | None = None,
         initial_batch_sizes: dict[str, int] | None = None,
         topology: str = "ieee13",
         zone_summary=None,
         bus_phase_groups=None,
         itl_deadline_override_s: float | None = None,
         num_replicas: int = 1,
         ofo_overrides: dict | None = None):
    """Run datacenter + grid simulation."""
    grid.attach_dc(dc, bus=dc_bus, connection_type="wye", power_factor=_DC_CONFIG.power_factor)

    controllers = []
    if control_mode == "ofo":
        active_models = tuple(m for m in _MODELS if m.model_label in (active_model_labels or ()))
        if not active_models:
            raise ValueError(
                f"OFO mode requires at least one of _MODELS to match the running "
                f"datacenter's model(s); got active_model_labels={active_model_labels!r}"
            )
        if itl_deadline_override_s is not None:
            active_models = tuple(
                m.model_copy(update={"itl_deadline_s": itl_deadline_override_s}) for m in active_models
            )
        controllers.append(
            _LoggedOFO(
                inference_models=active_models,
                datacenter=dc,
                grid=grid,
                models=_get_logistic_store(),
                config=OFOConfig(**(ofo_overrides or {})),
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
        model_path, vecnorm_path = _ppo_checkpoint_paths(topology, os.environ.get("PPO_RUN", "ppo"))
        if not model_path.exists():
            raise FileNotFoundError(
                f"No trained PPO checkpoint at {model_path}. Train one first with "
                f"`python examples/rl_controller/train_ppo.py --system {topology}`."
            )
        logger.info("Loading PPO checkpoint: %s", model_path)
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
                replica_counts={m.model_label: num_replicas for m in active_models},
            )
        )

    coord = Coordinator(
        datacenters=[dc], grid=grid,
        controllers=controllers,
        total_duration_s=duration_s,
    )
    return coord.run()


PAPER_OFO_OVERRIDES = dict(
    primal_step_size=0.1,
    w_throughput=0.001,
    w_switch=1.0,
    voltage_gradient_scale=1e6,
    voltage_dual_step_size=1.0,
    latency_dual_step_size=1.0,
    sensitivity_update_interval=3600,
    sensitivity_perturbation_kw=100.0,
)
for _k in list(PAPER_OFO_OVERRIDES):
    _ev = os.environ.get("OFO_" + _k.upper())
    if _ev is not None:
        PAPER_OFO_OVERRIDES[_k] = type(PAPER_OFO_OVERRIDES[_k])(float(_ev))


def _stats_to_dict(obj) -> dict:
    """Flatten a stats object (dataclass / pydantic / plain) to JSON-safe scalars."""
    import dataclasses
    if dataclasses.is_dataclass(obj):
        d = dataclasses.asdict(obj)
    elif hasattr(obj, "model_dump"):
        d = obj.model_dump()
    else:
        d = dict(vars(obj))
    out = {}
    for k, v in d.items():
        if isinstance(v, bool) or v is None or isinstance(v, str):
            out[k] = v
        elif isinstance(v, (int, float)):
            out[k] = float(v) if math.isfinite(float(v)) else None
    return out


def _worst_buses(log, n: int = 5, stride: int = 10) -> list[dict]:
    worst: dict[str, float] = {}
    for gs in log.grid_states[::stride]:
        for name in _get_topo_buses("ieee13"):
            try:
                tp = gs.voltages[name]
            except Exception:
                continue
            for v in (tp.a, tp.b, tp.c):
                try:
                    v = float(v)
                except Exception:
                    continue
                if 0.5 < v < 1.5:
                    worst[name] = max(worst.get(name, 0.0), v)
    top = sorted(worst.items(), key=lambda kv: -kv[1])[:n]
    return [{"bus": b, "vmax": round(v, 4)} for b, v in top]


def _summarize_run(log, itl_deadline_by_model: dict[str, float], exclude_buses=()) -> dict:
    """Paper-style metrics. FIX-1: exclude the same buses the controller/training
    excludes so the integral matches what OFO actually sees. Never raises."""
    summary: dict = {}
    exclude = tuple(set(_INTERNAL_BUSES) | {str(b).lower() for b in exclude_buses})
    try:
        vs = compute_allbus_voltage_stats(
            log.grid_states, v_min=0.95, v_max=1.05, exclude_buses=exclude
        )
        summary["voltage"] = _stats_to_dict(vs)
        summary["voltage"]["excluded_buses"] = list(exclude)
        summary["voltage"]["top_vmax_buses"] = _worst_buses(log)
    except Exception as e:
        summary["voltage_error"] = str(e)
    try:
        from openg2g.metrics.performance import compute_performance_stats
        ps = compute_performance_stats(log.dc_states, itl_deadline_s_by_model=itl_deadline_by_model)
        summary["performance"] = _stats_to_dict(ps)
    except Exception as e:
        summary["performance_error"] = str(e)
    return summary


def _throughput_for_tick(batch_by_model: dict[str, int], store=None,
                         replicas_by_model: dict[str, int] | None = None) -> dict[str, float]:
    """FIX-2: fitted per-replica throughput curve evaluated at the chosen batch,
    multiplied by replica count to give datacenter-total tokens/s."""
    if not batch_by_model:
        return {}
    if store is None:
        store = _get_logistic_store()
    out: dict[str, float] = {}
    for label, batch in batch_by_model.items():
        try:
            per_replica = float(store.throughput(label).eval(batch))
        except KeyError:
            continue
        out[label] = per_replica * (replicas_by_model or {}).get(label, 1)
    return out


def _run_full(req_dict: dict) -> dict:
    
    if PAPER_MODE or req_dict.get("paperMode"):
        from paper_mode import run_paper
        return run_paper(req_dict, _assemble_results, _stats_to_dict)
    
    if req_dict.get("evalMode"):
        from ppo import run_eval
        return run_eval(req_dict, _assemble_results, _stats_to_dict)
    
    if req_dict.get("trainedScenario"):
        return _run_trained(req_dict)
    topo = req_dict.get("topology", "ieee13").lower()
    buses = _get_topo_buses(topo)

    target_idx = req_dict["targetBus"] - 1
    if 0 <= target_idx < len(buses):
        dc_bus = buses[target_idx]
    else:
        dc_bus = buses[0] if buses else "671"

    replicas = max(1, req_dict["numReplicas"])
    logger.info("RUN CONFIG paperScenario=%s trainingGpus=%s startBatch=%s replicas=%s duration=%ss",
                req_dict.get("paperScenario"), req_dict.get("trainingGpus"),
                req_dict.get("maxNumSeqs"), replicas, req_dict.get("durationS"))
    control_mode = req_dict.get("controlMode", "baseline")
    if req_dict.get("ofoEnabled"):
        control_mode = "ofo"
    if req_dict.get("ppoEnabled"):
        control_mode = "ppo"

    dc, raw_power_W = _build_dc_from_real_trace(
        model_label=req_dict["modelLabel"], num_gpus=req_dict["numGpus"],
        max_num_seqs=req_dict["maxNumSeqs"], num_replicas=replicas, duration_s=req_dict["durationS"],
        base_kw_per_phase=req_dict.get("baseKwPerPhase", 500.0),
        paper_scenario=bool(req_dict.get("paperScenario", False)),
        training_gpus=int(req_dict.get("trainingGpus", 2400)),
    )
    grid = _build_grid(req_dict["substationVoltage"], dc_bus, topo)

    ofo_overrides = dict(PAPER_OFO_OVERRIDES)
    ofo_overrides.update({k: v for k, v in {
        "voltage_gradient_scale": req_dict.get("ofoVoltageGradientScale"),
        "latency_dual_step_size": req_dict.get("ofoLatencyDualStep"),
        "primal_step_size": req_dict.get("ofoPrimalStep"),
        "w_throughput": req_dict.get("ofoWThroughput"),
    }.items() if v is not None})

    deadline_override = (
        req_dict["itlDeadlineMsOverride"] / 1000.0
        if req_dict.get("itlDeadlineMsOverride") is not None else None
    )

    log = _run(
        dc, grid, req_dict["substationVoltage"], dc_bus, req_dict["durationS"],
        control_mode=control_mode,
        active_model_labels=(req_dict["modelLabel"],),
        initial_batch_sizes={req_dict["modelLabel"]: req_dict["maxNumSeqs"]},
        topology=topo,
        zone_summary=None,
        bus_phase_groups=None,
        itl_deadline_override_s=deadline_override,
        num_replicas=replicas,
        ofo_overrides=ofo_overrides,
    )

    itl_deadlines = {
        m.model_label: (deadline_override if deadline_override is not None else float(m.itl_deadline_s))
        for m in _MODELS if m.model_label == req_dict["modelLabel"]
    }
    return _assemble_results(
        req_dict, log, topo, target_idx, replicas, raw_power_W, control_mode, itl_deadlines,
        replicas_by_model={req_dict["modelLabel"]: replicas},
    )


def _assemble_results(req_dict, log, topo, target_idx, replicas, raw_power_W,
                      control_mode, itl_deadlines, logistic=None,
                      exclude_buses=(), replicas_by_model=None) -> dict:
    """Turn a SimulationLog into the rows + summary the frontend expects."""
    step = max(1, req_dict["sampleInterval"])
    gs_sampled = log.grid_states[::step]
    t_sampled = list(log.time_s[::step])
    dc_states = log.dc_states
    dc_times = [s.time_s for s in dc_states] 

    def _nearest_dc_idx(t: float) -> int:
        j = bisect_left(dc_times, t)
        if j == 0:
            return 0
        if j >= len(dc_times):
            return len(dc_times) - 1
        return j if abs(dc_times[j] - t) < abs(dc_times[j - 1] - t) else j - 1

    pf = float(_DC_CONFIG.power_factor)
    q_ratio = math.tan(math.acos(pf)) if 0 < pf <= 1 else 0.329 

    results = []
    for t, gs in zip(t_sampled, gs_sampled):
        vs = _voltages(gs, topo)
        ds = dc_states[_nearest_dc_idx(t)]
        kw = float((ds.power_w.a + ds.power_w.b + ds.power_w.c) / 1000)
        if math.isnan(kw):
            kw = 0.0
        trace_idx = min(int(t / 0.1), len(raw_power_W) - 1) if raw_power_W else 0
        raw_kw = raw_power_W[trace_idx] / 1000.0 if raw_power_W else kw

        target_v = vs[target_idx] if 0 <= target_idx < len(vs) else (vs[0] if vs else 1.0)
        batch_by_model = dict(getattr(ds, "batch_size_by_model", {}) or {})

        itl_s_by_model = {}
        if hasattr(ds, "observed_itl_s_by_model"):
            for label, itl in ds.observed_itl_s_by_model.items():
                if itl is not None and math.isfinite(float(itl)):
                    itl_s_by_model[label] = float(itl)

        #throughput_tokens_s_by_model = _throughput_for_tick(batch_by_model, logistic, replicas_by_model)
        rbm = replicas_by_model(t) if callable(replicas_by_model) else replicas_by_model
        throughput_tokens_s_by_model = _throughput_for_tick(batch_by_model, logistic, rbm)

        results.append({
            "time": float(t),
            "gpu_power_W": kw * 1000,
            "gpu_power_kW": kw,
            "dc_power_MW": kw / 1000.0,  # total DC power (incl. base load) in MW
            "gpu_power_raw_kW": raw_kw,
            "gpu_reactive_kVAR": kw * q_ratio,
           # "active_gpus": replicas * req_dict["numGpus"],
            "active_gpus": (sum(rbm.values()) if callable(replicas_by_model) else replicas) * req_dict["numGpus"],
            "voltages": vs,
            "min_voltage": min(vs) if vs else 1.0,
            "max_voltage": max(vs) if vs else 1.0,
            "target_bus_voltage": target_v,
            "total_load_kW": kw,
            "batch_by_model": batch_by_model,
            "batch_size_by_model": batch_by_model,
            "itl_s_by_model": itl_s_by_model,
            "throughput_tokens_s_by_model": throughput_tokens_s_by_model,
            "total_throughput_tokens_s": float(sum(throughput_tokens_s_by_model.values())),
        })

    summary = _summarize_run(log, itl_deadlines, exclude_buses)
    # Per-model deadlines so the UI doesn't apply one threshold to all models.
    summary["itl_deadline_s_by_model"] = {k: float(v) for k, v in itl_deadlines.items()}
    logger.info("RUN SUMMARY mode=%s %s", control_mode, summary)

    return {
        "summary": summary,
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


def _run_trained(req_dict: dict) -> dict:
    """Run the exact environment the PPO checkpoint was trained on
    (5 models, 4800 inference GPUs, 2400-GPU training burst, 1.5 MW base load,
    PV at 675, load at 680, exclude_buses -> 32 voltage slots)."""
    from train_ppo import make_sim_factory
    from scenarios import EXPERIMENTS
    from systems import DT_CTRL, DT_DC, SPECS_CACHE_DIR, TRAINING_TRACE_PATH

    topo = "ieee13"
    control_mode = req_dict.get("controlMode", "baseline")
    if req_dict.get("ofoEnabled"):
        control_mode = "ofo"
    if req_dict.get("ppoEnabled"):
        control_mode = "ppo"

    training_trace = TrainingTrace.ensure(TRAINING_TRACE_PATH)
    exp = EXPERIMENTS[topo](training_trace)

    master = Path(exp["sys"]["dss_case_dir"]) / exp["sys"]["dss_master_file"]
    if not master.exists():
        raise FileNotFoundError(
            f"Trained-scenario grid file not found: {master}. The training setup reads the "
            f"feeder from data/grid/ieee13 (see systems.py GRID_DATA_DIR); copy it there."
        )

    dc_sites = exp["dc_sites"]
    all_specs = tuple({m.spec.model_label: m.spec for site in dc_sites.values() for m, _ in site.models}.values())
    inference_data = InferenceData.ensure(SPECS_CACHE_DIR, all_specs, plot=False, dt_s=float(DT_DC))
    logistic = LogisticModelStore.ensure(SPECS_CACHE_DIR, all_specs, plot=False)

    make_sim, site_specs, site_replicas, site_batch = make_sim_factory(exp, inference_data)
    dcs, grid, tap_ctrl = make_sim()
    sid = next(iter(dcs))
    dc = dcs[sid]
    specs, rc, init_bs = site_specs[sid], site_replicas[sid], site_batch[sid]

    controllers = [tap_ctrl]
    if control_mode == "ofo":
        ofo_cfg = exp["ofo_config"]
        upd = {k: v for k, v in {
            "voltage_gradient_scale": req_dict.get("ofoVoltageGradientScale"),
            "latency_dual_step_size": req_dict.get("ofoLatencyDualStep"),
            "primal_step_size": req_dict.get("ofoPrimalStep"),
            "w_throughput": req_dict.get("ofoWThroughput"),
        }.items() if v is not None}
        if upd:
            ofo_cfg = ofo_cfg.model_copy(update=upd)
        controllers.append(_LoggedOFO(
            inference_models=specs, datacenter=dc, grid=grid, models=logistic,
            config=ofo_cfg, dt_s=DT_CTRL, initial_batch_sizes=init_bs,
        ))
    elif control_mode == "ppo":
        model_path, vecnorm_path = _ppo_checkpoint_paths(topo, os.environ.get("PPO_RUN", "ppo"))
        if not model_path.exists():
            raise FileNotFoundError(f"No trained PPO checkpoint at {model_path}.")
        logger.info("Loading PPO checkpoint: %s", model_path)
        controllers.append(PPOBatchSizeController(
            inference_models=specs, datacenter=dc, grid=grid,
            config=PPOControllerConfig(
                model_path=str(model_path),
                vecnormalize_path=str(vecnorm_path) if vecnorm_path.exists() else None,
            ),
            dt_s=DT_CTRL, initial_batch_sizes=init_bs, replica_counts=rc,
        ))

    duration = int(req_dict["durationS"])
    if duration < 3600:
        # Scenario events run to t=3300 s (training 1000-2000, replica ramp 2500-3000).
        logger.info("Trained scenario: durationS=%s is too short for its events; using 3600 s.", duration)
        duration = 3600
    labels = [sp.model_label for sp in specs]
    exclude_buses = tuple(exp["sys"].get("exclude_buses", ()))
    logger.info("TRAINED SCENARIO mode=%s models=%s replicas=%s duration=%ss exclude_buses=%s",
                control_mode, labels, rc, duration, exclude_buses)

    coord = Coordinator(datacenters=[dc], grid=grid, controllers=controllers, total_duration_s=duration)
    log = coord.run()

    label = req_dict.get("modelLabel") if req_dict.get("modelLabel") in labels else "Llama-3.1-405B"
    req2 = dict(req_dict)
    req2.update(
        modelLabel=label,
        numGpus=sum(rc[sp.model_label] * sp.gpus_per_replica for sp in specs),
        numReplicas=1,
        maxNumSeqs=init_bs[label],
    )
    itl_deadlines = {sp.model_label: float(sp.itl_deadline_s) for sp in specs}
    target_idx = req_dict["targetBus"] - 1
    return _assemble_results(
        req2, log, topo, target_idx, 1, [], control_mode, itl_deadlines, logistic,
        exclude_buses=exclude_buses,       # FIX-1
        replicas_by_model=dict(rc),        # FIX-2
    )


def _voltages(gs, topology: str = "ieee13") -> list[float]:
    """Per-bus voltage (worst/lowest phase per bus). NOTE: hides over-voltage on
    other phases; use summary.voltage.top_vmax_buses to see those."""
    result = []
    for name in _get_topo_buses(topology):
        try:
            tp = gs.voltages[name]
            vals = [float(v) for v in [tp.a, tp.b, tp.c] if not math.isnan(float(v)) and 0.5 < float(v) < 1.5]
            result.append(min(vals) if vals else None)
        except Exception:
            result.append(None)
    known = [v for v in result if v is not None]
    avg = sum(known) / len(known) if known else 1.0
    return [v if v is not None else avg for v in result]


# ── FastAPI ───────────────────────────────────────────────────────────────
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])


if PAPER_MODE:
    import paper_mode
    paper_mode.register_routes(
        app, voltages_fn=_voltages, run_full=_run_full, pool=_pool,
        buses_ordered=BUSES_ORDERED, lines_fn=lambda: _TOPO_LINES.get("ieee13", []),
    )



class PowerflowRequest(BaseModel):
    substationVoltage: float = 1.05
    numBuses: int = 13
    baseVoltage: float = 4.16
    targetBus: int = 0
    topology: str = "ieee13"


class LLMImpactRequest(BaseModel):
    
    paperMode: bool = os.environ.get("PAPER_MODE", "0") == "1"
    evalMode: Optional[str] = None 
    
    evalScenario: int = 0
    paperSeed: int = 0
    paperTapChange: bool = False
    targetBus: int = 9
    sampleInterval: int = 1
    substationVoltage: float = 1.05
    modelLabel: str = "Llama-3.1-8B"
    numGpus: int = 1
    maxNumSeqs: int = 128
    numReplicas: int = 1
    durationS: int = 300
    topology: str = "ieee13"
    controlMode: str = "baseline"
    ofoEnabled: bool = False
    ppoEnabled: bool = False
    itlDeadlineMsOverride: Optional[float] = None
    # paper default: 500 kW/phase = 1.5 MW fixed load (0.001 = GPUs only).
    baseKwPerPhase: float = float(os.environ.get("BASE_KW_PER_PHASE", "500"))
    ofoVoltageGradientScale: Optional[float] = None
    ofoLatencyDualStep: Optional[float] = None
    ofoPrimalStep: Optional[float] = None
    ofoWThroughput: Optional[float] = None
    # Paper-style disturbance (training overlay + replica ramp). Default via PAPER_SCENARIO=1.
    paperScenario: bool = os.environ.get("PAPER_SCENARIO", "0") == "1"
    # Run the exact environment PPO was trained on. Default via TRAINED_SCENARIO=1.
    trainedScenario: bool = os.environ.get("TRAINED_SCENARIO", "0") == "1"
    trainingGpus: int = int(os.environ.get("TRAINING_GPUS", "2400"))
    
    


class HeatmapRequest(BaseModel):
    voltages: list[float]
    dataCenterBus: Optional[int] = None
    dataCenterBusName: Optional[str] = None
    topology: str = "ieee13"
    busNames: Optional[list[str]] = None


@app.get("/api/health")
def health():
    return {"status": "ok", "data_ready": _DATA_DIR.exists()}


@app.get("/api/traces")
def list_traces():
    """Return available traces."""
    df = _load_traces_index()
    if df.empty:
        return {"traces": [], "models": [], "trainingAvailable": False}

    traces = df[["model_label", "num_gpus", "max_num_seqs"]].to_dict("records")

    models = []
    for label, grp in df.groupby("model_label"):
        spec = next((m for m in _MODELS if m.model_label == label), None)
        models.append({
            "modelLabel": label,
            "numGpus": int(grp["num_gpus"].iloc[0]),
            "batchSizes": sorted(grp["max_num_seqs"].tolist()),
            "initialReplicas": int(getattr(spec, "initial_replicas", 1)) if spec else 1,
            "feasibleBatchSizes": sorted(getattr(spec, "feasible_batch_sizes", []) or []) if spec else [],
            "itlDeadlineS": float(spec.itl_deadline_s) if spec is not None and getattr(spec, "itl_deadline_s", None) is not None else None,
        })

    return {
        "traces": traces,
        "models": models,
        "trainingAvailable": (_DATA_DIR / "training_trace.csv").exists(),
        "dataDir": str(_DATA_DIR),
    }
    
@app.get("/api/paper-variants")
def paper_variants():
    from paper_mode import paper_variants_info
    return {"variants": paper_variants_info()}


@lru_cache(maxsize=512)
def _mean_trace_power_w(trace_file: str) -> float:
    """Mean total power (W) of one trace CSV, cached so the chart endpoint doesn't re-read files."""
    df = pd.read_csv(_DATA_DIR / trace_file, usecols=["power_total_W"])
    return float(df["power_total_W"].mean())


@app.get("/api/power-throughput")
def power_throughput(modelLabel: str, numReplicas: int = 1, baseKwPerPhase: float = 500.0):
    """FIX-3: power vs throughput per batch size for one model (the frontend was
    getting 404). Power = mean trace power x replicas + fixed base load;
    throughput = fitted per-replica curve x replicas."""
    df = _load_traces_index()
    rows = df[df["model_label"] == modelLabel]
    if rows.empty:
        raise HTTPException(status_code=404, detail=f"No traces for model {modelLabel}")

    replicas = max(1, int(numReplicas))
    base_kw = 3.0 * float(baseKwPerPhase)
    store = _get_logistic_store()
    points = []
    for _, r in rows.sort_values("max_num_seqs").iterrows():
        batch = int(r["max_num_seqs"])
        try:
            gpu_kw = _mean_trace_power_w(str(r["trace_file"])) * replicas / 1000.0
        except Exception:
            gpu_kw = None
        try:
            tput = float(store.throughput(modelLabel).eval(batch)) * replicas
        except Exception:
            tput = None
        points.append({
            "batchSize": batch,
            "gpuPowerKW": gpu_kw,
            "totalPowerMW": ((gpu_kw + base_kw) / 1000.0) if gpu_kw is not None else None,
            "throughputTokensS": tput,
        })
    return {
        "modelLabel": modelLabel,
        "numReplicas": replicas,
        "baseLoadKW": base_kw,
        "points": points,
    }


_PF_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_POWERFLOW_CACHE: dict = {}


@app.post("/api/powerflow")
async def powerflow(req: PowerflowRequest):
    key = (req.topology.lower(), round(float(req.substationVoltage), 3), int(req.numBuses))
    if key not in _POWERFLOW_CACHE:
        loop = asyncio.get_event_loop()
        _POWERFLOW_CACHE[key] = await loop.run_in_executor(_PF_EXECUTOR, _powerflow_compute, req)
    return _POWERFLOW_CACHE[key]


def _powerflow_compute(req: PowerflowRequest):
    """Baseline grid simulation, no workload."""
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
                dc = _build_dc(scale=0.001, duration_s=5)
                grid = _build_grid(req.substationVoltage, "671", topo)
                log = _run(dc, grid, req.substationVoltage, "671", 5)
                vs = _voltages(log.grid_states[-1], topo)

            return {
                "buses": [{"id": i + 1, "name": BUSES_ORDERED[i], "voltage": v,
                           "activePower": 0.0, "reactivePower": 0.0} for i, v in enumerate(vs)],
                "lines": _TOPO_LINES.get("ieee13", []),
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
        v = round(req.substationVoltage - drop, 4)
        buses_out.append({"id": i + 1, "name": name, "voltage": v, "activePower": 0.0, "reactivePower": 0.0})

    lines_out = _TOPO_LINES.get(topo, [])
    logger.info(f"Powerflow stub {topo}: {len(buses_out)} buses, {len(lines_out)} lines returned")
    return {"buses": buses_out, "lines": lines_out}


@app.websocket("/ws/sim-stream")
async def sim_stream(ws: WebSocket):
    # NOTE: the simulation completes before the first row is sent; this replays results.
    await ws.accept()
    try:
        req_dict = await ws.receive_json()
        req = LLMImpactRequest(**req_dict)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_pool, _run_full, req.model_dump())  # FIX-6
        for row in result["timeSeries"]:
            await ws.send_json(row)
        await ws.send_json({"done": True, "summary": result.get("summary")})
    except WebSocketDisconnect:
        logger.info("WS client disconnected")
    except Exception as e:
        logger.exception("WS stream failed")
        try:
            await ws.send_json({"error": str(e)})
        except Exception:
            pass


@app.post("/api/heatmap")
async def heatmap(req: HeatmapRequest):
    topo = req.topology.lower()
    coords = _TOPO_COORDS.get(topo, {})
    lines = _TOPO_LINES.get(topo, [])
    cw, ch = CANVAS.get(topo, (900, 750))

    if req.busNames:
        bus_names = req.busNames
    elif topo == "ieee13":
        bus_names = BUSES_ORDERED
    else:
        bus_names = [str(i + 1) for i in range(len(req.voltages))]

    if len(req.voltages) != len(bus_names):
        raise HTTPException(400, f"voltages length {len(req.voltages)} != bus_names length {len(bus_names)}")

    dc_bus: str | None = None
    if req.dataCenterBusName:
        dc_bus = req.dataCenterBusName.lower()
    elif req.dataCenterBus and topo == "ieee13":
        idx = req.dataCenterBus - 1
        if 0 <= idx < len(bus_names):
            dc_bus = bus_names[idx].lower()

    substation_bus = bus_names[0] if bus_names else "650"

    with tempfile.NamedTemporaryFile(suffix=".svg", delete=False) as f:
        out = f.name

    try:
        generate_heatmap(
            voltages=req.voltages,
            bus_names=bus_names,
            coords=coords,
            lines=lines,
            output_path=out,
            canvas_w=cw,
            canvas_h=ch,
            dc_bus=dc_bus,
            substation_bus=substation_bus,
            topology=topo,
        )
        with open(out, "rb") as fh:
            svg = fh.read()
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
    
@app.post("/api/paper-warm")
async def paper_warm(req: LLMImpactRequest):
    loop = asyncio.get_event_loop()
    jobs = []
    for ofo in (False, True):
        d = req.model_dump()
        d.update(paperMode=True, ofoEnabled=ofo, ppoEnabled=False,
                 controlMode="ofo" if ofo else "baseline")
        jobs.append(loop.run_in_executor(_pool, _run_full, d))
    await asyncio.gather(*jobs)
    return {"status": "cached"}


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8080, workers=1, ws_ping_interval=None)