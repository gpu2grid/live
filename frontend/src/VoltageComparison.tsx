import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Papa from 'papaparse';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';
import { Upload, CheckCircle2, AlertTriangle, RotateCcw, RefreshCw } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SeriesPoint { t: number; v: number | null; }

interface ParsedRun {
  fileName: string;
  buses: string[];              
  seriesByBus: Record<string, SeriesPoint[]>;
  rowCount: number;
  durationS: number;
}

interface MergedPoint { t: number; baseline: number | null; ofo: number | null; }

interface RunStats {
  total: number; under: number; over: number;
  violPct: number; minV: number; maxV: number; worst: number;
}

interface AggregateStats {
  totalSamples: number; totalViol: number; violPct: number;
  worstV: number; busesViolated: number; totalBuses: number;
}

type RunKind = 'baseline' | 'ofo';
type Topology = 'ieee13' | 'ieee34' | 'ieee123';

const RUN_KINDS: RunKind[] = ['baseline', 'ofo'];

const VMIN = 0.95, VMAX = 1.05;
const BASELINE_COLOR = '#94a3b8';
const OFO_COLOR = '#0d9488';

const RUN_META: Record<RunKind, { label: string; color: string; bg: string }> = {
  baseline: { label: 'Baseline (no control)',    color: BASELINE_COLOR, bg: '#f8fafc' },
  ofo:      { label: 'OFO (tap control active)', color: OFO_COLOR,      bg: '#f0fdfa' },
};

const TOPOLOGY_OPTIONS: { value: Topology; label: string }[] = [
  { value: 'ieee13', label: 'IEEE 13-Bus' },
  { value: 'ieee34', label: 'IEEE 34-Bus' },
  { value: 'ieee123', label: 'IEEE 123-Bus' },
];

const safeFixed = (v: number | null | undefined, digits = 4, fallback = '—') =>
  v != null && isFinite(v) ? v.toFixed(digits) : fallback;



function defaultCsvPath(topology: Topology, kind: RunKind, basePath: string): string {



  const runFolder = `${kind}_tap-change`;
  const fileName = `voltage_trace_${kind}_tap-change.csv`;
  return `${basePath}/outputs/${topology}/${runFolder}/${fileName}`;
}



function parseCsvSource(source: File | string): Promise<ParsedRun> {
  return new Promise((resolve, reject) => {
    const isUrl = typeof source === 'string';
    Papa.parse(source as any, {
      header: true,
      skipEmptyLines: true,
      download: isUrl,
      complete: (result) => {
        try {
          const fields = (result.meta.fields ?? []) as string[];
          const timeField = fields.find(f => /(^|_)time_s$/i.test(f)) ?? fields[0];

          const buses: string[] = [];
          for (const f of fields) {
            const m = f.match(/^(.+)_min$/);
            if (m && !buses.includes(m[1])) buses.push(m[1]);
          }
          if (!buses.length) {
            reject(new Error('No "*_min" bus columns found in this CSV — check the export snippet.'));
            return;
          }

          const seriesByBus: Record<string, SeriesPoint[]> = {};
          buses.forEach(b => { seriesByBus[b] = []; });

          const rows = result.data as Record<string, string>[];
          let maxT = 0;
          for (const row of rows) {
            const t = parseFloat(row[timeField]);
            if (!isFinite(t)) continue;
            if (t > maxT) maxT = t;
            for (const b of buses) {
              const raw = row[`${b}_min`];
              const v = raw === undefined || raw === '' ? null : parseFloat(raw);
              seriesByBus[b].push({ t, v: (v != null && isFinite(v)) ? v : null });
            }
          }

          const fileName = isUrl ? (source as string).split('/').pop() ?? (source as string) : (source as File).name;
          resolve({ fileName: fileName!, buses, seriesByBus, rowCount: rows.length, durationS: maxT });
        } catch (e) {
          reject(e as Error);
        }
      },
      error: (err: any) => reject(err instanceof Error ? err : new Error(String(err))),
    });
  });
}

// ─── Stats helpers ──────────────────────────────────────────────────────────

function computeBusStats(run: ParsedRun | null, bus: string | null): RunStats | null {
  if (!run || !bus || !run.seriesByBus[bus]) return null;
  const vals = run.seriesByBus[bus].map(p => p.v).filter((v): v is number => v != null);
  if (!vals.length) return null;
  const under = vals.filter(v => v < VMIN).length;
  const over = vals.filter(v => v > VMAX).length;
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const worst = Math.abs(minV - 1) >= Math.abs(maxV - 1) ? minV : maxV;
  return { total: vals.length, under, over, violPct: ((under + over) / vals.length) * 100, minV, maxV, worst };
}

function computeAggregateStats(run: ParsedRun | null): AggregateStats | null {
  if (!run) return null;
  let totalSamples = 0, totalViol = 0, busesViolated = 0, worstDev = 0, worstV = 1.0;
  for (const bus of run.buses) {
    const vals = run.seriesByBus[bus].map(p => p.v).filter((v): v is number => v != null);
    if (!vals.length) continue;
    let busHasViol = false;
    for (const v of vals) {
      totalSamples++;
      if (v < VMIN || v > VMAX) { totalViol++; busHasViol = true; }
      const dev = Math.abs(v - 1);
      if (dev > worstDev) { worstDev = dev; worstV = v; }
    }
    if (busHasViol) busesViolated++;
  }
  return {
    totalSamples, totalViol,
    violPct: totalSamples ? (totalViol / totalSamples) * 100 : 0,
    worstV, busesViolated, totalBuses: run.buses.length,
  };
}

// ─── Tooltips ───────────────────────────────────────────────────────────────

const OverlayTooltip: React.FC<any> = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as MergedPoint;
  const present = RUN_KINDS.filter(k => (d as any)[k] != null);
  return (
    <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '8px 12px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>t = {safeFixed(d.t, 2)}s</div>
      {present.map(k => (
        <div key={k} style={{ color: RUN_META[k].color, fontWeight: 700 }}>
          {RUN_META[k].label}: {safeFixed((d as any)[k], 4)} p.u.
        </div>
      ))}
    </div>
  );
};

// ─── Status card (auto-load status, with manual-override fallback) ─────────

function RunStatusCard({
  kind, run, loading, error, onManualFile, onRetry,
}: {
  kind: RunKind; run: ParsedRun | null; loading: boolean; error: string | null;
  onManualFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRetry: () => void;
}) {
  const meta = RUN_META[kind];
  const accent = meta.color;
  const label = meta.label;
  const inputId = `vc-file-${kind}`;

  return (
    <div style={{
      flex: 1, minWidth: 260, background: run ? `${accent}0d` : '#f8fafc',
      border: `2px solid ${error ? '#fca5a5' : run ? accent : '#e2e8f0'}`,
      borderRadius: 8, padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 800, fontSize: 12, color: accent }}>{label}</span>
        {run && !loading && <CheckCircle2 size={16} color={accent} />}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 10px',
        background: '#fff', fontSize: 11, color: '#64748b',
      }}>
        {loading ? (
          <>
            <RefreshCw size={14} className="vc-spin" />
            Loading trace…
          </>
        ) : run ? (
          <>
            <CheckCircle2 size={14} color={accent} />
            {run.fileName}
          </>
        ) : (
          <>
            <AlertTriangle size={14} color="#dc2626" />
            Not loaded
          </>
        )}
      </div>

      {run && !loading && (
        <div style={{ marginTop: 6, fontSize: 10, color: '#64748b' }}>
          {run.rowCount} rows · {run.buses.length} buses · {safeFixed(run.durationS, 0)}s of trace
        </div>
      )}

      {error && !loading && (
        <div style={{ marginTop: 6, display: 'flex', gap: 4, alignItems: 'flex-start', fontSize: 10, color: '#dc2626' }}>
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} /> {error}
        </div>
      )}

      <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={onRetry} disabled={loading} style={{
          display: 'flex', alignItems: 'center', gap: 4, border: '1px solid #cbd5e1', background: '#fff',
          borderRadius: 6, padding: '4px 8px', fontSize: 10, fontWeight: 700, color: '#64748b',
          cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1,
        }}>
          <RotateCcw size={11} /> Retry
        </button>
        <label htmlFor={inputId} style={{
          display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 10, fontWeight: 700, color: '#64748b',
        }}>
          <Upload size={11} /> Use a different file…
        </label>
        <input id={inputId} type="file" accept=".csv" onChange={onManualFile} style={{ display: 'none' }} />
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

interface Props {
  topology?: Topology;
  onTopologyChange?: (t: Topology) => void;
  showTopologySwitcher?: boolean;
  dataBasePath?: string;
  csvPathBuilder?: (topology: Topology, kind: RunKind, basePath: string) => string;
}

export default function VoltageComparison({
  topology: topologyProp,
  onTopologyChange,
  showTopologySwitcher = true,
  dataBasePath = `${import.meta.env.BASE_URL}voltage-traces`,
  csvPathBuilder = defaultCsvPath,
}: Props) {
  const [topologyState, setTopologyState] = useState<Topology>(topologyProp ?? 'ieee13');
  const topology = topologyProp ?? topologyState;
  const setTopology = (t: Topology) => {
    if (onTopologyChange) onTopologyChange(t); else setTopologyState(t);
  };

  const [runs, setRuns] = useState<Record<RunKind, ParsedRun | null>>({ baseline: null, ofo: null });
  const [loadingByKind, setLoadingByKind] = useState<Record<RunKind, boolean>>({ baseline: false, ofo: false });
  const [errByKind, setErrByKind] = useState<Record<RunKind, string | null>>({ baseline: null, ofo: null });
  const [selectedBus, setSelectedBus] = useState<string | null>(null);

  // A bump counter lets the "Reload traces" button re-trigger the auto-load effect.
  const [retryTick, setRetryTick] = useState(0);

  const loadOne = useCallback((kind: RunKind) => {
    const url = csvPathBuilder(topology, kind, dataBasePath);
    setLoadingByKind(prev => ({ ...prev, [kind]: true }));
    setErrByKind(prev => ({ ...prev, [kind]: null }));
    parseCsvSource(url)
      .then(run => setRuns(prev => ({ ...prev, [kind]: run })))
      .catch((err: Error) => {
        setErrByKind(prev => ({ ...prev, [kind]: `Couldn't auto-load ${url} (${err.message}). Upload it manually below.` }));
        setRuns(prev => ({ ...prev, [kind]: null }));
      })
      .finally(() => setLoadingByKind(prev => ({ ...prev, [kind]: false })));
  }, [topology, dataBasePath, csvPathBuilder]);

  // Auto-load both traces whenever topology changes (or retry is clicked).
  useEffect(() => {
    setSelectedBus(null);
    RUN_KINDS.forEach(loadOne);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology, retryTick]);

  const handleManualFile = (kind: RunKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoadingByKind(prev => ({ ...prev, [kind]: true }));
    setErrByKind(prev => ({ ...prev, [kind]: null }));
    parseCsvSource(file)
      .then(run => setRuns(prev => ({ ...prev, [kind]: run })))
      .catch((err: Error) => {
        setErrByKind(prev => ({ ...prev, [kind]: err.message }));
        setRuns(prev => ({ ...prev, [kind]: null }));
      })
      .finally(() => { setLoadingByKind(prev => ({ ...prev, [kind]: false })); e.target.value = ''; });
  };

  const buses = useMemo(() => {
    const set = new Set<string>();
    RUN_KINDS.forEach(k => runs[k]?.buses.forEach(b => set.add(b)));
    return Array.from(set);
  }, [runs]);

  useEffect(() => {
    if (buses.length && (!selectedBus || !buses.includes(selectedBus))) {
      setSelectedBus(buses[0]);
    }
  }, [buses]); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge baseline + OFO into one time-aligned array per bus, keyed on t
  // (rounded to guard against float noise from independent solver runs).
  const mergedByBus = useMemo(() => {
    const out: Record<string, MergedPoint[]> = {};
    for (const bus of buses) {
      const map = new Map<number, MergedPoint>();
      const key = (t: number) => Math.round(t * 1000);
      RUN_KINDS.forEach(kind => {
        runs[kind]?.seriesByBus[bus]?.forEach(p => {
          const k = key(p.t);
          const entry = map.get(k) ?? { t: p.t, baseline: null, ofo: null };
          entry[kind] = p.v;
          map.set(k, entry);
        });
      });
      out[bus] = Array.from(map.values()).sort((a, b) => a.t - b.t);
    }
    return out;
  }, [buses, runs]);

  const bigSeries = selectedBus ? (mergedByBus[selectedBus] ?? []) : [];

  const busStatsByKind = useMemo(() => {
    const out = {} as Record<RunKind, RunStats | null>;
    RUN_KINDS.forEach(k => { out[k] = computeBusStats(runs[k], selectedBus); });
    return out;
  }, [runs, selectedBus]);

  const aggByKind = useMemo(() => {
    const out = {} as Record<RunKind, AggregateStats | null>;
    RUN_KINDS.forEach(k => { out[k] = computeAggregateStats(runs[k]); });
    return out;
  }, [runs]);

  const maxDuration = Math.max(...RUN_KINDS.map(k => runs[k]?.durationS ?? 0));
  const showShortTraceHint = RUN_KINDS.some(k => runs[k]) && maxDuration > 0 && maxDuration < 900;

  const allLoaded = RUN_KINDS.every(k => !!runs[k]);
  const anyLoading = RUN_KINDS.some(k => loadingByKind[k]);
  const numBuses = buses.length;
  const gridCols = numBuses > 100 ? 'repeat(auto-fill, minmax(110px, 1fr))'
    : numBuses > 34 ? 'repeat(auto-fill, minmax(140px, 1fr))'
    : 'repeat(auto-fill, minmax(170px, 1fr))';

  return (
    <div style={{ background: '#ffffff', color: '#0f172a', fontSize: 12 }}>
      <style>{`@keyframes vc-spin { to { transform: rotate(360deg); } } .vc-spin { animation: vc-spin 0.9s linear infinite; }`}</style>

      {/* Header / topology switcher / auto-load status */}
      <div style={{ borderBottom: '1px solid #e2e8f0', background: '#f8fafc', padding: '16px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>SEE IT FOR YOURSELF</div>

          {showTopologySwitcher && (
            <div style={{ display: 'flex', gap: 6, marginLeft: 4 }}>
              {TOPOLOGY_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setTopology(opt.value)}
                  style={{
                    background: topology === opt.value ? '#0891b2' : '#fff',
                    color: topology === opt.value ? '#fff' : '#64748b',
                    border: `2px solid ${topology === opt.value ? '#0891b2' : '#e2e8f0'}`,
                    borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          <button onClick={() => setRetryTick(n => n + 1)} disabled={anyLoading} style={{
            marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #cbd5e1',
            background: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 11, fontWeight: 700,
            color: '#64748b', cursor: anyLoading ? 'default' : 'pointer', opacity: anyLoading ? 0.6 : 1,
          }}>
            <RefreshCw size={12} className={anyLoading ? 'vc-spin' : undefined} /> {anyLoading ? 'Loading…' : 'Reload traces'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {RUN_KINDS.map(kind => (
            <RunStatusCard
              key={kind}
              kind={kind}
              run={runs[kind]}
              loading={loadingByKind[kind]}
              error={errByKind[kind]}
              onManualFile={handleManualFile(kind)}
              onRetry={() => loadOne(kind)}
            />
          ))}
        </div>
      </div>

      {!allLoaded && (
        <div style={{ padding: '60px 24px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
          {anyLoading
            ? `Loading baseline & OFO traces for ${topology.toUpperCase()}…`
            : `Couldn't auto-load both traces for ${topology.toUpperCase()} — check the status cards above.`}
        </div>
      )}

      {allLoaded && (
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {showShortTraceHint && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', display: 'flex', gap: 8, fontSize: 11, color: '#92400e' }}>
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                This trace only runs to t≈{safeFixed(maxDuration, 0)}s. Baseline and OFO are expected to look
                nearly identical until the disturbances kick in — training load around t=1000s and the inference
                ramp-down around t=2500s. Load the full 3600s export to see the divergence.
              </span>
            </div>
          )}

          {/* Bus selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: '#64748b' }}>BUS:</span>
            <select value={selectedBus ?? ''} onChange={e => setSelectedBus(e.target.value)} style={{ background: '#ecfeff', border: '2px solid #0891b2', borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer', fontWeight: 700, color: '#0891b2' }}>
              {buses.map(b => <option key={b} value={b}>{b.toUpperCase()}</option>)}
            </select>
          </div>

          {/* Big overlay chart */}
          <div style={{ background: '#f8fafc', border: '2px solid #0891b2', borderRadius: 8, padding: '16px 20px' }}>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 12 }}>
              Bus {selectedBus?.toUpperCase()} — Baseline vs. OFO
            </div>
            <div style={{ height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={bigSeries} margin={{ top: 4, right: 24, bottom: 4, left: 4 }}>
                  <XAxis dataKey="t" type="number" stroke="#94a3b8" tick={{ fontSize: 10 }} tickFormatter={v => `${v}s`} domain={['dataMin', 'dataMax']} />
                  <YAxis stroke="#94a3b8" tick={{ fontSize: 10 }} domain={[dataMin => Math.min(0.93, dataMin - 0.005), dataMax => Math.max(1.07, dataMax + 0.005)]} tickFormatter={v => v.toFixed(3)} />
                  <Tooltip content={<OverlayTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={0.95} stroke="#ef4444" strokeDasharray="5 3" strokeWidth={1.5} label={{ value: '0.95', position: 'insideBottomLeft', fontSize: 9, fill: '#ef4444' }} />
                  <ReferenceLine y={1.05} stroke="#f59e0b" strokeDasharray="5 3" strokeWidth={1.5} label={{ value: '1.05', position: 'insideTopLeft', fontSize: 9, fill: '#f59e0b' }} />
                  <ReferenceLine y={1.0} stroke="#e2e8f0" strokeWidth={1} />
                  <Line type="monotone" dataKey="baseline" name={RUN_META.baseline.label} stroke={BASELINE_COLOR} strokeWidth={1.75} dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="ofo" name={RUN_META.ofo.label} stroke={OFO_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Live-computed violation stats */}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${RUN_KINDS.length}, 1fr)`, gap: 14 }}>
            {RUN_KINDS.map(kind => {
              const meta = RUN_META[kind];
              const stats = busStatsByKind[kind];
              return (
                <div key={kind} style={{ background: meta.bg, border: `2px solid ${meta.color}`, borderRadius: 8, padding: '14px 18px' }}>
                  <div style={{ fontWeight: 800, fontSize: 12, color: meta.color, marginBottom: 8 }}>{meta.label} — Bus {selectedBus?.toUpperCase()}</div>
                  {stats ? (
                    <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>VIOLATION RATE</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: stats.violPct > 0 ? '#ef4444' : '#16a34a' }}>{safeFixed(stats.violPct, 1)}%</div>
                        <div style={{ fontSize: 9, color: '#94a3b8' }}>{stats.under + stats.over} / {stats.total} steps</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>WORST VOLTAGE</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: Math.abs(stats.worst - 1) > 0.05 ? '#ef4444' : '#0f172a' }}>{safeFixed(stats.worst, 4)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>RANGE</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>{safeFixed(stats.minV, 4)} – {safeFixed(stats.maxV, 4)}</div>
                      </div>
                    </div>
                  ) : <div style={{ fontSize: 11, color: '#94a3b8' }}>No data for this bus.</div>}
                </div>
              );
            })}
          </div>

          {/* System-wide summary */}
          {RUN_KINDS.every(k => !!aggByKind[k]) && (
            <div style={{ background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 8, padding: '12px 18px', display: 'flex', gap: 28, flexWrap: 'wrap', fontSize: 11, color: '#6d28d9' }}>
              <div>All-bus violation rate — {RUN_KINDS.map(k => `${RUN_META[k].label.split(' ')[0]}: ${safeFixed(aggByKind[k]!.violPct, 1)}%`).join(' · ')}</div>
              <div>Buses with ≥1 violation — {RUN_KINDS.map(k => `${RUN_META[k].label.split(' ')[0]}: ${aggByKind[k]!.busesViolated}/${aggByKind[k]!.totalBuses}`).join(' · ')}</div>
              <div>Worst voltage seen — {RUN_KINDS.map(k => `${RUN_META[k].label.split(' ')[0]}: ${safeFixed(aggByKind[k]!.worstV, 4)}`).join(' · ')}</div>
            </div>
          )}

          {/* Small multiples grid */}
          <div>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 10 }}>Every Bus — click a panel to inspect it above</div>
            <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 10 }}>
              {buses.map(bus => {
                const series = mergedByBus[bus] ?? [];
                const statsByKind = RUN_KINDS.reduce((acc, k) => {
                  acc[k] = computeBusStats(runs[k], bus);
                  return acc;
                }, {} as Record<RunKind, RunStats | null>);
                const isSelected = bus === selectedBus;
                const hasViol = RUN_KINDS.some(k => (statsByKind[k]?.violPct ?? 0) > 0);
                return (
                  <div key={bus} onClick={() => setSelectedBus(bus)} style={{
                    cursor: 'pointer',
                    background: isSelected ? '#ecfeff' : hasViol ? '#fef2f2' : '#ffffff',
                    border: `2px solid ${isSelected ? '#0891b2' : hasViol ? '#fca5a5' : '#e2e8f0'}`,
                    borderRadius: 8, padding: 8,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontWeight: 800, fontSize: numBuses > 34 ? 10 : 12, color: isSelected ? '#0891b2' : '#0f172a' }}>{bus.toUpperCase()}</span>
                    </div>
                    <div style={{ height: numBuses > 34 ? 50 : 70 }}>
                      <ResponsiveContainer width="100%" height="100%" minHeight={40}>
                        <LineChart data={series} margin={{ top: 2, right: 2, bottom: 0, left: 0 }}>
                          <XAxis dataKey="t" type="number" hide domain={['dataMin', 'dataMax']} />
                          <YAxis hide domain={[dataMin => Math.min(0.93, dataMin - 0.005), dataMax => Math.max(1.07, dataMax + 0.005)]} />
                          <ReferenceLine y={0.95} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
                          <ReferenceLine y={1.05} stroke="#f59e0b" strokeDasharray="3 3" strokeWidth={1} />
                          <Line type="monotone" dataKey="baseline" stroke={BASELINE_COLOR} strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
                          <Line type="monotone" dataKey="ofo" stroke={OFO_COLOR} strokeWidth={1.25} dot={false} isAnimationActive={false} connectNulls />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, marginTop: 3 }}>
                      <span style={{ color: BASELINE_COLOR, fontWeight: 700 }}>B {safeFixed(statsByKind.baseline?.violPct, 0)}%</span>
                      <span style={{ color: OFO_COLOR, fontWeight: 700 }}>O {safeFixed(statsByKind.ofo?.violPct, 0)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}