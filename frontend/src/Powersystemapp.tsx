import React, { useState, useEffect } from 'react';
import { AlertCircle, Settings, RefreshCw, Zap, Activity } from 'lucide-react';

interface PowerSystemAppProps {
  onVoltagesUpdated?: (voltages: number[]) => void;
  onLoadingChanged?:  (loading: boolean)  => void;
}

const PowerSystemApp = ({ onVoltagesUpdated, onLoadingChanged }: PowerSystemAppProps) => {
  const [busData, setBusData]           = useState<any[]>([]);
  const [lineData, setLineData]         = useState<any[]>([]);
  const [selectedBus, setSelectedBus]   = useState<any>(null);
  const [selectedLine, setSelectedLine] = useState<any>(null);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState('checking');
  const config = { numBuses: 13, baseVoltage: 4.16 };

  const API_URL = 'http://localhost:8080';

  useEffect(() => { checkServerHealth(); }, []);
  useEffect(() => { if (serverStatus === 'connected') fetchPowerFlowData(); }, [serverStatus]);
  useEffect(() => { onLoadingChanged?.(loading); }, [loading]);

  const checkServerHealth = async () => {
    try {
      const r = await fetch(`${API_URL}/api/health`);
      if (r.ok) { setServerStatus('connected'); setError(null); }
      else        { setServerStatus('error'); setError('Server returned an error'); }
    } catch {
      setServerStatus('disconnected');
      setError("Cannot connect to Julia server. Make sure it's running on port 8080.");
    }
  };

  const fetchPowerFlowData = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${API_URL}/api/powerflow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numBuses: config.numBuses, baseVoltage: config.baseVoltage }),
      });
      if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
      const data = await r.json();
      const buses = data.buses || [];
      setBusData(buses);
      setLineData(data.lines || []);
      setServerStatus('connected');
      // ── push baseline voltages up to App heatmap ──
      onVoltagesUpdated?.(buses.map((b: any) => b.voltage));
    } catch (e: any) {
      setError('Failed to fetch data: ' + e.message);
      setServerStatus('error');
    } finally { setLoading(false); }
  };

  const busPositions: Record<number, [number, number]> = {
    1: [60, 250], 2: [200, 250], 3: [340, 100], 6: [500, 100],
    4: [340, 250], 7: [480, 250], 8: [480, 175], 9: [480, 325],
    13: [620, 325], 5: [200, 400], 10: [340, 400], 11: [620, 200], 12: [620, 280],
  };

  const getConfigColor = (cfg: string) =>
    cfg === '601' ? '#3b82f6' : cfg === '602' ? '#8b5cf6' : '#059669';

  const statusColors: Record<string, string> = {
    connected: 'bg-green-500', disconnected: 'bg-red-500',
    checking: 'bg-yellow-500', error: 'bg-orange-500',
  };
  const statusLabels: Record<string, string> = {
    connected: 'Connected', disconnected: 'Disconnected',
    checking: 'Checking...', error: 'Error',
  };

  const StatusBar = () => (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg">
        <div className={`w-2 h-2 rounded-full ${statusColors[serverStatus] ?? 'bg-gray-500'}`} />
        <span className="text-sm font-medium">{statusLabels[serverStatus] ?? serverStatus}</span>
      </div>
      <button
        onClick={fetchPowerFlowData}
        disabled={loading || serverStatus !== 'connected'}
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
      >
        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        {loading ? 'Computing...' : busData.length ? 'Recalculate' : 'Calculate Power Flow'}
      </button>
    </div>
  );

  if (!busData.length) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-8">
        <div className="max-w-7xl mx-auto bg-white rounded-lg shadow-2xl p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Zap className="text-blue-600" size={32} />
              <div>
                <h1 className="text-3xl font-bold">IEEE 13-Bus Power System</h1>
                <p className="text-sm text-gray-600">Julia Backend + React Frontend</p>
              </div>
            </div>
            <StatusBar />
          </div>
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
              <AlertCircle className="text-red-600" size={20} />
              <div>
                <p className="text-red-800 font-semibold">Connection Error</p>
                <p className="text-red-600 text-sm mt-1">{error}</p>
              </div>
            </div>
          )}
          {loading && (
            <div className="text-center py-12">
              <RefreshCw className="animate-spin mx-auto mb-4 text-blue-600" size={48} />
              <p className="text-xl font-semibold">Loading power flow data...</p>
            </div>
          )}
          {!loading && serverStatus === 'disconnected' && (
            <div className="mt-6 p-6 bg-blue-50 rounded-lg border-2 border-blue-200">
              <h3 className="font-bold text-blue-900 mb-3 flex items-center gap-2">
                <Settings size={20} /> Setup Instructions
              </h3>
              <ol className="list-decimal list-inside space-y-2 text-blue-800">
                <li>Run: <code className="bg-blue-100 px-2 py-1 rounded">julia server.jl</code></li>
                <li>Click "Calculate Power Flow"</li>
              </ol>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-800 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-lg shadow-2xl p-6">

          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Zap className="text-blue-600" size={32} />
              <div>
                <h1 className="text-3xl font-bold">IEEE 13-Bus Power System</h1>
                <p className="text-sm text-gray-600">LinDistFlow Model</p>
              </div>
            </div>
            <StatusBar />
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
              <AlertCircle className="text-red-600" size={20} />
              <div>
                <p className="text-red-800 font-semibold">Connection Error</p>
                <p className="text-red-600 text-sm mt-1">{error}</p>
              </div>
            </div>
          )}

          {/* Network Diagram */}
          <div className="bg-gray-50 rounded-lg p-4 mb-6">
            <h2 className="text-xl font-semibold mb-4">Network Topology</h2>
            <svg viewBox="0 0 800 600" className="w-full bg-white rounded border-2" style={{ minHeight: 600 }}>
              {lineData.map((line) => {
                const fp = busPositions[line.from]; const tp = busPositions[line.to];
                if (!fp || !tp) return null;
                return (
                  <line key={`line-${line.id}`}
                    x1={fp[0]} y1={fp[1]} x2={tp[0]} y2={tp[1]}
                    stroke={selectedLine?.id === line.id ? '#f59e0b' : getConfigColor(line.configType)}
                    strokeWidth={selectedLine?.id === line.id ? 5 : 4}
                    strokeDasharray={line.length === 0 ? '5,5' : 'none'}
                    className="cursor-pointer hover:stroke-amber-500 transition-colors"
                    onClick={() => setSelectedLine(line)} />
                );
              })}
              {busData.map((bus) => {
                const pos = busPositions[bus.id]; if (!pos) return null;
                const [x, y] = pos;
                const color = bus.id === 1 ? '#10b981'
                  : bus.voltage < 0.95 ? '#ef4444'
                  : bus.voltage > 1.05 ? '#f59e0b'
                  : bus.activePower > 0 ? '#3b82f6' : '#6b7280';
                return (
                  <g key={`bus-${bus.id}`} className="cursor-pointer" onClick={() => setSelectedBus(bus)}>
                    <circle cx={x} cy={y} r={selectedBus?.id === bus.id ? 14 : 12}
                      fill={color} stroke={selectedBus?.id === bus.id ? '#f59e0b' : '#fff'}
                      strokeWidth={selectedBus?.id === bus.id ? 3 : 2} />
                    <text x={x} y={y - 20} textAnchor="middle" className="text-xs font-bold fill-gray-700">Bus {bus.id}</text>
                    <text x={x} y={y + 30} textAnchor="middle" className="text-xs fill-gray-600 font-semibold">
                      {bus.voltage.toFixed(3)} p.u.
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Bus + Line tables */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-gray-50 rounded-lg p-4">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Activity className="text-blue-600" size={24} /> Bus Data
              </h2>
              <div className="overflow-auto max-h-96">
                <table className="w-full text-sm">
                  <thead className="bg-blue-600 text-white sticky top-0">
                    <tr>
                      <th className="p-2 text-left">Bus</th>
                      <th className="p-2 text-right">V (p.u.)</th>
                      <th className="p-2 text-right">P (kW)</th>
                      <th className="p-2 text-right">Q (kVAR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {busData.map((bus) => (
                      <tr key={bus.id}
                        className={`border-b hover:bg-blue-100 cursor-pointer ${selectedBus?.id === bus.id ? 'bg-amber-100' : 'bg-white'}`}
                        onClick={() => setSelectedBus(bus)}>
                        <td className="p-2 font-semibold">{bus.id}</td>
                        <td className={`p-2 text-right font-bold ${bus.voltage < 0.95 ? 'text-red-600' : bus.voltage > 1.05 ? 'text-amber-600' : 'text-green-600'}`}>
                          {bus.voltage.toFixed(4)}{(bus.voltage < 0.95 || bus.voltage > 1.05) && ' ⚠️'}
                        </td>
                        <td className="p-2 text-right">{bus.activePower.toFixed(1)}</td>
                        <td className="p-2 text-right">{bus.reactivePower.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-4">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Zap className="text-amber-600" size={24} /> Line Flows
              </h2>
              <div className="overflow-auto max-h-96">
                <table className="w-full text-sm">
                  <thead className="bg-amber-600 text-white sticky top-0">
                    <tr>
                      <th className="p-2">Line</th><th className="p-2">From→To</th>
                      <th className="p-2">Config</th>
                      <th className="p-2 text-right">P (kW)</th>
                      <th className="p-2 text-right">Q (kVAR)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineData.map((line) => (
                      <tr key={line.id}
                        className={`border-b hover:bg-amber-100 cursor-pointer ${selectedLine?.id === line.id ? 'bg-amber-100' : 'bg-white'}`}
                        onClick={() => setSelectedLine(line)}>
                        <td className="p-2 font-semibold">{line.id}</td>
                        <td className="p-2">{line.from} → {line.to}</td>
                        <td className="p-2">
                          <span className="px-2 py-1 rounded text-xs font-bold text-white"
                            style={{ backgroundColor: getConfigColor(line.configType) }}>
                            {line.configType}
                          </span>
                        </td>
                        <td className="p-2 text-right">{line.activePower?.toFixed(1) ?? '0.0'}</td>
                        <td className="p-2 text-right">{line.reactivePower?.toFixed(1) ?? '0.0'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {selectedBus && (
            <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-6 border-2 border-blue-200">
              <div className="flex items-center gap-2 mb-4">
                <AlertCircle className="text-blue-600" size={24} />
                <h3 className="text-xl font-semibold">Bus {selectedBus.id} Details</h3>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-gray-600">Voltage (p.u.)</p>
                  <p className={`text-2xl font-bold ${selectedBus.voltage < 0.95 ? 'text-red-600' : selectedBus.voltage > 1.05 ? 'text-amber-600' : 'text-green-600'}`}>
                    {selectedBus.voltage.toFixed(4)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Active (kW)</p>
                  <p className="text-2xl font-bold text-green-600">{selectedBus.activePower.toFixed(1)}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Reactive (kVAR)</p>
                  <p className="text-2xl font-bold text-purple-600">{selectedBus.reactivePower.toFixed(1)}</p>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

export default PowerSystemApp;