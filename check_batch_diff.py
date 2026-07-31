"""
Diagnostic: confirms whether OFO/PPO's batch-size decisions actually reach
the datacenter, by running the same config under two control modes and
diffing `batch_by_model` tick-by-tick.

Usage:
    pip install websockets
    python check_batch_diff.py [--host ws://localhost:8080] [--mode ofo|ppo]
"""

import argparse
import asyncio
import json

import websockets

BASE_REQUEST = {
    "targetBus": 9,
    "topology": "ieee13",
    "numBuses": 13,
    "modelLabel": "Llama-3.1-8B",
    "numGpus": 1,
    "maxNumSeqs": 128,
    "numReplicas": 1,
    "substationVoltage": 1.05,
    "sampleInterval": 1,
    "durationS": 60,
}


async def run_once(host: str, control_mode: str) -> list[dict]:
    req = dict(BASE_REQUEST)
    req["controlMode"] = control_mode
    req["ofoEnabled"] = control_mode == "ofo"
    req["ppoEnabled"] = control_mode == "ppo"

    rows = []
    uri = f"{host}/ws/sim-stream"
    async with websockets.connect(uri, max_size=None) as ws:
        await ws.send(json.dumps(req))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("done"):
                break
            if msg.get("error"):
                raise RuntimeError(f"[{control_mode}] server error: {msg['error']}")
            rows.append(msg)
    return rows


def summarize(rows: list[dict]) -> list[tuple]:
    return [
        (r["time"], r.get("batch_size_by_model"), round(r["gpu_power_kW"], 2))
        for r in rows
    ]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="ws://localhost:8080")
    ap.add_argument("--mode", default="ofo", choices=["ofo", "ppo"])
    args = ap.parse_args()

    print(f"Running baseline...")
    baseline_rows = await run_once(args.host, "baseline")
    print(f"Running {args.mode}...")
    other_rows = await run_once(args.host, args.mode)

    baseline = summarize(baseline_rows)
    other = summarize(other_rows)

    n = min(len(baseline), len(other))
    print(f"\n{'t':>6}  {'baseline batch':<28} {'baseline kW':>12}  |  "
          f"{args.mode + ' batch':<28} {args.mode + ' kW':>12}  {'DIVERGED?'}")

    any_batch_diverged = False
    any_power_diverged = False
    for i in range(n):
        t_b, batch_b, kw_b = baseline[i]
        t_o, batch_o, kw_o = other[i]
        batch_diff = batch_b != batch_o
        power_diff = abs(kw_b - kw_o) > 1e-6
        any_batch_diverged |= batch_diff
        any_power_diverged |= power_diff
        flag = ""
        if batch_diff:
            flag += "BATCH "
        if power_diff:
            flag += "POWER"
        print(f"{t_b:6.1f}  {str(batch_b):<28} {kw_b:12.2f}  |  "
              f"{str(batch_o):<28} {kw_o:12.2f}  {flag}")

    print("\n-- Verdict --------------------------------------------------")
    if not any_batch_diverged:
        print(f"batch_by_model is IDENTICAL between baseline and {args.mode} "
              f"at every timestep.")
        print("=> The controller's SetBatchSize command is not reaching "
              "the datacenter (or not being applied). Look at:")
        print("   - Coordinator.run()'s command-dispatch loop (does it "
              "isinstance-check the target against LLMBatchSizeControlledDatacenter?)")
        print("   - OfflineDatacenter's handling of SetBatchSize (does it "
              "exist, and does it actually change what's sampled?)")
    elif not any_power_diverged:
        print(f"batch_by_model DOES change under {args.mode}, but "
              f"gpu_power_kW never moves in response.")
        print("=> The datacenter is recording the requested batch size as "
              "metadata but not re-deriving power from it.")
    else:
        print(f"Both batch_by_model and gpu_power_kW diverge under "
              f"{args.mode} -- the control loop is wired up correctly.")


if __name__ == "__main__":
    asyncio.run(main())
