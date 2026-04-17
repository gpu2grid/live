import React, { useState, useMemo, useEffect } from 'react';
import { Play, Pause, Cpu, ChevronLeft, ChevronRight, RotateCcw, AlertCircle, BookOpen } from 'lucide-react';
import { API_URL } from './api';


import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';

import TourOverlay from './TourOverlay';
import { useTour, TOUR_STORAGE_KEY } from './useTour';

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
}

interface TraceModel {
  modelLabel: string;
  numGpus: number;
  batchSizes: number[];
}

interface TracesResponse {
  models: TraceModel[];
  trainingAvailable: boolean;
}

interface LLMImpactProps {
  onVoltagesUpdated?: (voltages: number[], label: string, bus?: number) => void;
  onLoadingChanged?: (loading: boolean) => void;
  onReset?: () => void;
}

const BUS_INFO: Record<number, { name: string; baseLoad: number }> = {
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

const ViolTooltip: React.FC<any> = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '8px 12px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>Bus {d.bus} ({BUS_INFO[d.bus]?.name})</div>
      <div style={{ color: '#ef4444', marginBottom: 2 }}>Under-voltage: {d.underPct.toFixed(1)}%</div>
      <div style={{ color: '#f59e0b', marginBottom: 4 }}>Over-voltage: {d.overPct.toFixed(1)}%</div>
      <div style={{ color: '#94a3b8', fontSize: 10, borderTop: '1px solid #e2e8f0', paddingTop: 4 }}>
        Min: {d.minV.toFixed(4)} · Max: {d.maxV.toFixed(4)} p.u.
      </div>
    </div>
  );
};

const MiniTooltip: React.FC<any> = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 10px', fontSize: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>t = {d.t?.toFixed(2)}s</div>
      <div style={{ color: d.v < 0.95 ? '#ef4444' : d.v > 1.05 ? '#f59e0b' : '#16a34a' }}>
        V = {d.v?.toFixed(4)} p.u.
      </div>
    </div>
  );
};

export default function LLMImpactAnalysis({ onVoltagesUpdated, onLoadingChanged, onReset }: LLMImpactProps) {
  const [data, setData]             = useState<AnalysisData | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [selIdx, setSelIdx]         = useState(0);
  const [targetBus, setTargetBus]   = useState(9);
  const [substationVoltage, setSubstationVoltage] = useState(1.05);

  // Real trace selectors
  const [traceModels, setTraceModels]   = useState<TraceModel[]>([]);
  const [tracesReady, setTracesReady]   = useState(false);
  const [selectedModel, setSelectedModel] = useState('Llama-3.1-8B');
  const [selectedBatch, setSelectedBatch] = useState(128);
  const [numReplicas, setNumReplicas]   = useState(1);

  // Playback
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);

  const snap  = data?.timeSeries[selIdx] ?? null;
  const atEnd = data ? selIdx >= data.timeSeries.length - 1 : false;

  const tour = useTour({ hasData: !!data });

  // Fetch available traces from backend on mount
  useEffect(() => {
    fetch(`${API_URL}/api/traces`)
      .then(r => r.json())
      .then((res: TracesResponse) => {
        setTraceModels(res.models);
        if (res.models.length > 0) {
          setSelectedModel(res.models[0].modelLabel);
          setSelectedBatch(res.models[0].batchSizes[Math.floor(res.models[0].batchSizes.length / 2)]);
        }
        setTracesReady(true);
      })
      .catch(() => setTracesReady(false));
  }, []);

  const currentModel = traceModels.find(m => m.modelLabel === selectedModel);
  const availableBatches = currentModel?.batchSizes ?? [128];

  useEffect(() => {
    if (currentModel) {
      const mid = currentModel.batchSizes[Math.floor(currentModel.batchSizes.length / 2)];
      setSelectedBatch(mid);
    }
  }, [selectedModel]);

  useEffect(() => {
    if (!isPlaying || !data) return;
    const ms = 1000 / playSpeed;
    const id = setInterval(() => {
      setSelIdx(prev => {
        if (prev >= data.timeSeries.length - 1) { setIsPlaying(false); return prev; }
        return prev + 1;
      });
    }, ms);
    return () => clearInterval(id);
  }, [isPlaying, playSpeed, data]);

  useEffect(() => { setIsPlaying(false); setSelIdx(0); }, [data]);

  const togglePlay = () => {
    if (!data) return;
    if (!isPlaying && atEnd) setSelIdx(0);
    setIsPlaying(prev => !prev);
  };

  useEffect(() => {
    if (snap?.voltages && data) {
      onVoltagesUpdated?.(
        snap.voltages,
        `${data.modelLabel} (seqs=${data.maxNumSeqs}) @ t=${snap.time.toFixed(1)}s — ${snap.gpu_power_kW.toFixed(0)} kW on Bus ${targetBus}`,
        targetBus
      );
    }
  }, [selIdx, snap]);

  const handleReset = () => {
    setData(null); setError(null); setSelIdx(0); setIsPlaying(false);
    onReset?.();
  };

  const run = async () => {
    setLoading(true); setError(null); setData(null);
    setSelIdx(0); setIsPlaying(false);
    onLoadingChanged?.(true);
    try {
      
       const res = await fetch(`${API_URL}/api/llm-impact`, {

        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetBus,
          modelLabel:        selectedModel,
          numGpus:           currentModel?.numGpus ?? 1,
          maxNumSeqs:        selectedBatch,
          numReplicas,
          substationVoltage,
          sampleInterval:    1,
        }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      const result: AnalysisData = await res.json();
      setData(result);
      if (result?.timeSeries?.length) {
        const peakStep = result.timeSeries.reduce((a, b) => b.gpu_power_kW > a.gpu_power_kW ? b : a);
        onVoltagesUpdated?.(
          peakStep.voltages,
          `${result.modelLabel} peak — ${peakStep.gpu_power_kW.toFixed(0)} kW on Bus ${targetBus}`,
          targetBus
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false); onLoadingChanged?.(false);
    }
  };

  const violStats = useMemo(() => {
    if (!data) return [];
    const n = data.timeSeries.length;
    return Array.from({ length: 13 }, (_, i) => {
      const bus    = i + 1;
      const vSeries = data.timeSeries.map(d => d.voltages?.[i] ?? 1.0);
      const under  = vSeries.filter(v => v < 0.95).length;
      const over   = vSeries.filter(v => v > 1.05).length;
      return { bus, total: n, under, over,
        underPct: (under / n) * 100, overPct: (over / n) * 100,
        minV: Math.min(...vSeries), maxV: Math.max(...vSeries),
        isTarget: bus === targetBus };
    });
  }, [data, targetBus]);

  const busTimeSeries = useMemo(() => {
    if (!data) return [];
    return Array.from({ length: 13 }, (_, i) => {
      const bus    = i + 1;
      const series = data.timeSeries.map((d, idx) => ({ t: d.time, v: d.voltages?.[i] ?? 1.0, _i: idx }));
      const voltages   = series.map(s => s.v);
      const violations = voltages.filter(v => v < 0.95 || v > 1.05).length;
      return { bus, series, minV: Math.min(...voltages), maxV: Math.max(...voltages), violations, isTarget: bus === targetBus };
    });
  }, [data, targetBus]);

  // GPU power chart data (raw trace values)
  const powerChartData = useMemo(() => {
    if (!data) return [];
    return data.timeSeries.map(d => ({ t: d.time, kw: d.gpu_power_raw_kW ?? d.gpu_power_kW }));
  }, [data]);

  return (
    <div style={{ background: '#ffffff', color: '#0f172a', fontSize: 12 }}>

      <TourOverlay
        active={tour.active} currentStep={tour.currentStep}
        stepIndex={tour.stepIndex} totalSteps={tour.totalSteps}
        highlight={tour.highlight} waitingForData={tour.waitingForData}
        onNext={tour.goNext} onPrev={tour.goPrev} onSkip={tour.endTour}
      />

      {/* Header */}
      <div id="llm-header" style={{ borderBottom: '1px solid #e2e8f0', background: '#f8fafc', padding: '16px 24px', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 20, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: '#0f172a' }}>LLM GRID IMPACT</div>
        
          <button
            onClick={() => { localStorage.removeItem(TOUR_STORAGE_KEY); tour.startTour(); }}
            style={{ display: 'flex', alignItems: 'center', gap: 5, border: '1px solid #cbd5e1', background: '#fff', borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 700, color: '#64748b', cursor: 'pointer' }}>
            <BookOpen size={12} /> Tour
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>

          {/* Substation voltage */}
          <div id="substation-voltage">
            <div style={{ color: '#94a3b8', fontSize: 9, fontWeight: 800, marginBottom: 4 }}>Substation voltage (scenario):</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={0.90} max={1.10} step={0.001} value={substationVoltage}
                onChange={e => setSubstationVoltage(parseFloat(e.target.value))}
                style={{ width: 100, cursor: 'pointer' }} />
              <div style={{ background: '#fff', border: `1px solid ${substationVoltage < 0.95 ? '#fca5a5' : substationVoltage > 1.05 ? '#fde68a' : '#cbd5e1'}`, borderRadius: 6, padding: '6px 10px', fontWeight: 800, fontSize: 12, color: substationVoltage < 0.95 ? '#ef4444' : substationVoltage > 1.05 ? '#f59e0b' : '#0f172a', minWidth: 58, textAlign: 'center' }}>
                {substationVoltage.toFixed(3)}
              </div>
            </div>
          </div>

          {/* Data center bus */}
          <div id="bus-selector">
            <div style={{ color: '#0891b2', fontSize: 9, fontWeight: 800, marginBottom: 4 }}>DATA CENTER BUS:</div>
            <select value={targetBus} onChange={e => setTargetBus(+e.target.value)} style={{ background: '#ecfeff', border: '2px solid #0891b2', borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer', fontWeight: 700, color: '#0891b2' }}>
              {Object.entries(BUS_INFO).map(([n, b]) => (
                <option key={n} value={n}>Bus {n} — {b.name} ({b.baseLoad} kW base)</option>
              ))}
            </select>
          </div>

          {/* Model selector */}
          <div id="model-selector">
            <div style={{ color: '#7c3aed', fontSize: 9, fontWeight: 800, marginBottom: 4 }}>MODEL:</div>
            <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} style={{ background: '#f5f3ff', border: '2px solid #7c3aed', borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer', fontWeight: 700, color: '#7c3aed' }}>
              {tracesReady
                ? traceModels.map(m => <option key={m.modelLabel} value={m.modelLabel}>{m.modelLabel} ({m.numGpus} GPU{m.numGpus > 1 ? 's' : ''})</option>)
                : <option value="Llama-3.1-8B">Loading...</option>
              }
            </select>
          </div>

          {/* Batch size (max_num_seqs) */}
          <div id="batch-selector">
            <div style={{ color: '#7c3aed', fontSize: 9, fontWeight: 800, marginBottom: 4 }}>BATCH SIZE (max_num_seqs):</div>
            <select value={selectedBatch} onChange={e => setSelectedBatch(+e.target.value)} style={{ background: '#f5f3ff', border: '2px solid #7c3aed', borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer', fontWeight: 700, color: '#7c3aed' }}>
              {availableBatches.map(b => <option key={b} value={b}>{b} seqs</option>)}
            </select>
          </div>

          {/* Replicas */}
          <div id="replicas">
            <div style={{ color: '#94a3b8', fontSize: 9, fontWeight: 800, marginBottom: 4 }}>Replicas) </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 10px' }}>
              <Cpu size={14} color="#64748b" />
              <input type="number" min={1} max={500} value={numReplicas}
                onChange={e => setNumReplicas(+e.target.value || 1)}
                style={{ width: 50, border: 'none', outline: 'none', fontWeight: 700, fontSize: 12 }} />
              <span style={{ color: '#94a3b8', fontSize: 10 }}>× {currentModel?.numGpus ?? 1} GPUs</span>
            </div>
          </div>

          {/* Run / Reset */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div id="run-button">
              <button onClick={run} disabled={loading} style={{ background: loading ? '#cbd5e1' : '#0891b2', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 28px', fontWeight: 800, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Play size={14} />
                {loading ? 'Running...' : 'Run'}
              </button>
            </div>
            {data && !loading && (
              <button onClick={handleReset} style={{ background: '#fff', color: '#64748b', border: '2px solid #e2e8f0', borderRadius: 6, padding: '10px 20px', fontWeight: 800, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                <RotateCcw size={14} /> Reset
              </button>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ margin: '16px 24px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', display: 'flex', gap: 8 }}>
          <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0 }} />
          <span style={{ color: '#dc2626', fontSize: 12 }}>{error}</span>
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 0', gap: 16 }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid #e2e8f0', borderTopColor: '#0891b2', animation: 'spin 0.8s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <div style={{ color: '#64748b', fontSize: 12 }}>Running simulation with real {selectedModel} trace...</div>
        </div>
      )}

      {data && !loading && (
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          Using:
          {/* Trace info banner */}
          <div style={{ background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 8, padding: '10px 16px', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Model: <strong>{data.modelLabel}</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>GPUs/replica: <strong>{data.numGpus}</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Batch: <strong>{data.maxNumSeqs} seqs</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Replicas: <strong>{data.numReplicas}</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Total GPUs: <strong>{data.numGpus * data.numReplicas}</strong></div>
            <div style={{ fontSize: 11, color: '#6d28d9' }}>Source: <strong>ML.ENERGY Benchmark v3 (H100)</strong></div>
          </div>

          {/* Timeline scrubber */}
          <div id="timeline-scrubber" style={{ background: '#f8fafc', border: '2px solid #0891b2', borderRadius: 8, padding: '16px 20px' }}>
            <div style={{ fontWeight: 800, fontSize: 12, color: '#0891b2', marginBottom: 12 }}>
             Time through Power Trace
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <button onClick={() => { setIsPlaying(false); setSelIdx(i => Math.max(0, i - 1)); }} disabled={selIdx === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: selIdx === 0 ? 'not-allowed' : 'pointer', border: '1px solid #cbd5e1', background: '#fff', borderRadius: 6, padding: '6px 10px', fontSize: 11, fontWeight: 700, color: selIdx === 0 ? '#cbd5e1' : '#0f172a' }}>
                <ChevronLeft size={16} /> PREV
              </button>
              <button onClick={togglePlay} style={{ display: 'flex', alignItems: 'center', gap: 6, background: isPlaying ? '#0c4a6e' : '#0891b2', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 800, fontSize: 13, cursor: 'pointer', minWidth: 110, justifyContent: 'center' }}>
                {isPlaying ? <><Pause size={14} /> Pause</> : <><Play size={14} /> {atEnd ? 'Replay' : 'Play'}</>}
              </button>
              <button onClick={() => { setIsPlaying(false); setSelIdx(i => Math.min(data.timeSeries.length - 1, i + 1)); }} disabled={atEnd}
                style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: atEnd ? 'not-allowed' : 'pointer', border: '1px solid #cbd5e1', background: '#fff', borderRadius: 6, padding: '6px 10px', fontSize: 11, fontWeight: 700, color: atEnd ? '#cbd5e1' : '#0f172a' }}>
                NEXT <ChevronRight size={16} />
              </button>
              <div style={{ flex: 1 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700 }}>SPEED:</span>
                {[1, 2, 4, 8].map(s => (
                  <button key={s} onClick={() => setPlaySpeed(s)} style={{ border: `1px solid ${playSpeed === s ? '#0891b2' : '#cbd5e1'}`, background: playSpeed === s ? '#ecfeff' : '#fff', color: playSpeed === s ? '#0891b2' : '#64748b', borderRadius: 4, padding: '4px 8px', fontSize: 10, fontWeight: playSpeed === s ? 800 : 600, cursor: 'pointer' }}>{s}×</button>
                ))}
              </div>
              <div style={{ textAlign: 'right', minWidth: 160 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#0891b2' }}>t = {snap?.time.toFixed(2)}s</div>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                  {snap ? `${snap.gpu_power_kW.toFixed(0)} kW injected · raw: ${(snap.gpu_power_raw_kW ?? snap.gpu_power_kW).toFixed(0)} kW` : ''}
                </div>
              </div>
            </div>
            <div style={{ position: 'relative', height: 4, background: '#e2e8f0', borderRadius: 2, marginBottom: 6 }}>
              <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(selIdx / (data.timeSeries.length - 1)) * 100}%`, background: '#0891b2', borderRadius: 2, transition: 'width 0.15s' }} />
            </div>
            <input type="range" min={0} max={data.timeSeries.length - 1} value={selIdx}
              onChange={e => { setIsPlaying(false); setSelIdx(+e.target.value); }}
              style={{ width: '100%', height: 6, cursor: 'pointer', accentColor: '#0891b2' }} />
          </div>

          {/* GPU power trace chart */}
          {powerChartData.length > 0 && (
            <div style={{ background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 8, padding: '16px 20px' }}>
              <div style={{ fontWeight: 800, fontSize: 13, color: '#7c3aed', marginBottom: 4 }}>GPU Power Trace(ML.ENERGY H100)</div>
              <div style={{ color: '#6d28d9', fontSize: 10, marginBottom: 12 }}>
                {data.modelLabel} · {data.maxNumSeqs} seqs · {data.numReplicas} replica{data.numReplicas > 1 ? 's' : ''}
              </div>
              <div style={{ height: 120 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={powerChartData} margin={{ top: 4, right: 20, bottom: 4, left: 10 }}>
                    <XAxis dataKey="t" stroke="#94a3b8" tick={{ fontSize: 9 }} tickFormatter={v => `${v}s`} />
                    <YAxis stroke="#94a3b8" tick={{ fontSize: 9 }} tickFormatter={v => `${v.toFixed(0)}kW`} />
                    <ReferenceLine x={snap?.time} stroke="#0891b2" strokeWidth={1.5} opacity={0.7} />
                    <Line type="monotone" dataKey="kw" stroke="#7c3aed" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Summary stats */}
          {(() => {
            const totalViolPct = violStats.length
              ? (violStats.reduce((s, b) => s + b.under + b.over, 0) / (violStats.length * data.numSamples) * 100) : 0;
            const bussesViolated = violStats.filter(b => b.under + b.over > 0).length;
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ color: '#64748b', fontSize: 9, fontWeight: 800, marginBottom: 6 }}>DURATION</div>
                  <div style={{ color: '#0f172a', fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{data.duration.toFixed(1)}s</div>
                  <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 4 }}>{data.numSamples} samples</div>
                </div>
                <div style={{ background: data.minVoltage < 0.95 ? '#fef2f2' : '#f8fafc', border: `1px solid ${data.minVoltage < 0.95 ? '#fca5a5' : '#e2e8f0'}`, borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ color: data.minVoltage < 0.95 ? '#dc2626' : '#64748b', fontSize: 9, fontWeight: 800, marginBottom: 6 }}>WORST VOLTAGE</div>
                  <div style={{ color: data.minVoltage < 0.95 ? '#ef4444' : '#0f172a', fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{data.minVoltage.toFixed(4)}</div>
                  <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 4 }}>{data.minVoltage < 0.95 ? '⚠ Under-voltage' : 'Within bounds'}</div>
                </div>
                <div style={{ background: totalViolPct > 0 ? '#fef2f2' : '#f0fdf4', border: `1px solid ${totalViolPct > 0 ? '#fca5a5' : '#bbf7d0'}`, borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ color: totalViolPct > 0 ? '#dc2626' : '#166534', fontSize: 9, fontWeight: 800, marginBottom: 6 }}>VIOLATION RATE</div>
                  <div style={{ color: totalViolPct > 0 ? '#ef4444' : '#16a34a', fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{totalViolPct.toFixed(1)}%</div>
                  <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 4 }}>{bussesViolated} of 13 buses</div>
                </div>
                <div style={{ background: '#ecfeff', border: '2px solid #0891b2', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ color: '#0891b2', fontSize: 9, fontWeight: 800, marginBottom: 6 }}>DATA CENTER</div>
                  <div style={{ color: '#0891b2', fontSize: 16, fontWeight: 800, lineHeight: 1.2 }}>
                    Bus {targetBus}<br/>
                    <span style={{ fontSize: 12 }}>{BUS_INFO[targetBus]?.name}</span>
                  </div>
                  <div style={{ color: '#0891b2', fontSize: 10, marginTop: 4 }}>
                   GPU Cluster size: {data.numReplicas * data.numGpus} 
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Violation bar chart */}
          <div id="violation-chart" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '16px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Voltage Violation Frequency by Bus</div>
                <div style={{ color: '#64748b', fontSize: 10 }}>% of timesteps outside 0.95–1.05 p.u.</div>
              </div>
              <div style={{ display: 'flex', gap: 14, fontSize: 10 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: '#ef4444', borderRadius: 2, display: 'inline-block' }} /> Under</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: '#f59e0b', borderRadius: 2, display: 'inline-block' }} /> Over</span>
              </div>
            </div>
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={violStats} margin={{ top: 8, right: 20, bottom: 20, left: 10 }}>
                  <XAxis dataKey="bus" stroke="#64748b" tick={{ fontSize: 10 }} tickFormatter={v => `B${v}`}
                    label={{ value: 'Bus Number', position: 'insideBottom', offset: -12, fontSize: 10, fill: '#64748b' }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 10 }} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                  <Tooltip content={<ViolTooltip />} cursor={{ fill: '#f1f5f9' }} />
                  <ReferenceLine y={0} stroke="#cbd5e1" />
                  <Bar dataKey="underPct" stackId="a">
                    {violStats.map(entry => <Cell key={`u-${entry.bus}`} fill={entry.underPct > 0 ? '#ef4444' : '#e2e8f0'} stroke={entry.isTarget ? '#0891b2' : 'none'} strokeWidth={entry.isTarget ? 2 : 0} />)}
                  </Bar>
                  <Bar dataKey="overPct" stackId="a" radius={[4,4,0,0]}>
                    {violStats.map(entry => <Cell key={`o-${entry.bus}`} fill={entry.overPct > 0 ? '#f59e0b' : '#e2e8f0'} stroke={entry.isTarget ? '#0891b2' : 'none'} strokeWidth={entry.isTarget ? 2 : 0} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 13-bus voltage panels */}
          <div id="bus-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            {busTimeSeries.map(bus => {
              const hasViolations = bus.violations > 0;
              const borderColor = bus.isTarget ? '#0891b2' : hasViolations ? '#ef4444' : '#e2e8f0';
              const bgColor     = bus.isTarget ? '#ecfeff'  : hasViolations ? '#fef2f2'  : '#ffffff';
              return (
                <div key={bus.bus} style={{ background: bgColor, border: `2px solid ${borderColor}`, borderRadius: 8, padding: '12px' }}>
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontWeight: 800, fontSize: 13, color: bus.isTarget ? '#0891b2' : '#0f172a' }}>
                        {bus.isTarget ? ' ' : ''}Bus {bus.bus}
                      </span>
                      {hasViolations && (
                        <span style={{ background: '#fef2f2', color: '#ef4444', fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4, border: '1px solid #fca5a5' }}>
                          {((bus.violations / data.numSamples) * 100).toFixed(1)}% Violations
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 9, fontWeight: 700, marginBottom: 3, color: bus.isTarget ? '#0891b2' : '#94a3b8' }}>
                      {BUS_INFO[bus.bus]?.name}
                      {bus.isTarget && <span style={{ marginLeft: 5, background: '#0891b2', color: '#fff', fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3 }}>DATA CENTER</span>}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#94a3b8' }}>
                      <span>Min: {bus.minV.toFixed(4)}</span>
                      <span>Max: {bus.maxV.toFixed(4)}</span>
                    </div>
                  </div>
                  <div style={{ height: 100 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={bus.series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                        onClick={e => { const idx = e?.activePayload?.[0]?.payload?._i; if (idx != null) { setIsPlaying(false); setSelIdx(idx); } }}
                        style={{ cursor: 'pointer' }}>
                        <XAxis dataKey="t" hide />
                        <YAxis domain={([dataMin, dataMax]: [number, number]) => { const pad = (dataMax - dataMin) * 0.1 || 0.02; return [Math.min(dataMin - pad, 0.92), Math.max(dataMax + pad, 1.06)]; }} hide />
                        <Tooltip content={<MiniTooltip />} />
                        <ReferenceLine y={0.95} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
                        <ReferenceLine y={1.05} stroke="#f59e0b" strokeDasharray="3 3" strokeWidth={1} />
                        <ReferenceLine y={1.0}  stroke="#cbd5e1" strokeWidth={1} />
                        {snap && <ReferenceLine x={snap.time} stroke={bus.isTarget ? '#0891b2' : '#94a3b8'} strokeWidth={1.5} opacity={0.7} />}
                        <Line type="monotone" dataKey="v" stroke={bus.isTarget ? '#0891b2' : hasViolations ? '#ef4444' : '#16a34a'} strokeWidth={bus.isTarget ? 2 : 1.5} dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  {snap && (
                    <div style={{ marginTop: 6, textAlign: 'center', fontSize: 11, fontWeight: 800, color: snap.voltages[bus.bus-1] < 0.95 ? '#ef4444' : snap.voltages[bus.bus-1] > 1.05 ? '#f59e0b' : '#16a34a' }}>
                      t={snap.time.toFixed(1)}s · {snap.voltages[bus.bus-1]?.toFixed(4)} p.u.
                    </div>
                  )}
                </div>
              );
            })}
          </div>

        </div>
      )}
    </div>
  );
}