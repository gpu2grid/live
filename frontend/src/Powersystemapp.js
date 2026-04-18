import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { AlertCircle, Settings, RefreshCw, Zap, Activity } from 'lucide-react';
const PowerSystemApp = ({ onVoltagesUpdated, onLoadingChanged }) => {
    const [busData, setBusData] = useState([]);
    const [lineData, setLineData] = useState([]);
    const [selectedBus, setSelectedBus] = useState(null);
    const [selectedLine, setSelectedLine] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [serverStatus, setServerStatus] = useState('checking');
    const config = { numBuses: 13, baseVoltage: 4.16 };
    const API_URL = 'http://localhost:8080';
    useEffect(() => { checkServerHealth(); }, []);
    useEffect(() => { if (serverStatus === 'connected')
        fetchPowerFlowData(); }, [serverStatus]);
    useEffect(() => { onLoadingChanged?.(loading); }, [loading]);
    const checkServerHealth = async () => {
        try {
            const r = await fetch(`${API_URL}/api/health`);
            if (r.ok) {
                setServerStatus('connected');
                setError(null);
            }
            else {
                setServerStatus('error');
                setError('Server returned an error');
            }
        }
        catch {
            setServerStatus('disconnected');
            setError("Cannot connect to Julia server. Make sure it's running on port 8080.");
        }
    };
    const fetchPowerFlowData = async () => {
        setLoading(true);
        setError(null);
        try {
            const r = await fetch(`${API_URL}/api/powerflow`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ numBuses: config.numBuses, baseVoltage: config.baseVoltage }),
            });
            if (!r.ok)
                throw new Error(`HTTP error! status: ${r.status}`);
            const data = await r.json();
            const buses = data.buses || [];
            setBusData(buses);
            setLineData(data.lines || []);
            setServerStatus('connected');
            // ── push baseline voltages up to App heatmap ──
            onVoltagesUpdated?.(buses.map((b) => b.voltage));
        }
        catch (e) {
            setError('Failed to fetch data: ' + e.message);
            setServerStatus('error');
        }
        finally {
            setLoading(false);
        }
    };
    const busPositions = {
        1: [60, 250], 2: [200, 250], 3: [340, 100], 6: [500, 100],
        4: [340, 250], 7: [480, 250], 8: [480, 175], 9: [480, 325],
        13: [620, 325], 5: [200, 400], 10: [340, 400], 11: [620, 200], 12: [620, 280],
    };
    const getConfigColor = (cfg) => cfg === '601' ? '#3b82f6' : cfg === '602' ? '#8b5cf6' : '#059669';
    const statusColors = {
        connected: 'bg-green-500', disconnected: 'bg-red-500',
        checking: 'bg-yellow-500', error: 'bg-orange-500',
    };
    const statusLabels = {
        connected: 'Connected', disconnected: 'Disconnected',
        checking: 'Checking...', error: 'Error',
    };
    const StatusBar = () => (_jsxs("div", { className: "flex items-center gap-4", children: [_jsxs("div", { className: "flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg", children: [_jsx("div", { className: `w-2 h-2 rounded-full ${statusColors[serverStatus] ?? 'bg-gray-500'}` }), _jsx("span", { className: "text-sm font-medium", children: statusLabels[serverStatus] ?? serverStatus })] }), _jsxs("button", { onClick: fetchPowerFlowData, disabled: loading || serverStatus !== 'connected', className: "flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed", children: [_jsx(RefreshCw, { size: 16, className: loading ? 'animate-spin' : '' }), loading ? 'Computing...' : busData.length ? 'Recalculate' : 'Calculate Power Flow'] })] }));
    if (!busData.length) {
        return (_jsx("div", { className: "min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-8", children: _jsxs("div", { className: "max-w-7xl mx-auto bg-white rounded-lg shadow-2xl p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Zap, { className: "text-blue-600", size: 32 }), _jsxs("div", { children: [_jsx("h1", { className: "text-3xl font-bold", children: "IEEE 13-Bus Power System" }), _jsx("p", { className: "text-sm text-gray-600", children: "Julia Backend + React Frontend" })] })] }), _jsx(StatusBar, {})] }), error && (_jsxs("div", { className: "mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3", children: [_jsx(AlertCircle, { className: "text-red-600", size: 20 }), _jsxs("div", { children: [_jsx("p", { className: "text-red-800 font-semibold", children: "Connection Error" }), _jsx("p", { className: "text-red-600 text-sm mt-1", children: error })] })] })), loading && (_jsxs("div", { className: "text-center py-12", children: [_jsx(RefreshCw, { className: "animate-spin mx-auto mb-4 text-blue-600", size: 48 }), _jsx("p", { className: "text-xl font-semibold", children: "Loading power flow data..." })] })), !loading && serverStatus === 'disconnected' && (_jsxs("div", { className: "mt-6 p-6 bg-blue-50 rounded-lg border-2 border-blue-200", children: [_jsxs("h3", { className: "font-bold text-blue-900 mb-3 flex items-center gap-2", children: [_jsx(Settings, { size: 20 }), " Setup Instructions"] }), _jsxs("ol", { className: "list-decimal list-inside space-y-2 text-blue-800", children: [_jsxs("li", { children: ["Run: ", _jsx("code", { className: "bg-blue-100 px-2 py-1 rounded", children: "julia server.jl" })] }), _jsx("li", { children: "Click \"Calculate Power Flow\"" })] })] }))] }) }));
    }
    return (_jsx("div", { className: "bg-gradient-to-br from-slate-900 to-slate-800 p-8", children: _jsx("div", { className: "max-w-7xl mx-auto", children: _jsxs("div", { className: "bg-white rounded-lg shadow-2xl p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Zap, { className: "text-blue-600", size: 32 }), _jsxs("div", { children: [_jsx("h1", { className: "text-3xl font-bold", children: "IEEE 13-Bus Power System" }), _jsx("p", { className: "text-sm text-gray-600", children: "LinDistFlow Model" })] })] }), _jsx(StatusBar, {})] }), error && (_jsxs("div", { className: "mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3", children: [_jsx(AlertCircle, { className: "text-red-600", size: 20 }), _jsxs("div", { children: [_jsx("p", { className: "text-red-800 font-semibold", children: "Connection Error" }), _jsx("p", { className: "text-red-600 text-sm mt-1", children: error })] })] })), _jsxs("div", { className: "bg-gray-50 rounded-lg p-4 mb-6", children: [_jsx("h2", { className: "text-xl font-semibold mb-4", children: "Network Topology" }), _jsxs("svg", { viewBox: "0 0 800 600", className: "w-full bg-white rounded border-2", style: { minHeight: 600 }, children: [lineData.map((line) => {
                                        const fp = busPositions[line.from];
                                        const tp = busPositions[line.to];
                                        if (!fp || !tp)
                                            return null;
                                        return (_jsx("line", { x1: fp[0], y1: fp[1], x2: tp[0], y2: tp[1], stroke: selectedLine?.id === line.id ? '#f59e0b' : getConfigColor(line.configType), strokeWidth: selectedLine?.id === line.id ? 5 : 4, strokeDasharray: line.length === 0 ? '5,5' : 'none', className: "cursor-pointer hover:stroke-amber-500 transition-colors", onClick: () => setSelectedLine(line) }, `line-${line.id}`));
                                    }), busData.map((bus) => {
                                        const pos = busPositions[bus.id];
                                        if (!pos)
                                            return null;
                                        const [x, y] = pos;
                                        const color = bus.id === 1 ? '#10b981'
                                            : bus.voltage < 0.95 ? '#ef4444'
                                                : bus.voltage > 1.05 ? '#f59e0b'
                                                    : bus.activePower > 0 ? '#3b82f6' : '#6b7280';
                                        return (_jsxs("g", { className: "cursor-pointer", onClick: () => setSelectedBus(bus), children: [_jsx("circle", { cx: x, cy: y, r: selectedBus?.id === bus.id ? 14 : 12, fill: color, stroke: selectedBus?.id === bus.id ? '#f59e0b' : '#fff', strokeWidth: selectedBus?.id === bus.id ? 3 : 2 }), _jsxs("text", { x: x, y: y - 20, textAnchor: "middle", className: "text-xs font-bold fill-gray-700", children: ["Bus ", bus.id] }), _jsxs("text", { x: x, y: y + 30, textAnchor: "middle", className: "text-xs fill-gray-600 font-semibold", children: [bus.voltage.toFixed(3), " p.u."] })] }, `bus-${bus.id}`));
                                    })] })] }), _jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6", children: [_jsxs("div", { className: "bg-gray-50 rounded-lg p-4", children: [_jsxs("h2", { className: "text-xl font-semibold mb-4 flex items-center gap-2", children: [_jsx(Activity, { className: "text-blue-600", size: 24 }), " Bus Data"] }), _jsx("div", { className: "overflow-auto max-h-96", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-blue-600 text-white sticky top-0", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2 text-left", children: "Bus" }), _jsx("th", { className: "p-2 text-right", children: "V (p.u.)" }), _jsx("th", { className: "p-2 text-right", children: "P (kW)" }), _jsx("th", { className: "p-2 text-right", children: "Q (kVAR)" })] }) }), _jsx("tbody", { children: busData.map((bus) => (_jsxs("tr", { className: `border-b hover:bg-blue-100 cursor-pointer ${selectedBus?.id === bus.id ? 'bg-amber-100' : 'bg-white'}`, onClick: () => setSelectedBus(bus), children: [_jsx("td", { className: "p-2 font-semibold", children: bus.id }), _jsxs("td", { className: `p-2 text-right font-bold ${bus.voltage < 0.95 ? 'text-red-600' : bus.voltage > 1.05 ? 'text-amber-600' : 'text-green-600'}`, children: [bus.voltage.toFixed(4), (bus.voltage < 0.95 || bus.voltage > 1.05) && ' ⚠️'] }), _jsx("td", { className: "p-2 text-right", children: bus.activePower.toFixed(1) }), _jsx("td", { className: "p-2 text-right", children: bus.reactivePower.toFixed(1) })] }, bus.id))) })] }) })] }), _jsxs("div", { className: "bg-gray-50 rounded-lg p-4", children: [_jsxs("h2", { className: "text-xl font-semibold mb-4 flex items-center gap-2", children: [_jsx(Zap, { className: "text-amber-600", size: 24 }), " Line Flows"] }), _jsx("div", { className: "overflow-auto max-h-96", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-amber-600 text-white sticky top-0", children: _jsxs("tr", { children: [_jsx("th", { className: "p-2", children: "Line" }), _jsx("th", { className: "p-2", children: "From\u2192To" }), _jsx("th", { className: "p-2", children: "Config" }), _jsx("th", { className: "p-2 text-right", children: "P (kW)" }), _jsx("th", { className: "p-2 text-right", children: "Q (kVAR)" })] }) }), _jsx("tbody", { children: lineData.map((line) => (_jsxs("tr", { className: `border-b hover:bg-amber-100 cursor-pointer ${selectedLine?.id === line.id ? 'bg-amber-100' : 'bg-white'}`, onClick: () => setSelectedLine(line), children: [_jsx("td", { className: "p-2 font-semibold", children: line.id }), _jsxs("td", { className: "p-2", children: [line.from, " \u2192 ", line.to] }), _jsx("td", { className: "p-2", children: _jsx("span", { className: "px-2 py-1 rounded text-xs font-bold text-white", style: { backgroundColor: getConfigColor(line.configType) }, children: line.configType }) }), _jsx("td", { className: "p-2 text-right", children: line.activePower?.toFixed(1) ?? '0.0' }), _jsx("td", { className: "p-2 text-right", children: line.reactivePower?.toFixed(1) ?? '0.0' })] }, line.id))) })] }) })] })] }), selectedBus && (_jsxs("div", { className: "bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-6 border-2 border-blue-200", children: [_jsxs("div", { className: "flex items-center gap-2 mb-4", children: [_jsx(AlertCircle, { className: "text-blue-600", size: 24 }), _jsxs("h3", { className: "text-xl font-semibold", children: ["Bus ", selectedBus.id, " Details"] })] }), _jsxs("div", { className: "grid grid-cols-3 gap-4", children: [_jsxs("div", { children: [_jsx("p", { className: "text-sm text-gray-600", children: "Voltage (p.u.)" }), _jsx("p", { className: `text-2xl font-bold ${selectedBus.voltage < 0.95 ? 'text-red-600' : selectedBus.voltage > 1.05 ? 'text-amber-600' : 'text-green-600'}`, children: selectedBus.voltage.toFixed(4) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-gray-600", children: "Active (kW)" }), _jsx("p", { className: "text-2xl font-bold text-green-600", children: selectedBus.activePower.toFixed(1) })] }), _jsxs("div", { children: [_jsx("p", { className: "text-sm text-gray-600", children: "Reactive (kVAR)" }), _jsx("p", { className: "text-2xl font-bold text-purple-600", children: selectedBus.reactivePower.toFixed(1) })] })] })] }))] }) }) }));
};
export default PowerSystemApp;
