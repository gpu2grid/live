// ── Central API config ─────────────────────────────────────────────────────────


export const API_URL =
  import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV
    ? "http://localhost:7860"
    : "https://gpu2grid-live.hf.space");


export async function wakeBackend(): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/health`);
    if (res.ok) {
      console.log("[gpu2grid] backend awake ✓");
    } else {
      console.warn("[gpu2grid] /health returned", res.status);
    }
  } catch (err) {
    console.warn("[gpu2grid] backend sleeping, waking…", err);
  }
}