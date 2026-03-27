import { useState, useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';
import { Search, RotateCcw, Play, Pause, ChevronDown, Check, Download } from 'lucide-react';
import './App.css';

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'http://localhost:8787';

// ── Design tokens (sub.py 기반) ───────────────────────────────────────────
const NAVY      = '#0D1B2A';
const NAVY_MID  = '#1B3A5C';
const CREAM     = '#F5F6FA';
const GRAY_LITE = '#EEF1F7';
const GRAY_MID  = '#C8D0DC';
const GRAY_DARK = '#8A95A3';

const PITCH_PALETTE = [
  '#E63946','#2A9D8F','#E9C46A','#457B9D',
  '#F4A261','#8338EC','#06D6A0','#FFB703','#FB5607',
];

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

// ── Plotly를 직접 DOM에 렌더링 ────────────────────────────────────────────
function PlotChart({ id, data, layout }: { id: string; data: any[]; layout: any }) {
  const divRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!divRef.current) return;
    (Plotly as any).react(divRef.current, data, {
      ...layout,
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: CREAM,
      font: { family: 'Inter, sans-serif', color: NAVY },
      margin: { l: 50, r: 20, t: 30, b: 50 },
      legend: { orientation: 'h', y: -0.22, font: { size: 11 } },
    }, { displayModeBar: false, responsive: true });
  }, [data, layout]);
  return <div id={id} ref={divRef} style={{ width: '100%' }} />;
}

// ── 유틸 ──────────────────────────────────────────────────────────────────
function extractGamePk(value: string): string | null {
  const s = value.trim();
  if (/^\d+$/.test(s)) return s;
  try {
    const url = new URL(s.startsWith('http') ? s : `https://x.com?${s}`);
    const gp = url.searchParams.get('gamePk') ?? url.searchParams.get('game_pk');
    if (gp) return gp;
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
  if (!p.vy0 || !p.ay || !p.vz0 || !p.az) return null;
  const vyf = -Math.sqrt(Math.abs(p.vy0 ** 2 - 2 * p.ay * (50 - 17 / 12)));
  const t = (vyf - p.vy0) / p.ay;
  return -(Math.atan((p.vz0 + p.az * t) / vyf) * (180 / Math.PI));
}

function numAvg(arr: number[]): number | null {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

// both 선택 시 L+R 통합, 아니면 해당 타석만
function calcStats(data: PitchRecord[], pitchTypes: string[], stand: string) {
  return pitchTypes.map(pt => {
    const sub = data.filter(d =>
      d.pitch_name === pt &&
      (stand === 'both' || d.stand === (stand === 'left' ? 'L' : 'R'))
    );
    if (!sub.length) return null;
    const vaas   = sub.map(calcVaa).filter((v): v is number => v !== null);
    const speeds = sub.map(d => d.start_speed).filter((v): v is number => v !== null);
    const ivbs   = sub.map(d => d.breakZInducedInches).filter((v): v is number => v !== null);
    const hbs    = sub.map(d => d.breakXInches).filter((v): v is number => v !== null);
    const spins  = sub.map(d => d.spin_rate).filter((v): v is number => v !== null);
    const exts   = sub.map(d => d.extension).filter((v): v is number => v !== null);
    const whiffs = sub.filter(d => d.description === 'Swinging Strike').length;
    const strikes = sub.filter(d => d.call && ['S', 'X'].includes(d.call.toUpperCase())).length;
    return {
      Pitch:     pt,
      'VAA min': vaas.length ? Math.min(...vaas).toFixed(1) : '-',
      'VAA max': vaas.length ? Math.max(...vaas).toFixed(1) : '-',
      Velo:      numAvg(speeds)?.toFixed(1) ?? '-',
      IVB:       numAvg(ivbs)?.toFixed(1)   ?? '-',
      HB:        numAvg(hbs)?.toFixed(1)    ?? '-',
      Spin:      spins.length ? Math.round(spins.reduce((a, b) => a + b) / spins.length) : '-',
      Ext:       numAvg(exts)?.toFixed(1)   ?? '-',
      'Whiff%':  `${((whiffs / sub.length) * 100).toFixed(1)}%`,
      'Strike%': `${((strikes / sub.length) * 100).toFixed(1)}%`,
      Count:     sub.length,
    };
  }).filter(Boolean) as Record<string, any>[];
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput]           = useState('');
  const [gamePk, setGamePk]         = useState('');
  const [pitchers, setPitchers]     = useState<Pitcher[]>([]);
  const [selected, setSelected]     = useState<Pitcher | null>(null);
  const [selPitches, setSelPitches] = useState<string[]>([]);
  const [stand, setStand]           = useState('both');
  const [pitchData, setPitchData]   = useState<PitchRecord[]>([]);
  const [loading, setLoading]       = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [countdown, setCountdown]   = useState(15);
  const [error, setError]           = useState('');

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchFromSavant(gk: string): Promise<PitchRecord[]> {
    const res = await fetch(`${WORKER_URL}/gf?game_pk=${gk}`);
    if (!res.ok) throw new Error(`Worker error: ${res.status}`);
    const json = await res.json();
    const all: Record<string, unknown>[] = [
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
      const map: Record<string, Set<string>> = {};
      for (const p of all) {
        if (!p.pitcher_name) continue;
        map[p.pitcher_name] ??= new Set();
        if (p.pitch_name) map[p.pitcher_name].add(p.pitch_name);
      }
      setGamePk(gk);
      setPitchers(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, pts]) => ({ name, pitch_types: [...pts].sort() })));
      setSelected(null); setPitchData([]);
    } catch (e: any) {
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
    } catch (e: any) {
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

  async function handleDownload() {
    if (!selected || !pitchData.length) return;
    const base = `Report_${selected.name.replace(/,?\s+/g, '_')}`;
    for (const [id, suffix] of [
      ['plot-move', 'movement'],
      ['plot-zone', 'location'],
      ['plot-rel',  'release'],
    ] as const) {
      const el = document.getElementById(id);
      if (el) await (Plotly as any).downloadImage(el, {
        format: 'png', width: 800, height: 700, filename: `${base}_${suffix}`,
      });
    }
  }

  // ── 색상 맵 ──────────────────────────────────────────────────────────────
  const pitchTypes = [...new Set(pitchData.map(d => d.pitch_name).filter(Boolean))];
  const colorMap = Object.fromEntries(
    pitchTypes.map((pt, i) => [pt, PITCH_PALETTE[i % PITCH_PALETTE.length]])
  );

  // ── Plotly traces ─────────────────────────────────────────────────────────
  function makeTraces(xKey: keyof PitchRecord, yKey: keyof PitchRecord, hoverFn: (d: PitchRecord) => string) {
    return pitchTypes.map(pt => {
      const sub = pitchData.filter(d => d.pitch_name === pt);
      return {
        x: sub.map(d => d[xKey]), y: sub.map(d => d[yKey]),
        mode: 'markers', name: pt, type: 'scatter',
        marker: { size: 8, color: colorMap[pt], line: { color: 'white', width: 0.5 } },
        text: sub.map(hoverFn),
        hovertemplate: '%{text}<extra></extra>',
      };
    });
  }

  const moveTraces = makeTraces('breakXInches', 'breakZInducedInches',
    d => `<b>${d.pitch_name}</b><br>IVB: ${d.breakZInducedInches}"<br>HB: ${d.breakXInches}"<br>${d.start_speed} mph`);
  const zoneTraces = makeTraces('plate_x', 'plate_z',
    d => `<b>${d.pitch_name}</b><br>${d.start_speed} mph · ${d.spin_rate} rpm<br>${d.stand === 'L' ? 'vs LHB' : 'vs RHB'}`);
  const relTraces = makeTraces('x0', 'z0',
    d => `<b>${d.pitch_name}</b><br>X: ${(d.x0 ?? 0).toFixed(2)} ft<br>Z: ${(d.z0 ?? 0).toFixed(2)} ft`);

  const stats   = calcStats(pitchData, pitchTypes, stand);
  const bipData = pitchData.filter(d => d.events && d.launch_speed != null).slice(0, 15);

  // ── 공통 레이아웃 ─────────────────────────────────────────────────────────
  const baseLayout = {
    showlegend: true,
    legend: { orientation: 'h', y: -0.22, font: { size: 11, color: NAVY } },
    xaxis: { gridcolor: GRAY_MID, zerolinecolor: GRAY_MID, linecolor: GRAY_MID, tickfont: { color: GRAY_DARK } },
    yaxis: { gridcolor: GRAY_MID, zerolinecolor: GRAY_MID, linecolor: GRAY_MID, tickfont: { color: GRAY_DARK } },
  };

  const moveLayout = {
    ...baseLayout,
    height: 380,
    xaxis: { ...baseLayout.xaxis, range: [-24, 24], title: { text: 'HB (in)', font: { color: GRAY_DARK } }, zeroline: true },
    yaxis: { ...baseLayout.yaxis, range: [-24, 24], title: { text: 'IVB (in)', font: { color: GRAY_DARK } }, zeroline: true },
    shapes: [
      { type: 'circle', x0: -24, y0: -24, x1: 24, y1: 24, line: { color: GRAY_MID, dash: 'dash', width: 1 } },
      { type: 'line', x0: -24, y0: 0, x1: 24, y1: 0, line: { color: GRAY_MID, width: 1 } },
      { type: 'line', x0: 0, y0: -24, x1: 0, y1: 24, line: { color: GRAY_MID, width: 1 } },
    ],
    annotations: [
      { x: 0, y: 22, text: 'MORE RISE ▲', showarrow: false, font: { color: NAVY_MID, size: 10, family: 'Inter' } },
      { x: 0, y: -22, text: '▼ MORE DROP', showarrow: false, font: { color: NAVY_MID, size: 10, family: 'Inter' } },
      { x: 21, y: 0, text: 'ARM →', showarrow: false, font: { color: NAVY_MID, size: 10, family: 'Inter' }, textangle: -90 },
      { x: -21, y: 0, text: '← GLOVE', showarrow: false, font: { color: NAVY_MID, size: 10, family: 'Inter' }, textangle: -90 },
    ],
  };

  const zoneLayout = {
    ...baseLayout,
    height: 380,
    xaxis: { ...baseLayout.xaxis, range: [-2.5, 2.5], title: { text: '← Glove  |  Arm →', font: { color: GRAY_DARK } }, fixedrange: true },
    yaxis: { ...baseLayout.yaxis, range: [-0.3, 5.2], title: { text: 'Height (ft)', font: { color: GRAY_DARK } }, fixedrange: true },
    shapes: [
      // 스트라이크 존
      { type: 'rect', x0: -0.83, y0: 1.5, x1: 0.83, y1: 3.5, line: { color: NAVY, width: 2 } },
      // 존 내부 격자
      { type: 'line', x0: -0.83 + (1.66/3), y0: 1.5, x1: -0.83 + (1.66/3), y1: 3.5, line: { color: GRAY_MID, width: 0.7, dash: 'dash' } },
      { type: 'line', x0: -0.83 + (1.66*2/3), y0: 1.5, x1: -0.83 + (1.66*2/3), y1: 3.5, line: { color: GRAY_MID, width: 0.7, dash: 'dash' } },
      { type: 'line', x0: -0.83, y0: 1.5 + (2/3), x1: 0.83, y1: 1.5 + (2/3), line: { color: GRAY_MID, width: 0.7, dash: 'dash' } },
      { type: 'line', x0: -0.83, y0: 1.5 + (4/3), x1: 0.83, y1: 1.5 + (4/3), line: { color: GRAY_MID, width: 0.7, dash: 'dash' } },
      // 홈플레이트
      { type: 'path', path: 'M -0.71 0.15 L 0.71 0.15 L 0.71 0 L 0 -0.22 L -0.71 0 Z', fillcolor: GRAY_LITE, line: { color: NAVY, width: 1.4 } },
    ],
  };

  const relLayout = {
    ...baseLayout,
    height: 380,
    xaxis: { ...baseLayout.xaxis, range: [-5, 5], title: { text: 'Release X (ft)', font: { color: GRAY_DARK } }, zeroline: true },
    yaxis: { ...baseLayout.yaxis, range: [4, 8], title: { text: 'Release Z (ft)', font: { color: GRAY_DARK } } },
  };

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* 헤더 */}
      <header className="app-header">
        <div className="header-inner">
          <h1>Pitcher Report</h1>
          {selected && pitchData.length > 0 && (
            <div className="header-pitcher">
              <span className="pitcher-name">{selected.name}</span>
              <span className="pitcher-meta">game_pk: {gamePk} · {pitchData.length} pitches</span>
            </div>
          )}
        </div>
      </header>

      <div className="layout">
        {/* 사이드바 */}
        <aside className="sidebar">
          <section className="input-group">
            <label>Baseball Savant URL / game_pk</label>
            <div className="search-box">
              <input
                type="text" placeholder="URL 또는 game_pk..."
                value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleFetch()}
              />
              <button onClick={handleFetch} disabled={loading} className="btn-icon">
                <Search size={16} />
              </button>
            </div>
          </section>

          {pitchers.length > 0 && (<>
            <section className="input-group">
              <label>Pitcher</label>
              <div className="select-wrapper">
                <select value={selected?.name || ''} onChange={e => {
                  const p = pitchers.find(x => x.name === e.target.value);
                  setSelected(p || null); setSelPitches([]);
                }}>
                  <option value="" disabled>선택...</option>
                  {pitchers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
                <ChevronDown size={14} className="select-icon" />
              </div>
            </section>

            <section className="input-group">
              <label>Opponent Stand</label>
              <div className="stand-btns">
                {(['both', 'left', 'right'] as const).map(s => (
                  <button key={s} className={`stand-btn ${stand === s ? 'active' : ''}`}
                    onClick={() => setStand(s)}>
                    {s === 'both' ? 'Both' : s === 'left' ? 'vs L' : 'vs R'}
                  </button>
                ))}
              </div>
            </section>

            {selected && (
              <section className="input-group">
                <div className="label-row">
                  <label>Pitch Types</label>
                  <button className="text-btn" onClick={() =>
                    setSelPitches(selPitches.length === selected.pitch_types.length ? [] : [...selected.pitch_types])
                  }>Toggle All</button>
                </div>
                <div className="pitch-list">
                  {selected.pitch_types.map(pitch => (
                    <label key={pitch} className={`pitch-item ${selPitches.includes(pitch) ? 'active' : ''}`}>
                      <input type="checkbox" checked={selPitches.includes(pitch)} onChange={() =>
                        setSelPitches(prev => prev.includes(pitch) ? prev.filter(p => p !== pitch) : [...prev, pitch])
                      } />
                      <span className="pitch-dot" style={{ background: colorMap[pitch] || GRAY_MID }} />
                      <span>{pitch}</span>
                      <div className="checkbox-ui">{selPitches.includes(pitch) && <Check size={10} />}</div>
                    </label>
                  ))}
                </div>
              </section>
            )}

            <div className="sidebar-actions">
              <button className="btn-download" onClick={handleDownload}
                disabled={!selected || !pitchData.length}>
                <Download size={14} /> Download PNG
              </button>
              <button className={`btn-auto ${autoUpdate ? 'active' : ''}`}
                onClick={() => setAutoUpdate(!autoUpdate)}>
                {autoUpdate ? <Pause size={14} /> : <Play size={14} />}
                {autoUpdate ? `${countdown}s` : 'Auto'}
              </button>
            </div>
          </>)}

          {loading && <div className="loading-bar" />}
          {error && <div className="error-box">{error}</div>}
        </aside>

        {/* 메인 콘텐츠 */}
        <main className="main-content">
          {pitchData.length > 0 ? (
            <div className="report">

              {/* 차트 3개 */}
              <div className="charts-grid">
                <div className="chart-card">
                  <div className="chart-title">Movement Profile</div>
                  <PlotChart id="plot-move" data={moveTraces} layout={moveLayout} />
                </div>
                <div className="chart-card">
                  <div className="chart-title">Pitch Location</div>
                  <PlotChart id="plot-zone" data={zoneTraces} layout={zoneLayout} />
                </div>
                <div className="chart-card">
                  <div className="chart-title">Release Point</div>
                  <PlotChart id="plot-rel" data={relTraces} layout={relLayout} />
                </div>
              </div>

              {/* 통계 테이블 */}
              {stats.length > 0 && (
                <div className="table-card">
                  <div className="table-title">
                    Pitching Statistics
                    <span className="table-sub"> · VAA · Velo · IVB · HB · Spin · Whiff%</span>
                    {stand === 'both' && <span className="table-badge">L+R Combined</span>}
                  </div>
                  <div className="table-scroll">
                    <table className="stats-table">
                      <thead>
                        <tr>
                          {Object.keys(stats[0]).map(k => <th key={k}>{k}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {stats.map((row, i) => (
                          <tr key={i}>
                            {Object.entries(row).map(([k, v], j) => (
                              <td key={k} className={j === 0 ? 'pitch-cell' : ''} style={j === 0 ? {
                                borderLeft: `4px solid ${colorMap[String(v)] || GRAY_MID}`,
                              } : {}}>
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

              {/* BIP 테이블 */}
              {bipData.length > 0 && (
                <div className="table-card">
                  <div className="table-title">
                    Batted Ball Events
                    <span className="table-sub"> · EV &amp; LA</span>
                    <span className="ev-badge">EV ≥ 95 mph</span>
                  </div>
                  <div className="table-scroll">
                    <table className="stats-table">
                      <thead>
                        <tr><th>Pitch</th><th>Batter</th><th>Event</th><th>EV (mph)</th><th>LA (°)</th></tr>
                      </thead>
                      <tbody>
                        {bipData.map((d, i) => (
                          <tr key={i}>
                            <td className="pitch-cell" style={{ borderLeft: `4px solid ${colorMap[d.pitch_name] || GRAY_MID}` }}>
                              {d.pitch_name}
                            </td>
                            <td>{d.batter_name}</td>
                            <td>{d.events}</td>
                            <td className={(d.launch_speed ?? 0) >= 95 ? 'ev-high' : ''}>
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
              <RotateCcw size={40} color={GRAY_MID} />
              <p>게임 데이터를 불러오고 투수를 선택하세요</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
