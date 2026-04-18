import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo, useEffect } from 'react';
import { Play, Pause, Cpu, ChevronLeft, ChevronRight, RotateCcw, AlertCircle, BookOpen } from 'lucide-react';
import { API_URL } from './api';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from 'recharts';
import TourOverlay from './TourOverlay';
import { useTour, TOUR_STORAGE_KEY } from './useTour';
const BUS_INFO = {
    1: { name: '650 (Substation)', baseLoad: 0 },
    2: { name: '632', baseLoad: 200 },
    3: { name: '633', baseLoad: 170 },
    4: { name: '645', baseLoad: 230 },
    5: { name: '646', baseLoad: 0 },
    6: { name: '671', baseLoad: 400 },
    7: { name: '684', baseLoad: 128 },
    8: { name: '611', baseLoad: 0 },
    9: { name: '634', baseLoad: 1155 },
    10: { name: '675', baseLoad: 843 },
    11: { name: '652', baseLoad: 170 },
    12: { name: '680', baseLoad: 170 },
    13: { name: '692', baseLoad: 0 },
};
const ViolTooltip = ({ active, payload }) => {
    if (!active || !payload?.length)
        return null;
    const d = payload[0].payload;
    return (_jsxs("div", { style: { background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '8px 12px', fontSize: 11, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }, children: [_jsxs("div", { style: { fontWeight: 800, marginBottom: 4 }, children: ["Bus ", d.bus, " (", BUS_INFO[d.bus]?.name, ")"] }), _jsxs("div", { style: { color: '#ef4444', marginBottom: 2 }, children: ["Under-voltage: ", d.underPct.toFixed(1), "%"] }), _jsxs("div", { style: { color: '#f59e0b', marginBottom: 4 }, children: ["Over-voltage: ", d.overPct.toFixed(1), "%"] }), _jsxs("div", { style: { color: '#94a3b8', fontSize: 10, borderTop: '1px solid #e2e8f0', paddingTop: 4 }, children: ["Min: ", d.minV.toFixed(4), " \u00B7 Max: ", d.maxV.toFixed(4), " p.u."] })] }));
};
const MiniTooltip = ({ active, payload }) => {
    if (!active || !payload?.length)
        return null;
    const d = payload[0].payload;
    return (_jsxs("div", { style: { background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 10px', fontSize: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }, children: [_jsxs("div", { style: { fontWeight: 700, marginBottom: 2 }, children: ["t = ", d.t?.toFixed(2), "s"] }), _jsxs("div", { style: { color: d.v < 0.95 ? '#ef4444' : d.v > 1.05 ? '#f59e0b' : '#16a34a' }, children: ["V = ", d.v?.toFixed(4), " p.u."] })] }));
};
export default function LLMImpactAnalysis({ onVoltagesUpdated, onLoadingChanged, onReset }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [selIdx, setSelIdx] = useState(0);
    const [targetBus, setTargetBus] = useState(9);
    const [substationVoltage, setSubstationVoltage] = useState(1.05);
    // Real trace selectors
    const [traceModels, setTraceModels] = useState([]);
    const [tracesReady, setTracesReady] = useState(false);
    const [selectedModel, setSelectedModel] = useState('Llama-3.1-8B');
    const [selectedBatch, setSelectedBatch] = useState(128);
    const [numReplicas, setNumReplicas] = useState(1);
    // Playback
    const [isPlaying, setIsPlaying] = useState(false);
    const [playSpeed, setPlaySpeed] = useState(1);
    const snap = data?.timeSeries[selIdx] ?? null;
    const atEnd = data ? selIdx >= data.timeSeries.length - 1 : false;
    const tour = useTour({ hasData: !!data });
    // Fetch available traces from backend on mount
    useEffect(() => {
        fetch(`${API_URL}/api/traces`)
            .then(r => r.json())
            .then((res) => {
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
        if (!isPlaying || !data)
            return;
        const ms = 1000 / playSpeed;
        const id = setInterval(() => {
            setSelIdx(prev => {
                if (prev >= data.timeSeries.length - 1) {
                    setIsPlaying(false);
                    return prev;
                }
                return prev + 1;
            });
        }, ms);
        return () => clearInterval(id);
    }, [isPlaying, playSpeed, data]);
    useEffect(() => { setIsPlaying(false); setSelIdx(0); }, [data]);
    const togglePlay = () => {
        if (!data)
            return;
        if (!isPlaying && atEnd)
            setSelIdx(0);
        setIsPlaying(prev => !prev);
    };
    useEffect(() => {
        if (snap?.voltages && data) {
            onVoltagesUpdated?.(snap.voltages, `${data.modelLabel} (seqs=${data.maxNumSeqs}) @ t=${snap.time.toFixed(1)}s — ${snap.gpu_power_kW.toFixed(0)} kW on Bus ${targetBus}`, targetBus);
        }
    }, [selIdx, snap]);
    const handleReset = () => {
        setData(null);
        setError(null);
        setSelIdx(0);
        setIsPlaying(false);
        onReset?.();
    };
    const run = async () => {
        setLoading(true);
        setError(null);
        setData(null);
        setSelIdx(0);
        setIsPlaying(false);
        onLoadingChanged?.(true);
        try {
            const res = await fetch(`${API_URL}/api/llm-impact`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetBus,
                    modelLabel: selectedModel,
                    numGpus: currentModel?.numGpus ?? 1,
                    maxNumSeqs: selectedBatch,
                    numReplicas,
                    substationVoltage,
                    sampleInterval: 1,
                }),
            });
            if (!res.ok)
                throw new Error(await res.text() || `HTTP ${res.status}`);
            const result = await res.json();
            setData(result);
            if (result?.timeSeries?.length) {
                const peakStep = result.timeSeries.reduce((a, b) => b.gpu_power_kW > a.gpu_power_kW ? b : a);
                onVoltagesUpdated?.(peakStep.voltages, `${result.modelLabel} peak — ${peakStep.gpu_power_kW.toFixed(0)} kW on Bus ${targetBus}`, targetBus);
            }
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
            onLoadingChanged?.(false);
        }
    };
    const violStats = useMemo(() => {
        if (!data)
            return [];
        const n = data.timeSeries.length;
        return Array.from({ length: 13 }, (_, i) => {
            const bus = i + 1;
            const vSeries = data.timeSeries.map(d => d.voltages?.[i] ?? 1.0);
            const under = vSeries.filter(v => v < 0.95).length;
            const over = vSeries.filter(v => v > 1.05).length;
            return { bus, total: n, under, over,
                underPct: (under / n) * 100, overPct: (over / n) * 100,
                minV: Math.min(...vSeries), maxV: Math.max(...vSeries),
                isTarget: bus === targetBus };
        });
    }, [data, targetBus]);
    const busTimeSeries = useMemo(() => {
        if (!data)
            return [];
        return Array.from({ length: 13 }, (_, i) => {
            const bus = i + 1;
            const series = data.timeSeries.map((d, idx) => ({ t: d.time, v: d.voltages?.[i] ?? 1.0, _i: idx }));
            const voltages = series.map(s => s.v);
            const violations = voltages.filter(v => v < 0.95 || v > 1.05).length;
            return { bus, series, minV: Math.min(...voltages), maxV: Math.max(...voltages), violations, isTarget: bus === targetBus };
        });
    }, [data, targetBus]);
    // GPU power chart data (raw trace values)
    const powerChartData = useMemo(() => {
        if (!data)
            return [];
        return data.timeSeries.map(d => ({ t: d.time, kw: d.gpu_power_raw_kW ?? d.gpu_power_kW }));
    }, [data]);
    return (_jsxs("div", { style: { background: '#ffffff', color: '#0f172a', fontSize: 12 }, children: [_jsx(TourOverlay, { active: tour.active, currentStep: tour.currentStep, stepIndex: tour.stepIndex, totalSteps: tour.totalSteps, highlight: tour.highlight, waitingForData: tour.waitingForData, onNext: tour.goNext, onPrev: tour.goPrev, onSkip: tour.endTour }), _jsxs("div", { id: "llm-header", style: { borderBottom: '1px solid #e2e8f0', background: '#f8fafc', padding: '16px 24px', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 20, justifyContent: 'space-between' }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 12 }, children: [_jsx("div", { style: { fontWeight: 800, fontSize: 14, color: '#0f172a' }, children: "LLM GRID IMPACT" }), _jsxs("button", { onClick: () => { localStorage.removeItem(TOUR_STORAGE_KEY); tour.startTour(); }, style: { display: 'flex', alignItems: 'center', gap: 5, border: '1px solid #cbd5e1', background: '#fff', borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 700, color: '#64748b', cursor: 'pointer' }, children: [_jsx(BookOpen, { size: 12 }), " Tour"] })] }), _jsxs("div", { style: { display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }, children: [_jsxs("div", { id: "substation-voltage", children: [_jsx("div", { style: { color: '#94a3b8', fontSize: 9, fontWeight: 800, marginBottom: 4 }, children: "Substation voltage (scenario):" }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [_jsx("input", { type: "range", min: 0.90, max: 1.10, step: 0.001, value: substationVoltage, onChange: e => setSubstationVoltage(parseFloat(e.target.value)), style: { width: 100, cursor: 'pointer' } }), _jsx("div", { style: { background: '#fff', border: `1px solid ${substationVoltage < 0.95 ? '#fca5a5' : substationVoltage > 1.05 ? '#fde68a' : '#cbd5e1'}`, borderRadius: 6, padding: '6px 10px', fontWeight: 800, fontSize: 12, color: substationVoltage < 0.95 ? '#ef4444' : substationVoltage > 1.05 ? '#f59e0b' : '#0f172a', minWidth: 58, textAlign: 'center' }, children: substationVoltage.toFixed(3) })] })] }), _jsxs("div", { id: "bus-selector", children: [_jsx("div", { style: { color: '#0891b2', fontSize: 9, fontWeight: 800, marginBottom: 4 }, children: "DATA CENTER BUS:" }), _jsx("select", { value: targetBus, onChange: e => setTargetBus(+e.target.value), style: { background: '#ecfeff', border: '2px solid #0891b2', borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer', fontWeight: 700, color: '#0891b2' }, children: Object.entries(BUS_INFO).map(([n, b]) => (_jsxs("option", { value: n, children: ["Bus ", n, " \u2014 ", b.name, " (", b.baseLoad, " kW base)"] }, n))) })] }), _jsxs("div", { id: "model-selector", children: [_jsx("div", { style: { color: '#7c3aed', fontSize: 9, fontWeight: 800, marginBottom: 4 }, children: "MODEL:" }), _jsx("select", { value: selectedModel, onChange: e => setSelectedModel(e.target.value), style: { background: '#f5f3ff', border: '2px solid #7c3aed', borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer', fontWeight: 700, color: '#7c3aed' }, children: tracesReady
                                            ? traceModels.map(m => _jsxs("option", { value: m.modelLabel, children: [m.modelLabel, " (", m.numGpus, " GPU", m.numGpus > 1 ? 's' : '', ")"] }, m.modelLabel))
                                            : _jsx("option", { value: "Llama-3.1-8B", children: "Loading..." }) })] }), _jsxs("div", { id: "batch-selector", children: [_jsx("div", { style: { color: '#7c3aed', fontSize: 9, fontWeight: 800, marginBottom: 4 }, children: "BATCH SIZE (max_num_seqs):" }), _jsx("select", { value: selectedBatch, onChange: e => setSelectedBatch(+e.target.value), style: { background: '#f5f3ff', border: '2px solid #7c3aed', borderRadius: 6, padding: '6px 10px', fontSize: 12, outline: 'none', cursor: 'pointer', fontWeight: 700, color: '#7c3aed' }, children: availableBatches.map(b => _jsxs("option", { value: b, children: [b, " seqs"] }, b)) })] }), _jsxs("div", { id: "replicas", children: [_jsx("div", { style: { color: '#94a3b8', fontSize: 9, fontWeight: 800, marginBottom: 4 }, children: "Replicas) " }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 10px' }, children: [_jsx(Cpu, { size: 14, color: "#64748b" }), _jsx("input", { type: "number", min: 1, max: 500, value: numReplicas, onChange: e => setNumReplicas(+e.target.value || 1), style: { width: 50, border: 'none', outline: 'none', fontWeight: 700, fontSize: 12 } }), _jsxs("span", { style: { color: '#94a3b8', fontSize: 10 }, children: ["\u00D7 ", currentModel?.numGpus ?? 1, " GPUs"] })] })] }), _jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center' }, children: [_jsx("div", { id: "run-button", children: _jsxs("button", { onClick: run, disabled: loading, style: { background: loading ? '#cbd5e1' : '#0891b2', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 28px', fontWeight: 800, cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }, children: [_jsx(Play, { size: 14 }), loading ? 'Running...' : 'Run'] }) }), data && !loading && (_jsxs("button", { onClick: handleReset, style: { background: '#fff', color: '#64748b', border: '2px solid #e2e8f0', borderRadius: 6, padding: '10px 20px', fontWeight: 800, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }, children: [_jsx(RotateCcw, { size: 14 }), " Reset"] }))] })] })] }), error && (_jsxs("div", { style: { margin: '16px 24px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', display: 'flex', gap: 8 }, children: [_jsx(AlertCircle, { size: 16, color: "#ef4444", style: { flexShrink: 0 } }), _jsx("span", { style: { color: '#dc2626', fontSize: 12 }, children: error })] })), loading && (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 0', gap: 16 }, children: [_jsx("div", { style: { width: 40, height: 40, borderRadius: '50%', border: '3px solid #e2e8f0', borderTopColor: '#0891b2', animation: 'spin 0.8s linear infinite' } }), _jsx("style", { children: `@keyframes spin { to { transform: rotate(360deg); } }` }), _jsxs("div", { style: { color: '#64748b', fontSize: 12 }, children: ["Running simulation with real ", selectedModel, " trace..."] })] })), data && !loading && (_jsxs("div", { style: { padding: '24px', display: 'flex', flexDirection: 'column', gap: 20 }, children: ["Using:", _jsxs("div", { style: { background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 8, padding: '10px 16px', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }, children: [_jsxs("div", { style: { fontSize: 11, color: '#6d28d9' }, children: ["Model: ", _jsx("strong", { children: data.modelLabel })] }), _jsxs("div", { style: { fontSize: 11, color: '#6d28d9' }, children: ["GPUs/replica: ", _jsx("strong", { children: data.numGpus })] }), _jsxs("div", { style: { fontSize: 11, color: '#6d28d9' }, children: ["Batch: ", _jsxs("strong", { children: [data.maxNumSeqs, " seqs"] })] }), _jsxs("div", { style: { fontSize: 11, color: '#6d28d9' }, children: ["Replicas: ", _jsx("strong", { children: data.numReplicas })] }), _jsxs("div", { style: { fontSize: 11, color: '#6d28d9' }, children: ["Total GPUs: ", _jsx("strong", { children: data.numGpus * data.numReplicas })] }), _jsxs("div", { style: { fontSize: 11, color: '#6d28d9' }, children: ["Source: ", _jsx("strong", { children: "ML.ENERGY Benchmark v3 (H100)" })] })] }), _jsxs("div", { id: "timeline-scrubber", style: { background: '#f8fafc', border: '2px solid #0891b2', borderRadius: 8, padding: '16px 20px' }, children: [_jsx("div", { style: { fontWeight: 800, fontSize: 12, color: '#0891b2', marginBottom: 12 }, children: "Time through Power Trace" }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }, children: [_jsxs("button", { onClick: () => { setIsPlaying(false); setSelIdx(i => Math.max(0, i - 1)); }, disabled: selIdx === 0, style: { display: 'flex', alignItems: 'center', gap: 4, cursor: selIdx === 0 ? 'not-allowed' : 'pointer', border: '1px solid #cbd5e1', background: '#fff', borderRadius: 6, padding: '6px 10px', fontSize: 11, fontWeight: 700, color: selIdx === 0 ? '#cbd5e1' : '#0f172a' }, children: [_jsx(ChevronLeft, { size: 16 }), " PREV"] }), _jsx("button", { onClick: togglePlay, style: { display: 'flex', alignItems: 'center', gap: 6, background: isPlaying ? '#0c4a6e' : '#0891b2', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 20px', fontWeight: 800, fontSize: 13, cursor: 'pointer', minWidth: 110, justifyContent: 'center' }, children: isPlaying ? _jsxs(_Fragment, { children: [_jsx(Pause, { size: 14 }), " Pause"] }) : _jsxs(_Fragment, { children: [_jsx(Play, { size: 14 }), " ", atEnd ? 'Replay' : 'Play'] }) }), _jsxs("button", { onClick: () => { setIsPlaying(false); setSelIdx(i => Math.min(data.timeSeries.length - 1, i + 1)); }, disabled: atEnd, style: { display: 'flex', alignItems: 'center', gap: 4, cursor: atEnd ? 'not-allowed' : 'pointer', border: '1px solid #cbd5e1', background: '#fff', borderRadius: 6, padding: '6px 10px', fontSize: 11, fontWeight: 700, color: atEnd ? '#cbd5e1' : '#0f172a' }, children: ["NEXT ", _jsx(ChevronRight, { size: 16 })] }), _jsx("div", { style: { flex: 1 } }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 6 }, children: [_jsx("span", { style: { fontSize: 10, color: '#94a3b8', fontWeight: 700 }, children: "SPEED:" }), [1, 2, 4, 8].map(s => (_jsxs("button", { onClick: () => setPlaySpeed(s), style: { border: `1px solid ${playSpeed === s ? '#0891b2' : '#cbd5e1'}`, background: playSpeed === s ? '#ecfeff' : '#fff', color: playSpeed === s ? '#0891b2' : '#64748b', borderRadius: 4, padding: '4px 8px', fontSize: 10, fontWeight: playSpeed === s ? 800 : 600, cursor: 'pointer' }, children: [s, "\u00D7"] }, s)))] }), _jsxs("div", { style: { textAlign: 'right', minWidth: 160 }, children: [_jsxs("div", { style: { fontSize: 18, fontWeight: 800, color: '#0891b2' }, children: ["t = ", snap?.time.toFixed(2), "s"] }), _jsx("div", { style: { fontSize: 10, color: '#64748b', marginTop: 2 }, children: snap ? `${snap.gpu_power_kW.toFixed(0)} kW injected · raw: ${(snap.gpu_power_raw_kW ?? snap.gpu_power_kW).toFixed(0)} kW` : '' })] })] }), _jsx("div", { style: { position: 'relative', height: 4, background: '#e2e8f0', borderRadius: 2, marginBottom: 6 }, children: _jsx("div", { style: { position: 'absolute', left: 0, top: 0, height: '100%', width: `${(selIdx / (data.timeSeries.length - 1)) * 100}%`, background: '#0891b2', borderRadius: 2, transition: 'width 0.15s' } }) }), _jsx("input", { type: "range", min: 0, max: data.timeSeries.length - 1, value: selIdx, onChange: e => { setIsPlaying(false); setSelIdx(+e.target.value); }, style: { width: '100%', height: 6, cursor: 'pointer', accentColor: '#0891b2' } })] }), powerChartData.length > 0 && (_jsxs("div", { style: { background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 8, padding: '16px 20px' }, children: [_jsx("div", { style: { fontWeight: 800, fontSize: 13, color: '#7c3aed', marginBottom: 4 }, children: "GPU Power Trace(ML.ENERGY H100)" }), _jsxs("div", { style: { color: '#6d28d9', fontSize: 10, marginBottom: 12 }, children: [data.modelLabel, " \u00B7 ", data.maxNumSeqs, " seqs \u00B7 ", data.numReplicas, " replica", data.numReplicas > 1 ? 's' : ''] }), _jsx("div", { style: { height: 120 }, children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(LineChart, { data: powerChartData, margin: { top: 4, right: 20, bottom: 4, left: 10 }, children: [_jsx(XAxis, { dataKey: "t", stroke: "#94a3b8", tick: { fontSize: 9 }, tickFormatter: v => `${v}s` }), _jsx(YAxis, { stroke: "#94a3b8", tick: { fontSize: 9 }, tickFormatter: v => `${v.toFixed(0)}kW` }), _jsx(ReferenceLine, { x: snap?.time, stroke: "#0891b2", strokeWidth: 1.5, opacity: 0.7 }), _jsx(Line, { type: "monotone", dataKey: "kw", stroke: "#7c3aed", strokeWidth: 1.5, dot: false, isAnimationActive: false })] }) }) })] })), (() => {
                        const totalViolPct = violStats.length
                            ? (violStats.reduce((s, b) => s + b.under + b.over, 0) / (violStats.length * data.numSamples) * 100) : 0;
                        const bussesViolated = violStats.filter(b => b.under + b.over > 0).length;
                        return (_jsxs("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }, children: [_jsxs("div", { style: { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px' }, children: [_jsx("div", { style: { color: '#64748b', fontSize: 9, fontWeight: 800, marginBottom: 6 }, children: "DURATION" }), _jsxs("div", { style: { color: '#0f172a', fontSize: 22, fontWeight: 800, lineHeight: 1 }, children: [data.duration.toFixed(1), "s"] }), _jsxs("div", { style: { color: '#94a3b8', fontSize: 10, marginTop: 4 }, children: [data.numSamples, " samples"] })] }), _jsxs("div", { style: { background: data.minVoltage < 0.95 ? '#fef2f2' : '#f8fafc', border: `1px solid ${data.minVoltage < 0.95 ? '#fca5a5' : '#e2e8f0'}`, borderRadius: 8, padding: '12px 14px' }, children: [_jsx("div", { style: { color: data.minVoltage < 0.95 ? '#dc2626' : '#64748b', fontSize: 9, fontWeight: 800, marginBottom: 6 }, children: "WORST VOLTAGE" }), _jsx("div", { style: { color: data.minVoltage < 0.95 ? '#ef4444' : '#0f172a', fontSize: 22, fontWeight: 800, lineHeight: 1 }, children: data.minVoltage.toFixed(4) }), _jsx("div", { style: { color: '#94a3b8', fontSize: 10, marginTop: 4 }, children: data.minVoltage < 0.95 ? '⚠ Under-voltage' : 'Within bounds' })] }), _jsxs("div", { style: { background: totalViolPct > 0 ? '#fef2f2' : '#f0fdf4', border: `1px solid ${totalViolPct > 0 ? '#fca5a5' : '#bbf7d0'}`, borderRadius: 8, padding: '12px 14px' }, children: [_jsx("div", { style: { color: totalViolPct > 0 ? '#dc2626' : '#166534', fontSize: 9, fontWeight: 800, marginBottom: 6 }, children: "VIOLATION RATE" }), _jsxs("div", { style: { color: totalViolPct > 0 ? '#ef4444' : '#16a34a', fontSize: 22, fontWeight: 800, lineHeight: 1 }, children: [totalViolPct.toFixed(1), "%"] }), _jsxs("div", { style: { color: '#94a3b8', fontSize: 10, marginTop: 4 }, children: [bussesViolated, " of 13 buses"] })] }), _jsxs("div", { style: { background: '#ecfeff', border: '2px solid #0891b2', borderRadius: 8, padding: '12px 14px' }, children: [_jsx("div", { style: { color: '#0891b2', fontSize: 9, fontWeight: 800, marginBottom: 6 }, children: "DATA CENTER" }), _jsxs("div", { style: { color: '#0891b2', fontSize: 16, fontWeight: 800, lineHeight: 1.2 }, children: ["Bus ", targetBus, _jsx("br", {}), _jsx("span", { style: { fontSize: 12 }, children: BUS_INFO[targetBus]?.name })] }), _jsxs("div", { style: { color: '#0891b2', fontSize: 10, marginTop: 4 }, children: ["GPU Cluster size: ", data.numReplicas * data.numGpus] })] })] }));
                    })(), _jsxs("div", { id: "violation-chart", style: { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '16px 20px' }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }, children: [_jsxs("div", { children: [_jsx("div", { style: { fontWeight: 800, fontSize: 13 }, children: "Voltage Violation Frequency by Bus" }), _jsx("div", { style: { color: '#64748b', fontSize: 10 }, children: "% of timesteps outside 0.95\u20131.05 p.u." })] }), _jsxs("div", { style: { display: 'flex', gap: 14, fontSize: 10 }, children: [_jsxs("span", { style: { display: 'flex', alignItems: 'center', gap: 4 }, children: [_jsx("span", { style: { width: 10, height: 10, background: '#ef4444', borderRadius: 2, display: 'inline-block' } }), " Under"] }), _jsxs("span", { style: { display: 'flex', alignItems: 'center', gap: 4 }, children: [_jsx("span", { style: { width: 10, height: 10, background: '#f59e0b', borderRadius: 2, display: 'inline-block' } }), " Over"] })] })] }), _jsx("div", { style: { height: 220 }, children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(BarChart, { data: violStats, margin: { top: 8, right: 20, bottom: 20, left: 10 }, children: [_jsx(XAxis, { dataKey: "bus", stroke: "#64748b", tick: { fontSize: 10 }, tickFormatter: v => `B${v}`, label: { value: 'Bus Number', position: 'insideBottom', offset: -12, fontSize: 10, fill: '#64748b' } }), _jsx(YAxis, { stroke: "#64748b", tick: { fontSize: 10 }, tickFormatter: v => `${v}%`, domain: [0, 100] }), _jsx(Tooltip, { content: _jsx(ViolTooltip, {}), cursor: { fill: '#f1f5f9' } }), _jsx(ReferenceLine, { y: 0, stroke: "#cbd5e1" }), _jsx(Bar, { dataKey: "underPct", stackId: "a", children: violStats.map(entry => _jsx(Cell, { fill: entry.underPct > 0 ? '#ef4444' : '#e2e8f0', stroke: entry.isTarget ? '#0891b2' : 'none', strokeWidth: entry.isTarget ? 2 : 0 }, `u-${entry.bus}`)) }), _jsx(Bar, { dataKey: "overPct", stackId: "a", radius: [4, 4, 0, 0], children: violStats.map(entry => _jsx(Cell, { fill: entry.overPct > 0 ? '#f59e0b' : '#e2e8f0', stroke: entry.isTarget ? '#0891b2' : 'none', strokeWidth: entry.isTarget ? 2 : 0 }, `o-${entry.bus}`)) })] }) }) })] }), _jsx("div", { id: "bus-grid", style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }, children: busTimeSeries.map(bus => {
                            const hasViolations = bus.violations > 0;
                            const borderColor = bus.isTarget ? '#0891b2' : hasViolations ? '#ef4444' : '#e2e8f0';
                            const bgColor = bus.isTarget ? '#ecfeff' : hasViolations ? '#fef2f2' : '#ffffff';
                            return (_jsxs("div", { style: { background: bgColor, border: `2px solid ${borderColor}`, borderRadius: 8, padding: '12px' }, children: [_jsxs("div", { style: { marginBottom: 8 }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }, children: [_jsxs("span", { style: { fontWeight: 800, fontSize: 13, color: bus.isTarget ? '#0891b2' : '#0f172a' }, children: [bus.isTarget ? ' ' : '', "Bus ", bus.bus] }), hasViolations && (_jsxs("span", { style: { background: '#fef2f2', color: '#ef4444', fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4, border: '1px solid #fca5a5' }, children: [((bus.violations / data.numSamples) * 100).toFixed(1), "% Violations"] }))] }), _jsxs("div", { style: { fontSize: 9, fontWeight: 700, marginBottom: 3, color: bus.isTarget ? '#0891b2' : '#94a3b8' }, children: [BUS_INFO[bus.bus]?.name, bus.isTarget && _jsx("span", { style: { marginLeft: 5, background: '#0891b2', color: '#fff', fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3 }, children: "DATA CENTER" })] }), _jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#94a3b8' }, children: [_jsxs("span", { children: ["Min: ", bus.minV.toFixed(4)] }), _jsxs("span", { children: ["Max: ", bus.maxV.toFixed(4)] })] })] }), _jsx("div", { style: { height: 100 }, children: _jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(LineChart, { data: bus.series, margin: { top: 4, right: 4, bottom: 0, left: 0 }, onClick: (e) => { const idx = e?.activePayload?.[0]?.payload?._i; if (idx != null) {
                                                    setIsPlaying(false);
                                                    setSelIdx(idx);
                                                } }, style: { cursor: 'pointer' }, children: [_jsx(XAxis, { dataKey: "t", hide: true }), _jsx(YAxis, { domain: ([dataMin, dataMax]) => { const pad = (dataMax - dataMin) * 0.1 || 0.02; return [Math.min(dataMin - pad, 0.92), Math.max(dataMax + pad, 1.06)]; }, hide: true }), _jsx(Tooltip, { content: _jsx(MiniTooltip, {}) }), _jsx(ReferenceLine, { y: 0.95, stroke: "#ef4444", strokeDasharray: "3 3", strokeWidth: 1 }), _jsx(ReferenceLine, { y: 1.05, stroke: "#f59e0b", strokeDasharray: "3 3", strokeWidth: 1 }), _jsx(ReferenceLine, { y: 1.0, stroke: "#cbd5e1", strokeWidth: 1 }), snap && _jsx(ReferenceLine, { x: snap.time, stroke: bus.isTarget ? '#0891b2' : '#94a3b8', strokeWidth: 1.5, opacity: 0.7 }), _jsx(Line, { type: "monotone", dataKey: "v", stroke: bus.isTarget ? '#0891b2' : hasViolations ? '#ef4444' : '#16a34a', strokeWidth: bus.isTarget ? 2 : 1.5, dot: false, isAnimationActive: false })] }) }) }), snap && (_jsxs("div", { style: { marginTop: 6, textAlign: 'center', fontSize: 11, fontWeight: 800, color: snap.voltages[bus.bus - 1] < 0.95 ? '#ef4444' : snap.voltages[bus.bus - 1] > 1.05 ? '#f59e0b' : '#16a34a' }, children: ["t=", snap.time.toFixed(1), "s \u00B7 ", snap.voltages[bus.bus - 1]?.toFixed(4), " p.u."] }))] }, bus.bus));
                        }) })] }))] }));
}
