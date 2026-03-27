import { useState, useEffect, useRef } from 'react';
import Plot from 'react-plotly.js';
import { Search, RotateCcw, Play, Pause, ChevronDown, Check, Download } from 'lucide-react';
import './App.css';

// Cloudflare Worker URL — 빌드 시 환경변수로 주입, 없으면 로컬 개발용 fallback
const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787';

// ── 필요한 컬럼만 추출 ────────────────────────────────────────────────────
const NEEDED_COLS = new Set([
  'pitcher_name','pitch_name','stand',
  'plate_x','plate_z',
  'breakXInches','breakZInducedInches',
  'start_speed','spin_rate','extension',
  'x0','z0',
  'events','batter_name','launch_speed','launch_angle',
  'description','call',
  'vy0','ay','vz0','az',
  'game_total_pitches',
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

const PITCH_COLORS: Record<string,string> = {
  '4-Seam Fastball':'#E63946','Sinker':'#FF6B6B','Cutter':'#2A9D8F',
  'Slider':'#E9C46A','Sweeper':'#F4D03F','Curveball':'#457B9D',
  'Knuckle Curve':'#5B8DB8','Changeup':'#F4A261','Splitter':'#8338EC',
  'Knuckleball':'#06D6A0',
};
const PALETTE = ['#E63946','#2A9D8F','#E9C46A','#457B9D','#F4A261','#8338EC','#06D6A0','#FFB703','#FB5607'];
const getColor = (name: string, i: number) => PITCH_COLORS[name] ?? PALETTE[i % PALETTE.length];

// ── 유틸 ──────────────────────────────────────────────────────────────────
function extractGamePk(value: string): string | null {
  const s = value.trim();
  if (/^\d+$/.test(s)) return s;
  const qs = new URL(s.startsWith('http') ? s : `https://x.com?${s}`).searchParams;
  if (qs.get('gamePk')) return qs.get('gamePk');
  if (qs.get('game_pk')) return qs.get('game_pk');
  const m = s.match(/#(\d+)/) ?? s.match(/\/(\d{6,})/);
  return m ? m[1] : null;
}

function cleanRecord(raw: Record<string,unknown>): PitchRecord {
  const out: Record<string,unknown> = {};
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

function avg(arr: number[]) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }

function calcStats(data: PitchRecord[], pitchTypes: string[], stand: string) {
  return pitchTypes.flatMap(pt => {
    const stances = stand === 'both' ? ['L','R'] : [stand === 'left' ? 'L' : 'R'];
    return stances.flatMap(s => {
      const sub = data.filter(d => d.pitch_name===pt && d.stand===s);
      if (!sub.length) return [];
      const vaas   = sub.map(calcVaa).filter((v): v is number => v!==null);
      const speeds = sub.map(d=>d.start_speed).filter((v): v is number => v!==null);
      const ivbs   = sub.map(d=>d.breakZInducedInches).filter((v): v is number => v!==null);
      const hbs    = sub.map(d=>d.breakXInches).filter((v): v is number => v!==null);
      const spins  = sub.map(d=>d.spin_rate).filter((v): v is number => v!==null);
      const exts   = sub.map(d=>d.extension).filter((v): v is number => v!==null);
      const whiffs = sub.filter(d=>d.description==='Swinging Strike').length;
      const strikes= sub.filter(d=>d.call && ['S','X'].includes(d.call.toUpperCase())).length;
      return [{
        Pitch:     stand==='both' ? `${pt} (${s})` : pt,
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
      }];
    });
  });
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput]               = useState('');
  const [gamePk, setGamePk]             = useState('');
  const [pitchers, setPitchers]         = useState<Pitcher[]>([]);
  const [selected, setSelected]         = useState<Pitcher|null>(null);
  const [selPitches, setSelPitches]     = useState<string[]>([]);
  const [stand, setStand]               = useState('both');
  const [pitchData, setPitchData]       = useState<PitchRecord[]>([]);
  const [loading, setLoading]           = useState(false);
  const [autoUpdate, setAutoUpdate]     = useState(false);
  const [countdown, setCountdown]       = useState(15);
  const [error, setError]               = useState('');

  const timerRef    = useRef<ReturnType<typeof setInterval>|null>(null);
  const movePlotRef = useRef<any>(null);
  const zonePlotRef = useRef<any>(null);
  const relPlotRef  = useRef<any>(null);

  // ── Baseball Savant 데이터 fetch (Worker 경유) ──────────────────────────
  async function fetchFromSavant(gk: string): Promise<PitchRecord[]> {
    const res = await fetch(`${WORKER_URL}/gf?game_pk=${gk}`);
    if (!res.ok) throw new Error(`Worker error: ${res.status}`);
    const json = await res.json();
    const all: Record<string,unknown>[] = [
      ...(json.team_home ?? []),
      ...(json.team_away ?? []),
    ];
    return all.map(cleanRecord);
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
      setGamePk(gk);
      setPitchers(Object.entries(map).sort(([a],[b])=>a.localeCompare(b))
        .map(([name, pts]) => ({ name, pitch_types: [...pts].sort() })));
      setSelected(null); setPitchData([]);
    } catch(e: any) {
      setError(e.message ?? 'Failed to fetch');
    } finally { setLoading(false); }
  }

  async function loadPitchData(gk: string, pitcher: Pitcher) {
    setLoading(true);
    try {
      const all = await fetchFromSavant(gk);
      let filtered = all.filter(d => d.pitcher_name === pitcher.name);
      if (selPitches.length) filtered = filtered.filter(d => selPitches.includes(d.pitch_name));
      if (stand !== 'both') {
        const code = stand === 'left' ? 'L' : 'R';
        filtered = filtered.filter(d => d.stand === code);
      }
      setPitchData(filtered);
      setError('');
    } catch(e: any) {
      setError(e.message ?? 'Failed to load pitch data');
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (gamePk && selected) loadPitchData(gamePk, selected);
  }, [gamePk, selected, selPitches, stand]);

  useEffect(() => {
    if (autoUpdate && gamePk && selected) {
      timerRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) { loadPitchData(gamePk, selected!); return 15; }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setCountdown(15);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoUpdate, gamePk, selected]);

  // ── PNG 다운로드 (브라우저에서 처리) ──────────────────────────────────
  async function handleDownload() {
    if (!selected || !pitchData.length) return;
    const base = `Report_${selected.name.replace(/,?\s+/g,'_')}`;
    const Plotly = (await import('plotly.js-dist-min')).default as any;
    for (const [ref, suffix] of [
      [movePlotRef, 'movement'],
      [zonePlotRef, 'location'],
      [relPlotRef,  'release'],
    ] as const) {
      if (ref.current?.el) {
        await Plotly.downloadImage(ref.current.el, {
          format: 'png', width: 800, height: 700,
          filename: `${base}_${suffix}`,
        });
      }
    }
  }

  // ── Plotly traces ──────────────────────────────────────────────────────
  const pitchTypes = [...new Set(pitchData.map(d=>d.pitch_name).filter(Boolean))];
  const colorMap   = Object.fromEntries(pitchTypes.map((pt,i) => [pt, getColor(pt,i)]));

  function makeTraces(
    xKey: keyof PitchRecord,
    yKey: keyof PitchRecord,
    hoverFn: (d: PitchRecord) => string,
  ) {
    return pitchTypes.map(pt => {
      const sub = pitchData.filter(d => d.pitch_name === pt);
      return {
        x: sub.map(d => d[xKey]), y: sub.map(d => d[yKey]),
        mode: 'markers', name: pt, type: 'scatter',
        marker: { size: 9, color: colorMap[pt], line: { color:'white', width:0.5 } },
        text: sub.map(hoverFn),
        hovertemplate: '%{text}<extra></extra>',
      };
    });
  }

  const moveTraces = makeTraces('breakXInches','breakZInducedInches',
    d=>`${d.pitch_name}<br>IVB: ${d.breakZInducedInches}"<br>HB: ${d.breakXInches}"<br>${d.start_speed} mph`);
  const zoneTraces = makeTraces('plate_x','plate_z',
    d=>`${d.pitch_name}<br>${d.start_speed} mph · ${d.spin_rate} rpm<br>${d.stand==='L'?'vs LHB':'vs RHB'}`);
  const relTraces  = makeTraces('x0','z0',
    d=>`${d.pitch_name}<br>X: ${(d.x0??0).toFixed(2)} ft<br>Z: ${(d.z0??0).toFixed(2)} ft`);

  const stats   = calcStats(pitchData, pitchTypes, stand);
  const bipData = pitchData.filter(d=>d.events && d.launch_speed!=null).slice(0,15);

  const commonLayout = {
    paper_bgcolor:'rgba(0,0,0,0)', plot_bgcolor:'rgba(0,0,0,0)',
    margin:{l:45,r:20,t:10,b:45},
    showlegend:true, legend:{orientation:'h' as const, y:-0.2, font:{size:11}},
    font:{family:'Inter, sans-serif'},
  };

  // ── JSX ───────────────────────────────────────────────────────────────
  return (
    <div className="container">
      <header><h1>Pitcher Report</h1></header>

      <main>
        <div className="sidebar">
          <section className="input-group">
            <h3>Baseball Savant URL / game_pk</h3>
            <div className="search-box">
              <input
                type="text" placeholder="URL 또는 game_pk..."
                value={input} onChange={e=>setInput(e.target.value)}
                onKeyDown={e=>e.key==='Enter' && handleFetch()}
              />
              <button onClick={handleFetch} disabled={loading}><Search size={18}/></button>
            </div>
          </section>

          {pitchers.length > 0 && (<>
            <section className="input-group">
              <h3>Select Pitcher</h3>
              <div className="select-wrapper">
                <select value={selected?.name||''} onChange={e=>{
                  const p = pitchers.find(x=>x.name===e.target.value);
                  setSelected(p||null); setSelPitches([]);
                }}>
                  <option value="" disabled>Choose...</option>
                  {pitchers.map(p=><option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
                <ChevronDown className="select-icon" size={18}/>
              </div>
            </section>

            <section className="input-group">
              <h3>Opponent Stand</h3>
              <div className="select-wrapper">
                <select value={stand} onChange={e=>setStand(e.target.value)}>
                  <option value="both">Both</option>
                  <option value="left">vs LHB</option>
                  <option value="right">vs RHB</option>
                </select>
                <ChevronDown className="select-icon" size={18}/>
              </div>
            </section>

            {selected && (
              <section className="input-group">
                <div className="flex-header">
                  <h3>Pitch Types</h3>
                  <button className="text-btn" onClick={()=>
                    setSelPitches(selPitches.length===selected.pitch_types.length ? [] : [...selected.pitch_types])
                  }>Toggle All</button>
                </div>
                <div className="pitch-list">
                  {selected.pitch_types.map(pitch=>(
                    <label key={pitch} className={`pitch-item ${selPitches.includes(pitch)?'active':''}`}>
                      <input type="checkbox" checked={selPitches.includes(pitch)} onChange={()=>
                        setSelPitches(prev=>prev.includes(pitch)?prev.filter(p=>p!==pitch):[...prev,pitch])
                      }/>
                      <div className="checkbox-ui">{selPitches.includes(pitch)&&<Check size={12}/>}</div>
                      <span className="pitch-dot" style={{background:colorMap[pitch]||'#8A95A3'}}/>
                      <span>{pitch}</span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            <div className="actions">
              <button className="btn-secondary" onClick={handleDownload}
                disabled={!selected||!pitchData.length}>
                <Download size={18}/> Download Charts (PNG)
              </button>
              <button className={`btn-toggle ${autoUpdate?'active':''}`}
                onClick={()=>setAutoUpdate(!autoUpdate)}>
                {autoUpdate?<Pause size={18}/>:<Play size={18}/>}
                <span>{autoUpdate?`${countdown}s`:'Auto Update'}</span>
              </button>
            </div>
          </>)}

          {loading && <div className="loading-bar"/>}
          {error   && <div className="error-box">{error}</div>}
        </div>

        <div className="content">
          {pitchData.length > 0 ? (
            <div className="dashboard">
              <div className="charts-row">
                <div className="chart-card">
                  <h4>Movement Profile</h4>
                  <Plot ref={movePlotRef} data={moveTraces as any} layout={{
                    ...commonLayout, width:380, height:400,
                    xaxis:{range:[-24,24],title:{text:'HB (in)'},gridcolor:'#eee',zeroline:true,zerolinecolor:'#aaa'},
                    yaxis:{range:[-24,24],title:{text:'IVB (in)'},gridcolor:'#eee',zeroline:true,zerolinecolor:'#aaa'},
                    shapes:[{type:'circle',x0:-24,y0:-24,x1:24,y1:24,line:{color:'#C8D0DC',dash:'dash',width:1}}],
                  }} config={{displayModeBar:false}}/>
                </div>

                <div className="chart-card">
                  <h4>Pitch Location (Catcher View)</h4>
                  <Plot ref={zonePlotRef} data={zoneTraces as any} layout={{
                    ...commonLayout, width:380, height:400,
                    xaxis:{range:[-2.5,2.5],title:{text:'← Glove | Arm →'},fixedrange:true,gridcolor:'#eee'},
                    yaxis:{range:[0,5],title:{text:'Height (ft)'},fixedrange:true,gridcolor:'#eee'},
                    shapes:[
                      {type:'rect',x0:-0.83,y0:1.5,x1:0.83,y1:3.5,line:{color:'#0D1B2A',width:2}},
                      {type:'path',path:'M -0.71 0.15 L 0.71 0.15 L 0.71 0 L 0 -0.22 L -0.71 0 Z',
                       fillcolor:'#C8D0DC',line:{color:'#0D1B2A'}},
                    ],
                  }} config={{displayModeBar:false}}/>
                </div>

                <div className="chart-card">
                  <h4>Release Point</h4>
                  <Plot ref={relPlotRef} data={relTraces as any} layout={{
                    ...commonLayout, width:380, height:400,
                    xaxis:{range:[-5,5],title:{text:'Release X (ft)'},gridcolor:'#eee',zeroline:true,zerolinecolor:'#aaa'},
                    yaxis:{range:[4,8],title:{text:'Release Z (ft)'},gridcolor:'#eee'},
                  }} config={{displayModeBar:false}}/>
                </div>
              </div>

              {stats.length > 0 && (
                <div className="data-table-card">
                  <h4>Pitching Statistics</h4>
                  <div className="table-wrapper">
                    <table>
                      <thead><tr>{Object.keys(stats[0]).map(k=><th key={k}>{k}</th>)}</tr></thead>
                      <tbody>
                        {stats.map((row,i)=>(
                          <tr key={i}>
                            {Object.entries(row).map(([k,v],j)=>(
                              <td key={k} style={j===0?{
                                fontWeight:600,
                                borderLeft:`4px solid ${colorMap[String(v).split(' ')[0]]||'#ccc'}`,
                                paddingLeft:'10px',
                              }:{}}>{String(v)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {bipData.length > 0 && (
                <div className="data-table-card">
                  <h4>Batted Ball Events <span className="ev-note">(EV ≥ 95 mph highlighted)</span></h4>
                  <div className="table-wrapper">
                    <table>
                      <thead><tr><th>Pitch</th><th>Batter</th><th>Event</th><th>EV (mph)</th><th>LA (°)</th></tr></thead>
                      <tbody>
                        {bipData.map((d,i)=>(
                          <tr key={i}>
                            <td style={{borderLeft:`4px solid ${colorMap[d.pitch_name]||'#ccc'}`,paddingLeft:'10px',fontWeight:600}}>
                              {d.pitch_name}
                            </td>
                            <td>{d.batter_name}</td>
                            <td>{d.events}</td>
                            <td style={{color:(d.launch_speed??0)>=95?'#E63946':'inherit',fontWeight:(d.launch_speed??0)>=95?700:400}}>
                              {d.launch_speed}
                            </td>
                            <td>{d.launch_angle}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <RotateCcw size={48}/>
              <p>게임 데이터를 불러오고 투수를 선택하세요</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
