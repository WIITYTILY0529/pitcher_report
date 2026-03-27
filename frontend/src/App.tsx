import { useState, useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';
import { Search, RotateCcw, Play, Pause, ChevronDown, Check, Download } from 'lucide-react';
import './App.css';

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787';

const NAVY     = '#0D1B2A';
const NAVY_MID = '#1B3A5C';
const GRAY_LITE= '#EEF1F7';
const GRAY_MID = '#C8D0DC';
const GRAY_DARK= '#8A95A3';

// ── 구종별 고정 색상 (구종 추가/제거해도 색상 불변) ─────────────────────
const PITCH_COLORS: Record<string, string> = {
  '4-Seam Fastball': '#E63946',
  'Sinker':          '#FF6B6B',
  'Cutter':          '#F4A261',
  'Slider':          '#E9C46A',
  'Sweeper':         '#FFB703',
  'Curveball':       '#457B9D',
  'Knuckle Curve':   '#5B8DB8',
  'Changeup':        '#2A9D8F',
  'Splitter':        '#8338EC',
  'Knuckleball':     '#06D6A0',
  'Eephus':          '#FB5607',
  'Screwball':       '#FF006E',
  'Forkball':        '#3A86FF',
  'Slurve':          '#FFBE0B',
};

// 미등록 구종은 구종명 해시 기반으로 고정 색상 할당
const FALLBACK_PALETTE = ['#E63946','#2A9D8F','#E9C46A','#457B9D','#F4A261','#8338EC','#06D6A0','#FFB703','#FB5607'];
function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

function getPitchColor(name: string): string {
  return PITCH_COLORS[name] ?? hashColor(name);
}

const NEEDED_COLS = new Set([
  'pitcher_name','pitch_name','stand','plate_x','plate_z',
  'breakXInches','breakZInducedInches','start_speed','spin_rate','extension',
  'x0','z0','events','batter_name','launch_speed','launch_angle',
  'description','call','vy0','ay','vz0','az','game_total_pitches',
]);

interface Pitcher { name: string; pitch_types: string[] }
interface PitchRecord {
  pitcher_name: string; pitch_name: string; stand: string;
  plate_x: number|null; plate_z: number|null;
  breakXInches: number|null; breakZInducedInches: number|null;
  start_speed: number|null; spin_rate: number|null; extension: number|null;
  x0: number|null; z0: number|null;
  events: string|null; batter_name: string|null;
  launch_speed: number|null; launch_angle: number|null;
  description: string|null; call: string|null;
  vy0: number|null; ay: number|null; vz0: number|null; az: number|null;
}

// ── Plotly DOM 렌더러 — 컨테이너 크기에 맞게 자동 조절 ──────────────────
function PlotChart({ id, data, layout }: { id: string; data: any[]; layout: any }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    (Plotly as any).react(ref.current, data, {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: '#FAFBFD',
      font: { family: 'Inter, sans-serif', color: NAVY },
      margin: { l: 52, r: 20, t: 16, b: 52 },
      showlegend: true,
      legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.12, font: { size: 12 } },
      autosize: true,
      ...layout,
    }, { displayModeBar: false, responsive: true });
  }, [data, layout]);
  return <div id={id} ref={ref} style={{ width: '100%', height: '100%' }} />;
}

// ── 유틸 ──────────────────────────────────────────────────────────────────
function extractGamePk(v: string): string | null {
  const s = v.trim();
  if (/^\d+$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://x.com?${s}`);
    const g = u.searchParams.get('gamePk') ?? u.searchParams.get('game_pk');
    if (g) return g;
  } catch {}
  const m = s.match(/#(\d+)/) ?? s.match(/\/(\d{6,})/);
  return m ? m[1] : null;
}

function cleanRecord(raw: Record<string, unknown>): PitchRecord {
  const out: Record<string, unknown> = {};
  for (const k of NEEDED_COLS) {
    const v = raw[k];
    out[k] = (typeof v === 'number' && !isFinite(v)) ? null : (v ?? null);
  }
  return out as unknown as PitchRecord;
}

function calcVaa(p: PitchRecord): number | null {
  if (!p.vy0||!p.ay||!p.vz0||!p.az) return null;
  const vyf = -Math.sqrt(Math.abs(p.vy0**2 - 2*p.ay*(50 - 17/12)));
  const t = (vyf - p.vy0) / p.ay;
  return -(Math.atan((p.vz0 + p.az*t) / vyf) * (180/Math.PI));
}

function avg(arr: number[]) { return arr.length ? arr.reduce((a,b)=>a+b)/arr.length : null; }
function std(arr: number[], mean: number) {
  return arr.length < 2 ? 0 : Math.sqrt(arr.reduce((s,v)=>s+(v-mean)**2,0)/arr.length);
}

// 1-sigma ellipse를 Plotly scatter trace로 생성 (N=72점 근사)
function ellipseTrace(cx: number, cy: number, rx: number, ry: number, color: string, name: string) {
  const N = 72;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i <= N; i++) {
    const a = (2 * Math.PI * i) / N;
    xs.push(cx + rx * Math.cos(a));
    ys.push(cy + ry * Math.sin(a));
  }
  return {
    x: xs, y: ys, mode: 'lines', name, legendgroup: name,
    showlegend: false, hoverinfo: 'skip',
    line: { color, width: 1.5, dash: 'dash' },
  };
}

// 채운 타원 (fill)
function ellipseFillTrace(cx: number, cy: number, rx: number, ry: number, color: string, name: string) {
  const N = 72;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i <= N; i++) {
    const a = (2 * Math.PI * i) / N;
    xs.push(cx + rx * Math.cos(a));
    ys.push(cy + ry * Math.sin(a));
  }
  return {
    x: xs, y: ys, mode: 'lines', name, legendgroup: name,
    showlegend: false, hoverinfo: 'skip', fill: 'toself',
    fillcolor: color + '28', // ~16% opacity
    line: { color: 'rgba(0,0,0,0)', width: 0 },
  };
}

// 구종별 scatter + ellipse traces 생성
function makeEllipseTraces(
  data: PitchRecord[],
  pitchTypes: string[],
  colorMap: Record<string,string>,
  xKey: keyof PitchRecord,
  yKey: keyof PitchRecord,
  hoverFn: (d: PitchRecord) => string,
  filterFn?: (d: PitchRecord) => boolean,
) {
  const traces: any[] = [];
  for (const pt of pitchTypes) {
    const sub = (filterFn ? data.filter(filterFn) : data)
      .filter(d => d.pitch_name === pt);
    const xs = sub.map(d => d[xKey] as number).filter(v => v != null && isFinite(v));
    const ys = sub.map(d => d[yKey] as number).filter(v => v != null && isFinite(v));
    if (!xs.length) continue;
    const col = colorMap[pt];
    const cx = avg(xs)!;
    const cy = avg(ys)!;
    const rx = Math.max(std(xs, cx), 0.15);
    const ry = Math.max(std(ys, cy), 0.15);

    // 채운 타원 → 외곽선 타원 → 산점도 → 중심점 순서
    traces.push(ellipseFillTrace(cx, cy, rx, ry, col, pt));
    traces.push(ellipseTrace(cx, cy, rx, ry, col, pt));
    traces.push({
      x: xs, y: ys, mode: 'markers', name: pt, legendgroup: pt,
      showlegend: true, type: 'scatter',
      marker: { size: 7, color: col, line: { color: 'white', width: 0.5 }, opacity: 0.75 },
      text: sub.map(hoverFn), hovertemplate: '%{text}<extra></extra>',
    });
    // 중심점 (큰 원)
    traces.push({
      x: [cx], y: [cy], mode: 'markers', name: pt, legendgroup: pt,
      showlegend: false, hoverinfo: 'skip',
      marker: { size: 14, color: col, line: { color: 'white', width: 2 } },
    });
  }
  return traces;
}

function calcStats(data: PitchRecord[], pitchTypes: string[], stand: string) {
  return pitchTypes.map(pt => {
    const sub = data.filter(d =>
      d.pitch_name === pt &&
      (stand === 'both' || d.stand === (stand === 'left' ? 'L' : 'R'))
    );
    if (!sub.length) return null;
    const vaas   = sub.map(calcVaa).filter((v): v is number => v !== null);
    const speeds = sub.map(d=>d.start_speed).filter((v): v is number => v!==null);
    const ivbs   = sub.map(d=>d.breakZInducedInches).filter((v): v is number => v!==null);
    const hbs    = sub.map(d=>d.breakXInches).filter((v): v is number => v!==null);
    const spins  = sub.map(d=>d.spin_rate).filter((v): v is number => v!==null);
    const exts   = sub.map(d=>d.extension).filter((v): v is number => v!==null);
    const whiffs = sub.filter(d=>d.description==='Swinging Strike').length;
    const strikes= sub.filter(d=>d.call&&['S','X'].includes(d.call.toUpperCase())).length;
    return {
      Pitch:     pt,
      'VAA min': vaas.length ? Math.min(...vaas).toFixed(1) : '-',
      'VAA max': vaas.length ? Math.max(...vaas).toFixed(1) : '-',
      Velo:      avg(speeds)?.toFixed(1) ?? '-',
      IVB:       avg(ivbs)?.toFixed(1)   ?? '-',
      HB:        avg(hbs)?.toFixed(1)    ?? '-',
      Spin:      spins.length ? Math.round(spins.reduce((a,b)=>a+b)/spins.length) : '-',
      Ext:       avg(exts)?.toFixed(1)   ?? '-',
      'Whiff%':  `${((whiffs/sub.length)*100).toFixed(1)}%`,
      'Strike%': `${((strikes/sub.length)*100).toFixed(1)}%`,
      Count:     sub.length,
    };
  }).filter(Boolean) as Record<string,any>[];
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput]           = useState('');
  const [gamePk, setGamePk]         = useState('');
  const [pitchers, setPitchers]     = useState<Pitcher[]>([]);
  const [selected, setSelected]     = useState<Pitcher|null>(null);
  const [selPitches, setSelPitches] = useState<string[]>([]);
  const [stand, setStand]           = useState('both');
  const [pitchData, setPitchData]   = useState<PitchRecord[]>([]);
  const [boxscore, setBoxscore]     = useState<Record<string,any>>({});
  const [loading, setLoading]       = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [countdown, setCountdown]   = useState(15);
  const [error, setError]           = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval>|null>(null);

  async function fetchFromSavant(gk: string): Promise<PitchRecord[]> {
    const res = await fetch(`${WORKER_URL}/gf?game_pk=${gk}`);
    if (!res.ok) throw new Error(`Worker error: ${res.status}`);
    const json = await res.json();
    return [...(json.team_home??[]),...(json.team_away??[])].map(cleanRecord);
  }

  async function handleFetch() {
    if (!input.trim()) return;
    setLoading(true); setError('');
    try {
      const gk = extractGamePk(input);
      if (!gk) throw new Error('유효한 game_pk 또는 URL을 입력하세요.');
      const all = await fetchFromSavant(gk);
      if (!all.length) throw new Error('투구 데이터가 없습니다.');
      const map: Record<string,Set<string>> = {};
      for (const p of all) {
        if (!p.pitcher_name) continue;
        map[p.pitcher_name] ??= new Set();
        if (p.pitch_name) map[p.pitcher_name].add(p.pitch_name);
      }
      setGamePk(gk); setSelected(null); setPitchData([]);
      setPitchers(Object.entries(map).sort(([a],[b])=>a.localeCompare(b))
        .map(([name,pts])=>({ name, pitch_types:[...pts].sort() })));

      // 박스스코어 — MLB Stats API 직접 호출 (CORS 허용)
      try {
        const bsRes = await fetch(
          `https://statsapi.mlb.com/api/v1/game/${gk}/boxscore`
        );
        if (bsRes.ok) {
          const bsJson = await bsRes.json();
          const stats: Record<string,any> = {};
          for (const side of ['away','home'] as const) {
            const players = bsJson?.teams?.[side]?.players ?? {};
            for (const p of Object.values(players) as any[]) {
              const ps = p?.stats?.pitching;
              if (ps && Object.keys(ps).length) {
                stats[p.person.fullName] = ps;
              }
            }
          }
          setBoxscore(stats);
        }
      } catch { /* 박스스코어 실패해도 계속 진행 */ }
    } catch(e:any) { setError(e.message??'Failed'); }
    finally { setLoading(false); }
  }

  async function loadPitchData(gk: string, pitcher: Pitcher) {
    setLoading(true);
    try {
      const all = await fetchFromSavant(gk);
      let f = all.filter(d=>d.pitcher_name===pitcher.name);
      if (selPitches.length) f = f.filter(d=>selPitches.includes(d.pitch_name));
      if (stand!=='both') { const c=stand==='left'?'L':'R'; f=f.filter(d=>d.stand===c); }
      setPitchData(f); setError('');
    } catch(e:any) { setError(e.message??'Failed'); }
    finally { setLoading(false); }
  }

  useEffect(()=>{ if(gamePk&&selected) loadPitchData(gamePk,selected); },[gamePk,selected,selPitches,stand]);

  useEffect(()=>{
    if(autoUpdate&&gamePk&&selected){
      timerRef.current=setInterval(()=>{
        setCountdown(p=>{ if(p<=1){loadPitchData(gamePk,selected!);return 15;} return p-1; });
      },1000);
    } else { if(timerRef.current) clearInterval(timerRef.current); setCountdown(15); }
    return ()=>{ if(timerRef.current) clearInterval(timerRef.current); };
  },[autoUpdate,gamePk,selected]);

  // 개별 차트 다운로드 헬퍼
  async function downloadPlot(id: string, suffix: string) {
    if (!selected) return;
    const base = `Report_${selected.name.replace(/,?\s+/g,'_')}`;
    const el = document.getElementById(id);
    if (el) await (Plotly as any).downloadImage(el, {
      format:'png', width:800, height:800, filename:`${base}_${suffix}`,
    });
  }

  async function downloadTable(id: string, suffix: string) {
    if (!selected) return;
    const base = `Report_${selected.name.replace(/,?\s+/g,'_')}`;
    const html2canvas = (await import('html2canvas')).default;
    const el = document.getElementById(id);
    if (!el) return;
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff' });
    const link = document.createElement('a');
    link.download = `${base}_${suffix}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  async function handleDownload() {
    if (!selected||!pitchData.length) return;
    await downloadPlot('plot-move', 'movement');
    await downloadPlot('plot-zone', 'location');
    await downloadPlot('plot-rel',  'release');
    await downloadTable('table-stats', 'statistics');
    await downloadTable('table-bip',   'batted_ball');
  }

  const pitchTypes = [...new Set(pitchData.map(d=>d.pitch_name).filter(Boolean))];
  const colorMap   = Object.fromEntries(pitchTypes.map(pt => [pt, getPitchColor(pt)]));

  // 선택된 투수의 박스스코어 스탯 매칭 (성/이름 순서 다를 수 있어서 느슨하게 매칭)
  const selectedBoxscore = (() => {
    if (!selected || !Object.keys(boxscore).length) return null;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g,'');
    const target = norm(selected.name);
    for (const [name, stats] of Object.entries(boxscore)) {
      const n = norm(name);
      if (n === target || n.includes(target) || target.includes(n)) return stats as any;
    }
    return null;
  })();

  // ── traces ────────────────────────────────────────────────────────────────
  // 로케이션: L+R 합쳐서 하나
  const zoneTraces = makeEllipseTraces(pitchData, pitchTypes, colorMap,
    'plate_x','plate_z',
    d=>`<b>${d.pitch_name}</b><br>${d.start_speed} mph · ${d.spin_rate} rpm<br>${d.stand==='L'?'vs LHB':'vs RHB'}`);

  const moveTraces = makeEllipseTraces(pitchData, pitchTypes, colorMap,    'breakXInches','breakZInducedInches',
    d=>`<b>${d.pitch_name}</b><br>IVB: ${d.breakZInducedInches}"<br>HB: ${d.breakXInches}"<br>${d.start_speed} mph`);

  const relTraces = makeEllipseTraces(pitchData, pitchTypes, colorMap,
    'x0','z0',
    d=>`<b>${d.pitch_name}</b><br>X: ${(d.x0??0).toFixed(2)} ft<br>Z: ${(d.z0??0).toFixed(2)} ft`);

  const stats   = calcStats(pitchData, pitchTypes, stand);
  const bipData = pitchData.filter(d=>d.events&&d.launch_speed!=null).slice(0,15);

  // ── 공통 축 스타일 ────────────────────────────────────────────────────────
  const ax = (extra={}) => ({ gridcolor:GRAY_MID, zerolinecolor:GRAY_MID, linecolor:GRAY_MID, tickfont:{color:GRAY_DARK,size:10}, ...extra });

  // 스트라이크존 shapes
  const zoneShapes = [
    {type:'rect',x0:-0.83,y0:1.5,x1:0.83,y1:3.5,line:{color:NAVY,width:2}},
    {type:'line',x0:-0.83+(1.66/3),y0:1.5,x1:-0.83+(1.66/3),y1:3.5,line:{color:GRAY_MID,width:0.7,dash:'dash'}},
    {type:'line',x0:-0.83+(1.66*2/3),y0:1.5,x1:-0.83+(1.66*2/3),y1:3.5,line:{color:GRAY_MID,width:0.7,dash:'dash'}},
    {type:'line',x0:-0.83,y0:1.5+(2/3),x1:0.83,y1:1.5+(2/3),line:{color:GRAY_MID,width:0.7,dash:'dash'}},
    {type:'line',x0:-0.83,y0:1.5+(4/3),x1:0.83,y1:1.5+(4/3),line:{color:GRAY_MID,width:0.7,dash:'dash'}},
    {type:'path',path:'M -0.71 0.15 L 0.71 0.15 L 0.71 0 L 0 -0.22 L -0.71 0 Z',fillcolor:GRAY_LITE,line:{color:NAVY,width:1.4}},
  ];

  const lhbLayout = {
    shapes:zoneShapes,
    xaxis:ax({range:[-2.5,2.5],title:{text:'← Glove | Arm →',font:{color:GRAY_DARK,size:10}},fixedrange:true}),
    yaxis:ax({range:[-0.3,5.2],title:{text:'Height (ft)',font:{color:GRAY_DARK,size:10}},fixedrange:true,scaleanchor:'x',scaleratio:1}),
  };

  const moveLayout = {
    xaxis:ax({range:[-24,24],title:{text:'← Glove Side  |  Arm Side →',font:{color:GRAY_DARK,size:10}},zeroline:true,zerolinewidth:1}),
    yaxis:ax({range:[-24,24],title:{text:'Induced Vertical Break (in)',font:{color:GRAY_DARK,size:10}},zeroline:true,zerolinewidth:1,scaleanchor:'x',scaleratio:1}),
    shapes:[
      {type:'circle',x0:-24,y0:-24,x1:24,y1:24,line:{color:GRAY_MID,dash:'dash',width:1}},
      {type:'line',x0:-24,y0:0,x1:24,y1:0,line:{color:GRAY_MID,width:1}},
      {type:'line',x0:0,y0:-24,x1:0,y1:24,line:{color:GRAY_MID,width:1}},
    ],
    annotations:[
      {x:0,y:22,text:'MORE RISE ▲',showarrow:false,font:{color:NAVY_MID,size:9}},
      {x:0,y:-22,text:'▼ MORE DROP',showarrow:false,font:{color:NAVY_MID,size:9}},
    ],
  };

  const relLayout = {
    xaxis:ax({range:[-5,5],title:{text:'Release X (ft)',font:{color:GRAY_DARK,size:10}},zeroline:true,scaleanchor:'y',scaleratio:1}),
    yaxis:ax({range:[4,8],title:{text:'Release Z (ft)',font:{color:GRAY_DARK,size:10}}}),
  };



  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <h1>Pitcher Report</h1>
          {selected && pitchData.length>0 && (
            <div className="header-pitcher">
              <span className="pitcher-name">{selected.name}</span>
              <span className="pitcher-meta">game_pk: {gamePk} · {pitchData.length} pitches</span>
              {selectedBoxscore && (
                <div className="boxscore-row">
                  {[
                    ['IP', selectedBoxscore.inningsPitched],
                    ['H',  selectedBoxscore.hits],
                    ['R',  selectedBoxscore.runs],
                    ['ER', selectedBoxscore.earnedRuns],
                    ['BB', selectedBoxscore.baseOnBalls],
                    ['K',  selectedBoxscore.strikeOuts],
                    ['NP', selectedBoxscore.numberOfPitches],
                    ['S',  selectedBoxscore.strikes],
                  ].map(([label, val]) => (
                    <div key={label as string} className="bs-cell">
                      <span className="bs-label">{label}</span>
                      <span className="bs-val">{val ?? '-'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section className="input-group">
            <label>Baseball Savant URL / game_pk</label>
            <div className="search-box">
              <input type="text" placeholder="URL 또는 game_pk..."
                value={input} onChange={e=>setInput(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&handleFetch()} />
              <button onClick={handleFetch} disabled={loading} className="btn-icon"><Search size={16}/></button>
            </div>
          </section>

          {pitchers.length>0 && (<>
            <section className="input-group">
              <label>Pitcher</label>
              <div className="select-wrapper">
                <select value={selected?.name||''} onChange={e=>{
                  const p=pitchers.find(x=>x.name===e.target.value);
                  setSelected(p||null); setSelPitches([]);
                }}>
                  <option value="" disabled>선택...</option>
                  {pitchers.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
                <ChevronDown size={14} className="select-icon"/>
              </div>
            </section>

            <section className="input-group">
              <label>Opponent Stand</label>
              <div className="stand-btns">
                {(['both','left','right'] as const).map(s=>(
                  <button key={s} className={`stand-btn ${stand===s?'active':''}`} onClick={()=>setStand(s)}>
                    {s==='both'?'Both':s==='left'?'vs L':'vs R'}
                  </button>
                ))}
              </div>
            </section>

            {selected && (
              <section className="input-group">
                <div className="label-row">
                  <label>Pitch Types</label>
                  <button className="text-btn" onClick={()=>
                    setSelPitches(selPitches.length===selected.pitch_types.length?[]:[ ...selected.pitch_types])
                  }>Toggle All</button>
                </div>
                <div className="pitch-list">
                  {selected.pitch_types.map(pitch=>(
                    <label key={pitch} className={`pitch-item ${selPitches.includes(pitch)?'active':''}`}>
                      <input type="checkbox" checked={selPitches.includes(pitch)} onChange={()=>
                        setSelPitches(prev=>prev.includes(pitch)?prev.filter(p=>p!==pitch):[...prev,pitch])
                      }/>
                      <span className="pitch-dot" style={{background:colorMap[pitch]||GRAY_MID}}/>
                      <span>{pitch}</span>
                      <div className="checkbox-ui">{selPitches.includes(pitch)&&<Check size={10}/>}</div>
                    </label>
                  ))}
                </div>
              </section>
            )}

            <div className="sidebar-actions">
              <button className="btn-download" onClick={handleDownload} disabled={!selected||!pitchData.length}>
                <Download size={14}/> Download PNG
              </button>
              <button className={`btn-auto ${autoUpdate?'active':''}`} onClick={()=>setAutoUpdate(!autoUpdate)}>
                {autoUpdate?<Pause size={14}/>:<Play size={14}/>}
                {autoUpdate?`${countdown}s`:'Auto'}
              </button>
            </div>
          </>)}

          {loading && <div className="loading-bar"/>}
          {error   && <div className="error-box">{error}</div>}
        </aside>

        <main className="main-content">
          {pitchData.length>0 ? (
            <div className="report">
              <div className="chart-stack">
                <div className="chart-block">
                  <div className="chart-header">
                    <div className="chart-title">Pitch Breaks</div>
                    <button className="btn-dl" onClick={()=>downloadPlot('plot-move','movement')} title="Download PNG"><Download size={13}/></button>
                  </div>
                  <div className="chart-square">
                    <PlotChart id="plot-move" data={moveTraces} layout={moveLayout}/>
                  </div>
                </div>
                <div className="chart-block">
                  <div className="chart-header">
                    <div className="chart-title">Pitch Location <span className="chart-count">({pitchData.length} pitches)</span></div>
                    <button className="btn-dl" onClick={()=>downloadPlot('plot-zone','location')} title="Download PNG"><Download size={13}/></button>
                  </div>
                  <div className="chart-square">
                    <PlotChart id="plot-zone" data={zoneTraces} layout={lhbLayout}/>
                  </div>
                </div>
                <div className="chart-block">
                  <div className="chart-header">
                    <div className="chart-title">Release Point</div>
                    <button className="btn-dl" onClick={()=>downloadPlot('plot-rel','release')} title="Download PNG"><Download size={13}/></button>
                  </div>
                  <div className="chart-square">
                    <PlotChart id="plot-rel" data={relTraces} layout={relLayout}/>
                  </div>
                </div>

                {stats.length>0 && (
                  <div className="chart-block" id="table-stats">
                    <div className="chart-header">
                      <div className="chart-title">
                        Pitching Statistics
                        <span className="table-sub"> · VAA · Velo · IVB · HB · Spin · Whiff%</span>
                        {stand==='both'&&<span className="table-badge">L+R Combined</span>}
                      </div>
                      <button className="btn-dl" onClick={()=>downloadTable('table-stats','statistics')} title="Download PNG"><Download size={13}/></button>
                    </div>
                    <div className="table-scroll">
                      <table className="stats-table">
                        <thead><tr>{Object.keys(stats[0]).map(k=><th key={k}>{k}</th>)}</tr></thead>
                        <tbody>
                          {stats.map((row,i)=>(
                            <tr key={i}>
                              {Object.entries(row).map(([k,v],j)=>(
                                <td key={k} className={j===0?'pitch-cell':''} style={j===0?{borderLeft:`4px solid ${colorMap[String(v)]||GRAY_MID}`}:{}}>
                                  {String(v)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {bipData.length>0 && (
                  <div className="chart-block" id="table-bip">
                    <div className="chart-header">
                      <div className="chart-title">
                        Batted Ball Events
                        <span className="ev-badge">EV ≥ 95 mph</span>
                      </div>
                      <button className="btn-dl" onClick={()=>downloadTable('table-bip','batted_ball')} title="Download PNG"><Download size={13}/></button>
                    </div>
                    <div className="table-scroll">
                      <table className="stats-table">
                        <thead><tr><th>Pitch</th><th>Batter</th><th>Event</th><th>EV (mph)</th><th>LA (°)</th></tr></thead>
                        <tbody>
                          {bipData.map((d,i)=>(
                            <tr key={i}>
                              <td className="pitch-cell" style={{borderLeft:`4px solid ${colorMap[d.pitch_name]||GRAY_MID}`}}>{d.pitch_name}</td>
                              <td>{d.batter_name}</td>
                              <td>{d.events}</td>
                              <td className={(d.launch_speed??0)>=95?'ev-high':''}>{d.launch_speed}</td>
                              <td>{d.launch_angle}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <RotateCcw size={40} color={GRAY_MID}/>
              <p>게임 데이터를 불러오고 투수를 선택하세요</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
