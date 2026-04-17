import { useState, useEffect } from 'react';
import LLMImpactAnalysis from './LLMImpactAnalysis';
import VoltageHeatmap from './VoltageHeatmap';
import { API_URL, wakeBackend } from './api';

const App = () => {
  const [heatmapVoltages, setHeatmapVoltages]   = useState<number[] | null>(null);
  const [heatmapLoading, setHeatmapLoading]     = useState(false);
  const [heatmapLabel, setHeatmapLabel]         = useState<string>('Baseline (no LLM load)');
  const [baselineVoltages, setBaselineVoltages] = useState<number[] | null>(null);
  const [dataCenterBus, setDataCenterBus]       = useState<number | null>(null);

  useEffect(() => {
    
    wakeBackend();

    // load heatmap baseline
    const loadBaseline = async () => {
      setHeatmapLoading(true);
      try {
        const res = await fetch(`${API_URL}/api/powerflow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ numBuses: 13, baseVoltage: 4.16, substationVoltage: 1.05 }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const voltages = (data.buses || []).map((b: any) => b.voltage);
        setBaselineVoltages(voltages);
        setHeatmapVoltages(voltages);
        setHeatmapLabel('Baseline (no LLM load)');
      } catch { }
      finally { setHeatmapLoading(false); }
    };
    loadBaseline();
  }, []);

  const handleReset = () => {
    if (baselineVoltages) {
      setHeatmapVoltages([...baselineVoltages]);
      setHeatmapLabel('Baseline (no LLM load)');
      setDataCenterBus(null);
    }
  };

  return (
    <div className="min-h-screen bg-white">

      <div style={{ padding: '16px 32px', background: '#f1f5f9', borderBottom: '1px solid #e2e8f0' }}>
        {heatmapVoltages ? (
          <VoltageHeatmap
            voltages={heatmapVoltages}
            loading={heatmapLoading}
            label={heatmapLabel}
            dataCenterBus={dataCenterBus}
          />
        ) : (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#94a3b8', fontSize: 12,
            border: '1px dashed #e2e8f0', borderRadius: 8 }}>
            {heatmapLoading ? 'Loading voltage heatmap…' : 'Waiting for backend…'}
          </div>
        )}
      </div>

      <LLMImpactAnalysis
        onVoltagesUpdated={(v, label, bus) => {
          setHeatmapVoltages([...v]);
          setHeatmapLabel(label ?? 'With LLM Load');
          setDataCenterBus(bus ?? null);
        }}
        onLoadingChanged={setHeatmapLoading}
        onReset={handleReset}
      />

    </div>
  );
};

export default App;