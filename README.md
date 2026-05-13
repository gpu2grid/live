# gpu2grid/live

Simulates how AI datacenter workloads affect electrical grid stability. 

GPU power traces from real LLM inference and training runs are replayed through an IEEE 13-bus distribution feeder solved via OpenDSS, 
using the [openg2g](https://github.com/gpu2grid/openg2g) simulation framework. The simulator shows how different models, batch sizes, cluster sizes, and connection points cause voltage violations across the grid.

**[Try the live simulator at](https://gpu2grid.io/live)**

---

## What it does

- Injects real H100 GPU power traces (ML.ENERGY Benchmark v3) into an IEEE 13-bus feeder
- Solves power flow at each 0.1s timestep using OpenDSS via the `openg2g` framework
- Visualizes per-bus voltage over time, violation rates, and GPU power draw
- Supports multiple LLM models (Llama 3.1 8B/70B/405B, Qwen3), batch sizes, and replica counts

## Quick Start

```bash
# Backend
cd backend
uv sync
python server.py

# Frontend (in a separate terminal)
cd frontend
npm install
npm run dev
```

The frontend runs at `http://localhost:5173` and expects the backend at `http://localhost:8080`.

For local development, create `frontend/.env.local`:
```
VITE_API_URL=http://localhost:8080
```

## Data

GPU power traces are from the [ML.ENERGY Benchmark v3](https://ml.energy) (H100 measurements). On first run, traces are downloaded and cached under `data/offline/`.

```bash
python examples/offline/run_ofo.py --system ieee13 --mode all
```


## Stack

- **Backend** — FastAPI + OpenDSS via [`openg2g`](https://github.com/gpu2grid/openg2g)
- **Frontend** — React + Recharts
- **Grid model** — IEEE 13-bus distribution feeder
- **GPU traces** — ML.ENERGY Benchmark v3 (H100)

