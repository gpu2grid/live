import argparse
import asyncio
import json
import statistics

import websockets

BASE_REQUEST = {
    "targetBus": 9,
    "topology": "ieee13",
    "numBuses": 13,
    "modelLabel": "Llama-3.1-8B",
    "numGpus": 1,
    "numReplicas": 1,
    "substationVoltage": 1.05,
    "sampleInterval": 1,
    "durationS": 60,
    "controlMode": "baseline",
    "ofoEnabled": False,
    "ppoEnabled": False,
}


async def run_once(host: str, max_num_seqs: int) -> list[float]:
    req = dict(BASE_REQUEST)
    req["maxNumSeqs"] = max_num_seqs

    powers = []
    uri = f"{host}/ws/sim-stream"
    async with websockets.connect(uri, max_size=None) as ws:
        await ws.send(json.dumps(req))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("done"):
                break
            if msg.get("error"):
                raise RuntimeError(f"[batch={max_num_seqs}] server error: {msg['error']}")
            powers.append(msg["gpu_power_kW"])
    return powers


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="ws://localhost:8080")
    ap.add_argument("--low", type=int, default=128)
    ap.add_argument("--high", type=int, default=512)
    args = ap.parse_args()

    print(f"Running static baseline at batch={args.low}...")
    low_powers = await run_once(args.host, args.low)
    print(f"Running static baseline at batch={args.high}...")
    high_powers = await run_once(args.host, args.high)

    low_avg, low_peak = statistics.mean(low_powers), max(low_powers)
    high_avg, high_peak = statistics.mean(high_powers), max(high_powers)

    print(f"\nbatch={args.low:<5} avg kW: {low_avg:8.2f}   peak kW: {low_peak:8.2f}")
    print(f"batch={args.high:<5} avg kW: {high_avg:8.2f}   peak kW: {high_peak:8.2f}")
    pct_diff = (high_avg - low_avg) / low_avg * 100

    print(f"\nDelta: {pct_diff:+.1f}% average power change for a "
          f"{args.high/args.low:.0f}x batch size increase")

    print("\n-- Verdict --------------------------------------------------")
    if abs(pct_diff) < 5:
        print("Batch size has ~no effect on simulated power even in a static (no-controller) run.")
        print("=> Check InferenceData.load() / _get_trace_power()'s CSV lookup -- "
              "confirm the trace CSVs for different max_num_seqs actually contain "
              "different power profiles for this model.")
    else:
        print(f"Batch size DOES meaningfully change power in a static run ({pct_diff:+.1f}%).")
        print("=> Compare against OFO's numbers from check_batch_diff.py: if OFO reports "
              "switching to batch=512 but its gpu_power_kW stays near this run's batch=128 "
              "average instead of approaching the batch=512 average, that confirms "
              "OfflineDatacenter is not recomputing power from the live commanded batch "
              "size -- only the reported label is updating.")


if __name__ == "__main__":
    asyncio.run(main())
