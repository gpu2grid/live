import React, { useEffect, useMemo, useState } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList,
} from 'recharts';
import { API_URL } from './api';
import { CollapsibleCard } from './CollabsibleCard';



const MODE_COLOR: Record<string, string> = { baseline: '#64748b', ofo: '#0d9488', ppo: '#4f46e5' };
const MODE_NAME: Record<string, string>  = { baseline: 'Baseline', ofo: 'OFO', ppo: 'PPO' };
const MODES = ['baseline', 'ofo', 'ppo'];
const RING_R: Record<string, number> = { baseline: 11, ofo: 15, ppo: 19 };
const LABEL_DY: Record<string, number> = { baseline: 26, ofo: 40, ppo: 54 };
const PALETTE = ['#4682b4', '#c0392b', '#2e9e44', '#e08a2c', '#8e6bbf'];

interface CurvePoint {
  batch: number;
  power_kW: number;          // total datacenter power (GPU + base load)
  gpu_power_kW: number;      // GPUs only
  throughput_tok_s: number;
  itl_ms: number | null;     // optional: backend may not send latency
}
interface TraceModel { modelLabel: string; numGpus: number }

const firstVal = (rec?: Record<string, number>): number | undefined =>
  rec ? Object.values(rec)[0] : undefined;
const hw = (label: string) => (/-B200$/i.test(label) ? 'B200' : 'H100');
const pretty = (m: TraceModel) => `${m.modelLabel.replace(/-(H100|B200)$/i, '')} · ${hw(m.modelLabel)} · ${m.numGpus} GPU${m.numGpus > 1 ? 's' : ''}/replica`;


function normalisePoints(rawPoints: any[], baseKw: number): CurvePoint[] {
  return (rawPoints ?? [])
    .map((p: any): CurvePoint => {
      const gpuKw: number | null = p.gpuPowerKW ?? p.gpu_power_kW ?? null;
      const totalKw: number | null =
        p.totalPowerMW != null ? p.totalPowerMW * 1000
        : p.power_kW != null ? p.power_kW
        : gpuKw != null ? gpuKw + baseKw
        : null;
      return {
        batch: p.batchSize ?? p.batch,
        power_kW: totalKw as number,
        gpu_power_kW: gpuKw as number,
        throughput_tok_s: (p.throughputTokensS ?? p.throughput_tok_s) as number,
        itl_ms: p.itlMs ?? p.itl_ms ?? null,
      };
    })
    // The backend sends null when it can't compute a value; drop those so they don't become NaN.
    .filter(p =>
      p.batch != null &&
      Number.isFinite(p.gpu_power_kW) && Number.isFinite(p.power_kW) &&
      Number.isFinite(p.throughput_tok_s))
    .sort((a, b) => a.batch - b.batch);
}

export default function PowerThroughputCurve({
  runs, activeMode, modelLabel, numReplicas, snapTime, itlDeadlineMs, baseKwPerPhase = 500,
}: {
  runs: Record<string, any>;        
  activeMode: string;
  modelLabel: string;
  numReplicas: number;
  snapTime?: number;
  itlDeadlineMs: number;
  baseKwPerPhase?: number;           
}) {
  const reps = Math.max(1, numReplicas);
  const [includeBase, setIncludeBase] = useState(true);
  const [extra, setExtra] = useState<string[]>([]);
  const [models, setModels] = useState<TraceModel[]>([]);
  const [curves, setCurves] = useState<Record<string, { points: CurvePoint[]; baseKw: number }>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {  
    fetch(`${API_URL}/api/traces`).then(r => r.json()).then(res => setModels(res.models ?? [])).catch(() => {});
  }, []);

  const labels = useMemo(() => [modelLabel, ...extra.filter(l => l !== modelLabel)], [modelLabel, extra]);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all(labels.map(l => {
      const q = new URLSearchParams({ modelLabel: l, numReplicas: String(reps), baseKwPerPhase: String(baseKwPerPhase) });
      return fetch(`${API_URL}/api/power-throughput?${q}`, { signal: ctrl.signal })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404
          ? `HTTP 404 — no /api/power-throughput endpoint or no traces for ${l}` : `HTTP ${r.status}`))))
        .then(res => {
          const baseKw: number = res.baseLoadKW ?? res.baseKw ?? 3 * baseKwPerPhase;
          return [l, { points: normalisePoints(res.points, baseKw), baseKw }] as const;
        });
    }))
      .then(entries => { setCurves(Object.fromEntries(entries)); setErr(null); })
      .catch(e => { if (e.name !== 'AbortError') setErr(String(e.message ?? e)); });
    return () => ctrl.abort();
  }, [labels, reps, baseKwPerPhase]);

  const series = useMemo(() => labels.filter(l => curves[l]).map((l, i) => ({
    label: l, color: PALETTE[i % PALETTE.length], main: i === 0,
    data: curves[l].points.map(p => ({
      batch: p.batch, name: l,
      mw: (includeBase ? p.power_kW : p.gpu_power_kW) / 1000,
      tok: p.throughput_tok_s,
      itl: p.itl_ms,
      itlBad: p.itl_ms != null && p.itl_ms > itlDeadlineMs,
    })),
  })), [labels, curves, includeBase, itlDeadlineMs]);
  const main = series[0];

  // Where each run's batch size sits on the MAIN curve at the scrubber time.
  const markers = useMemo(() => {
    if (!main || !main.data.length) return [];
    return MODES.filter(m => runs[m]).map(m => {
      const ts = runs[m].timeSeries as any[];
      if (!ts.length) return null;
      const t = snapTime ?? ts[ts.length - 1].time;
      const tick = ts.reduce((b, s) => (Math.abs(s.time - t) < Math.abs(b.time - t) ? s : b), ts[0]);
      const batch = tick.batch_by_model?.[modelLabel] ?? firstVal(tick.batch_by_model);
      if (batch == null) return null;
      const pt = main.data.reduce((b, p) => (Math.abs(p.batch - batch) < Math.abs(b.batch - batch) ? p : b), main.data[0]);
      // batch sequence this run went through, e.g. 128 → 256 → 512
      const seq: number[] = [];
      ts.forEach(s => { const b = s.batch_by_model?.[modelLabel] ?? firstVal(s.batch_by_model); if (b != null && seq[seq.length - 1] !== b) seq.push(b); });
      return { mode: m, name: MODE_NAME[m], ...pt, runBatch: batch, seq };
    }).filter(Boolean) as any[];
  }, [runs, main, snapTime, modelLabel]);

  // Axis scaling
  const all = [...series.flatMap(s => s.data)];
  const xs = all.map(p => p.mw), ys = all.map(p => p.tok);
  const spanMW = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const xDec = Math.min(5, Math.max(2, Math.ceil(-Math.log10(Math.max(spanMW, 1e-5) / 5))));
  const xDomain: [number, number] = xs.length
    ? [Math.min(...xs) - Math.max(spanMW * 0.08, 1e-4), Math.max(...xs) + Math.max(spanMW * 0.08, 1e-4)] : [0, 1];
  const maxTok = ys.length ? Math.max(...ys) : 0;
  const [yDiv, yUnit] = maxTok >= 5e5 ? [1e6, 'M tok/s'] : maxTok >= 2e3 ? [1e3, 'K tok/s'] : [1, 'tok/s'];
  const fmtY = (v: number) => { const u = v / yDiv; return u >= 100 ? u.toFixed(0) : u >= 1 ? u.toFixed(1) : u.toFixed(2); };

  // One-line takeaway: active run vs baseline
  const insight = useMemo(() => {
    const a = markers.find(m => m.mode === activeMode), b = markers.find(m => m.mode === 'baseline');
    if (!a || !b || a.mode === 'baseline' || a.batch === b.batch) return null;
    const dP = a.mw - b.mw, dPpct = (dP / b.mw) * 100, dT = ((a.tok - b.tok) / b.tok) * 100;
    return { a, b, dP, dPpct, dT };
  }, [markers, activeMode]);

  const Tip: React.FC<any> = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '8px 12px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        <div style={{ fontWeight: 800, marginBottom: 2 }}>{d.name}: batch {d.batch}</div>
        <div>Power: {Number(d.mw).toFixed(4)} MW</div>
        <div>Throughput: {fmtY(d.tok)} {yUnit}</div>
        {d.itl != null && <div style={{ color: d.itlBad ? '#dc2626' : '#64748b' }}>Latency (fitted): {Number(d.itl).toFixed(0)} ms</div>}
      </div>
    );
  };

  const addable = models.filter(m => !labels.includes(m.modelLabel));
  const hasLatency = all.some(p => p.itl != null);
  const noData = !err && labels.every(l => curves[l]) && all.length === 0;

  return (
    <CollapsibleCard
      title="Power vs Throughput — batch size effect"
      defaultOpen
    >
      <div className="ptc" style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '16px 20px' }}>
        <style>{`.ptc *:focus, .ptc .recharts-wrapper, .ptc .recharts-surface { outline: none !important; }`}</style>
        {err && <div style={{ fontSize: 11, color: '#dc2626', marginBottom: 8 }}>Couldn't load curve: {err}</div>}
        {noData && (
          <div style={{ fontSize: 11, color: '#b45309', marginBottom: 8 }}>
            The server returned no usable points for this model (missing trace files or logistic fit).
          </div>
        )}

        {/* takeaway */}
        {insight && (
          <div style={{ fontSize: 12, color: '#0f172a', marginBottom: 8 }}>
            <strong style={{ color: MODE_COLOR[activeMode] }}>{insight.a.name}</strong> at batch <strong>{insight.a.runBatch}</strong> vs{' '}
            <strong>Baseline</strong> at batch <strong>{insight.b.runBatch}</strong>:{' '}
            {insight.dP >= 0 ? '+' : ''}{insight.dP.toFixed(4)} MW ({insight.dPpct >= 0 ? '+' : ''}{insight.dPpct.toFixed(1)}% power),{' '}
            {insight.dT >= 0 ? '+' : ''}{insight.dT.toFixed(0)}% throughput
            {insight.a.itl != null && insight.b.itl != null
              ? `, latency ${Number(insight.b.itl).toFixed(0)} → ${Number(insight.a.itl).toFixed(0)} ms`
              : ''}.
          </div>
        )}

        {/* controls */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center', fontSize: 11, color: '#475569', marginBottom: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontWeight: 700 }}>
            <input type="checkbox" checked={includeBase} onChange={e => setIncludeBase(e.target.checked)} /> Include base load
          </label>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 700 }}>Compare with another model:</span>
            <select value="" onChange={e => { if (e.target.value) setExtra(x => [...x, e.target.value].slice(0, 4)); }}
              style={{ fontSize: 11, border: '1px solid #cbd5e1', borderRadius: 5, padding: '3px 6px', maxWidth: 260 }}>
              <option value="">add…</option>
              {addable.map(m => <option key={m.modelLabel} value={m.modelLabel}>{pretty(m)}</option>)}
            </select>
          </span>
        </div>

        {/* legend (curves) */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 11, marginBottom: 4 }}>
          {series.map(s => (
            <span key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: '#0f172a' }}>
              <span style={{ width: 20, height: 3, background: s.color, display: 'inline-block', borderRadius: 2 }} />
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, border: '1px solid #111', display: 'inline-block', marginLeft: -16 }} />
              <span style={{ marginLeft: 8 }}>{(models.find(m => m.modelLabel === s.label) ? pretty(models.find(m => m.modelLabel === s.label)!) : s.label)}</span>
              {!s.main && (
                <button type="button" onClick={() => setExtra(x => x.filter(l => l !== s.label))}
                  style={{ border: 'none', background: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 13, padding: 0 }} title="remove">×</button>
              )}
            </span>
          ))}
        </div>

        <div style={{ height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 22, right: 30, bottom: 32, left: 8 }} style={{ outline: 'none' }}>
              <CartesianGrid stroke="#eceff3" />
              <XAxis type="number" dataKey="mw" domain={xDomain} allowDataOverflow tickCount={6} tick={{ fontSize: 11, fill: '#111' }}
                stroke="#111" tickFormatter={(v: number) => v.toFixed(xDec)}
                label={{ value: `Datacenter power (MW)${includeBase ? '' : ' — GPUs only'}`, position: 'insideBottom', offset: -20, fontSize: 12, fill: '#111' }} />
              <YAxis type="number" dataKey="tok" domain={[0, maxTok * 1.14 || 1]} allowDataOverflow tickCount={6} tick={{ fontSize: 11, fill: '#111' }}
                stroke="#111" width={50} tickFormatter={(v: number) => fmtY(v)}
                label={{ value: `Token throughput (${yUnit})`, angle: -90, position: 'insideLeft', offset: 8, fontSize: 12, fill: '#111' }} />
              <Tooltip content={<Tip />} cursor={false} />

              {[...series].reverse().map(s => (
                <Scatter key={s.label} data={s.data} fill={s.color} line={{ stroke: s.color, strokeWidth: 3 }}
                  isAnimationActive={false}
                  shape={(p: any) => (
                    <circle cx={p.cx} cy={p.cy} r={s.main ? 7 : 5.5} fill={s.color}
                      stroke={p.payload.itlBad ? '#ef4444' : '#111'} strokeWidth={p.payload.itlBad ? 2.8 : 0.8} />
                  )}>
                  {s.main && <LabelList dataKey="batch" position="top" offset={12} style={{ fontSize: 11, fontWeight: 800, fill: '#1e293b' }} />}
                </Scatter>
              ))}

              {/* controller markers, snapped onto the main curve */}
              {markers.map(m => (
                <Scatter key={m.mode} data={[m]} fill={MODE_COLOR[m.mode]} isAnimationActive={false}
                  shape={(p: any) => <circle cx={p.cx} cy={p.cy} r={RING_R[m.mode]} fill="none" stroke={MODE_COLOR[m.mode]} strokeWidth={3} />}>
                  <LabelList dataKey="name" content={(lp: any) => (
                    <text x={lp.x} y={lp.y + LABEL_DY[m.mode]} textAnchor="middle" fontSize={11} fontWeight={800} fill={MODE_COLOR[m.mode]}>
                      {m.name}: batch {m.runBatch}
                    </text>
                  )} />
                </Scatter>
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: 10.5, color: '#64748b', marginTop: 6 }}>
          {hasLatency && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2.5px solid #ef4444', display: 'inline-block' }} />
              fitted latency above your {Math.round(itlDeadlineMs)} ms target
            </span>
          )}
        </div>
      </div>
    </CollapsibleCard>
  );
}