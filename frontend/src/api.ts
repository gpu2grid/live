// ── Central API config ─────────────────────────────────────────────────────────

export const API_URL = "https://gpu2grid-live.hf.space";

export async function wakeBackend(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(`${API_URL}/api/health`);
      if (res.ok) {
        console.log("[gpu2grid] backend awake ✓");
        return;
      }
    } catch {}
    console.log(`[gpu2grid] waking... attempt ${i + 1}`);
    await new Promise(r => setTimeout(r, 3000));
  }
}