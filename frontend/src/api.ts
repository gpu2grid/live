// ── Central API config ─────────────────────────────────────────────────────────





export const API_URL = "https://gpu2grid-live.hf.space";

export async function wakeBackend(): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/health`);
    if (res.ok) {
      console.log("[gpu2grid] backend awake ✓");
    }
  } catch (err) {
    console.warn("[gpu2grid] backend sleeping, waking…", err);
  }
}