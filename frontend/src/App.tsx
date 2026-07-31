import { useState, useEffect, useRef, useCallback } from 'react';
import LLMImpactAnalysis from './LLMImpactAnalysis';
import VoltageComparison from './VoltageComparison';
import VoltageHeatmap, { Topology } from './VoltageHeatmap';
import { API_URL, wakeBackend } from './api';

const TOPOLOGY_OPTIONS: { value: Topology; label: string; numBuses: number }[] = [
  { value: 'ieee13',  label: 'IEEE 13-Bus',  numBuses: 13  },
  { value: 'ieee34',  label: 'IEEE 34-Bus',  numBuses: 34  },
  { value: 'ieee123', label: 'IEEE 123-Bus', numBuses: 123 },
];

type BottomTab = 'live' | 'ofo';

// Draggable split between the config panel and the heatmap viewport.
const LEFT_PANEL_MIN_PCT = 22;
const LEFT_PANEL_MAX_PCT = 60;
const LEFT_PANEL_DEFAULT_PCT = 35;
const LEFT_PANEL_STORAGE_KEY = 'llmGridImpact.leftPanelPct';

const App = () => {
  const [topology,          setTopology]          = useState<Topology>('ieee13');
  const [busNames,          setBusNames]          = useState<string[] | null>(null);
  const [topoLines,         setTopoLines]         = useState<[string,string,string][]>([]);
  const [heatmapVoltages,   setHeatmapVoltages]   = useState<number[] | null>(null);
  const [heatmapLoading,    setHeatmapLoading]    = useState(false);
  const [heatmapLabel,      setHeatmapLabel]      = useState('');
  const [baselineVoltages,  setBaselineVoltages]  = useState<number[] | null>(null);
  const [dataCenterBus,     setDataCenterBus]     = useState<number | null>(null);
  const [dataCenterBusName, setDataCenterBusName] = useState<string | null>(null);
  const [bottomTab,         setBottomTab]         = useState<BottomTab>('live');

  // ── Resizable left/right split ────────────────────────────────────────────
  const [leftPct, setLeftPct] = useState<number>(() => {
    const saved = Number(localStorage.getItem(LEFT_PANEL_STORAGE_KEY));
    return saved >= LEFT_PANEL_MIN_PCT && saved <= LEFT_PANEL_MAX_PCT ? saved : LEFT_PANEL_DEFAULT_PCT;
  });
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);


  
  const [isHoveringSplit, setIsHoveringSplit] = useState(false);
  const dashboardRef = useRef<HTMLDivElement>(null);

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingSplit(true);
  }, []);

  useEffect(() => {
    if (!isDraggingSplit) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = dashboardRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(LEFT_PANEL_MAX_PCT, Math.max(LEFT_PANEL_MIN_PCT, pct)));
    };
    const handleMouseUp = () => setIsDraggingSplit(false);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingSplit]);

  useEffect(() => {
    localStorage.setItem(LEFT_PANEL_STORAGE_KEY, String(leftPct));
  }, [leftPct]);

  useEffect(() => {
    const init = async () => {
      setHeatmapLoading(true);
      setHeatmapVoltages(null);
      setBusNames(null);
      setBaselineVoltages(null);
      setTopoLines([]);

      await wakeBackend();

      const topoMeta = TOPOLOGY_OPTIONS.find(t => t.value === topology)!;

      let coordBuses: string[] = [];
      try {
        const r = await fetch(`${API_URL}/api/topology/${topology}/buses`);
        if (r.ok) {
          const data = await r.json();
          coordBuses = (data.buses as string[]) ?? [];
        }
      } catch {}

      try {
        const res = await fetch(`${API_URL}/api/powerflow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topology,
            numBuses:          topoMeta.numBuses,
            baseVoltage:       4.16,
            substationVoltage: 1.05,
          }),
        });

        if (res.ok) {
          const data = await res.json();

          if (data.lines?.length) setTopoLines(data.lines);

          const busesData: { id: number; voltage: number; name?: string }[] = data.buses ?? [];
          const pfBusNames: string[] = busesData.map((b, i) =>
            (b.name ?? '').toLowerCase() || String(i + 1)
          );
          const pfVoltages: number[] = busesData.map(b => b.voltage);

          if (coordBuses.length > 0) {
            const pfNameSet = new Set(pfBusNames.map(n => n.toLowerCase()));
            const filteredBuses = coordBuses.filter(b => pfNameSet.has(b.toLowerCase()));

            if (filteredBuses.length === pfVoltages.length) {
              setBusNames(filteredBuses);
              setBaselineVoltages(pfVoltages);
              setHeatmapVoltages(pfVoltages);
            } else if (filteredBuses.length > 0) {
              const nameToV: Record<string, number> = {};
              pfBusNames.forEach((n, i) => { nameToV[n.toLowerCase()] = pfVoltages[i]; });
              const alignedV = filteredBuses.map(b => nameToV[b.toLowerCase()] ?? 1.0);
              setBusNames(filteredBuses);
              setBaselineVoltages(alignedV);
              setHeatmapVoltages(alignedV);
            } else {
              setBusNames(pfBusNames.length > 0 ? pfBusNames : null);
              setBaselineVoltages(pfVoltages);
              setHeatmapVoltages(pfVoltages);
            }
          } else {
            setBusNames(pfBusNames.length > 0 ? pfBusNames : null);
            setBaselineVoltages(pfVoltages);
            setHeatmapVoltages(pfVoltages);
          }

          setHeatmapLabel('');
          setDataCenterBus(null);
          setDataCenterBusName(null);
        }
      } catch (e) {
        console.error('Powerflow failed:', e);
      }

      setHeatmapLoading(false);
    };
    init();
  }, [topology]);

  const handleReset = () => {
    if (baselineVoltages) {
      setHeatmapVoltages([...baselineVoltages]);
      setHeatmapLabel('Baseline (no LLM load)');
      setDataCenterBus(null);
      setDataCenterBusName(null);
    }
  };


  const splitActive = isDraggingSplit || isHoveringSplit;

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: '#0f172a',
    }}>

      {/* ── Topology bar ── */}
      <div style={{
        padding: '10px 20px',
        background: 'linear-gradient(180deg, #131c31 0%, #0f172a 100%)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
        borderBottom: '1px solid #1e293b',
        minHeight: 44,
      }}>
        <span style={{ color: '#94a3b8', fontSize: 10, fontWeight: 700, letterSpacing: 1.2 }}>
          FEEDER
        </span>
        {TOPOLOGY_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setTopology(opt.value)}
            style={{
              background:   topology === opt.value ? '#0891b2' : '#182338',
              color:        topology === opt.value ? '#fff'    : '#94a3b8',
              border:       topology === opt.value ? '1px solid #22b8d4' : '1px solid #263248',
              borderRadius: 6,
              padding: '5px 13px',
              fontSize: 11,
              fontWeight: 800,
              cursor: 'pointer',
              transition: 'all 0.15s',
              lineHeight: 1.4,
              boxShadow: topology === opt.value ? '0 1px 6px rgba(8,145,178,0.35)' : 'none',
            }}
          >
            {opt.label}
          </button>
        ))}
        {heatmapLabel && bottomTab === 'live' && (
          <>
            {/* vertical divider to separate controls from the status readout */}
            <div style={{ width: 1, height: 18, background: '#263248', marginLeft: 'auto' }} />
            <span style={{
              color: '#7c8aa5',
              fontSize: 11,
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              paddingLeft: 4,
            }}>
              {heatmapLabel}
            </span>
          </>
        )}
      </div>

      {/* ── Global Tab Bar ── */}
      <div style={{
        display: 'flex', gap: 4, padding: '10px 24px 0',
        borderBottom: '1px solid #1e293b', flexShrink: 0, background: '#0f172a',
      }}>
        {([
          { key: 'live', label: 'Live Simulation' },
          { key: 'ofo',  label: 'Baseline vs. OFO' },
        ] as { key: BottomTab; label: string }[]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setBottomTab(tab.key)}
            style={{
              border: 'none',
              borderRadius: '6px 6px 0 0',
              borderBottom: bottomTab === tab.key ? '2px solid #0891b2' : '2px solid transparent',
              background: bottomTab === tab.key ? 'rgba(8,145,178,0.08)' : 'transparent',
              color: bottomTab === tab.key ? '#22d3ee' : '#64748b',
              fontWeight: 700,
              fontSize: 12,
              padding: '8px 18px 10px',
              cursor: 'pointer',
              transition: 'color 0.15s, background 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Main Dashboard Panel Area ── */}
      <div
        ref={dashboardRef}
        style={{
          flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, background: '#fff',
        
          userSelect: isDraggingSplit ? 'none' : 'auto',
          cursor: isDraggingSplit ? 'col-resize' : 'default',
        }}
      >

        {bottomTab === 'live' ? (
          <>
            {/* Left Column: Input Configuration Panel (resizable) */}
            <div style={{
              flex: `0 0 ${leftPct}%`,
              borderRight: '2px solid #e2e8f0',
              overflowY: 'auto',
              padding: '16px',
              background: '#ffffff',
            }}>
              <LLMImpactAnalysis
                topology={topology}
                baselineVoltages={baselineVoltages}
                onVoltagesUpdated={(v, label, bus) => {
                  setHeatmapVoltages([...v]);
                  setHeatmapLabel(label ?? 'With LLM Load');
                  setDataCenterBus(bus ?? null);
                  setDataCenterBusName(null);
                }}
                onLoadingChanged={setHeatmapLoading}
                onReset={handleReset}
              />
            </div>

            {}
            <div
              onMouseDown={handleSplitMouseDown}
              onMouseEnter={() => setIsHoveringSplit(true)}
              onMouseLeave={() => setIsHoveringSplit(false)}
              title="Drag to resize"
              style={{
                flex: '0 0 14px',
                marginLeft: -7,
                marginRight: -7,
                zIndex: 5,
                cursor: 'col-resize',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                position: 'relative',
              }}
            >
              {/* Full-height track — a soft, always-visible vertical line so
                  the split reads as an adjustable seam even at rest. */}
              <div style={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: splitActive ? 3 : 2,
                transform: 'translateX(-50%)',
                background: splitActive ? '#0891b2' : '#dbe3ee',
                transition: isDraggingSplit ? 'none' : 'background 0.15s, width 0.15s',
              }} />

              {/* Grip pill with dots — the actual "this is draggable" cue,
                  centered on the track and tinted on hover/drag for
                  feedback. */}
              <div style={{
                position: 'relative',
                width: 16,
                height: 40,
                borderRadius: 999,
                background: splitActive ? '#0891b2' : '#eef1f6',
                border: `1px solid ${splitActive ? '#0891b2' : '#cbd5e1'}`,
                boxShadow: splitActive ? '0 1px 4px rgba(8,145,178,0.35)' : '0 1px 2px rgba(15,23,42,0.06)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                transition: isDraggingSplit ? 'none' : 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
              }}>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{
                    width: 3,
                    height: 3,
                    borderRadius: '50%',
                    background: splitActive ? '#ffffff' : '#94a3b8',
                    transition: isDraggingSplit ? 'none' : 'background 0.15s',
                  }} />
                ))}
              </div>
            </div>

            {/* Right Column: Visualization Viewport (fills remaining space) */}
            <div style={{
              flex: '1 1 auto',
              minWidth: 0,             // Prevents the container from scaling past its share of the split
              position: 'relative',    // Establish layout bounds context for inner canvas/SVG
              padding: '16px',
              // Matches the left panel's background so the two columns read
              // as one continuous surface — a grey vs. white split here made
              // the heatmap look like a separate, lower box even though the
              // padding on both sides is identical.
              background: '#ffffff',
              display: 'flex',
              flexDirection: 'column',
            }}>
              {heatmapVoltages ? (
                <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                  <VoltageHeatmap
                    voltages={heatmapVoltages}
                    busNames={busNames ?? undefined}
                    lines={topoLines}
                    loading={heatmapLoading}
                    label={heatmapLabel}
                    dataCenterBus={dataCenterBus}
                    dataCenterBusName={dataCenterBusName}
                    topology={topology}
                  />
                </div>
              ) : (
                <div style={{
                  width: '100%', height: '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#94a3b8', fontSize: 12,
                  border: '1px dashed #cbd5e1', borderRadius: 8, background: 'white',
                }}>
                  {heatmapLoading
                    ? `Loading ${TOPOLOGY_OPTIONS.find(t => t.value === topology)?.label} heatmap…`
                    : 'Waiting for backend…'}
                </div>
              )}
            </div>
          </>
        ) : (
          /* Wide View Comparison Mode */
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
            <VoltageComparison
              topology={topology}
              onTopologyChange={setTopology}
              showTopologySwitcher={false}
            />
          </div>
        )}

      </div>
    </div>
  );
};

export default App;