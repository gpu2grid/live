import { useState, useEffect, useRef } from "react";
import { API_URL } from './api';

const BUS_NAMES: Record<number, string> = {
    1:'650', 2:'632', 3:'633', 4:'645', 5:'646', 6:'671',
    7:'684', 8:'611', 9:'634', 10:'675', 11:'652', 12:'680', 13:'692',
};

interface Props {
  voltages: number[];
  dataCenterBus?: number | null;
  loading?: boolean; 
  label?: string;
}

export default function VoltageHeatmap({ voltages, dataCenterBus }: Props) {
  const [selectedBus, setSelectedBus] = useState<number | null>(null);
  const [hoveredBus, setHoveredBus] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number, y: number } | null>(null);
  const [svgCode, setSvgCode] = useState<string>("");
  const containerRef = useRef<HTMLDivElement>(null);

  //ger svg
  useEffect(() => {
    async function fetchSvg() {
      try {
        const res = await fetch(`${API_URL}/api/heatmap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voltages, dataCenterBus }),
        });
        const text = await res.text();
        setSvgCode(text);
      } catch (e) { console.error(e); }
    }
    if (voltages?.length > 0) fetchSvg();
  }, [JSON.stringify(voltages), dataCenterBus]);

  // mouse events
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseMove = (e: MouseEvent) => {
      const target = e.target as SVGElement;
      const busElement = target.closest('[id^="bus-node-"]');

      if (busElement) {
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        const busId = parseInt(busElement.id.split('-').pop() || "0");
        
        setTooltipPos({ x, y });
        setHoveredBus(busId);
      } else {
        setHoveredBus(null);
      }
    };

    const handleClick = (e: MouseEvent) => {
      const target = e.target as SVGElement;
      const busElement = target.closest('[id^="bus-node-"]');

      if (busElement) {
        const busId = parseInt(busElement.id.split('-').pop() || "0");
        setSelectedBus(selectedBus === busId ? null : busId);
      } else {
        setSelectedBus(null);
      }
    };

    container.addEventListener("mousemove", handleMouseMove);
    container.addEventListener("click", handleClick);
    return () => {
      container.removeEventListener("mousemove", handleMouseMove);
      container.removeEventListener("click", handleClick);
    };
  }, [svgCode, selectedBus]);


  const activeBusId = hoveredBus || selectedBus;

  return (
    <div style={{ background: "#f8fafc", padding: "20px", borderRadius: "12px", border: "1px solid #e2e8f0", position: 'relative' }}>
      <div 
        ref={containerRef}
        className="svg-heatmap"
        style={{ position: 'relative' }}
        dangerouslySetInnerHTML={{ __html: svgCode }} 
      />

      {}
      {activeBusId && tooltipPos && (() => {
        const v = voltages[activeBusId - 1];
        let status = "NORMAL";
        let statusColor = "#16a34a";

        if (v < 0.95) { status = "UNDER-VOLTAGE"; statusColor = "#ef4444"; }
        else if (v > 1.05) { status = "OVER-VOLTAGE"; statusColor = "#f59e0b"; }

        return (
          <div style={{ 
            position: 'absolute', 
            left: tooltipPos.x + 15, 
            top: tooltipPos.y - 75,
            zIndex: 100,
            padding: "10px 14px", 
            backgroundColor: "rgba(255, 255, 255, 0.98)", 
            border: `2px solid ${statusColor}`, 
            borderRadius: "10px", 
            boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
            pointerEvents: 'none', 
            minWidth: '160px',
            transition: 'top 0.1s ease-out, left 0.1s ease-out' 
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: '10px', fontWeight: 800, color: '#64748b' }}>BUS {activeBusId}</span>
              <span style={{ 
                fontSize: '9px', fontWeight: 900, padding: '2px 6px', borderRadius: '4px', 
                backgroundColor: `${statusColor}22`, color: statusColor, border: `1px solid ${statusColor}44`
              }}>
                {status}
              </span>
            </div>
            
            <div style={{ fontSize: '22px', fontWeight: 900, color: statusColor, lineHeight: 1 }}>
              {v?.toFixed(4)} <span style={{ fontSize: '12px', fontWeight: 600 }}>p.u.</span>
            </div>
            
            <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: 4 }}>
               Node Name: {BUS_NAMES[activeBusId]}
            </div>
            {selectedBus === activeBusId && (
              <div style={{ fontSize: '9px', color: '#0891b2', fontStyle: 'italic', marginTop: 2 }}>
              </div>
            )}
          </div>
        );
      })()}

      <style>{`
        .svg-heatmap svg { width: 100% !important; height: auto !important; display: block; }
        [id^="bus-node-"] { cursor: pointer; pointer-events: all; transition: opacity 0.2s; }
        [id^="bus-node-"]:hover { opacity: 0.6; }
      `}</style>
    </div>
  );
}
