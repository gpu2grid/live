"""
paper_mode.py

Runs the paper's IEEE-13 scenario (model_insights/common.py) for server.py,
restricted to 4 models. does not run b200 currently
"""

from __future__ import annotations
from openg2g.datacenter.config import ModelDeployment, ReplicaSchedule
import asyncio
from fastapi import HTTPException
import importlib.util
import json
import logging
import math
import os
import sys
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

PAPER_DIR = Path(os.environ.get("PAPER_DIR", Path(__file__).parent / "examples" / "model_insights"))

PAPER_VARIANTS: dict[str, dict] = {
    "Qwen3-8B":        dict(replicas=4800, deadline_ms=50,  hardware="H100"),
    "Qwen3-8B-B200":   dict(replicas=4326, deadline_ms=50,  hardware="B200"),
    "Llama-3.1-70B":   dict(replicas=1264, deadline_ms=100, hardware="H100"),
    "Llama-3.1-405B":  dict(replicas=637,  deadline_ms=120, hardware="H100"),
}

ANCHOR_PEAK_KW = 3120.0  

#same as bus 6??
IEEE13_TARGET_IDX = 5 
PAPER_DURATION_S = 3600

_aic = None
_shared = None
_LOAD_LOCK = threading.RLock() 


def _load_common_impl():
    """Import the paper's common.py under a private name.

    The paper's `systems.py` has the same module name as the RL one that
    server.py imports in _run_trained, so we swap sys.modules['systems']
    only for the duration of the import and then restore the original.
    """
    global _aic
    if _aic is not None:
        return _aic
    common_path = PAPER_DIR / "common.py"
    if not common_path.exists():
        raise FileNotFoundError(f"{common_path} not found; set PAPER_DIR to the model_insights folder.")

    saved_systems = sys.modules.pop("systems", None)
    sys.path.insert(0, str(PAPER_DIR))
    try:
        spec = importlib.util.spec_from_file_location("paper_common", common_path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["paper_common"] = mod 
        spec.loader.exec_module(mod)
    finally:
        sys.path.remove(str(PAPER_DIR))
        sys.modules.pop("systems", None)
        if saved_systems is not None:
            sys.modules["systems"] = saved_systems
    _aic = mod
    return mod


def _get_shared_impl(aic):
    global _shared
    if _shared is None:
        specs = tuple(aic.SPECS[label] for label in PAPER_VARIANTS)
        _shared = aic.load_shared_data(specs_used=specs)  
    return _shared


def _replica_fn(label: str, replicas: int, aic):
    """t (s) -> {label: active replicas}, mirroring build_scenario's default ramp."""
    from openg2g.datacenter.config import ReplicaSchedule

    target = max(1, int(round(replicas * 0.5)))  
    sched = ReplicaSchedule(initial=replicas).ramp_to(target, t_start=2500.0, t_end=3000.0)
    return lambda t: {label: int(sched.count_at(float(t)))}


def _load_common():
    with _LOAD_LOCK:
        return _load_common_impl()


def _get_shared(aic):
    with _LOAD_LOCK:
        return _get_shared_impl(aic)


def paper_variants_info() -> list[dict]:
    return [{"modelLabel": k, **v} for k, v in PAPER_VARIANTS.items()]


def _resolve_config(req: dict, aic, shared) -> dict:
    """Paper defaults."""
    label = req["modelLabel"]
    v = PAPER_VARIANTS[label]
    custom = bool(req.get("paperCustom"))
    deadline_ms = v["deadline_ms"]
    replicas = v["replicas"]
    if custom and req.get("paperDeadlineMs") is not None:
        deadline_ms = int(round(float(req["paperDeadlineMs"])))
    if not 1 <= deadline_ms <= 10_000:
        raise ValueError(f"Latency target must be between 1 and 10000 ms (got {deadline_ms}).")

    spec = aic.restrict_spec_by_deadline(aic.SPECS[label], shared.logistic_models, deadline_ms / 1000.0)
    feas = sorted(int(b) for b in spec.feasible_batch_sizes)
    if not feas:
        raise ValueError(f"No batch size of {label} meets a {deadline_ms} ms latency target; raise the target.")

    if custom:
        if req.get("paperReplicas"):
            replicas = int(req["paperReplicas"])
            if not 1 <= replicas <= 20_000:
                raise ValueError(f"Replicas must be between 1 and 20000 (got {replicas}).")
        elif req.get("paperAutoSize", True) and deadline_ms != v["deadline_ms"]:
            replicas = int(aic.compute_matched_peak_replicas(spec, ANCHOR_PEAK_KW, shared.logistic_models))

    start_batch = max(feas)
    if custom and req.get("paperInitialBatch") is not None:
        start_batch = int(req["paperInitialBatch"])
        if start_batch not in feas:
            raise ValueError(f"Starting batch {start_batch} is not allowed at a {deadline_ms} ms target; choose one of {feas}.")

    seed = int(req.get("paperSeed", 0))
    if not 0 <= seed <= 99:
        raise ValueError("Seed must be between 0 and 99.")
    return dict(label=label, v=v, custom=custom, deadline_ms=deadline_ms, replicas=replicas,
                spec=spec, start_batch=start_batch, seed=seed)


def _run_paper_uncached(req: dict, assemble, stats_to_dict) -> dict:
  
    label = req["modelLabel"]
    if label not in PAPER_VARIANTS:
        raise ValueError(f"paperMode supports only {list(PAPER_VARIANTS)}; got {label!r}")
    if req.get("ppoEnabled") or req.get("controlMode") == "ppo":
        raise ValueError("paperMode does not support PPO (the paper's model_insights runs use baseline / OFO).")


    aic = _load_common()
    shared = _get_shared(aic)
    cfg = _resolve_config(req, aic, shared)
    v, seed = cfg["v"], cfg["seed"]
    replicas, deadline_ms, spec, start_batch = cfg["replicas"], cfg["deadline_ms"], cfg["spec"], cfg["start_batch"]

    use_ofo = bool(req.get("ofoEnabled")) or req.get("controlMode") == "ofo"
    use_tap = bool(req.get("paperTapChange", False))
    mode = f"{'ofo' if use_ofo else 'baseline'}-{'tap-change' if use_tap else 'no-tap'}"

    duration = int(req.get("durationS") or PAPER_DURATION_S)
    if duration < PAPER_DURATION_S:
        logger.info("paperMode: durationS=%s too short for the scenario events; using %s s.", duration, PAPER_DURATION_S)
        duration = PAPER_DURATION_S

    deployments = [(ModelDeployment(spec=spec, initial_batch_size=start_batch), ReplicaSchedule(initial=replicas))]
    apr_mw = aic.compute_achievable_power_range(deployments=deployments, logistic_models=shared.logistic_models)

    logger.info("PAPER RUN%s model=%s hw=%s replicas=%d deadline=%dms batches=%s mode=%s seed=%d duration=%ds",
                " (custom)" if cfg["custom"] else "", label, v["hardware"], replicas, deadline_ms, list(spec.feasible_batch_sizes), mode, seed, duration)

    case_dir = aic.SYSTEMS["ieee13"]()["dss_case_dir"]
    old_cwd = os.getcwd()
    os.chdir(case_dir)  
    try:
        ov = {"seed": seed}
        gpu_budget = replicas * spec.gpus_per_replica + 200  
        if cfg["custom"] and gpu_budget > 7200:
            ov["total_gpu_capacity"] = gpu_budget
        scenario = aic.build_scenario(deployments, shared=shared, overrides=aic.ScenarioOverrides(**ov))
        result = aic.run_scenario(scenario, shared.logistic_models, mode=mode, total_duration_s=duration)
    finally:
        os.chdir(old_cwd)

    req2 = dict(req)
    req2.update(
        modelLabel=label,
        numGpus=spec.gpus_per_replica,
        numReplicas=replicas,
        maxNumSeqs=start_batch,
        targetBus=IEEE13_TARGET_IDX + 1,
        sampleInterval=max(10, int(req.get("sampleInterval", 1))),
    )
    out = assemble(
        req2, result.log, "ieee13", IEEE13_TARGET_IDX, replicas, [], mode,
        {label: deadline_ms / 1000.0}, shared.logistic_models,
        exclude_buses=tuple(scenario["exclude_buses"]),
      
        replicas_by_model=_replica_fn(label, replicas, aic),
    )

    out["summary"]["paper"] = {
        "voltage": stats_to_dict(result.voltage),
        "performance": stats_to_dict(result.performance),
        "achievable_power_range_mw": apr_mw,
        "mode": mode,
        "seed": seed,
        "hardware": v["hardware"],
        "num_replicas": replicas,
        "gpus_per_replica": spec.gpus_per_replica,
        "deadline_ms": deadline_ms,
        "custom": cfg["custom"],
        "default_deadline_ms": v["deadline_ms"],
        "default_replicas": v["replicas"],
        "feasible_batch_sizes": list(spec.feasible_batch_sizes),
        "initial_batch": start_batch,
    }
    return out



CACHE_VERSION = "v1"
CACHE_DIR = Path(os.environ.get("PAPER_CACHE_DIR", Path(__file__).parent / ".paper_cache"))


def _mode_name(req: dict) -> str:
    use_ofo = bool(req.get("ofoEnabled")) or req.get("controlMode") == "ofo"
    use_tap = bool(req.get("paperTapChange", False))
    return f"{'ofo' if use_ofo else 'baseline'}-{'tap-change' if use_tap else 'no-tap'}"


def _cache_path(req: dict) -> Path:
    duration = max(PAPER_DURATION_S, int(req.get("durationS") or PAPER_DURATION_S))
    sample = max(10, int(req.get("sampleInterval", 1)))
    name = "{}__{}__seed{}__{}__d{}__s{}{}__{}.json".format(
        req["modelLabel"], v_hw(req["modelLabel"]), int(req.get("paperSeed", 0)),
        _mode_name(req), duration, sample, _custom_suffix(req), CACHE_VERSION,
    )
    return CACHE_DIR / name


def _custom_suffix(req: dict) -> str:
    if not req.get("paperCustom"):
        return ""
    v = PAPER_VARIANTS[req["modelLabel"]]
    parts = []
    dl = req.get("paperDeadlineMs")
    dl_i = None if dl is None else int(round(float(dl)))
    if dl_i is not None and dl_i != v["deadline_ms"]:
        parts.append(f"dl{dl_i}")
    if req.get("paperReplicas"):
        parts.append(f"r{int(req['paperReplicas'])}")
    elif req.get("paperAutoSize", True) and dl_i is not None and dl_i != v["deadline_ms"]:
        parts.append("rauto")
    if req.get("paperInitialBatch") is not None:
        parts.append(f"b{int(req['paperInitialBatch'])}")
    return ("__" + "_".join(parts)) if parts else ""


def v_hw(label: str) -> str:
    return PAPER_VARIANTS.get(label, {}).get("hardware", "NA")


def run_paper(req: dict, assemble, stats_to_dict) -> dict:
    """Cached entry point used by server.py. Set paperNoCache=true to force a rerun."""
    if req.get("modelLabel") not in PAPER_VARIANTS:
        raise ValueError(f"paperMode supports only {list(PAPER_VARIANTS)}; got {req.get('modelLabel')!r}")
    path = _cache_path(req)
    if not req.get("paperNoCache") and path.exists():
        try:
            logger.info("PAPER CACHE HIT %s", path.name)
            return json.loads(path.read_text())
        except Exception as e:  # corrupt file: fall through and recompute
            logger.warning("Bad cache file %s (%s); recomputing", path.name, e)

    out = _run_paper_uncached(req, assemble, stats_to_dict)

    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(out))
        tmp.replace(path)  # atomic, safe if two workers race
        logger.info("PAPER CACHE WRITE %s", path.name)
    except Exception as e:
        logger.warning("Could not write cache %s: %s", path, e)
    return out




_traces_cache: dict | None = None
_noload_cache: list[float] | None = None
PAPER_BASE_KW_PER_PHASE = 500.0  # common.build_scenario default


def _restricted_spec(aic, shared, label: str):
    v = PAPER_VARIANTS[label]
    return aic.restrict_spec_by_deadline(aic.SPECS[label], shared.logistic_models, v["deadline_ms"] / 1000.0)


def paper_traces_response() -> dict:
    """Same shape as server.list_traces, but only the paper's 4 models with
    the paper's replica counts, deadline-restricted batch sizes and deadlines."""
    global _traces_cache
    if _traces_cache is None:
        aic = _load_common()
        shared = _get_shared(aic)
        models = []
        for label, v in PAPER_VARIANTS.items():
            spec = _restricted_spec(aic, shared, label)
            feas = sorted(int(b) for b in spec.feasible_batch_sizes)
            models.append({
                "modelLabel": label,
                "numGpus": int(spec.gpus_per_replica),
                "batchSizes": feas,
                "initialReplicas": int(v["replicas"]),
                "feasibleBatchSizes": feas,
                "itlDeadlineS": v["deadline_ms"] / 1000.0,
                "hardware": v["hardware"],
            })
        _traces_cache = {"traces": [], "models": models, "trainingAvailable": True, "paperMode": True}
    return _traces_cache


def paper_power_throughput(label: str, replicas: int | None = None) -> dict:

    if label not in PAPER_VARIANTS:
        raise KeyError(label)
    aic = _load_common()
    shared = _get_shared(aic)
    allowed = {int(b) for b in _restricted_spec(aic, shared, label).feasible_batch_sizes}
    all_batches = sorted(int(b) for b in aic.SPECS[label].feasible_batch_sizes)
    n = int(replicas) if replicas else PAPER_VARIANTS[label]["replicas"]
    p_fit = shared.logistic_models.power(label)
    t_fit = shared.logistic_models.throughput(label)
    lat_fit = shared.logistic_models.latency(label)
    base_kw = 3.0 * PAPER_BASE_KW_PER_PHASE
    points = []
    for b in all_batches:
        gpu_kw = float(p_fit.eval(b)) * n / 1e3
        tput = float(t_fit.eval(b)) * n
        itl_ms = float(lat_fit.eval(b)) * 1000.0
        points.append({
            "batch": b,
            "power_kW": gpu_kw + base_kw,       # total DC power incl. base load
            "gpu_power_kW": gpu_kw,
            "throughput_tok_s": tput,
            "itl_ms": itl_ms,
            "feasible": b in allowed,
            # legacy names
            "batchSize": b,
            "gpuPowerKW": gpu_kw,
            "totalPowerMW": (gpu_kw + base_kw) / 1e3,
            "throughputTokensS": tput,
        })
    return {"modelLabel": label, "numReplicas": n, "baseKw": base_kw, "baseLoadKW": base_kw, "points": points}


def _read_noload_cache() -> list[float] | None:
    global _noload_cache
    if _noload_cache is not None:
        return _noload_cache
    cache_file = CACHE_DIR / f"noload__{CACHE_VERSION}.json"
    if cache_file.exists():
        try:
            _noload_cache = json.loads(cache_file.read_text())
            return _noload_cache
        except Exception:
            return None
    return None


def _paper_noload_job(buses_ordered: list[str]) -> list[float]:


    aic = _load_common()
    shared = _get_shared(aic)
    label = "Qwen3-8B"
    spec = _restricted_spec(aic, shared, label)
    deployments = [(ModelDeployment(spec=spec, initial_batch_size=min(spec.feasible_batch_sizes)),
                    ReplicaSchedule(initial=1))]
    case_dir = aic.SYSTEMS["ieee13"]()["dss_case_dir"]
    old_cwd = os.getcwd()
    os.chdir(case_dir)
    try:
        scenario = aic.build_scenario(
            deployments, shared=shared,
            overrides=aic.ScenarioOverrides(training_n_gpus=0, base_kw_per_phase=0.001, enable_tap_schedule=False),
        )
        result = aic.run_scenario(scenario, shared.logistic_models, mode="baseline-no-tap", total_duration_s=2)
    finally:
        os.chdir(old_cwd)

    gs = result.log.grid_states[-1]
    vals: list[float | None] = []
    for name in buses_ordered:
        try:
            tp = gs.voltages[name]
            ph = [float(x) for x in (tp.a, tp.b, tp.c) if not math.isnan(float(x)) and 0.5 < float(x) < 1.5]
            vals.append(min(ph) if ph else None)
        except Exception:
            vals.append(None)
    known = [v for v in vals if v is not None]
    avg = sum(known) / len(known) if known else 1.0
    out = [v if v is not None else avg for v in vals]
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (CACHE_DIR / f"noload__{CACHE_VERSION}.json").write_text(json.dumps(out))
    except Exception as e:
        logger.warning("Could not write no-load cache: %s", e)
    return out


def register_routes(app, voltages_fn, run_full, pool, buses_ordered, lines_fn) -> None:
    """Call right after the CORS middleware, BEFORE server.py's own routes:
    FastAPI uses the first matching route, so these override the originals."""
 

    @app.get("/api/traces")
    def paper_traces():
        try:
            return paper_traces_response()
        except Exception as e:
            logger.exception("paper traces failed")
            raise HTTPException(status_code=500, detail=str(e))

    @app.get("/api/power-throughput")
    def paper_power_tp(modelLabel: str, numReplicas: int = 1, baseKwPerPhase: float = 500.0):
        # baseKwPerPhase is ignored on purpose (the paper fixes it); numReplicas is honoured for custom runs.
        try:
            return paper_power_throughput(modelLabel, numReplicas if numReplicas and numReplicas > 1 else None)
        except KeyError:
            raise HTTPException(status_code=404, detail=f"{modelLabel} is not a paper model: {list(PAPER_VARIANTS)}")

    noload_lock = asyncio.Lock()  # one no-load job at a time; later callers hit the cache

    @app.post("/api/powerflow")
    async def paper_powerflow(body: dict):
        global _noload_cache
        topo = str(body.get("topology", "ieee13")).lower()
        if topo != "ieee13":
            raise HTTPException(status_code=400, detail="PAPER_MODE supports the IEEE 13-bus feeder only.")
        loop = asyncio.get_event_loop()
        async with noload_lock:
            vs = _read_noload_cache()
            if vs is None:
                try:
                    vs = await loop.run_in_executor(pool, _paper_noload_job, list(buses_ordered))
                except Exception as e:
                    logger.exception("paper no-load failed")
                    raise HTTPException(status_code=500, detail=str(e))
                _noload_cache = vs
        return {
            "buses": [{"id": i + 1, "name": buses_ordered[i], "voltage": v,
                       "activePower": 0.0, "reactivePower": 0.0} for i, v in enumerate(vs)],
            "lines": lines_fn(),
        }

    @app.get("/api/paper-variants")
    def paper_variants():
        return {"variants": paper_variants_info()}

    @app.post("/api/paper-warm")
    async def paper_warm(body: dict):
        """Run baseline and OFO for one model in parallel and fill the disk cache."""
        base = {"durationS": PAPER_DURATION_S, "sampleInterval": 10, "paperMode": True, "targetBus": 6,
                "topology": "ieee13", "numReplicas": 1, "numGpus": 1, "maxNumSeqs": 128, "substationVoltage": 1.0}
        base.update(body)
        loop = asyncio.get_event_loop()
        jobs = []
        for ofo in (False, True):
            d = dict(base)
            d.update(ofoEnabled=ofo, ppoEnabled=False, controlMode="ofo" if ofo else "baseline")
            jobs.append(loop.run_in_executor(pool, run_full, d))
        await asyncio.gather(*jobs)
        return {"status": "cached", "modelLabel": base.get("modelLabel")}

    logger.info("PAPER_MODE routes registered (traces, powerflow, power-throughput, paper-warm)")