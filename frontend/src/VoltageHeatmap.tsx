import { useState, useEffect, useRef } from "react";

interface VoltageHeatmapProps {
  voltages: number[];
  loading?: boolean;
  label?: string;
  dataCenterBus?: number | null;  
}

export default function VoltageHeatmap({ voltages, loading = false, label, dataCenterBus }: VoltageHeatmapProps) {
  const [imgSrc, setImgSrc]     = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const debounceRef             = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef               = useRef({ voltages, dataCenterBus });

  useEffect(() => {
    if (!voltages || voltages.length !== 13) return;
    latestRef.current = { voltages, dataCenterBus };

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchHeatmap(latestRef.current.voltages, latestRef.current.dataCenterBus);
    }, 300);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [JSON.stringify(voltages), dataCenterBus]);

  const fetchHeatmap = async (v: number[], dcBus?: number | null) => {
    setFetching(true); setError(null);
    try {
      const res = await fetch("http://localhost:8080/api/heatmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voltages: v, dataCenterBus: dcBus ?? null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      setImgSrc(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
    } catch (e) {
      setError((e as Error).message);
    } finally { setFetching(false); }
  };

  const busy = loading || fetching;

  return (
    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "16px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, color: "#0f172a" }}>Voltage Heatmap</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {label && (
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 20,
              background: label.includes("LLM") ? "#fef9c3" : "#f0fdf4",
              color:      label.includes("LLM") ? "#854d0e"  : "#166534",
              border: `1px solid ${label.includes("LLM") ? "#fde047" : "#bbf7d0"}`,
            }}>{label}</span>
          )}
          {busy && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#0891b2", fontSize: 11, fontWeight: 700 }}>
              <div style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid #e2e8f0", borderTopColor: "#0891b2", animation: "spin 0.8s linear infinite" }} />
              <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              Rendering…
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ color: "#ef4444", fontSize: 11, padding: "8px 12px",
          background: "#fef2f2", borderRadius: 6, border: "1px solid #fca5a5", marginBottom: 10 }}>
          ⚠ {error}
        </div>
      )}

      {!imgSrc && !busy && !error && (
        <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 12,
          padding: "40px 0", border: "1px dashed #e2e8f0", borderRadius: 6 }}>
          Run power flow to generate heatmap
        </div>
      )}

      {imgSrc && (
        <img src={imgSrc} alt="Voltage heatmap"
          style={{ width: "100%", borderRadius: 6, display: "block",
            opacity: busy ? 0.4 : 1, transition: "opacity 0.15s" }} />
      )}

      {voltages?.length === 13 && (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 5 }}>
          {voltages.map((v, i) => {
            const isDC = dataCenterBus === i + 1;
            return (
              <div key={i} style={{
                fontSize: 10, fontWeight: 700, padding: "3px 7px", borderRadius: 4,
                background: isDC ? '#0891b2' : v < 0.95 ? "#fef2f2" : v > 1.05 ? "#fffbeb" : "#f0fdf4",
                color:      isDC ? '#fff'     : v < 0.95 ? "#ef4444" : v > 1.05 ? "#f59e0b" : "#16a34a",
                border: `2px solid ${isDC ? '#0891b2' : v < 0.95 ? "#fca5a5" : v > 1.05 ? "#fde68a" : "#bbf7d0"}`,
              }}>
               B{i+1}: {v.toFixed(3)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}