import { useState, useEffect, useRef, useCallback } from "react";
import { API_URL } from './api';

export type Topology = 'ieee13' | 'ieee34' | 'ieee123';

interface BusNode {
  name: string;
  displayName: string;
  voltage: number;
  x: number; y: number;
  isSubstation: boolean;
  isDC: boolean;
}

interface LineEdge {
  x1: number; y1: number;
  x2: number; y2: number;
  label: string;
}

interface TopoData {
  buses: string[];
  coords: Record<string, [number, number]>;
}

const PHANTOM_NODES = new Set([
  'rg60','814r','852r','150r','9r','25r','160r','61s','sourcebus','670'
]);

const IEEE13_BUS_INDEX: Record<string, number> = {
  '650':1,'632':2,'633':3,'645':4,'646':5,'671':6,
  '684':7,'611':8,'634':9,'675':10,'652':11,'680':12,'692':13,
};

const TOPO_LABEL: Record<Topology, string> = {
  ieee13:'IEEE 13-Bus', ieee34:'IEEE 34-Bus', ieee123:'IEEE 123-Bus',
};

const VMIN = 0.92, VMAX = 1.06;

function rdYlGn(t: number): string {
  t = Math.max(0, Math.min(1, t));
  const stops: [number,[number,number,number]][] = [
    [0.00,[215,25,28]],[0.25,[253,174,97]],[0.50,[255,255,191]],
    [0.75,[166,217,106]],[1.00,[26,150,65]],
  ];
  let lo=stops[0], hi=stops[stops.length-1];
  for (let i=0;i<stops.length-1;i++) {
    if (t>=stops[i][0]&&t<=stops[i+1][0]){lo=stops[i];hi=stops[i+1];break;}
  }
  const f=(t-lo[0])/(hi[0]-lo[0]||1);
  return `rgb(${Math.round(lo[1][0]+f*(hi[1][0]-lo[1][0]))},${Math.round(lo[1][1]+f*(hi[1][1]-lo[1][1]))},${Math.round(lo[1][2]+f*(hi[1][2]-lo[1][2]))})`;
}

function vColor(v: number) { return rdYlGn((v-VMIN)/(VMAX-VMIN)); }
function vTextColor(v: number) {
  if (v<0.95) return '#dc2626';
  if (v>1.05) return '#d97706';
  return '#166534';
}


const TOP_PAD = 84;


const SIDE_PAD = 92;

function scaleCoords(
  rawCoords: Record<string,[number,number]>,
  W: number, H: number, pad=SIDE_PAD, topPad=TOP_PAD,
): Record<string,[number,number]> {
  const entries=Object.entries(rawCoords).filter(([k])=>!PHANTOM_NODES.has(k.toLowerCase()));
  if (!entries.length) return {};
  const xs=entries.map(([,[x]])=>x), ys=entries.map(([,[,y]])=>y);
  const xMin=Math.min(...xs),xMax=Math.max(...xs);
  const yMin=Math.min(...ys),yMax=Math.max(...ys);
  const xR=xMax-xMin||1, yR=yMax-yMin||1;
  const res: Record<string,[number,number]>={};
  for (const [name,[x,y]] of entries) {
    res[name.toLowerCase()]=[
      Math.round(pad+(x-xMin)/xR*(W-2*pad)),
      Math.round(topPad+(y-yMin)/yR*(H-pad-topPad)),
    ];
  }
  return res;
}

function scaleOne(
  raw:[number,number], all:Record<string,[number,number]>,
  W:number, H:number, pad=SIDE_PAD, topPad=TOP_PAD,
):[number,number] {
  const vs=Object.values(all);
  const xs=vs.map(([x])=>x),ys=vs.map(([,y])=>y);
  const xMin=Math.min(...xs),xMax=Math.max(...xs);
  const yMin=Math.min(...ys),yMax=Math.max(...ys);
  return [
    Math.round(pad+(raw[0]-xMin)/(xMax-xMin||1)*(W-2*pad)),
    Math.round(topPad+(raw[1]-yMin)/(yMax-yMin||1)*(H-pad-topPad)),
  ];
}

interface Props {
  voltages:number[]; busNames?:string[];
  lines?:[string,string,string][];
  dataCenterBus?:number|null; dataCenterBusName?:string|null;
  loading?:boolean; label?:string; topology?:Topology;
}

export default function VoltageHeatmap({
  voltages,busNames,lines:linesProp=[],
  dataCenterBus,dataCenterBusName,topology='ieee13',
}:Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Use the full container height, not an aspect-ratio guess
  const [dims, setDims] = useState({w:900,h:480});
  const [topoData, setTopoData] = useState<TopoData|null>(null);
  const [edges, setEdges]       = useState<LineEdge[]>([]);
  const [nodes, setNodes]       = useState<BusNode[]>([]);
  const [hovered, setHovered]   = useState<string|null>(null);
  const [tipXY, setTipXY]       = useState<[number,number]|null>(null);

  const [zoom, setZoom]  = useState(1);
  const [pan, setPan]    = useState({x:0,y:0});
  const isPanning        = useRef(false);
  const panStart         = useRef({mx:0,my:0,px:0,py:0});

  useEffect(()=>{setZoom(1);setPan({x:0,y:0});},[topology]);

  // Track BOTH width and height of the container so SVG fills it exactly
  useEffect(()=>{
    const obs=new ResizeObserver(entries=>{
      const {width, height}=entries[0].contentRect;
      if (width>100 && height>60) setDims({w:width, h:height});
    });
    if (containerRef.current) obs.observe(containerRef.current);
    return ()=>obs.disconnect();
  },[]);

  useEffect(()=>{
    fetch(`${API_URL}/api/topology/${topology}/buses`)
      .then(r=>r.json()).then((d:TopoData)=>setTopoData(d)).catch(console.error);
  },[topology]);

  useEffect(()=>{
    if (!topoData||!voltages.length) return;
    const {w,h}=dims;
    const scaled=scaleCoords(topoData.coords,w,h);

    const vMap:Record<string,number>={};
    const names=busNames??Object.keys(scaled);
    names.forEach((n,i)=>{vMap[n.toLowerCase()]=voltages[i]??1.0;});

    let dcKey:string|null=null;
    if (dataCenterBusName) dcKey=dataCenterBusName.toLowerCase();
    else if (dataCenterBus&&busNames) dcKey=busNames[dataCenterBus-1]?.toLowerCase()??null;
    const subKey=names.find(n=>scaled[n.toLowerCase()])?.toLowerCase()??'';

    setNodes(Object.entries(scaled).map(([key,[px,py]])=>{
      const idx = topology==='ieee13'
        ? (IEEE13_BUS_INDEX[key]??IEEE13_BUS_INDEX[key.toUpperCase()])
        : undefined;
      const displayName = (topology==='ieee13' && idx) ? `Bus ${idx}` : key.toUpperCase();
      return {
        name:key, displayName,
        voltage:vMap[key]??1.0, x:px, y:py,
        isSubstation:key===subKey, isDC:key===dcKey,
      };
    }));

    const newEdges:LineEdge[]=[];
    for (const [b1raw,b2raw,label] of linesProp) {
      const b1=b1raw.split('.')[0].toLowerCase();
      const b2=b2raw.split('.')[0].toLowerCase();
      if (b1.includes('_open')||b2.includes('_open')) continue;
      const p1=scaled[b1]??(topoData.coords[b1]?scaleOne(topoData.coords[b1],topoData.coords,w,h):null);
      const p2=scaled[b2]??(topoData.coords[b2]?scaleOne(topoData.coords[b2],topoData.coords,w,h):null);
      if (!p1&&!p2) continue;
      const [x1,y1]=p1??p2!,[x2,y2]=p2??p1!;
      if (x1===x2&&y1===y2) continue;
      newEdges.push({x1,y1,x2,y2,label});
    }
    setEdges(newEdges);
  },[topoData,voltages,busNames,dataCenterBus,dataCenterBusName,dims,topology,linesProp]);

  const handleWheel=useCallback((e:React.WheelEvent<SVGSVGElement>)=>{
    e.preventDefault();
    const factor=e.deltaY<0?1.12:1/1.12;
    setZoom(z=>Math.max(0.3,Math.min(10,z*factor)));
  },[]);

  const handleMouseDown=useCallback((e:React.MouseEvent<SVGSVGElement>)=>{
    if (e.button!==0) return;
    isPanning.current=true;
    panStart.current={mx:e.clientX,my:e.clientY,px:pan.x,py:pan.y};
  },[pan]);

  const handleMouseMove=useCallback((e:React.MouseEvent<SVGSVGElement>)=>{
    if (isPanning.current) {
      setPan({
        x:panStart.current.px+(e.clientX-panStart.current.mx),
        y:panStart.current.py+(e.clientY-panStart.current.my),
      });
      return;
    }
    const rect=e.currentTarget.getBoundingClientRect();
    const mx=(e.clientX-rect.left-pan.x)/zoom;
    const my=(e.clientY-rect.top-pan.y)/zoom;
    let closest:string|null=null, minD=((numBuses>50?8:14)+10)**2;
    for (const nd of nodes) {
      const d=(nd.x-mx)**2+(nd.y-my)**2;
      if (d<minD){minD=d;closest=nd.name;}
    }
    setHovered(closest);
    setTipXY(closest?[e.clientX-rect.left,e.clientY-rect.top]:null);
  },[nodes,zoom,pan]);

  const handleMouseUp=useCallback(()=>{isPanning.current=false;},[]);

  const numBuses=nodes.length;
  const nr  =numBuses>100?4 :numBuses>34?6 :10;
  const lw  =numBuses>100?1.0:numBuses>34?1.5:2.5;
  const fs  =numBuses>100?7 :numBuses>34?8 :11;
  const fse =numBuses>100?5 :numBuses>34?6 :8;

  const showEdgeLabels=numBuses<=13;

  const {w,h}=dims;

 
  const cbH = 10;
  const cbW = Math.min(260, Math.max(140, w - 260)); // stays clear of the badge (left) and zoom controls (right)
  const cbX = w/2 - cbW/2;
  const cbY = 16;
  const cbGradId='rdylgn_v3';
  const cbTicks = [VMIN, 0.95, 1.00, 1.05, VMAX];
  const cbValToX = (v:number) => cbX + Math.max(0,Math.min(1,(v-VMIN)/(VMAX-VMIN))) * cbW;

  const hovNode=hovered?nodes.find(n=>n.name===hovered):null;

  return (
    <div ref={containerRef} style={{
      background:'white', borderRadius:12,
      border:'1px solid #e2e8f0', position:'relative', userSelect:'none',
      width:'100%', height:'100%', overflow:'visible',
    }}>
      {/* Badge */}
      <div style={{
        position:'absolute',top:8,left:12,zIndex:20,
        background:'#0f172a',color:'#fff',fontSize:10,
        fontWeight:800,padding:'3px 8px',borderRadius:4,letterSpacing:1,
      }}>{TOPO_LABEL[topology]}</div>

      {/* Zoom controls */}
      <div style={{
        position:'absolute',top:8,right:10,zIndex:20,
        display:'flex',alignItems:'center',gap:2,
        background:'rgba(255,255,255,0.95)',
        border:'1px solid #e2e8f0',
        borderRadius:6,padding:'3px 6px',
        boxShadow:'0 1px 4px rgba(0,0,0,0.08)',
        maxWidth:'calc(100% - 24px)',
        whiteSpace:'nowrap',
      }}>
        {[
          {label:'+',fn:()=>setZoom(z=>Math.min(10,z*1.3)),title:'Zoom in'},
          {label:'−',fn:()=>setZoom(z=>Math.max(0.3,z/1.3)),title:'Zoom out'},
          {label:'⊡',fn:()=>{setZoom(1);setPan({x:0,y:0});},title:'Reset view'},
        ].map(({label,fn,title})=>(
          <button key={label} onClick={fn} title={title} style={{
            width:24,height:24,borderRadius:4,border:'none',flexShrink:0,
            background:'transparent',cursor:'pointer',fontSize:13,fontWeight:700,
            color:'#475569',display:'flex',alignItems:'center',justifyContent:'center',
          }}>{label}</button>
        ))}
        <div style={{width:1,height:16,background:'#e2e8f0',margin:'0 3px',flexShrink:0}}/>
        {}
        <span
          title="Scroll to zoom · drag to pan"
          style={{fontSize:13,color:'#94a3b8',cursor:'help',flexShrink:0,padding:'0 2px'}}
        >
          ⓘ
        </span>
      </div>

      <svg
        width={w} height={h} viewBox={`0 0 ${w} ${h}`}
        style={{display:'block',cursor:isPanning.current?'grabbing':'grab',overflow:'hidden'}}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={()=>{isPanning.current=false;setHovered(null);setTipXY(null);}}
      >
        <rect width={w} height={h} fill="white" rx={12}/>

        <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
          {/* Lines */}
          {edges.map((e,i)=>{
            const isVertical = Math.abs(e.x1-e.x2) < 8;
            const isShort = Math.hypot(e.x2-e.x1,e.y2-e.y1) < 60;

            const skipLabel = isVertical || isShort;
            return (
              <g key={i}>
                <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke="white" strokeWidth={lw*2.8/zoom} strokeLinecap="round"/>
                <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke="#1e293b" strokeWidth={lw/zoom} strokeLinecap="round"/>
                {showEdgeLabels&&e.label&&!skipLabel&&(()=>{
                  const mx=(e.x1+e.x2)/2,my=(e.y1+e.y2)/2;
                  const tw=e.label.length*fse*0.58;
                  const scaledFse=fse/zoom;
                  return (<>
                    <rect x={mx-tw/2-2} y={my-scaledFse/2-2}
                      width={tw+4} height={scaledFse+4}
                      rx={2} fill="white" opacity={0.9} stroke="#cbd5e1" strokeWidth={0.5/zoom}/>
                    <text x={mx} y={my+scaledFse*0.38} textAnchor="middle"
                      fontSize={scaledFse} fontFamily="monospace" fill="#334155">{e.label}</text>
                  </>);
                })()}
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map(nd=>{
            const col=vColor(nd.voltage);
            const under=nd.voltage<0.95,over=nd.voltage>1.05;
            const isHov=hovered===nd.name;
            const vtxt=`${nd.voltage.toFixed(3)} p.u.`;
            const scaledNr=nr/zoom, scaledFs=fs/zoom, scaledFsV=(fs-1)/zoom;
            const nameTw=nd.displayName.length*scaledFs*0.62;
            const vtxtTw=vtxt.length*scaledFsV*0.58;

            return (
              <g key={nd.name}>
                {(under||over)&&(
                  <circle cx={nd.x} cy={nd.y} r={scaledNr+8/zoom}
                    fill={under?'#ef444433':'#f59e0b33'}
                    stroke={under?'#ef4444':'#f59e0b'}
                    strokeWidth={1.5/zoom}/>
                )}
                {isHov&&!under&&!over&&(
                  <circle cx={nd.x} cy={nd.y} r={scaledNr+7/zoom}
                    fill="#f59e0b22" stroke="#f59e0b" strokeWidth={1.5/zoom}/>
                )}
                {nd.isDC&&(<>
                  <circle cx={nd.x} cy={nd.y} r={scaledNr+10/zoom}
                    fill="none" stroke="#0891b2" strokeWidth={2.5/zoom}/>
                  <circle cx={nd.x} cy={nd.y} r={scaledNr+14/zoom}
                    fill="none" stroke="#0891b2" strokeWidth={1/zoom} opacity={0.4}/>
                </>)}
                {nd.isSubstation?(
                  <rect x={nd.x-scaledNr} y={nd.y-scaledNr}
                    width={scaledNr*2} height={scaledNr*2}
                    fill={col} stroke="#1e293b" strokeWidth={2/zoom}/>
                ):(
                  <circle cx={nd.x} cy={nd.y} r={scaledNr}
                    fill={col} stroke="#1e293b" strokeWidth={1.5/zoom}/>
                )}
                {/* Label above */}
                <rect x={nd.x-nameTw/2-3} y={nd.y-scaledNr-scaledFs-9/zoom}
                  width={nameTw+6} height={scaledFs+4/zoom}
                  fill="white" opacity={0.85} rx={2/zoom}/>
                <text x={nd.x} y={nd.y-scaledNr-6/zoom}
                  textAnchor="middle" fontSize={scaledFs}
                  fontFamily="Inter,Arial,sans-serif"
                  fontWeight={nd.isSubstation?800:700} fill="#1e293b">
                  {nd.displayName}
                </text>
                {/* Voltage below */}
                <rect x={nd.x-vtxtTw/2-2} y={nd.y+scaledNr+2/zoom}
                  width={vtxtTw+4} height={scaledFsV+2/zoom}
                  fill="white" opacity={0.85} rx={2/zoom}/>
                <text x={nd.x} y={nd.y+scaledNr+scaledFsV+2/zoom}
                  textAnchor="middle" fontSize={scaledFsV}
                  fontFamily="Inter,Arial,sans-serif"
                  fontWeight={700} fill={vTextColor(nd.voltage)}>
                  {vtxt}
                </text>
              </g>
            );
          })}
        </g>

        {/*horizonyal */}
        <defs>
          <linearGradient id={cbGradId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor={rdYlGn(0.0)}/>
            <stop offset="25%"  stopColor={rdYlGn(0.25)}/>
            <stop offset="50%"  stopColor={rdYlGn(0.5)}/>
            <stop offset="75%"  stopColor={rdYlGn(0.75)}/>
            <stop offset="100%" stopColor={rdYlGn(1.0)}/>
          </linearGradient>
        </defs>

        <text x={cbX-8} y={cbY+cbH-1} textAnchor="end"
          fontSize={9} fill="#64748b" fontFamily="Inter,Arial,sans-serif">V (p.u.)</text>

        <rect x={cbX} y={cbY} width={cbW} height={cbH}
          fill={`url(#${cbGradId})`} stroke="#94a3b8" strokeWidth={0.5}/>

        {([{v:0.95,col:'#ef4444'},{v:1.05,col:'#f59e0b'}] as const).map(({v,col})=>{
          const lx=cbValToX(v);
          return <line key={v} x1={lx} y1={cbY} x2={lx} y2={cbY+cbH}
            stroke={col} strokeWidth={1.5} strokeDasharray="2 2"/>;
        })}

        {cbTicks.map(v=>{
          const lx=cbValToX(v);
          return (<g key={v}>
            <line x1={lx} y1={cbY+cbH} x2={lx} y2={cbY+cbH+3} stroke="#64748b" strokeWidth={0.8}/>
            <text x={lx} y={cbY+cbH+13} textAnchor="middle" fontSize={8} fill="#64748b" fontFamily="monospace">
              {v.toFixed(2)}
            </text>
          </g>);
        })}

        {/* Legend — bottom-left corner, compact */}
        {(()=>{
          const lx=12, ly=h-96, lw2=155, lh=88;
          return (<>
            <rect x={lx} y={ly} width={lw2} height={lh}
              fill="white" stroke="#e2e8f0" strokeWidth={0.8} rx={4} opacity={0.96}/>
            <circle cx={lx+13} cy={ly+12} r={5} fill="none" stroke="#0891b2" strokeWidth={2}/>
            <text x={lx+24} y={ly+16} fontSize={8} fontFamily="Inter,Arial,sans-serif" fill="#1e293b">Data center bus</text>
            <circle cx={lx+13} cy={ly+28} r={5} fill="#ef444433" stroke="#ef4444" strokeWidth={1.2}/>
            <text x={lx+24} y={ly+32} fontSize={8} fontFamily="Inter,Arial,sans-serif" fill="#1e293b">Under-voltage &lt; 0.95 p.u.</text>
            <circle cx={lx+13} cy={ly+44} r={5} fill="#f59e0b33" stroke="#f59e0b" strokeWidth={1.2}/>
            <text x={lx+24} y={ly+48} fontSize={8} fontFamily="Inter,Arial,sans-serif" fill="#1e293b">Over-voltage &gt; 1.05 p.u.</text>
            <rect x={lx+7} y={ly+57} width={11} height={11} fill="#4ade80" stroke="#1e293b" strokeWidth={1.2}/>
            <text x={lx+24} y={ly+67} fontSize={8} fontFamily="Inter,Arial,sans-serif" fill="#1e293b">Substation</text>
            <circle cx={lx+13} cy={ly+79} r={5} fill="#4ade80" stroke="#1e293b" strokeWidth={1.2}/>
            <text x={lx+24} y={ly+83} fontSize={8} fontFamily="Inter,Arial,sans-serif" fill="#1e293b">Load bus</text>
          </>);
        })()}
      </svg>

      {/* Tooltip */}
      {hovNode&&tipXY&&(()=>{
        const v=hovNode.voltage;
        const sc=v<0.95?'#ef4444':v>1.05?'#f59e0b':'#16a34a';
        const st=v<0.95?'UNDER-VOLTAGE':v>1.05?'OVER-VOLTAGE':'NORMAL';
        return (
          <div style={{
            position:'absolute',
            left:Math.min(tipXY[0]+16,w-185),top:Math.max(tipXY[1]-90,8),
            zIndex:100,pointerEvents:'none',
            background:'rgba(255,255,255,0.98)',border:`2px solid ${sc}`,
            borderRadius:10,padding:'10px 14px',
            boxShadow:'0 6px 20px rgba(0,0,0,0.13)',minWidth:160,
          }}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <span style={{fontSize:10,fontWeight:800,color:'#64748b',letterSpacing:1}}>
                {hovNode.displayName}{topology==='ieee13'?` (${hovNode.name.toUpperCase()})`:''} 
              </span>
              <span style={{fontSize:9,fontWeight:900,padding:'2px 6px',borderRadius:4,
                background:`${sc}22`,color:sc,border:`1px solid ${sc}44`}}>{st}</span>
            </div>
            <div style={{fontSize:22,fontWeight:900,color:sc,lineHeight:1}}>
              {v.toFixed(4)}<span style={{fontSize:12,fontWeight:600}}> p.u.</span>
            </div>
            {hovNode.isDC&&<div style={{fontSize:10,color:'#0891b2',marginTop:4,fontWeight:700}}>⚡ Datacenter Bus</div>}
            {hovNode.isSubstation&&<div style={{fontSize:10,color:'#64748b',marginTop:4}}>🔲 Substation</div>}
          </div>
        );
      })()}
    </div>
  );
}