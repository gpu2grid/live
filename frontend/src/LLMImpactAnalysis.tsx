import React, { useState, useMemo, useEffect } from 'react';
import { Play, Pause, Cpu, ChevronLeft, ChevronRight, RotateCcw, AlertCircle, AlertTriangle, BookOpen, Filter } from 'lucide-react';
import { API_URL } from './api';
import { CollapsibleCard } from './CollabsibleCard';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Cell, Legend
} from 'recharts';

import TourOverlay from './TourOverlay';
import { useTour, TOUR_STORAGE_KEY } from './useTour';
import PowerThroughputCurve from './PowerThroughputCurve';



const fmt = (n: number | undefined | null, digits = 2, fallback = '—') =>
  n != null && isFinite(n) ? n.toFixed(digits) : fallback;


const PHANTOM_BUSES = new Set([
  'rg60','814r','852r','150r','9r','25r','160r','61s','sourcebus','670',
]);

// When true the backend runs the paper's IEEE-13 scenario (PAPER_MODE=1 on the server).
const PAPER_MODE = true;
const pickDefaultBatch = (batches: number[]) =>
  PAPER_MODE ? Math.max(...batches) : (batches.includes(128) ? 128 : batches[Math.floor(batches.length / 2)]);

const BASELINE_COLOR = '#94a3b8';
const LOAD_COLOR = '#0891b2';
const OFO_COLOR = '#0d9488';
const PPO_COLOR = '#4f46e5';


const DEFAULT_SUBSTATION_VOLTAGE = 1.0;



const UI = {
  radius: 10,
  radiusSm: 7,
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  shadow: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 1px rgba(15, 23, 42, 0.03)',
  textMuted: '#64748b',
  textFaint: '#94a3b8',
  panelPad: '16px 20px',
};

type ControlMode = 'baseline' | 'ofo' | 'ppo';
type Hardware = 'H100' | 'B200';

const CONTROL_MODES: ControlMode[] = PAPER_MODE ? ['baseline', 'ofo'] : ['baseline', 'ofo', 'ppo'];
const HARDWARE_OPTIONS: Hardware[] = ['H100', 'B200'];

const MODE_META: Record<ControlMode, { label: string; short: string; color: string; bg: string }> = {
  baseline: { label: 'Baseline (no control)',    short: 'Baseline', color: BASELINE_COLOR, bg: '#f8fafc' },
  ofo:      { label: 'OFO (tap control active)', short: 'OFO',      color: OFO_COLOR,       bg: '#f0fdfa' },
  ppo:      { label: 'PPO (learned policy)',     short: 'PPO',      color: PPO_COLOR,       bg: '#eef2ff' },
};

// GPU hardware isn't a separate backend field — it's encoded as a suffix on
// the model_label itself (e.g. "Qwen3-32B-B200"). Labels with no suffix
// predate the B200 traces and are treated as H100, matching the existing
// hardcoded "ML.ENERGY Benchmark v3 (H100)" source line elsewhere in this file.
function inferHardware(modelLabel: string): Hardware {
  if (/-B200$/i.test(modelLabel)) return 'B200';
  return 'H100';
}
function displayModelName(modelLabel: string): string {
  return modelLabel.replace(/-(H100|B200)$/i, '');
}

// Paper defaults for where the datacenter(s) attach. IEEE34 and IEEE123 have
// MULTIPLE datacenters in the paper (2 and 4 respectively) — this app's
// backend attaches exactly one DC per run (`grid.attach_dc()` is called once
// in `_run_full`), so for those topologies we default to the first listed
// zone bus rather than pretending to simulate all zones at once.
const DEFAULT_DC_BUSES: Record<string, string[]> = {
  ieee13: ['671'],
  ieee34: ['850', '844'],
  ieee123: ['8', '23', '60', '105'],
};

interface TimestepData {
  time: number;
  gpu_power_W: number;
  gpu_power_kW: number;
  gpu_power_raw_kW: number;
  gpu_reactive_kVAR: number;
  voltages: number[];
  min_voltage: number;
  max_voltage: number;
  target_bus_voltage: number;
  total_load_kW: number;
  batch_by_model?: Record<string, number>;
  // From the _serialize_tick patch — real per-timestep values, not derived:
  // itl_s_by_model is sampled by the datacenter each control interval (the
  // same value OFO's latency dual reads); throughput_tokens_s_by_model comes
  // from evaluating the same fitted logistic curve PrimalBatchOptimizer uses
  // internally, at the batch size actually chosen that tick.
  itl_s_by_model?: Record<string, number>;
  throughput_tokens_s_by_model?: Record<string, number>;
}

interface AnalysisData {
  numSamples: number;
  targetBus: number;
  modelLabel: string;
  numGpus: number;
  maxNumSeqs: number;
  numReplicas: number;
  duration: number;
  minVoltage: number;
  maxVoltage: number;
  avgGpuPower: number;
  peakGpuPower: number;
  timeSeries: TimestepData[];
  controlMode: ControlMode;
  substationV?: number;   // substation voltage this run used
  summary?: any;           // backend summary (includes summary.paper)
}

interface TraceModel {
  modelLabel: string;
  numGpus: number;
  batchSizes: number[];
  // From the /api/traces patch — real openg2g InferenceModelSpec fields,
  // optional here so this still compiles against an un-patched backend.
  initialReplicas?: number;
  feasibleBatchSizes?: number[];
  itlDeadlineS?: number;
}

interface TracesResponse {
  models: TraceModel[];
  trainingAvailable: boolean;
}

interface BusInfo {
  name: string;
  baseLoad: number;
}

interface LLMImpactProps {
  topology?: string;
  baselineVoltages?: number[] | null;
  onVoltagesUpdated?: (voltages: number[], label: string, bus?: number) => void;
  onLoadingChanged?: (loading: boolean) => void;
  onReset?: () => void;
}

const IEEE13_BUS_INFO: Record<number, BusInfo> = {
  1:  { name: '650 (Substation)', baseLoad: 0    },
  2:  { name: '632',              baseLoad: 200  },
  3:  { name: '633',              baseLoad: 170  },
  4:  { name: '645',              baseLoad: 230  },
  5:  { name: '646',              baseLoad: 0    },
  6:  { name: '671',              baseLoad: 400  },
  7:  { name: '684',              baseLoad: 128  },
  8:  { name: '611',              baseLoad: 0    },
  9:  { name: '634',              baseLoad: 1155 },
  10: { name: '675',              baseLoad: 843  },
  11: { name: '652',              baseLoad: 170  },
  12: { name: '680',              baseLoad: 170  },
  13: { name: '692',              baseLoad: 0    },
};

const snapVoltage = (snap: TimestepData | null | undefined, busIndex: number): number | null => {
  if (!snap?.voltages || !Array.isArray(snap.voltages)) return null;
  const v = snap.voltages[busIndex];
  return (v != null && isFinite(v)) ? v : null;
};

const safeFixed = (v: number | null | undefined, digits = 4, fallback = '—'): string =>
  v != null && isFinite(v) ? v.toFixed(digits) : fallback;

function computeRunSummary(run: AnalysisData, numBuses: number) {
  const n = run.timeSeries.length;
  let totalSamples = 0, totalViol = 0, bussesViolated = 0, worstDev = 0, worstV = 1.0;
  for (let i = 0; i < numBuses; i++) {
    let busHasViol = false;
    for (const step of run.timeSeries) {
      const v = step.voltages?.[i] ?? 1.0;
      totalSamples++;
      if (v < 0.95 || v > 1.05) { totalViol++; busHasViol = true; }
      const dev = Math.abs(v - 1);
      if (dev > worstDev) { worstDev = dev; worstV = v; }
    }
    if (busHasViol) bussesViolated++;
  }
  return {
    violPct: totalSamples ? (totalViol / totalSamples) * 100 : 0,
    bussesViolated, worstV, totalBuses: numBuses, totalSamples,
  };
}

const ViolTooltip: React.FC<any> = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '8px 12px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>Bus {d.bus} ({d.busName})</div>
      <div style={{ color: '#ef4444', marginBottom: 2 }}>Under-voltage: {safeFixed(d.underPct, 1)}%</div>
      <div style={{ color: '#f59e0b', marginBottom: 4 }}>Over-voltage: {safeFixed(d.overPct, 1)}%</div>
      <div style={{ color: '#94a3b8', fontSize: 10, borderTop: '1px solid #e2e8f0', paddingTop: 4 }}>
        Min: {safeFixed(d.minV, 4)} · Max: {safeFixed(d.maxV, 4)} p.u.
      </div>
    </div>
  );
};

const MiniTooltip: React.FC<any> = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const v: number | undefined = d.v;
  return (
    <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 10px', fontSize: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>t = {safeFixed(d.t, 2)}s</div>
      <div style={{ color: v == null ? '#94a3b8' : v < 0.95 ? '#ef4444' : v > 1.05 ? '#f59e0b' : '#16a34a' }}>
        V = {safeFixed(v, 4)} p.u.
      </div>
      {d.baseline != null && (
        <div style={{ color: BASELINE_COLOR, marginTop: 2 }}>No-load baseline: {safeFixed(d.baseline, 4)} p.u.</div>
      )}
    </div>
  );
};

const OverlayTooltip: React.FC<any> = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '8px 12px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>t = {safeFixed(d.t, 2)}s</div>
      <div style={{ color: BASELINE_COLOR, fontWeight: 700 }}>No-load baseline: {safeFixed(d.baseline, 4)} p.u.</div>
      <div style={{ color: LOAD_COLOR, fontWeight: 700 }}>With LLM load: {safeFixed(d.withLoad, 4)} p.u.</div>
    </div>
  );
};

const RunsOverlayTooltip: React.FC<any> = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const modes = CONTROL_MODES.filter(m => d[`${m}Run`] != null);
  return (
    <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '8px 12px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>t = {safeFixed(d.t, 2)}s</div>
      {modes.map(m => (
        <div key={m} style={{ color: MODE_META[m].color, fontWeight: 700 }}>
          {MODE_META[m].short}: {safeFixed(d[`${m}Run`], 4)} p.u.
        </div>
      ))}
    </div>
  );
};

// ── Tradeoff Timeline: shared sync + formatting ────────────────────────────
// All sub-charts in the Tradeoff Timeline card share this syncId, so
// hovering any one of them shows the Recharts crosshair and tooltip at the
// same timestep across all of them.
const TRADEOFF_SYNC_ID = 'tradeoff-timeline';

const fmtVoltageTip     = (v: number) => `${fmt(v, 4)} p.u.`;
const fmtDvTip          = (v: number) => `${v >= 0 ? '+' : ''}${fmt(v, 4)} p.u.`;
const fmtLatencyTip     = (v: number) => `${fmt(v, 1)} ms`;
const fmtBatchTip       = (v: number) => `${fmt(v, 0)} seqs`;
const fmtPowerTip       = (v: number) => `${fmt(v, 4)} MW`;
const fmtThroughputTip  = (v: number) => `${fmt(v, 0)} tok/s`;

const TradeoffTooltip: React.FC<any> = ({ active, payload, label, formatValue }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '8px 12px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>t = {fmt(label, 1)}s</div>
      {payload.filter((p: any) => p.value != null).map((p: any) => (
        <div key={p.dataKey} style={{ color: p.color, fontWeight: 700 }}>
          {p.name}: {formatValue(p.value, p.name)}
        </div>
      ))}
    </div>
  );
};

// Panel, Chip and ChipGroup live at module level (not inside TradeoffTimeline)
// so React doesn't see a new component type each render and remount every chart.
const TradeoffPanel = ({ n, title, role, children }: any) => (
  <div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: '#fff', background: '#475569', borderRadius: 999, padding: '1px 7px' }}>{n}</span>
      <span style={{ fontSize: 11, fontWeight: 800, color: '#0f172a' }}>{title}</span>
      <span style={{ fontSize: 10, color: '#94a3b8' }}>{role}</span>
    </div>
    <div style={{ height: 110 }}>{children}</div>
  </div>
);

const TradeoffChip = ({ label, value, bad }: { label: string; value: string; bad?: boolean }) => (
  <div style={{ background: bad ? '#fef2f2' : '#fff', border: `1px solid ${bad ? '#fca5a5' : '#e2e8f0'}`, borderRadius: 8, padding: '6px 10px' }}>
    <div style={{ fontSize: 8, fontWeight: 800, color: '#94a3b8', letterSpacing: '0.04em' }}>{label}</div>
    <div style={{ fontSize: 12, fontWeight: 800, color: bad ? '#dc2626' : '#0f172a' }}>{value}</div>
  </div>
);

const TradeoffChipGroup = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <div style={{ fontSize: 9, fontWeight: 800, color: '#64748b', letterSpacing: '0.06em' }}>{title}</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{children}</div>
  </div>
);

const firstVal = <T,>(rec?: Record<string, T>): T | undefined =>
  rec ? Object.values(rec)[0] : undefined;

function TradeoffTimelineImpl({
  runs, activeMode, targetBus, snapTime, modelLabel,
  itlDeadlineMs, minThroughput, baselineVoltages, feasibleBatchSizes,
}: {
  runs: Record<ControlMode, AnalysisData | null>;
  activeMode: ControlMode;
  targetBus: number;
  snapTime?: number;
  modelLabel: string;
  itlDeadlineMs: number;
  minThroughput: number;
  baselineVoltages?: number[] | null;   // no-load voltages, for the ΔV panel
  feasibleBatchSizes?: number[];        // from /api/traces, drawn as faint levels
}) {
  const modes = CONTROL_MODES.filter(m => !!runs[m]);
  const missingModes = CONTROL_MODES.filter(m => !runs[m]);
  const noLoadV = baselineVoltages?.[targetBus - 1];
  const hasNoLoad = noLoadV != null && isFinite(noLoadV);

  // Mean throughput of the baseline run — reference line when the user hasn't
  // set a minimum-throughput constraint.
  const baseTpMean = useMemo(() => {
    const tp = (runs.baseline?.timeSeries ?? [])
      .map(s => s.throughput_tokens_s_by_model?.[modelLabel] ?? firstVal(s.throughput_tokens_s_by_model))
      .filter((x): x is number => x != null);
    return tp.length ? tp.reduce((a, b) => a + b, 0) / tp.length : null;
  }, [runs.baseline, modelLabel]);

  const { rows, vDomain, itlDomain, batchDomain, batchIsFixed } = useMemo(() => {
    const len = Math.max(0, ...modes.map(m => runs[m]!.timeSeries.length));
    const rows: any[] = [];
    let vMin = 1, vMax = 1;
    let bMin = Infinity, bMax = -Infinity;
    const itls: number[] = [];

    for (let i = 0; i < len; i++) {
      const row: any = {};
      modes.forEach(m => {
        const s = runs[m]!.timeSeries[i];
        if (!s) return;
        row.t = row.t ?? s.time;
        const v = s.voltages?.[targetBus - 1] ?? s.target_bus_voltage;
        // No fallback to maxNumSeqs: if the backend didn't send batch, show a gap.
        const b = s.batch_by_model?.[modelLabel] ?? firstVal(s.batch_by_model) ?? null;
        const itl = s.itl_s_by_model?.[modelLabel] ?? firstVal(s.itl_s_by_model);
        const tp = s.throughput_tokens_s_by_model?.[modelLabel] ?? firstVal(s.throughput_tokens_s_by_model);

        row[`${m}_v`] = v;
        row[`${m}_dv`] = hasNoLoad && v != null ? v - (noLoadV as number) : null;
        row[`${m}_batch`] = b;
        row[`${m}_mw`] = s.gpu_power_kW / 1000;
        row[`${m}_itl`] = itl != null ? itl * 1000 : null;
        row[`${m}_tp`] = tp ?? null;

        if (v != null) { vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); }
        if (b != null) { bMin = Math.min(bMin, b); bMax = Math.max(bMax, b); }
        if (itl != null) itls.push(itl * 1000);
      });
      rows.push(row);
    }

    itls.sort((a, b) => a - b);
    const p95 = itls.length ? itls[Math.floor(itls.length * 0.95)] : itlDeadlineMs;

    const haveBatch = isFinite(bMin) && isFinite(bMax);
    const batchDomain: [number, number | string] = haveBatch
      ? [Math.max(0, Math.floor(bMin * 0.8)), Math.ceil(bMax * 1.1)]
      : [0, 'auto'];

    return {
      rows,
      vDomain: [Math.min(0.94, vMin - 0.01), Math.max(1.06, vMax + 0.01)] as [number, number],
      itlDomain: [0, Math.max(itlDeadlineMs * 2, p95 * 1.2)] as [number, number], // clip spikes, keep deadline readable
      batchDomain,
      batchIsFixed: haveBatch && bMin === bMax,
    };
  }, [runs, targetBus, modelLabel, itlDeadlineMs, hasNoLoad, noLoadV]);

  // Summary for the active run
  const story = useMemo(() => {
    const d = runs[activeMode];
    if (!d || d.timeSeries.length === 0) return null;
    const ts = d.timeSeries;

    const bs = ts.map(s => s.batch_by_model?.[modelLabel] ?? firstVal(s.batch_by_model))
      .filter((x): x is number => x != null);
    const vs = ts.map(s => s.voltages?.[targetBus - 1] ?? s.target_bus_voltage)
      .filter((x): x is number => x != null);
    const itl = ts.map(s => s.itl_s_by_model?.[modelLabel] ?? firstVal(s.itl_s_by_model))
      .filter((x): x is number => x != null).map(x => x * 1000);
    const tp = ts.map(s => s.throughput_tokens_s_by_model?.[modelLabel] ?? firstVal(s.throughput_tokens_s_by_model))
      .filter((x): x is number => x != null);
    const kws = ts.map(s => s.gpu_power_kW / 1000);

    return {
      batch: bs.length ? [Math.min(...bs), Math.max(...bs)] : null,
      power: [Math.min(...kws), Math.max(...kws)],
      vViolPct: vs.length ? (vs.filter(v => v < 0.95 || v > 1.05).length / vs.length) * 100 : 0,
      itlViolPct: itl.length ? (itl.filter(x => x > itlDeadlineMs).length / itl.length) * 100 : 0,
      itlPeak: itl.length ? Math.max(...itl) : null,
      apr: d.summary?.paper?.achievable_power_range_mw ?? null,
      tpMean: tp.length ? tp.reduce((a, b) => a + b, 0) / tp.length : null,
    };
  }, [runs, activeMode, targetBus, modelLabel, itlDeadlineMs]);

  const lineFor = (suffix: string, stepped = false) => modes.map(m => (
    <Line key={m} type={stepped ? 'stepAfter' : 'monotone'} dataKey={`${m}_${suffix}`} name={MODE_META[m].short}
      stroke={MODE_META[m].color} strokeWidth={m === activeMode ? 2.5 : 1.5}
      strokeDasharray={m === 'baseline' ? '5 3' : undefined} dot={false} isAnimationActive={false} connectNulls />
  ));

  // Returned as an array (not a fragment) so Recharts reliably picks up the axes.
  const common = (fmtY: (v: number) => string, w = 44, domain?: any) => [
    <XAxis key="x" dataKey="t" tick={{ fontSize: 9 }} tickFormatter={(v: number) => `${Math.round(v)}s`} stroke="#94a3b8" />,
    <YAxis key="y" tick={{ fontSize: 9 }} tickFormatter={fmtY} stroke="#94a3b8" width={w} domain={domain} allowDataOverflow />,
    snapTime != null ? <ReferenceLine key="snap" x={snapTime} stroke="#0f172a" strokeWidth={1} opacity={0.5} /> : null,
  ];

  const visibleFeasible = (feasibleBatchSizes ?? []).filter(
    b => typeof batchDomain[1] === 'number' && b >= (batchDomain[0] as number) && b <= (batchDomain[1] as number)
  );

  let panelNo = 0;
  const nextN = () => String(++panelNo);

  return (
    <CollapsibleCard title={`Tradeoff Timeline — ${modes.map(m => MODE_META[m].short).join(' vs ')}`}>
      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: UI.radius, padding: UI.panelPad, display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Summary strip, grouped by role */}
        {story && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
            <TradeoffChipGroup title="DC FLEXIBILITY">
              <TradeoffChip label="BATCH RANGE"
                value={story.batch ? `${story.batch[0]} → ${story.batch[1]} seqs` : '—'} />
            </TradeoffChipGroup>
            <TradeoffChipGroup title="GRID IMPACT">
              <TradeoffChip label="TOTAL DC POWER (MIN–MAX, INCL. BASE LOAD)" value={`${fmt(story.power[0], 3)}–${fmt(story.power[1], 3)} MW`} />
              <TradeoffChip label="ACHIEVABLE POWER RANGE (PAPER)" value={story.apr != null ? `${fmt(story.apr, 2)} MW` : '—'} />
              <TradeoffChip label={`BUS ${targetBus} VOLT. VIOLATIONS`} value={`${fmt(story.vViolPct, 1)}%`} bad={story.vViolPct > 0} />
            </TradeoffChipGroup>
            <TradeoffChipGroup title="AI PERFORMANCE">
              <TradeoffChip label={`ITL > ${Math.round(itlDeadlineMs)} ms`} value={`${fmt(story.itlViolPct, 1)}% of time`} bad={story.itlViolPct > 0} />
              <TradeoffChip label="PEAK ITL" value={story.itlPeak != null ? `${fmt(story.itlPeak, 0)} ms` : '—'}
                bad={story.itlPeak != null && story.itlPeak > itlDeadlineMs} />
              <TradeoffChip label="MEAN THROUGHPUT (MODELED)" value={story.tpMean != null ? `${fmt(story.tpMean, 0)} tok/s` : '—'}
                bad={minThroughput > 0 && story.tpMean != null && story.tpMean < minThroughput} />
            </TradeoffChipGroup>
          </div>
        )}

        {missingModes.length > 0 && (
          <div style={{ fontSize: 10, color: '#7c3aed', border: '1px dashed #c4b5fd', borderRadius: 6, padding: '4px 8px', alignSelf: 'flex-start' }}>
            Not run yet: {missingModes.map(m => MODE_META[m].short).join(' / ')}. Run them to overlay on these charts.
          </div>
        )}

        {/* 1. Lever */}
        <TradeoffPanel n={nextN()} title="Batch size (number of sequences)"
          role={batchIsFixed ? 'DC flexibility (fixed)' : 'DC flexibility'}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart syncId={TRADEOFF_SYNC_ID} data={rows}>
              {common(v => `${v}`, 34, batchDomain)}
              {visibleFeasible.map(b => (
                <ReferenceLine key={`fb-${b}`} y={b} stroke="#cbd5e1" strokeDasharray="1 4" />
              ))}
              <Tooltip content={<TradeoffTooltip formatValue={fmtBatchTip} />} />
              <Legend wrapperStyle={{ fontSize: 9 }} />
              {lineFor('batch', true)}
            </LineChart>
          </ResponsiveContainer>
        </TradeoffPanel>

        {/* 2. Power */}
        <TradeoffPanel n={nextN()} title="Datacenter power (MW)" role="effect of the batch size on the grid">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart syncId={TRADEOFF_SYNC_ID} data={rows}>
              {common(v => `${v.toFixed(2)}MW`, 52)}
              <Tooltip content={<TradeoffTooltip formatValue={fmtPowerTip} />} />
              {lineFor('mw')}
            </LineChart>
          </ResponsiveContainer>
        </TradeoffPanel>

     

        {/* 4. Absolute voltage */}
        <TradeoffPanel n={nextN()} title={`Data Center Bus ${targetBus} voltage (p.u.)`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart syncId={TRADEOFF_SYNC_ID} data={rows}>
              {common(v => v.toFixed(3), 44, vDomain)}
              <ReferenceArea y1={0.95} y2={1.05} fill="#16a34a" fillOpacity={0.07} />
              <ReferenceArea y1={1.05} y2={vDomain[1]} fill="#f59e0b" fillOpacity={0.08} />
              <ReferenceArea y1={vDomain[0]} y2={0.95} fill="#ef4444" fillOpacity={0.08} />
              <ReferenceLine y={1.05} stroke="#f59e0b" strokeDasharray="4 3" label={{ value: '1.05 limit', fontSize: 9, fill: '#f59e0b', position: 'insideTopRight' }} />
              <ReferenceLine y={0.95} stroke="#ef4444" strokeDasharray="4 3" label={{ value: '0.95 limit', fontSize: 9, fill: '#ef4444', position: 'insideBottomRight' }} />
              <Tooltip content={<TradeoffTooltip formatValue={fmtVoltageTip} />} />
              {lineFor('v')}
            </LineChart>
          </ResponsiveContainer>
        </TradeoffPanel>

        {/* 5. ITL */}
        <TradeoffPanel n={nextN()} title="Inter-token latency (ms)" role="constraint: stay below the latency target / ITL deadline">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart syncId={TRADEOFF_SYNC_ID} data={rows}>
              {common(v => `${v.toFixed(0)}ms`, 44, itlDomain)}
              <ReferenceArea y1={itlDeadlineMs} y2={itlDomain[1]} fill="#ef4444" fillOpacity={0.07} />
              <ReferenceLine y={itlDeadlineMs} stroke="#ef4444" strokeDasharray="4 3" label={{ value: 'Latency target', fontSize: 9, fill: '#ef4444', position: 'insideTopRight' }} />
              <Tooltip content={<TradeoffTooltip formatValue={fmtLatencyTip} />} />
              {lineFor('itl')}
            </LineChart>
          </ResponsiveContainer>
        </TradeoffPanel>

        {/* 6. Throughput (modeled from batch, not measured) */}
        <TradeoffPanel n={nextN()} title="Token throughput (tokens/s)"
          role={minThroughput > 0 ? 'constraint' : 'AI workload performance (modeled from batch size)'}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart syncId={TRADEOFF_SYNC_ID} data={rows}>
              {common(v => `${v.toFixed(0)}`, 44, [0, 'auto'])}
              {minThroughput > 0 && <ReferenceArea y1={0} y2={minThroughput} fill="#ef4444" fillOpacity={0.07} />}
              {minThroughput > 0 && (
                <ReferenceLine y={minThroughput} stroke="#ef4444" strokeDasharray="4 3"
                  label={{ value: 'min throughput', fontSize: 9, fill: '#ef4444', position: 'insideBottomRight' }} />
              )}
              {minThroughput === 0 && baseTpMean != null && (
                <ReferenceLine y={baseTpMean} stroke="#94a3b8" strokeDasharray="4 3"
                  label={{ value: 'baseline mean', fontSize: 9, fill: '#94a3b8', position: 'insideBottomRight' }} />
              )}
              <Tooltip content={<TradeoffTooltip formatValue={fmtThroughputTip} />} />
              {lineFor('tp')}
            </LineChart>
          </ResponsiveContainer>
        </TradeoffPanel>
      </div>
    </CollapsibleCard>
  );
}

// Number field that only commits on Enter / blur, so typing doesn't re-render the whole results page.
const CommitNumber = ({ value, onCommit, disabled, style, min = 1 }: {
  value: number; onCommit: (n: number) => void; disabled?: boolean; style?: React.CSSProperties; min?: number;
}) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft !== '' && isFinite(n) && n >= min) { if (n !== value) onCommit(n); }
    else setDraft(String(value));
  };
  return (
    <input type="number" min={min} disabled={disabled} value={draft} style={style}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
};

const TradeoffTimeline = React.memo(TradeoffTimelineImpl);
const PowerThroughputCurveMemo = React.memo(PowerThroughputCurve);

export default function LLMImpactAnalysis({ topology = 'ieee13', baselineVoltages, onVoltagesUpdated, onLoadingChanged, onReset }: LLMImpactProps) {
  const [runs, setRuns]             = useState<Record<ControlMode, AnalysisData | null>>({ baseline: null, ofo: null, ppo: null });
  const [controlMode, setControlMode] = useState<ControlMode>('baseline');
  const data = runs[controlMode];

  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [selIdx, setSelIdx]         = useState(0);
  const [targetBus, setTargetBus]   = useState(6); // Bus 671 — paper default DC attachment for IEEE13
  const [graphBus, setGraphBus]     = useState(6);
  const [selectedBuses, setSelectedBuses] = useState<number[]>([]);
  const [busSearch, setBusSearch]   = useState('');

  const [substationVoltage, setSubstationVoltage] = useState(DEFAULT_SUBSTATION_VOLTAGE);

  const [busInfo, setBusInfo]       = useState<Record<number, BusInfo>>(IEEE13_BUS_INFO);
  const [numBuses, setNumBuses]     = useState(13);

  // No-load baseline fetched for THIS component's substation voltage. The
  // baselineVoltages prop comes from the parent, which may be at a different
  // voltage, so prefer our own and fall back to the prop until it arrives.
  const [localBaseline, setLocalBaseline] = useState<number[] | null>(null);
  const effectiveBaseline = localBaseline ?? baselineVoltages ?? null;

  const [traceModels, setTraceModels]   = useState<TraceModel[]>([]);
  const [tracesReady, setTracesReady]   = useState(false);
  const [selectedHardware, setSelectedHardware] = useState<Hardware>('H100');
  const [selectedModel, setSelectedModel] = useState('Qwen3-8B');
  const [selectedBatch, setSelectedBatch] = useState(128);
  const [numReplicas, setNumReplicas]   = useState(1);
  // Paper preset (locked, cached) vs Customize (what-if on the same paper scenario).
  const [customMode, setCustomMode] = useState(false);
  const [autoSize, setAutoSize]     = useState(true);   // re-size replicas to the paper's 3.12 MW anchor
  const [paperSeed, setPaperSeed]   = useState(0);
  const [runsCfg, setRunsCfg]       = useState<Record<string, string>>({});

  // User-editable ITL deadline override, in ms — seeded from the model's real
  // itl_deadline_s whenever the model changes, but editable afterward. Only
  // takes effect on OFO runs; the backend clones InferenceModelSpec with this
  // value before constructing OFOBatchSizeController (see the live-latency
  // patch). Harmless to send on baseline/PPO runs — the backend ignores it.
  const [itlDeadlineOverrideMs, setItlDeadlineOverrideMs] = useState(50);

  // Optional minimum-throughput constraint (tokens/s). 0 = no constraint, so
  // throughput stays a plain objective in the Tradeoff Timeline. Display-only:
  // it draws a line/shaded zone and flags the mean; it is not sent to the backend.
  const [minThroughput, setMinThroughput] = useState<number>(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(2);
  const timeSeries = data?.timeSeries ?? [];

  // Grid pages
  const [gridPage, setGridPage] = useState(0);

  const safeSelIdx = timeSeries.length > 0 ? Math.min(selIdx, timeSeries.length - 1) : 0;
  const snap  = timeSeries[safeSelIdx] ?? null;
  const atEnd = safeSelIdx >= (timeSeries.length - 1);

  const otherModesWithData = CONTROL_MODES.filter(m => m !== controlMode && !!runs[m]);

  const tour = useTour({ hasData: !!data });

  useEffect(() => {
    setRuns({ baseline: null, ofo: null, ppo: null });
    setControlMode('baseline');
    setError(null);
    setSelIdx(0);
    setIsPlaying(false);
    onReset?.();

    const topo = topology.toLowerCase();

    if (topo === 'ieee13') {
      setBusInfo(IEEE13_BUS_INFO);
      setNumBuses(13);
      setTargetBus(6); // Bus 671
      return;
    }

    fetch(`${API_URL}/api/topology/${topology}/buses`)
      .then(r => r.json())
      .then((res: { buses: string[]; coords: Record<string, [number, number]> }) => {
        const buses = res.buses.filter(b => !PHANTOM_BUSES.has(b.toLowerCase()));
        const newBusInfo: Record<number, BusInfo> = {};
        buses.forEach((name, i) => {
          newBusInfo[i + 1] = { name: name.toUpperCase(), baseLoad: 0 };
        });
        setBusInfo(newBusInfo);
        setNumBuses(buses.length);

        // Paper default DC bus(es) for this feeder — pick the first one that
        // actually exists in the fetched bus list.
        const candidates = DEFAULT_DC_BUSES[topo] ?? [];
        const matchIdx = buses.findIndex(b => candidates.some(c => c.toLowerCase() === b.toLowerCase()));
        setTargetBus(matchIdx >= 0 ? matchIdx + 1 : 1);
      })
      .catch(err => {
        console.error('Failed to load bus list for', topology, err);
        const count = topology === 'ieee34' ? 34 : 123;
        const fallback: Record<number, BusInfo> = {};
        for (let i = 1; i <= count; i++) fallback[i] = { name: String(i), baseLoad: 0 };
        setBusInfo(fallback);
        setNumBuses(count);
        setTargetBus(1);
      });
  }, [topology]);

  useEffect(() => {
    const ctrl = new AbortController();
    // Debounce: dragging the slider would otherwise fire a sim per tick.
    const id = setTimeout(() => {
      fetch(`${API_URL}/api/powerflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ substationVoltage, topology, numBuses, paperMode: PAPER_MODE }),
        signal: ctrl.signal,
      })
        .then(r => r.json())
        .then(res => {
          if (Array.isArray(res?.buses)) {
            setLocalBaseline(res.buses.map((b: any) => b.voltage));
          }
        })
        .catch(() => { /* aborted or backend down: keep previous baseline */ });
    }, 400);
    return () => { clearTimeout(id); ctrl.abort(); };
  }, [substationVoltage, topology]);

  useEffect(() => {
    setSelectedBuses([]);
    setBusSearch('');
  }, [busInfo]);

  useEffect(() => {
    fetch(`${API_URL}/api/traces`)
      .then(r => r.json())
      .then((res: TracesResponse) => {
        setTraceModels(res.models);
        if (res.models.length > 0) {
          // Prefer the paper's default (a -B200 labeled model, e.g.
          // Qwen3-32B-B200) over just taking the first entry, if it exists
          // in this deployment's trace data.
     
          const preferred = res.models.find(m => inferHardware(m.modelLabel) === 'H100') ?? res.models[0];
          setSelectedHardware(inferHardware(preferred.modelLabel));
          setSelectedModel(preferred.modelLabel);
          const batches = preferred.batchSizes;
          setSelectedBatch(pickDefaultBatch(batches));
          setNumReplicas(preferred.initialReplicas ?? 1);
        }
        setTracesReady(true);
      })
      .catch(() => setTracesReady(false));
  }, []);

  // Models under the currently selected hardware tier, inferred from the
  // model_label suffix rather than a separate backend field.
  const modelsForHardware = useMemo(
    () => traceModels.filter(m => inferHardware(m.modelLabel) === selectedHardware),
    [traceModels, selectedHardware]
  );

  useEffect(() => {
    if (modelsForHardware.length && !modelsForHardware.some(m => m.modelLabel === selectedModel)) {
      setSelectedModel(modelsForHardware[0].modelLabel);
    }
  }, [selectedHardware, traceModels]);

  const currentModel = traceModels.find(m => m.modelLabel === selectedModel);
  const availableBatches = currentModel?.batchSizes ?? [128];

  useEffect(() => {
    if (currentModel) {
      const batches = currentModel.batchSizes;
      // openg2g's stated default initial batch size is 128 — use it when
      // this model's traces actually include it, else fall back to the
      // middle of whatever's available.
      setSelectedBatch(pickDefaultBatch(batches));
      // openg2g default replicas for this model — still editable afterward.
      setNumReplicas(currentModel.initialReplicas ?? 1);
      // Reseed the ITL deadline override from this model's real default —
      // still editable afterward, same pattern as replicas above.
      if (currentModel.itlDeadlineS != null) {
        setItlDeadlineOverrideMs(currentModel.itlDeadlineS * 1000);
      }
    }
  }, [selectedModel]);

  useEffect(() => {
    if (!isPlaying || !data) return;
    const ms = 1000 / playSpeed;
    const id = setInterval(() => {
      setSelIdx(prev => {
        if (prev >= timeSeries.length - 1) { setIsPlaying(false); return prev; }
        return prev + 1;
      });
    }, ms);
    return () => clearInterval(id);
  }, [isPlaying, playSpeed, data]);



  useEffect(() => { setGraphBus(targetBus); }, [targetBus]);

  const togglePlay = () => {
    if (!data) return;
    if (!isPlaying && atEnd) setSelIdx(0);
    setIsPlaying(prev => !prev);
  };

  useEffect(() => {
    if (snap?.voltages?.length && data) {
      onVoltagesUpdated?.(
        snap.voltages,
        `${MODE_META[controlMode].short} · ${data.modelLabel} (seqs=${data.maxNumSeqs}) @ t=${safeFixed(snap.time, 1)}s — ${safeFixed(snap.gpu_power_kW / 1000, 3)} MW on Bus ${targetBus}`,
        targetBus
      );
    }
  }, [safeSelIdx, controlMode, data, targetBus]);

  const resetToPaper = () => {
    setCustomMode(false); setAutoSize(true);
    if (currentModel) {
      setNumReplicas(currentModel.initialReplicas ?? 1);
      setSelectedBatch(pickDefaultBatch(currentModel.batchSizes));
      if (currentModel.itlDeadlineS != null) setItlDeadlineOverrideMs(currentModel.itlDeadlineS * 1000);
    }
  };

  const handleReset = () => {
    setRuns(prev => ({ ...prev, [controlMode]: null }));
    setError(null); setSelIdx(0); setIsPlaying(false);
    onReset?.();
  };

  const run = async () => {
    const mode = controlMode;
    const cfgKey = JSON.stringify([selectedModel, paperSeed, customMode,
      customMode ? [Math.round(itlDeadlineOverrideMs), autoSize ? 'auto' : numReplicas, selectedBatch] : null]);
    setRunsCfg(prev => {
      const next: Record<string, string> = { [mode]: cfgKey };
      for (const k of Object.keys(prev)) if (k !== mode && prev[k] === cfgKey) next[k] = prev[k];
      return next;
    });
    setRuns(prev => {
      const out: any = { ...prev };
      for (const k of CONTROL_MODES) if (k !== mode && runsCfg[k] !== cfgKey) out[k] = null;
      return out;
    });
    setLoading(true); setError(null);
    setRuns(prev => ({ ...prev, [mode]: null }));
    setSelIdx(0); setIsPlaying(false);
    onLoadingChanged?.(true);

    const accumulated: TimestepData[] = [];
    const wsUrl = API_URL.replace('http', 'ws');
    const ws = new WebSocket(`${wsUrl}/ws/sim-stream`);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        targetBus,
        topology,
        numBuses,
        modelLabel:        selectedModel,
        numGpus:           currentModel?.numGpus ?? 1,
        maxNumSeqs:        selectedBatch,
        numReplicas,
        substationVoltage,
        sampleInterval:    PAPER_MODE ? 10 : 1,
        durationS:         PAPER_MODE ? 3600 : 300,
        paperMode:         PAPER_MODE,
        paperSeed:         paperSeed,
        paperCustom:       customMode,
        ...(customMode ? {
          paperDeadlineMs:   itlDeadlineOverrideMs,
          paperAutoSize:     autoSize,
          paperReplicas:     autoSize ? undefined : numReplicas,
          paperInitialBatch: selectedBatch,
        } : {}),
        controlMode:       mode,
        ofoEnabled:         mode === 'ofo',
        ppoEnabled:         mode === 'ppo',
        // Only consumed by the OFO branch server-side — harmless on baseline/PPO.
        itlDeadlineMsOverride: itlDeadlineOverrideMs,
      }));
    };

    // Buffer rows and re-render at most every 200 ms instead of once per row.
    let timer: number | null = null;
    let firstFlush = true;

    const flush = () => {
      timer = null;
      if (!accumulated.length) return;
      const rows = accumulated.slice();   // new array so the memos see a change
      if (firstFlush) { firstFlush = false; setLoading(false); onLoadingChanged?.(false); }
      setRuns(prev => ({
        ...prev,
        [mode]: {
          numSamples: rows.length,
          targetBus,
          modelLabel: selectedModel,
          numGpus: currentModel?.numGpus ?? 1,
          maxNumSeqs: selectedBatch,
          numReplicas,
          controlMode: mode,
          substationV: substationVoltage,
          duration: rows[rows.length - 1].time,
          minVoltage: rows.reduce((m, r) => Math.min(m, r.min_voltage), 1.0),
          maxVoltage: rows.reduce((m, r) => Math.max(m, r.max_voltage), 1.0),
          peakGpuPower: rows.reduce((m, r) => Math.max(m, r.gpu_power_W), 0),
          avgGpuPower: rows.reduce((s, r) => s + r.gpu_power_W, 0) / rows.length,
          timeSeries: rows,
        } as AnalysisData,
      }));
    };

    ws.onmessage = (evt) => {
      const tick = JSON.parse(evt.data);
      if (tick.error) {
        if (timer != null) { clearTimeout(timer); timer = null; }
        setError(tick.error); setLoading(false); onLoadingChanged?.(false); ws.close(); return;
      }
      if (tick.done) {
        if (timer != null) { clearTimeout(timer); timer = null; }
        flush();
        setLoading(false); onLoadingChanged?.(false);
        ws.close();
        return;
      }

      accumulated.push({
        time:               tick.time,
        gpu_power_W:        tick.gpu_power_kW * 1000,
        gpu_power_kW:       tick.gpu_power_kW,
        gpu_power_raw_kW:   tick.gpu_power_raw_kW,
        gpu_reactive_kVAR:  tick.gpu_power_kW * 0.329,
        voltages:           tick.voltages ?? [],
        min_voltage:        tick.min_voltage ?? 1.0,
        max_voltage:        tick.max_voltage ?? 1.0,
        target_bus_voltage: tick.target_bus_voltage ?? 1.0,
        total_load_kW:      tick.gpu_power_kW,
        // _run_full emits `batch_size_by_model`; accept either name.
        batch_by_model:     tick.batch_by_model ?? tick.batch_size_by_model ?? undefined,
        itl_s_by_model:             tick.itl_s_by_model ?? undefined,
        throughput_tokens_s_by_model: tick.throughput_tokens_s_by_model ?? undefined,
      });
      if (timer == null) timer = window.setTimeout(flush, 200);
    };

    ws.onerror = () => {
      setError('WebSocket connection failed');
      setLoading(false);
      onLoadingChanged?.(false);
    };
  };



  const GRID_MIN_CARD_WIDTH = 168;
  const busGridCols = `repeat(auto-fill, minmax(${GRID_MIN_CARD_WIDTH}px, 1fr))`;

  const baselineForBus = (bus: number): number | null => {
    const v = effectiveBaseline?.[bus - 1];
    return (v != null && isFinite(v)) ? v : null;
  };

  const violStats = useMemo(() => {
    if (!data) return [];
    const n = timeSeries.length;
    if (n === 0) return [];
    return Array.from({ length: numBuses }, (_, i) => {
      const bus     = i + 1;
      const vSeries = timeSeries.map(d => d.voltages?.[i] ?? 1.0);
      const under   = vSeries.filter(v => v < 0.95).length;
      const over    = vSeries.filter(v => v > 1.05).length;
      const minV    = vSeries.length ? Math.min(...vSeries) : 1.0;
      const maxV    = vSeries.length ? Math.max(...vSeries) : 1.0;
      return {
        bus, total: n, under, over,
        underPct: (under / n) * 100, overPct: (over / n) * 100,
        minV, maxV,
        busName: busInfo[bus]?.name ?? String(bus),
        isTarget: bus === targetBus,
      };
    });
  }, [data, targetBus, numBuses, busInfo]);

  const busTimeSeries = useMemo(() => {
    if (!data) return [];
    return Array.from({ length: numBuses }, (_, i) => {
      const bus      = i + 1;
      const baseV    = baselineForBus(bus);
      const series   = timeSeries.map((d, idx) => ({ t: d.time, v: d.voltages?.[i] ?? 1.0, baseline: baseV, _i: idx }));
      const voltages = series.map(s => s.v);
      const violations = voltages.filter(v => v < 0.95 || v > 1.05).length;
      const minV = voltages.length ? Math.min(...voltages) : 1.0;
      const maxV = voltages.length ? Math.max(...voltages) : 1.0;
      return { bus, series, minV, maxV, violations, isTarget: bus === targetBus, baseV };
    });
  }, [data, targetBus, numBuses, effectiveBaseline]);

  const powerChartData = useMemo(() => {
    if (!data) return [];
    return timeSeries.map(d => ({
      t: d.time,
      kw: (d.gpu_power_raw_kW ?? d.gpu_power_kW ?? 0) / 1000,
    }));
  }, [data]);

  const targetBaselineStats = useMemo(() => {
    const baseV = baselineForBus(targetBus);
    if (baseV == null) return null;
    const violating = baseV < 0.95 || baseV > 1.05;
    return { v: baseV, violating };
  }, [targetBus, effectiveBaseline]);

  const targetWithLoadStats = useMemo(() => {
    if (!data) return null;
    const bs = violStats.find(v => v.bus === targetBus);
    if (!bs) return null;
    return {
      violPct: bs.underPct + bs.overPct,
      minV: bs.minV, maxV: bs.maxV,
      worst: Math.abs(bs.minV - 1) >= Math.abs(bs.maxV - 1) ? bs.minV : bs.maxV,
    };
  }, [data, violStats, targetBus]);

  const graphOverlaySeries = useMemo(() => {
    if (!data) return [];
    const idx = graphBus - 1;
    const baseV = baselineForBus(graphBus);
    return timeSeries.map(d => ({
      t: d.time,
      baseline: baseV,
      withLoad: d.voltages?.[idx] ?? null,
    }));
  }, [data, graphBus, effectiveBaseline]);

  const graphBusStats = useMemo(() => {
    if (!data) return null;
    return violStats.find(v => v.bus === graphBus) ?? null;
  }, [data, graphBus, violStats]);

  const systemComparison = useMemo(() => {
    if (!data || !effectiveBaseline?.length) return null;
    const baseBusesViolated = effectiveBaseline.filter(v => v < 0.95 || v > 1.05).length;
    const baseWorst = effectiveBaseline.reduce((worst, v) => Math.abs(v - 1) > Math.abs(worst - 1) ? v : worst, 1.0);
    const loadBusesViolated = violStats.filter(b => b.under + b.over > 0).length;
    const loadWorst = violStats.reduce((worst, b) => {
      const w = Math.abs(b.minV - 1) >= Math.abs(b.maxV - 1) ? b.minV : b.maxV;
      return Math.abs(w - 1) > Math.abs(worst - 1) ? w : worst;
    }, 1.0);
    return {
      baseBusesViolated, loadBusesViolated,
      totalBuses: numBuses,
      baseWorst, loadWorst,
    };
  }, [data, effectiveBaseline, violStats, numBuses]);

  const runsComparison = useMemo(() => {
    const present = CONTROL_MODES.filter(m => !!runs[m]);
    if (present.length < 2) return null;
    const summaries = {} as Record<ControlMode, ReturnType<typeof computeRunSummary>>;
    present.forEach(m => { summaries[m] = computeRunSummary(runs[m]!, numBuses); });
    return { present, summaries };
  }, [runs, numBuses]);

  const runsOverlaySeries = useMemo(() => {
    const present = CONTROL_MODES.filter(m => !!runs[m]);
    if (present.length < 2) return { series: [] as any[], present: [] as ControlMode[] };
    const idx = graphBus - 1;
    const len = Math.max(...present.map(m => runs[m]!.timeSeries.length));
    const out: any[] = [];
    for (let i = 0; i < len; i++) {
      const row: any = { t: null };
      present.forEach(m => {
        const step = runs[m]!.timeSeries[i];
        row.t = row.t ?? step?.time ?? i;
        row[`${m}Run`] = step?.voltages?.[idx] ?? null;
      });
      out.push(row);
    }
    return { series: out, present };
  }, [runs, graphBus]);

  const topoLabel = topology === 'ieee13' ? 'IEEE 13-Bus' : topology === 'ieee34' ? 'IEEE 34-Bus' : 'IEEE 123-Bus';

  // ── Violation chart sizing ────────────────────────────────────────────────
  const violChartHeight = numBuses > 34 ? 360 : numBuses > 13 ? 280 : 220;
  const violBottomMargin = numBuses > 13 ? 60 : 20;
  const violLabelOffset  = numBuses > 13 ? -45 : -12;
  const xAxisTickAngle   = numBuses > 13 ? -60 : 0;
  const xAxisTextAnchor  = numBuses > 13 ? 'end' : 'middle';

  const xAxisTickFontSize = 9;
  const xAxisTickInterval = numBuses > 60 ? 1 : 0; 
  const xAxisHeight      = numBuses > 13 ? 68 : 30;

  // ── Bus grid filtering ───────────────────────────────────────────────────
  const visibleBuses = useMemo(() => {
    let list = selectedBuses.length === 0 ? busTimeSeries : busTimeSeries.filter(b => selectedBuses.includes(b.bus));
    if (busSearch.trim()) {
      const q = busSearch.trim().toLowerCase();
      list = list.filter(b => String(b.bus).includes(q) || (busInfo[b.bus]?.name ?? '').toLowerCase().includes(q));
    }
    return list;
  }, [busTimeSeries, selectedBuses, busSearch, busInfo]);

  const violatingBusNumbers = useMemo(() => violStats.filter(b => b.under + b.over > 0).map(b => b.bus), [violStats]);

  const worstBusesSorted = useMemo(() => {
    return [...violStats]
      .sort((a, b) => {
        const devA = Math.max(Math.abs(a.minV - 1), Math.abs(a.maxV - 1));
        const devB = Math.max(Math.abs(b.minV - 1), Math.abs(b.maxV - 1));
        return devB - devA;
      })
      .map(b => b.bus);
  }, [violStats]);

  const LARGE_BUS_THRESHOLD = 20;
  const DEFAULT_LARGE_CAP = 25;
  const isLargeFeeder = numBuses > LARGE_BUS_THRESHOLD;

  useEffect(() => {
    if (!data) return;
    if (isLargeFeeder && selectedBuses.length === 0 && worstBusesSorted.length > 0) {
      setSelectedBuses(worstBusesSorted.slice(0, DEFAULT_LARGE_CAP));
    }
   
  }, [data, isLargeFeeder]);

  const GRID_PAGE_SIZE = 24;
  useEffect(() => { setGridPage(0); }, [selectedBuses, busSearch, numBuses]);
  const totalGridPages = Math.max(1, Math.ceil(visibleBuses.length / GRID_PAGE_SIZE));
  const pagedBuses = useMemo(
    () => visibleBuses.slice(gridPage * GRID_PAGE_SIZE, (gridPage + 1) * GRID_PAGE_SIZE),
    [visibleBuses, gridPage]
  );

  const applyBusPreset = (preset: 'all' | 'violations' | 'top10' | 'top25' | 'dc') => {
    if (preset === 'all') setSelectedBuses([]);
    else if (preset === 'violations') setSelectedBuses(violatingBusNumbers.length ? violatingBusNumbers : [targetBus]);
    else if (preset === 'top10') setSelectedBuses(worstBusesSorted.slice(0, 10));
    else if (preset === 'top25') setSelectedBuses(worstBusesSorted.slice(0, 25));
    else if (preset === 'dc') setSelectedBuses([targetBus]);
  };

  const selectStyle = (accent: string): React.CSSProperties => ({
    background: '#fff', border: `2px solid ${accent}`, borderRadius: UI.radiusSm,
    padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer', fontWeight: 700, color: accent,
  });

  const groupLabelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 800, color: '#94a3b8', letterSpacing: '0.06em', marginBottom: 2,
  };

  const dcBusCandidates = DEFAULT_DC_BUSES[topology.toLowerCase()] ?? [];
  const multiDcNote = dcBusCandidates.length > 1
    ? `Paper default uses ${dcBusCandidates.length} datacenters on this feeder (buses ${dcBusCandidates.join(', ')}) — this app simulates one DC bus at a time, defaulted to the first.`
    : null;

  return (
    <div style={{ background: '#ffffff', color: '#0f172a', fontSize: 12 }}>

      <TourOverlay
        active={tour.active} currentStep={tour.currentStep}
        stepIndex={tour.stepIndex} totalSteps={tour.totalSteps}
        highlight={tour.highlight} waitingForData={tour.waitingForData}
        onNext={tour.goNext} onPrev={tour.goPrev} onSkip={tour.endTour}
      />

      {/* Header */}
      <div id="llm-header" style={{ border: `1px solid ${UI.border}`, borderRadius: UI.radius, background: '#f8fafc', padding: '18px 24px', marginBottom: 18, boxShadow: UI.shadow }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a', letterSpacing: '-0.01em' }}>LLM Grid Impact</div>
          {PAPER_MODE && (
            <div title="Replicas, batch, deadline, source voltage, taps and seed are fixed to the paper's IEEE-13 scenario"
              style={{ background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 999, padding: '2px 10px', fontSize: 10, fontWeight: 700, color: '#6d28d9' }}>
            </div>
          )}
          {PAPER_MODE && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', border: '1px solid #c4b5fd', borderRadius: 7, overflow: 'hidden' }}>
                {([['Paper preset', false], ['Customize', true]] as [string, boolean][]).map(([lbl, on]) => (
                  <button key={lbl} type="button" disabled={loading}
                    onClick={() => (on ? setCustomMode(true) : resetToPaper())}
                    style={{ border: 'none', padding: '4px 11px', fontSize: 11, fontWeight: 800, cursor: loading ? 'not-allowed' : 'pointer',
                      background: customMode === on ? '#6d28d9' : '#fff', color: customMode === on ? '#fff' : '#6d28d9' }}>
                    {lbl}
                  </button>
                ))}
              </div>
              {customMode && (
                <>
               
                </>
              )}
            </div>
          )}
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 999, padding: '2px 10px', fontSize: 10, fontWeight: 700, color: '#166534' }}>
            {topoLabel}
          </div>
          <button
            onClick={() => { localStorage.removeItem(TOUR_STORAGE_KEY); tour.startTour(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 5, border: '1px solid #cbd5e1', background: '#fff', borderRadius: UI.radiusSm, padding: '4px 10px', fontSize: 11, fontWeight: 700, color: '#64748b', cursor: 'pointer' }}>
            <BookOpen size={12} /> Tour
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, alignItems: 'flex-start' }}>

          {/* ── Data center / workload setup ─────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 24, borderRight: '1px solid #e2e8f0' }}>
            <div style={groupLabelStyle}>DATA CENTER / WORKLOAD SETUP</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>

              <div id="model-selector">
                <div style={{ color: '#7c3aed', fontSize: 9, fontWeight: 800, marginBottom: 4, letterSpacing: '0.04em' }}>TARGET MODEL</div>
                <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} style={selectStyle('#7c3aed')}>
                  {tracesReady
                    ? modelsForHardware.map(m => <option key={m.modelLabel} value={m.modelLabel}>{displayModelName(m.modelLabel)} ({m.numGpus} GPU{m.numGpus > 1 ? 's' : ''})</option>)
                    : <option value={selectedModel}>Loading...</option>
                  }
                </select>
              </div>

              <div id="hardware-selector">
                <div style={{ color: '#7c3aed', fontSize: 9, fontWeight: 800, marginBottom: 4, letterSpacing: '0.04em' }}>GPU HARDWARE</div>
                <select value={selectedHardware} onChange={e => setSelectedHardware(e.target.value as Hardware)} style={selectStyle('#7c3aed')}>
                  {HARDWARE_OPTIONS.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
               
              </div>

              <div id="batch-selector">
                <div style={{ color: '#7c3aed', fontSize: 9, fontWeight: 800, marginBottom: 4, letterSpacing: '0.04em' }}>BATCH SIZE (MAX_NUM_SEQS)</div>
                <select value={selectedBatch} disabled={PAPER_MODE && !customMode} onChange={e => setSelectedBatch(+e.target.value)} style={selectStyle('#7c3aed')}>
                  {availableBatches.map(b => <option key={b} value={b}>{b} seqs</option>)}
                </select>
              </div>

              <div id="replicas">
                <div style={{ color: '#94a3b8', fontSize: 9, fontWeight: 800, marginBottom: 4, letterSpacing: '0.04em' }}>REPLICAS</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #cbd5e1', borderRadius: UI.radiusSm, padding: '6px 10px' }}>
                  <Cpu size={14} color="#64748b" />
                  <CommitNumber value={numReplicas} min={1} disabled={PAPER_MODE && !customMode}
                    onCommit={n => { setAutoSize(false); setNumReplicas(Math.round(n)); }}
                    style={{ width: 64, border: 'none', outline: 'none', fontWeight: 700, fontSize: 12 }} />
                  <span style={{ color: '#94a3b8', fontSize: 10 }}>× {currentModel?.numGpus ?? 1} GPUs</span>
                </div>
                <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3 }}>
                  Defaulted as openg2g's initial_replicas for each model 
                </div>
              </div>

              <div id="latency-target">
                <div style={{ color: '#7c3aed', fontSize: 9, fontWeight: 800, marginBottom: 4, letterSpacing: '0.04em' }}>LATENCY TARGET (ITL DEADLINE)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#fff', border: '2px solid #7c3aed', borderRadius: UI.radiusSm, padding: '6px 10px' }}>
                    <CommitNumber value={Math.round(itlDeadlineOverrideMs)} min={1} disabled={PAPER_MODE && !customMode}
                      onCommit={setItlDeadlineOverrideMs}
                      style={{ width: 56, border: 'none', outline: 'none', fontWeight: 700, fontSize: 12, color: '#7c3aed' }} />
                    <span style={{ fontSize: 11, color: '#7c3aed', fontWeight: 700 }}>ms</span>
                  </div>
                  {currentModel?.itlDeadlineS != null && Math.round(itlDeadlineOverrideMs) !== Math.round(currentModel.itlDeadlineS * 1000) && (
                    <button
                      type="button"
                      onClick={() => setItlDeadlineOverrideMs(currentModel!.itlDeadlineS! * 1000)}
                      style={{ fontSize: 9, fontWeight: 700, color: '#7c3aed', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                    >
                      reset to default
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3, maxWidth: 170 }}>
                  {customMode ? 'Limits which batch sizes are allowed (baseline and OFO).' : 'Fixed by the paper preset.'} Default: {currentModel?.itlDeadlineS != null ? `${(currentModel.itlDeadlineS * 1000).toFixed(0)} ms` : '—'}.
                </div>
              </div>

              <div id="min-throughput">
                <div style={{ color: '#7c3aed', fontSize: 9, fontWeight: 800, marginBottom: 4, letterSpacing: '0.04em' }}>MIN THROUGHPUT (OPTIONAL)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#fff', border: '2px solid #7c3aed', borderRadius: UI.radiusSm, padding: '6px 10px' }}>
                  <input
                    type="number"
                    min={0}
                    value={minThroughput}
                    onChange={e => setMinThroughput(+e.target.value || 0)}
                    style={{ width: 64, border: 'none', outline: 'none', fontWeight: 700, fontSize: 12, color: '#7c3aed' }}
                  />
                  <span style={{ fontSize: 11, color: '#7c3aed', fontWeight: 700 }}>tok/s</span>
                </div>
                <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3, maxWidth: 170 }}>
                </div>
              </div>

            </div>
          </div>

          {/* ── Grid side setup ──────────────────────────────────────────── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={groupLabelStyle}>GRID SIDE SETUP</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>

              <div id="control-mode-selector">
                <div style={{ color: '#94a3b8', fontSize: 9, fontWeight: 800, marginBottom: 4, letterSpacing: '0.04em' }}>CONTROL MODE</div>
                <div style={{ display: 'flex', border: '2px solid #cbd5e1', borderRadius: UI.radiusSm, overflow: 'hidden' }}>
                  {CONTROL_MODES.map(m => {
                    const active = controlMode === m;
                    const meta = MODE_META[m];
                    return (
                      <button
                        key={m}
                        onClick={() => !loading && setControlMode(m)}
                        disabled={loading}
                        title={
                          m === 'ofo' ? 'Runs the simulation with OFO active — jointly regulates voltage and inter-token latency via batch size'
                          : m === 'ppo' ? 'Runs the simulation with the trained PPO batch-size policy active'
                          : 'Runs the simulation with no control'
                        }
                        style={{
                          background: active ? meta.color : '#fff',
                          color: active ? '#fff' : '#64748b',
                          border: 'none',
                          padding: '7px 14px',
                          fontSize: 11,
                          fontWeight: 800,
                          cursor: loading ? 'not-allowed' : 'pointer',
                          opacity: loading && !active ? 0.5 : 1,
                          display: 'flex', alignItems: 'center', gap: 5,
                          transition: 'background 0.12s ease, color 0.12s ease',
                        }}>
                        {runs[m] && <span style={{ width: 6, height: 6, borderRadius: '50%', background: active ? '#fff' : meta.color, display: 'inline-block' }} />}
                        {meta.short}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div id="bus-selector">
                <div style={{ color: '#0891b2', fontSize: 9, fontWeight: 800, marginBottom: 4, letterSpacing: '0.04em' }}>DATA CENTER BUS</div>
                <select value={targetBus} onChange={e => setTargetBus(+e.target.value)} style={selectStyle('#0891b2')}>
                  {Object.entries(busInfo).map(([n, b]) => (
                    <option key={n} value={n}>Bus {n} — {b.name}{b.baseLoad > 0 ? ` (${(b.baseLoad / 1000).toFixed(2)} MW base)` : ''}</option>
                  ))}
                </select>
                {multiDcNote && (
                  <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3, maxWidth: 220 }}>{multiDcNote}</div>
                )}
              </div>

              <div id="substation-voltage">
                <div style={{ color: '#94a3b8', fontSize: 9, fontWeight: 800, marginBottom: 4, letterSpacing: '0.04em' }}>SUBSTATION VOLTAGE (SCENARIO)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="range" min={0.90} max={1.10} step={0.001} value={substationVoltage}
                    disabled={PAPER_MODE}
                    onChange={e => setSubstationVoltage(parseFloat(e.target.value))}
                    style={{ width: 100, cursor: 'pointer', accentColor: '#0891b2' }} />
                  <div style={{ background: '#fff', border: `1px solid ${substationVoltage < 0.95 ? '#fca5a5' : substationVoltage > 1.05 ? '#fde68a' : '#cbd5e1'}`, borderRadius: UI.radiusSm, padding: '6px 10px', fontWeight: 800, fontSize: 12, color: substationVoltage < 0.95 ? '#ef4444' : substationVoltage > 1.05 ? '#f59e0b' : '#0f172a', minWidth: 58, textAlign: 'center' }}>
                    {substationVoltage.toFixed(3)}
                  </div>
                  {Math.abs(substationVoltage - DEFAULT_SUBSTATION_VOLTAGE) > 0.0005 && (
                    <button
                      type="button"
                      onClick={() => setSubstationVoltage(DEFAULT_SUBSTATION_VOLTAGE)}
                      style={{ fontSize: 9, fontWeight: 700, color: '#0891b2', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                    >
                      reset to {DEFAULT_SUBSTATION_VOLTAGE.toFixed(3)}
                    </button>
                  )}
                </div>
              </div>

            </div>
          </div>

          {/* ── Actions ──────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto', alignSelf: 'flex-end' }}>
            <div id="run-button">
              <button onClick={run} disabled={loading} style={{ background: loading ? '#cbd5e1' : MODE_META[controlMode].color, color: '#fff', border: 'none', borderRadius: UI.radiusSm, padding: '10px 28px', fontWeight: 800, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, boxShadow: loading ? 'none' : UI.shadow }}>
                <Play size={14} />
                {loading ? 'Running...' : `Run (${MODE_META[controlMode].short})`}
              </button>
            </div>
            {data && !loading && (
              <button onClick={handleReset} style={{ background: '#fff', color: '#64748b', border: '2px solid #e2e8f0', borderRadius: UI.radiusSm, padding: '10px 20px', fontWeight: 800, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                <RotateCcw size={14} /> Reset {MODE_META[controlMode].short}
              </button>
            )}
          </div>

        </div>
      </div>

      {error && (
        <div style={{ margin: '16px 24px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: UI.radius, padding: '10px 14px', display: 'flex', gap: 8 }}>
          <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0 }} />
          <span style={{ color: '#dc2626', fontSize: 12 }}>{error}</span>
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 0', gap: 16 }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid #e2e8f0', borderTopColor: MODE_META[controlMode].color, animation: 'spin 0.8s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{ color: '#64748b', fontSize: 12 }}>Running {MODE_META[controlMode].label} simulation with real {displayModelName(selectedModel)} trace on {topoLabel}...</div>
        </div>
      )}

      {runsComparison && !loading && (
        <div style={{ margin: '16px 24px 0', background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: UI.radius, padding: '12px 18px', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: '#6d28d9' }}>
          <div style={{ fontWeight: 800 }}>Controller comparison (same data-center config):</div>
          <div>Violation rate — {runsComparison.present.map(m => `${MODE_META[m].short}: ${fmt(runsComparison.summaries[m].violPct, 1)}%`).join(' · ')}</div>
          <div>Buses violated — {runsComparison.present.map(m => `${MODE_META[m].short}: ${runsComparison.summaries[m].bussesViolated}/${numBuses}`).join(' · ')}</div>
          <div>Worst voltage — {runsComparison.present.map(m => `${MODE_META[m].short}: ${fmt(runsComparison.summaries[m].worstV, 4)}`).join(' · ')}</div>
        </div>
      )}

      {runsComparison && runsOverlaySeries.series.length > 0 && !loading && (
        <div style={{ margin: '16px 24px 0', background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: UI.radius, padding: '16px 20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 4 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: '#6d28d9' }}>
              Controller comparison — Bus {graphBus} voltage over time
            </div>
            <div>
              <select value={graphBus} onChange={e => setGraphBus(+e.target.value)} style={{ background: '#fff', border: '2px solid #c4b5fd', borderRadius: UI.radiusSm, padding: '5px 10px', fontSize: 11, outline: 'none', cursor: 'pointer', fontWeight: 700, color: '#6d28d9' }}>
                {Object.entries(busInfo).map(([n, b]) => (
                  <option key={n} value={n}>Bus {n} — {b.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ height: 160 }}>
            <ResponsiveContainer width="100%" height="100%" minHeight={100}>
              <LineChart data={runsOverlaySeries.series} margin={{ top: 8, right: 20, bottom: 4, left: 10 }}>
                <XAxis dataKey="t" stroke="#94a3b8" tick={{ fontSize: 9 }} tickFormatter={v => `${v}s`} />
                <YAxis stroke="#94a3b8" tick={{ fontSize: 9 }} domain={[0.9, 1.1]} tickFormatter={v => v.toFixed(2)} />
                <ReferenceLine y={0.95} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
                <ReferenceLine y={1.05} stroke="#f59e0b" strokeDasharray="3 3" strokeWidth={1} />
                <Tooltip content={<RunsOverlayTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {runsOverlaySeries.present.map(m => (
                  <Line key={m} type="monotone" dataKey={`${m}Run`} name={MODE_META[m].short} stroke={MODE_META[m].color} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {!data && !loading && !error && (
        <div style={{ padding: '48px 24px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
          {MODE_META[controlMode].short} hasn't been run yet — configure the data center above and hit Run.
          {otherModesWithData.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {otherModesWithData.map(m => MODE_META[m].short).join(' and ')} already {otherModesWithData.length > 1 ? 'have' : 'has'} results — switch the toggle above to view {otherModesWithData.length > 1 ? 'them' : 'it'}, or run {MODE_META[controlMode].short} to compare.
            </div>
          )}
        </div>
      )}

      {data && !loading && (
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ background: MODE_META[controlMode].bg, border: `1px solid ${MODE_META[controlMode].color}`, borderRadius: UI.radius, padding: '10px 16px', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: MODE_META[controlMode].color }}>{MODE_META[controlMode].label}</div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Feeder: <strong>{topoLabel}</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Model: <strong>{displayModelName(data.modelLabel)}</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>GPUs/replica: <strong>{data.numGpus}</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Batch: <strong>{data.maxNumSeqs} seqs</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Replicas: <strong>{data.numReplicas}</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Total GPUs: <strong>{data.numGpus * data.numReplicas}</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Source: <strong>ML.ENERGY Benchmark v3 ({inferHardware(data.modelLabel)})</strong></div>
          </div>

          <CollapsibleCard
            title={`Time through Power Trace — ${MODE_META[controlMode].short}`}
            defaultOpen={false}
            summary={
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 11, fontWeight: 700, background: '#ecfeff', color: '#0891b2', border: '1px solid #cffaff', padding: '2px 6px', borderRadius: 4 }}>
                  {playSpeed}× speed
                </span>
                <span style={{ fontSize: 12, fontWeight: 800, color: MODE_META[controlMode].color }}>
                  t = {snap ? safeFixed(snap.time, 2) : '—'}s
                </span>
                {snap && (
                  <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600 }}>
                    {safeFixed(snap.gpu_power_kW / 1000, 3)} MW
                  </span>
                )}
              </div>
            }
          >
            <div id="timeline-scrubber">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                <button
                  onClick={() => { setIsPlaying(false); setSelIdx(i => Math.max(0, i - 1)); }}
                  disabled={safeSelIdx === 0}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: safeSelIdx === 0 ? 'not-allowed' : 'pointer', border: '1px solid #cbd5e1', background: '#fff', borderRadius: UI.radiusSm, padding: '6px 10px', fontSize: 11, fontWeight: 700, color: safeSelIdx === 0 ? '#cbd5e1' : '#0f172a' }}
                >
                  <ChevronLeft size={16} /> PREV
                </button>

                <button
                  onClick={togglePlay}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: isPlaying ? '#0c4a6e' : MODE_META[controlMode].color, color: '#fff', border: 'none', borderRadius: UI.radiusSm, padding: '8px 20px', fontWeight: 800, fontSize: 13, cursor: 'pointer', minWidth: 110, justifyContent: 'center' }}
                >
                  {isPlaying ? <><Pause size={14} /> Pause</> : <><Play size={14} /> {atEnd ? 'Replay' : 'Play'}</>}
                </button>

                <button
                  onClick={() => { setIsPlaying(false); setSelIdx(i => Math.min(timeSeries.length - 1, i + 1)); }}
                  disabled={atEnd}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: atEnd ? 'not-allowed' : 'pointer', border: '1px solid #cbd5e1', background: '#fff', borderRadius: UI.radiusSm, padding: '6px 10px', fontSize: 11, fontWeight: 700, color: atEnd ? '#cbd5e1' : '#0f172a' }}
                >
                  NEXT <ChevronRight size={16} />
                </button>

                <div style={{ flex: 1 }} />

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700 }}>SPEED:</span>
                  {[2, 4, 8].map(s => (
                    <button
                      key={s}
                      onClick={() => setPlaySpeed(s)}
                      style={{ border: `1px solid ${playSpeed === s ? '#0891b2' : '#cbd5e1'}`, background: playSpeed === s ? '#ecfeff' : '#fff', color: playSpeed === s ? '#0891b2' : '#64748b', borderRadius: 4, padding: '4px 8px', fontSize: 10, fontWeight: playSpeed === s ? 800 : 600, cursor: 'pointer' }}
                    >
                      {s}×
                    </button>
                  ))}
                </div>

                <div style={{ textAlign: 'right', minWidth: 200 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: MODE_META[controlMode].color }}>
                    t = {snap ? safeFixed(snap.time, 2) : '—'}s
                  </div>
                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                    {snap
                      ? `${safeFixed(snap.gpu_power_kW / 1000, 3)} MW injected · raw: ${safeFixed((snap.gpu_power_raw_kW ?? snap.gpu_power_kW) / 1000, 3)} MW`
                        + (snap.batch_by_model && Object.keys(snap.batch_by_model).length
                            ? ' · batch: ' + Object.entries(snap.batch_by_model).map(([k, v]) => `${k}=${v}`).join(', ')
                            : '')
                      : ''}
                  </div>
                </div>
              </div>

              <div style={{ position: 'relative', height: 4, background: '#e2e8f0', borderRadius: 2, marginBottom: 6 }}>
                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${timeSeries.length > 1 ? (safeSelIdx / (timeSeries.length - 1)) * 100 : 0}%`, background: MODE_META[controlMode].color, borderRadius: 2, transition: 'width 0.15s' }} />
              </div>

              <input
                type="range"
                min={0}
                max={Math.max(0, timeSeries.length - 1)}
                value={safeSelIdx}
                onChange={e => { setIsPlaying(false); setSelIdx(+e.target.value); }}
                style={{ width: '100%', height: 6, cursor: 'pointer', accentColor: MODE_META[controlMode].color }}
              />
            </div>
          </CollapsibleCard>

          {/* Bus filter — controls which cards show in the grid below. */}
          <CollapsibleCard
            title="Filter Buses"
            subtitle="Choose which buses appear in the grid below"
            defaultOpen={false}
            summary={
              <span style={{ fontSize: 11, fontWeight: 600, color: '#334155' }}>
                {selectedBuses.length === 0 ? `All ${numBuses} shown` : `${visibleBuses.length} of ${numBuses} shown`}
              </span>
            }
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', fontSize: 11, fontWeight: 700 }}>
                  <Filter size={13} /> {selectedBuses.length === 0 ? `All ${numBuses} buses shown` : `${visibleBuses.length} of ${numBuses} buses shown`}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {isLargeFeeder && (
                    <input
                      type="text"
                      placeholder="Search bus # or name..."
                      value={busSearch}
                      onChange={e => setBusSearch(e.target.value)}
                      style={{ fontSize: 11, padding: '5px 10px', borderRadius: UI.radiusSm, border: '1px solid #cbd5e1', outline: 'none', width: 160 }}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => applyBusPreset('top25')}
                    style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: UI.radiusSm, border: '1px solid #cbd5e1', background: '#ffffff', color: '#475569', cursor: 'pointer' }}
                  >
                    Worst 25
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedBuses([])}
                    style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: UI.radiusSm, border: '1px solid #cbd5e1', background: selectedBuses.length === 0 ? '#f0f9ff' : '#ffffff', color: selectedBuses.length === 0 ? '#0369a1' : '#475569', cursor: 'pointer' }}
                  >
                    Show all
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedBuses(violatingBusNumbers)}
                    disabled={violatingBusNumbers.length === 0}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: UI.radiusSm, border: '1px solid #fca5a5', background: '#fff', color: violatingBusNumbers.length === 0 ? '#fca5a5' : '#dc2626', cursor: violatingBusNumbers.length === 0 ? 'not-allowed' : 'pointer' }}
                  >
                    <AlertTriangle size={11} /> Violations only
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: isLargeFeeder ? 160 : 'none', overflowY: isLargeFeeder ? 'auto' : 'visible', padding: isLargeFeeder ? 4 : 0 }}>
                {busTimeSeries.map(bus => {
                  const isActive = selectedBuses.length === 0 || selectedBuses.includes(bus.bus);
                  const isTarget = bus.isTarget;
                  const hasViol = bus.violations > 0;

                  return (
                    <button
                      key={bus.bus}
                      type="button"
                      onClick={() => {
                        setSelectedBuses(prev => {
                          const base = prev.length === 0 ? busTimeSeries.map(b => b.bus) : prev;
                          return base.includes(bus.bus) ? base.filter(b => b !== bus.bus) : [...base, bus.bus];
                        });
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '5px 10px',
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                        userSelect: 'none',
                        border: isActive
                          ? isTarget ? '1px solid #2563eb' : hasViol ? '1px solid #ef4444' : '1px solid #0284c7'
                          : '1px solid #e2e8f0',
                        backgroundColor: isActive
                          ? isTarget ? '#eff6ff' : hasViol ? '#fef2f2' : '#f0f9ff'
                          : '#ffffff',
                        color: isActive
                          ? isTarget ? '#1e40af' : hasViol ? '#b91c1c' : '#0369a1'
                          : '#cbd5e1',
                        transition: 'all 0.12s ease',
                      }}
                    >
                      <span>Bus {bus.bus}</span>
                      {isTarget && (
                        <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3, backgroundColor: isActive ? '#2563eb' : '#cbd5e1', color: '#ffffff' }}>
                          DC
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </CollapsibleCard>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontWeight: 800, fontSize: 13, color: '#0f172a' }}>Bus Voltage Panels</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontSize: 10, color: '#94a3b8' }}>
                  {visibleBuses.length === 0
                    ? `0 of ${numBuses} shown`
                    : `Showing ${gridPage * GRID_PAGE_SIZE + 1}–${Math.min((gridPage + 1) * GRID_PAGE_SIZE, visibleBuses.length)} of ${visibleBuses.length}`}
                  {' · click a card to graph it above'}
                </div>
                {totalGridPages > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      onClick={() => setGridPage(p => Math.max(0, p - 1))}
                      disabled={gridPage === 0}
                      style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: UI.radiusSm, padding: '4px 8px', cursor: gridPage === 0 ? 'not-allowed' : 'pointer', color: gridPage === 0 ? '#cbd5e1' : '#0f172a' }}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', minWidth: 56, textAlign: 'center' }}>
                      Page {gridPage + 1} / {totalGridPages}
                    </span>
                    <button
                      onClick={() => setGridPage(p => Math.min(totalGridPages - 1, p + 1))}
                      disabled={gridPage >= totalGridPages - 1}
                      style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: UI.radiusSm, padding: '4px 8px', cursor: gridPage >= totalGridPages - 1 ? 'not-allowed' : 'pointer', color: gridPage >= totalGridPages - 1 ? '#cbd5e1' : '#0f172a' }}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {isLargeFeeder && selectedBuses.length > 0 && (
              <div style={{ fontSize: 10, color: '#7c3aed', marginBottom: 8 }}>
                Showing the {selectedBuses.length} worst buses by default for this feeder size — use "Show all" above to see every bus.
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', alignItems: 'center', fontSize: 10, color: '#475569', background: '#f8fafc', border: `1px solid ${UI.border}`, borderRadius: UI.radiusSm, padding: '8px 12px', marginBottom: 12 }}>
              <span style={{ fontWeight: 800, color: '#94a3b8', letterSpacing: '0.03em', fontSize: 9 }}>READING THE MINI CHARTS:</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 16, height: 2, background: '#16a34a', display: 'inline-block', borderRadius: 1 }} />
                Live voltage this run (red if violating)
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="16" height="2"><line x1="0" y1="1" x2="16" y2="1" stroke={BASELINE_COLOR} strokeWidth="1.5" strokeDasharray="3 2" /></svg>
                No-load baseline (no DC connected)
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="16" height="2"><line x1="0" y1="1" x2="16" y2="1" stroke="#ef4444" strokeWidth="1.5" strokeDasharray="3 2" /></svg>
                0.95 p.u. under-voltage limit
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="16" height="2"><line x1="0" y1="1" x2="16" y2="1" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="3 2" /></svg>
                1.05 p.u. over-voltage limit
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 1.5, height: 12, background: '#94a3b8', display: 'inline-block' }} />
                Current scrubber position
              </span>
            </div>

            {visibleBuses.length === 0 ? (
              <div style={{ padding: '32px 0', textAlign: 'center', color: '#94a3b8', fontSize: 12, background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: UI.radius }}>
                No buses match the current filter — adjust the selection above.
              </div>
            ) : (
              <div id="bus-grid" style={{ display: 'grid', gridTemplateColumns: busGridCols, gap: 12 }}>
                {pagedBuses.map(bus => {
                  const hasViolations = bus.violations > 0;
                  const isGraphed = bus.bus === graphBus;
                  const borderColor = isGraphed ? '#0891b2' : bus.isTarget ? MODE_META[controlMode].color : hasViolations ? '#fca5a5' : '#e2e8f0';
                  const borderWidth = isGraphed || bus.isTarget ? 2 : hasViolations ? 1.5 : 1;
                  const bgColor     = bus.isTarget ? MODE_META[controlMode].bg  : hasViolations ? '#fef2f2'  : '#ffffff';
                  const busV = snapVoltage(snap, bus.bus - 1);
                  const busName = busInfo[bus.bus]?.name ?? String(bus.bus);
                  return (
                    <div
                      key={bus.bus}
                      onClick={() => setGraphBus(bus.bus)}
                      title={`Inspect Bus ${bus.bus} in the detail chart above`}
                      style={{
                        background: bgColor,
                        border: `${borderWidth}px solid ${borderColor}`,
                        boxShadow: isGraphed ? `0 0 0 3px ${MODE_META[controlMode].color}22` : 'none',
                        borderRadius: UI.radius,
                        padding: '12px',
                        cursor: 'pointer',
                        transition: 'box-shadow 0.12s ease, border-color 0.12s ease',
                      }}
                    >
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                          <span style={{ fontWeight: 800, fontSize: 13, color: bus.isTarget ? MODE_META[controlMode].color : '#0f172a' }}>
                            Bus {bus.bus}
                          </span>
                          {hasViolations && (
                            <span style={{ background: '#fef2f2', color: '#ef4444', fontSize: 9, fontWeight: 800, padding: '2px 5px', borderRadius: 4, border: '1px solid #fca5a5' }}>
                              {safeFixed((bus.violations / data.numSamples) * 100, 1)}% Viol.
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 4, color: bus.isTarget ? MODE_META[controlMode].color : '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {busName}
                          {bus.isTarget && <span style={{ marginLeft: 4, background: MODE_META[controlMode].color, color: '#fff', fontSize: 8, fontWeight: 800, padding: '1px 4px', borderRadius: 3 }}>DC</span>}
                          {isGraphed && !bus.isTarget && <span style={{ marginLeft: 4, background: '#0891b2', color: '#fff', fontSize: 8, fontWeight: 800, padding: '1px 4px', borderRadius: 3 }}>VIEWING</span>}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#94a3b8' }}>
                          <span>Min: {safeFixed(bus.minV, 4)}</span>
                          <span>Max: {safeFixed(bus.maxV, 4)}</span>
                        </div>
                        {bus.baseV != null && (
                          <div style={{ fontSize: 9, color: BASELINE_COLOR, marginTop: 2 }}>No-load: {safeFixed(bus.baseV, 4)}</div>
                        )}
                      </div>
                      <div style={{ height: 108 }}>
                        <ResponsiveContainer width="100%" height="100%" minHeight={88}>
                          {(() => {
                            const vs = bus.series.map(s => s.v).filter(v => v != null && isFinite(v));
                            const dataMin = vs.length ? Math.min(...vs) : 1.0;
                            const dataMax = vs.length ? Math.max(...vs) : 1.0;
                            const lo = bus.baseV != null ? Math.min(dataMin, bus.baseV) : dataMin;
                            const hi = bus.baseV != null ? Math.max(dataMax, bus.baseV) : dataMax;
                            const range = hi - lo;
                            const pad = Math.max(range * 0.2, 0.005);
                            const yLo = lo - pad, yHi = hi + pad;
                            const yMid = (yLo + yHi) / 2;
                            const tFirst = bus.series[0]?.t ?? 0;
                            const tLast = bus.series[bus.series.length - 1]?.t ?? 0;
                            return (
                              <LineChart data={bus.series} margin={{ top: 4, right: 6, bottom: 2, left: 2 }}
                                onClick={(e: any) => { const idx = e?.activePayload?.[0]?.payload?._i; if (idx != null) { setIsPlaying(false); setSelIdx(idx); } }}
                                style={{ cursor: 'pointer' }}>
                                <XAxis
                                  dataKey="t"
                                  tick={{ fontSize: 8, fill: '#94a3b8' }}
                                  ticks={[tFirst, tLast]}
                                  tickFormatter={v => `${Math.round(v)}s`}
                                  axisLine={{ stroke: '#e2e8f0' }}
                                  tickLine={false}
                                  height={14}
                                />
                                <YAxis
                                  domain={[yLo, yHi]}
                                  ticks={[yLo, yMid, yHi]}
                                  tick={{ fontSize: 8, fill: '#94a3b8' }}
                                  tickFormatter={v => v.toFixed(3)}
                                  axisLine={{ stroke: '#e2e8f0' }}
                                  tickLine={false}
                                  width={34}
                                />
                                <Tooltip content={<MiniTooltip />} />
                                <ReferenceLine y={0.95} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
                                <ReferenceLine y={1.05} stroke="#f59e0b" strokeDasharray="3 3" strokeWidth={1} />
                                <ReferenceLine y={1.0}  stroke="#cbd5e1" strokeWidth={1} />
                                {snap && <ReferenceLine x={snap.time} stroke={bus.isTarget ? MODE_META[controlMode].color : '#94a3b8'} strokeWidth={1.5} opacity={0.7} />}
                                {bus.baseV != null && (
                                  <Line type="monotone" dataKey="baseline" stroke={BASELINE_COLOR} strokeWidth={1} strokeDasharray="3 2" dot={false} isAnimationActive={false} connectNulls />
                                )}
                                <Line type="monotone" dataKey="v" stroke={bus.isTarget ? MODE_META[controlMode].color : hasViolations ? '#ef4444' : '#16a34a'} strokeWidth={bus.isTarget ? 2 : 1.5} dot={false} isAnimationActive={false} />
                              </LineChart>
                            );
                          })()}
                        </ResponsiveContainer>
                      </div>
                      {snap && busV != null && (
                        <div style={{ marginTop: 4, textAlign: 'center', fontSize: 11, fontWeight: 800, color: busV < 0.95 ? '#ef4444' : busV > 1.05 ? '#f59e0b' : '#16a34a' }}>
                          {safeFixed(busV, 4)} p.u.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <CollapsibleCard
            title="Bus Voltage Detail"
            subtitle={`No-load baseline vs. ${MODE_META[controlMode].short} — pick a bus to inspect`}
            defaultOpen={false}
            summary={
              graphBusStats && (
                <span style={{ fontSize: 11, fontWeight: 600, color: (graphBusStats.underPct + graphBusStats.overPct) > 0 ? '#ef4444' : '#16a34a' }}>
                  Bus {graphBus} · Violations: {safeFixed(graphBusStats.underPct + graphBusStats.overPct, 1)}%
                </span>
              )
            }
          >
            <div id="bus-graph-detail" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: UI.radius, padding: UI.panelPad }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 800, letterSpacing: '0.04em' }}>GRAPH BUS</span>
                  <span style={{ fontSize: 9, color: '#94a3b8' }}>· tip: click any bus card below to inspect it here</span>
                </div>
                <select value={graphBus} onChange={e => setGraphBus(+e.target.value)} style={{ background: '#fff', border: '2px solid #cbd5e1', borderRadius: UI.radiusSm, padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer', fontWeight: 700, color: '#0f172a' }}>
                  {Object.entries(busInfo).map(([n, b]) => (
                    <option key={n} value={n}>Bus {n} — {b.name}{b.baseLoad > 0 ? ` (${(b.baseLoad / 1000).toFixed(2)} MW base)` : ''}</option>
                  ))}
                </select>
              </div>

              {graphBusStats && (
                <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', marginBottom: 10, fontSize: 11, color: '#475569' }}>
                  <span>Min: <strong>{safeFixed(graphBusStats.minV, 4)}</strong></span>
                  <span>Max: <strong>{safeFixed(graphBusStats.maxV, 4)}</strong></span>
                  <span>Violation rate: <strong style={{ color: (graphBusStats.underPct + graphBusStats.overPct) > 0 ? '#ef4444' : '#16a34a' }}>{safeFixed(graphBusStats.underPct + graphBusStats.overPct, 1)}%</strong></span>
                </div>
              )}

              <div style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%" minHeight={120}>
                  <LineChart data={graphOverlaySeries} margin={{ top: 8, right: 20, bottom: 4, left: 10 }}>
                    <XAxis dataKey="t" stroke="#94a3b8" tick={{ fontSize: 9 }} tickFormatter={v => `${v}s`} />
                    <YAxis stroke="#94a3b8" tick={{ fontSize: 9 }} domain={[0.9, 1.1]} tickFormatter={v => v.toFixed(2)} />
                    <ReferenceLine y={0.95} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
                    <ReferenceLine y={1.05} stroke="#f59e0b" strokeDasharray="3 3" strokeWidth={1} />
                    {snap && <ReferenceLine x={snap.time} stroke={MODE_META[controlMode].color} strokeWidth={1.5} opacity={0.7} />}
                    <Tooltip content={<OverlayTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Line type="monotone" dataKey="baseline" name="No-load baseline" stroke={BASELINE_COLOR} strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
                    <Line type="monotone" dataKey="withLoad" name={`With ${MODE_META[controlMode].short}`} stroke={LOAD_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </CollapsibleCard>

          {/* ── Tradeoff Timeline — overlays every controller run: batch → power → voltage → ITL / throughput ── */}
          {data.substationV != null && Math.abs(data.substationV - substationVoltage) > 0.0005 && (
            <div style={{ fontSize: 10, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '4px 8px' }}>
              This run used substation {data.substationV.toFixed(3)} p.u. but the slider is at {substationVoltage.toFixed(3)}.
              Rerun to keep the no-load comparison consistent.
            </div>
          )}
          <TradeoffTimeline
            runs={runs}
            activeMode={controlMode}
            targetBus={targetBus}
            snapTime={snap?.time}
            modelLabel={data.modelLabel}
            itlDeadlineMs={itlDeadlineOverrideMs}
            minThroughput={minThroughput}
            baselineVoltages={effectiveBaseline}
            feasibleBatchSizes={currentModel?.feasibleBatchSizes}
          />

          <PowerThroughputCurveMemo
            runs={runs}
            activeMode={controlMode}
            modelLabel={data.modelLabel}
            numReplicas={data.numReplicas}
            snapTime={snap?.time}
            itlDeadlineMs={itlDeadlineOverrideMs}
          />

          <CollapsibleCard
            title={`Data Center & System Performance — Bus ${targetBus}`}
            subtitle={`${MODE_META[controlMode].short} vs No-Load Baseline Analytics`}
            defaultOpen={false}
            summary={
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                {targetWithLoadStats && (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 4,
                    backgroundColor: targetWithLoadStats.violPct > 0 ? '#fef2f2' : '#f0fdf4',
                    color: targetWithLoadStats.violPct > 0 ? '#ef4444' : '#16a34a',
                    border: `1px solid ${targetWithLoadStats.violPct > 0 ? '#fca5a5' : '#bbf7d0'}`
                  }}>
                    {safeFixed(targetWithLoadStats.violPct, 1)}% Target Violations
                  </span>
                )}
                <span style={{ fontSize: 11, fontWeight: 700, color: data.minVoltage < 0.95 ? '#ef4444' : '#64748b' }}>
                  Worst V: {safeFixed(data.minVoltage, 4)} p.u.
                </span>
              </div>
            }
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ background: '#f8fafc', border: `1px solid ${BASELINE_COLOR}`, borderRadius: UI.radius, padding: '14px 18px' }}>
                  <div style={{ fontWeight: 800, fontSize: 12, color: BASELINE_COLOR, marginBottom: 8 }}>No-load baseline — Bus {targetBus}</div>
                  {targetBaselineStats ? (
                    <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>VOLTAGE</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: targetBaselineStats.violating ? '#ef4444' : '#0f172a' }}>{safeFixed(targetBaselineStats.v, 4)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>STATUS</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: targetBaselineStats.violating ? '#ef4444' : '#16a34a' }}>{targetBaselineStats.violating ? 'Out of bounds' : 'Within bounds'}</div>
                      </div>
                    </div>
                  ) : <div style={{ fontSize: 11, color: '#94a3b8' }}>Baseline snapshot not available yet.</div>}
                </div>

                <div style={{ background: MODE_META[controlMode].bg, border: `2px solid ${MODE_META[controlMode].color}`, borderRadius: UI.radius, padding: '14px 18px' }}>
                  <div style={{ fontWeight: 800, fontSize: 12, color: MODE_META[controlMode].color, marginBottom: 8 }}>{MODE_META[controlMode].short} — Bus {targetBus}</div>
                  {targetWithLoadStats ? (
                    <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>VIOLATION RATE</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: targetWithLoadStats.violPct > 0 ? '#ef4444' : '#16a34a' }}>{safeFixed(targetWithLoadStats.violPct, 1)}%</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>WORST VOLTAGE</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: Math.abs(targetWithLoadStats.worst - 1) > 0.05 ? '#ef4444' : '#0f172a' }}>{safeFixed(targetWithLoadStats.worst, 4)}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700 }}>RANGE</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>{safeFixed(targetWithLoadStats.minV, 4)} – {safeFixed(targetWithLoadStats.maxV, 4)}</div>
                      </div>
                    </div>
                  ) : <div style={{ fontSize: 11, color: '#94a3b8' }}>No data for this bus.</div>}
                </div>
              </div>

              {systemComparison && (
                <div style={{ background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: UI.radius, padding: '12px 18px', display: 'flex', gap: 28, flexWrap: 'wrap', fontSize: 11, color: '#6d28d9' }}>
                  <div>Buses with ≥1 violation — No-load: <strong>{systemComparison.baseBusesViolated}/{systemComparison.totalBuses}</strong> · {MODE_META[controlMode].short}: <strong>{systemComparison.loadBusesViolated}/{systemComparison.totalBuses}</strong></div>
                  <div>Worst voltage seen — No-load: <strong>{safeFixed(systemComparison.baseWorst, 4)}</strong> · {MODE_META[controlMode].short}: <strong>{safeFixed(systemComparison.loadWorst, 4)}</strong></div>
                </div>
              )}

              {(() => {
                const totalViolPct = violStats.length
                  ? (violStats.reduce((s, b) => s + b.under + b.over, 0) / (violStats.length * data.numSamples) * 100) : 0;
                const bussesViolated = violStats.filter(b => b.under + b.over > 0).length;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: UI.radius, padding: '12px 14px' }}>
                      <div style={{ color: '#64748b', fontSize: 9, fontWeight: 800, marginBottom: 6 }}>DURATION</div>
                      <div style={{ color: '#0f172a', fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{safeFixed(data.duration, 1)}s</div>
                      <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 4 }}>{data.numSamples} samples</div>
                    </div>
                    <div style={{ background: data.minVoltage < 0.95 ? '#fef2f2' : '#f8fafc', border: `1px solid ${data.minVoltage < 0.95 ? '#fca5a5' : '#e2e8f0'}`, borderRadius: UI.radius, padding: '12px 14px' }}>
                      <div style={{ color: data.minVoltage < 0.95 ? '#dc2626' : '#64748b', fontSize: 9, fontWeight: 800, marginBottom: 6 }}>WORST VOLTAGE</div>
                      <div style={{ color: data.minVoltage < 0.95 ? '#ef4444' : '#0f172a', fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{safeFixed(data.minVoltage, 4)}</div>
                      <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 4 }}>{data.minVoltage < 0.95 ? '⚠ Under-voltage' : 'Within bounds'}</div>
                    </div>
                    <div style={{ background: totalViolPct > 0 ? '#fef2f2' : '#f0fdf4', border: `1px solid ${totalViolPct > 0 ? '#fca5a5' : '#bbf7d0'}`, borderRadius: UI.radius, padding: '12px 14px' }}>
                      <div style={{ color: totalViolPct > 0 ? '#dc2626' : '#166534', fontSize: 9, fontWeight: 800, marginBottom: 6 }}>VIOLATION RATE</div>
                      <div style={{ color: totalViolPct > 0 ? '#ef4444' : '#16a34a', fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{safeFixed(totalViolPct, 1)}%</div>
                      <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 4 }}>{bussesViolated} of {numBuses} buses</div>
                    </div>
                    <div style={{ background: MODE_META[controlMode].bg, border: `2px solid ${MODE_META[controlMode].color}`, borderRadius: UI.radius, padding: '12px 14px' }}>
                      <div style={{ color: MODE_META[controlMode].color, fontSize: 9, fontWeight: 800, marginBottom: 6 }}>DATA CENTER ({MODE_META[controlMode].short})</div>
                      <div style={{ color: MODE_META[controlMode].color, fontSize: 16, fontWeight: 800, lineHeight: 1.2 }}>
                        Bus {targetBus}<br/>
                        <span style={{ fontSize: 12 }}>{busInfo[targetBus]?.name}</span>
                      </div>
                      <div style={{ color: MODE_META[controlMode].color, fontSize: 10, marginTop: 4 }}>
                        GPU Cluster size: {data.numReplicas * data.numGpus}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </CollapsibleCard>

          <CollapsibleCard
            title={`Voltage Violation Frequency by Bus — ${MODE_META[controlMode].short}`}
            subtitle="% of timesteps outside 0.95–1.05 p.u."
            defaultOpen={false}
            summary={
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 10 }}>
                <span style={{ fontWeight: 700, color: violatingBusNumbers.length > 0 ? '#ef4444' : '#16a34a' }}>
                  {violatingBusNumbers.length} of {numBuses} buses violating
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 8, height: 8, background: '#ef4444', borderRadius: 2, display: 'inline-block' }} /> Under
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 8, height: 8, background: '#f59e0b', borderRadius: 2, display: 'inline-block' }} /> Over
                </span>
              </div>
            }
          >
            <div id="violation-chart" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: UI.radius, padding: UI.panelPad, overflowX: numBuses > 40 ? 'auto' : 'visible' }}>
              <div style={{ height: violChartHeight, minWidth: numBuses > 40 ? numBuses * 22 : '100%' }}>
                <ResponsiveContainer width="100%" height="100%" minHeight={80}>
                  <BarChart data={violStats} margin={{ top: 8, right: 20, bottom: violBottomMargin, left: 10 }}>
                    <XAxis
                      dataKey="bus"
                      stroke="#64748b"
                      tick={{ fontSize: xAxisTickFontSize }}
                      tickFormatter={v => `B${v}`}
                      interval={xAxisTickInterval}
                      angle={xAxisTickAngle}
                      textAnchor={xAxisTextAnchor}
                      height={xAxisHeight}
                      label={{ value: 'Bus Number', position: 'insideBottom', offset: violLabelOffset, fontSize: 10, fill: '#64748b' }}
                    />
                    <YAxis stroke="#64748b" tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                    <Tooltip content={<ViolTooltip />} cursor={{ fill: '#f1f5f9' }} />
                    <ReferenceLine y={0} stroke="#cbd5e1" />
                    <Bar dataKey="underPct" stackId="a">
                      {violStats.map(entry => (
                        <Cell
                          key={`u-${entry.bus}`}
                          fill={entry.underPct > 0 ? '#ef4444' : '#e2e8f0'}
                          stroke={entry.isTarget ? MODE_META[controlMode].color : 'none'}
                          strokeWidth={entry.isTarget ? 2 : 0}
                        />
                      ))}
                    </Bar>
                    <Bar dataKey="overPct" stackId="a" radius={[4, 4, 0, 0]}>
                      {violStats.map(entry => (
                        <Cell
                          key={`o-${entry.bus}`}
                          fill={entry.overPct > 0 ? '#f59e0b' : '#e2e8f0'}
                          stroke={entry.isTarget ? MODE_META[controlMode].color : 'none'}
                          strokeWidth={entry.isTarget ? 2 : 0}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </CollapsibleCard>

          {powerChartData.length > 0 && (
            <CollapsibleCard
              title={`GPU Power Trace (ML.ENERGY ${inferHardware(data.modelLabel)})`}
              subtitle={`${displayModelName(data.modelLabel)} · ${data.maxNumSeqs} seqs · ${data.numReplicas} replica${data.numReplicas > 1 ? 's' : ''}`}
              defaultOpen={false}
              summary={
                <span style={{ fontSize: 11, fontWeight: 600, color: '#7c3aed', background: '#f5f3ff', padding: '2px 8px', borderRadius: 4 }}>
                  {powerChartData.length} data points
                </span>
              }
            >
              <div style={{ background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: UI.radius, padding: UI.panelPad }}>
                <div style={{ height: 120 }}>
                  <ResponsiveContainer width="100%" height="100%" minHeight={80}>
                    <LineChart data={powerChartData} margin={{ top: 4, right: 20, bottom: 4, left: 10 }}>
                      <XAxis dataKey="t" stroke="#94a3b8" tick={{ fontSize: 9 }} tickFormatter={v => `${v}s`} />
                      <YAxis stroke="#94a3b8" tick={{ fontSize: 9 }} tickFormatter={v => `${v.toFixed(2)}MW`} />
                      <ReferenceLine x={snap?.time} stroke={MODE_META[controlMode].color} strokeWidth={1.5} opacity={0.7} />
                      <Line type="monotone" dataKey="kw" stroke="#7c3aed" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </CollapsibleCard>
          )}

        </div>
      )}
    </div>
  );
}