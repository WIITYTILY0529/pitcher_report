import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import Plot from 'react-plotly.js';
import { Search, RotateCcw, Play, Pause, ChevronDown, Check, Download } from 'lucide-react';
import './App.css';

const API_BASE_URL = import.meta.env.MODE === 'development'
  ? 'http://localhost:8000'
  : window.location.origin;

interface Pitcher {
  name: string;
  pitch_types: string[];
}

interface PitchRecord {
  pitcher_name: string;
  pitch_name: string;
  plate_x: number | null;
  plate_z: number | null;
  breakXInches: number | null;
  breakZInducedInches: number | null;
  start_speed: number | null;
  spin_rate: number | null;
  extension: number | null;
  release_pos_x: number | null;
  release_pos_z: number | null;
  stand: string;
  events: string | null;
  batter_name: string | null;
  launch_speed: number | null;
  launch_angle: number | null;
  description: string | null;
  call: string | null;
  vy0: number | null;
  ay: number | null;
  vz0: number | null;
  az: number | null;
}

const PITCH_COLORS: Record<string, string> = {
  '4-Seam Fastball': '#E63946',
  'Sinker':          '#FF6B6B',
  'Cutter':          '#2A9D8F',
  'Slider':          '#E9C46A',
  'Sweeper':         '#F4D03F',
  'Curveball':       '#457B9D',
  'Knuckle Curve':   '#5B8DB8',
  'Changeup':        '#F4A261',
  'Splitter':        '#8338EC',
  'Knuckleball':     '#06D6A0',
};

const PALETTE = [
  '#E63946','#2A9D8F','#E9C46A','#457B9D',
  '#F4A261','#8338EC','#06D6A0','#FFB703','#FB5607',
];

function getPitchColor(name: string, index: number): string {
  return PITCH_COLORS[name] ?? PALETTE[index % PALETTE.length];
}

// VAA 계산 (서버에서 안 줄 경우 프론트에서 계산)
function calcVaa(p: PitchRecord): number | null {
  if (!p.vy0 || !p.ay || !p.vz0 || !p.az) return null;
  const y0 = 50, yf = 17 / 12;
  const vyf = -Math.sqrt(Math.abs(p.vy0 ** 2 - 2 * p.ay * (y0 - yf)));
  const t = (vyf - p.vy0) / p.ay;
  const vzf = p.vz0 + p.az * t;
  return -(Math.atan(vzf / vyf) * (180 / Math.PI));
}

function isStrike(p: PitchRecord): boolean {
  if (p.call) return ['S', 'X'].includes(p.call.toUpperCase());
  return false;
}

function isWhiff(p: PitchRecord): boolean {
  return p.description === 'Swinging Strike';
}

// 구종별 통계 계산
function calcStats(data: PitchRecord[], pitchTypes: string[], opponentStand: string) {
  return pitchTypes.flatMap(pt => {
    const stances = opponentStand === 'both' ? ['L', 'R'] : [opponentStand === 'left' ? 'L' : 'R'];
    return stances.flatMap(stance => {
      const sub = data.filter(d => d.pitch_name === pt && d.stand === stance);
      if (!sub.length) return [];
      const vaas = sub.map(calcVaa).filter((v): v is number => v !== null);
      const speeds = sub.map(d => d.start_speed).filter((v): v is number => v !== null);
      const ivbs = sub.map(d => d.breakZInducedInches).filter((v): v is number => v !== null);
      const hbs = sub.map(d => d.breakXInches).filter((v): v is number => v !== null);
      const spins = sub.map(d => d.spin_rate).filter((v): v is number => v !== null);
      const exts = sub.map(d => d.extension).filter((v): v is number => v !== null);
      const whiffs = sub.filter(isWhiff).length;
      const strikes = sub.filter(isStrike).length;
      return [{
        Pitch:     opponentStand === 'both' ? `${pt} (${stance})` : pt,
        'VAA min': vaas.length ? Math.min(...vaas).toFixed(1) : '-',
        'VAA max': vaas.length ? Math.max(...vaas).toFixed(1) : '-',
        Velo:      speeds.length ? (speeds.reduce((a,b)=>a+b,0)/speeds.length).toFixed(1) : '-',
        IVB:       ivbs.length   ? (ivbs.reduce((a,b)=>a+b,0)/ivbs.length).toFixed(1)   : '-',
        HB:        hbs.length    ? (hbs.reduce((a,b)=>a+b,0)/hbs.length).toFixed(1)     : '-',
        Spin:      spins.length  ? Math.round(spins.reduce((a,b)=>a+b,0)/spins.length)  : '-',
        Ext:       exts.length   ? (exts.reduce((a,b)=>a+b,0)/exts.length).toFixed(1)   : '-',
        'Whiff%':  `${((whiffs / sub.length) * 100).toFixed(1)}%`,
        'Strike%': `${((strikes / sub.length) * 100).toFixed(1)}%`,
        Count:     sub.length,
      }];
    });
  });
}

export default function App() {
  const [url, setUrl] = useState('');
  const [gamePk, setGamePk] = useState('');
  const [pitchers, setPitchers] = useState<Pitcher[]>([]);
  const [selectedPitcher, setSelectedPitcher] = useState<Pitcher | null>(null);
  const [selectedPitches, setSelectedPitches] = useState<string[]>([]);
  const [opponentStand, setOpponentStand] = useState('both');
  const [pitchData, setPitchData] = useState<PitchRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [isAutoUpdate, setIsAutoUpdate] = useState(false);
  const [countdown, setCountdown] = useState(15);
  const [error, setError] = useState('');

  const autoUpdateRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Plotly 차트 ref (PNG 다운로드용)
  const movePlotRef = useRef<any>(null);
  const zonePlotRef = useRef<any>(null);
  const releasePlotRef = useRef<any>(null);

  const handleFetchGame = async () => {
    if (!url) return;
    setLoading(true);
    setError('');
    try {
      const res = await axios.post(`${API_BASE_URL}/api/fetch`, { url });
      setGamePk(res.data.game_pk);
      setPitchers(res.data.pitchers);
      setSelectedPitcher(null);
      setPitchData([]);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to fetch game data');
    } finally {
      setLoading(false);
    }
  };

  const fetchPitchData = async () => {
    if (!gamePk || !selectedPitcher) return;
    setLoading(true);
    try {
      const res = await axios.post(`${API_BASE_URL}/api/pitch-data`, {
        game_pk: gamePk,
        pitcher_name: selectedPitcher.name,
        selected_pitches: selectedPitches.length > 0 ? selectedPitches : null,
        opponent_stand: opponentStand,
      });
      setPitchData(res.data);
      setError('');
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to fetch pitch data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (gamePk && selectedPitcher) fetchPitchData();
  }, [gamePk, selectedPitcher, selectedPitches, opponentStand]);

  useEffect(() => {
    if (isAutoUpdate && gamePk && selectedPitcher) {
      autoUpdateRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            handleFetchGame().then(() => fetchPitchData());
            return 15;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (autoUpdateRef.current) clearInterval(autoUpdateRef.current);
      setCountdown(15);
    }
    return () => { if (autoUpdateRef.current) clearInterval(autoUpdateRef.current); };
  }, [isAutoUpdate, gamePk, selectedPitcher]);

  // 브라우저에서 PNG 다운로드 (서버 호출 없음)
  const handleDownload = async () => {
    if (!selectedPitcher) return;
    const fileName = `Report_${selectedPitcher.name.replace(/,?\s+/g, '_')}_Final`;
    const plots = [
      { ref: movePlotRef,     name: `${fileName}_movement` },
      { ref: zonePlotRef,     name: `${fileName}_location` },
      { ref: releasePlotRef,  name: `${fileName}_release` },
    ];
    for (const { ref, name } of plots) {
      if (ref.current?.el) {
        const Plotly = (await import('plotly.js-dist-min')).default;
        await Plotly.downloadImage(ref.current.el, {
          format: 'png', width: 800, height: 700, filename: name,
        });
      }
    }
  };

  const pitchTypes = Array.from(new Set(pitchData.map(d => d.pitch_name).filter(Boolean)));
  const colorMap = Object.fromEntries(pitchTypes.map((pt, i) => [pt, getPitchColor(pt, i)]));

  // ── Plotly traces ──────────────────────────────────────────────────────
  const makeScatterTraces = (
    xKey: keyof PitchRecord,
    yKey: keyof PitchRecord,
    hoverFn: (d: PitchRecord) => string
  ) =>
    pitchTypes.map(pt => {
      const sub = pitchData.filter(d => d.pitch_name === pt);
      return {
        x: sub.map(d => d[xKey]),
        y: sub.map(d => d[yKey]),
        mode: 'markers',
        name: pt,
        type: 'scatter',
        marker: { size: 9, color: colorMap[pt], line: { color: 'white', width: 0.5 } },
        text: sub.map(hoverFn),
        hovertemplate: '%{text}<extra></extra>',
      };
    });

  const moveTraces = makeScatterTraces(
    'breakXInches', 'breakZInducedInches',
    d => `${d.pitch_name}<br>IVB: ${d.breakZInducedInches}"<br>HB: ${d.breakXInches}"<br>Velo: ${d.start_speed} mph`
  );

  const zoneTraces = makeScatterTraces(
    'plate_x', 'plate_z',
    d => `${d.pitch_name}<br>Velo: ${d.start_speed} mph<br>Spin: ${d.spin_rate} rpm<br>${d.stand === 'L' ? 'vs LHB' : 'vs RHB'}`
  );

  const releaseTraces = makeScatterTraces(
    'release_pos_x', 'release_pos_z',
    d => `${d.pitch_name}<br>X: ${d.release_pos_x?.toFixed(2)}<br>Z: ${d.release_pos_z?.toFixed(2)}`
  );

  const stats = calcStats(pitchData, pitchTypes, opponentStand);
  const bipData = pitchData.filter(d => d.events && d.launch_speed != null).slice(0, 15);

  const commonLayout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { l: 45, r: 20, t: 10, b: 45 },
    showlegend: true,
    legend: { orientation: 'h' as const, y: -0.18, font: { size: 11 } },
    font: { family: 'Inter, sans-serif' },
  };

  return (
    <div className="container">
      <header>
        <h1>Pitcher Report Generator</h1>
      </header>

      <main>
        <div className="sidebar">
          <section className="input-group">
            <h3>Baseball Savant URL / game_pk</h3>
            <div className="search-box">
              <input
                type="text"
                placeholder="URL 또는 game_pk..."
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleFetchGame()}
              />
              <button onClick={handleFetchGame} disabled={loading}>
                <Search size={18} />
              </button>
            </div>
          </section>

          {pitchers.length > 0 && (
            <>
              <section className="input-group">
                <h3>Select Pitcher</h3>
                <div className="select-wrapper">
                  <select
                    value={selectedPitcher?.name || ''}
                    onChange={e => {
                      const p = pitchers.find(pit => pit.name === e.target.value);
                      setSelectedPitcher(p || null);
                      setSelectedPitches([]);
                    }}
                  >
                    <option value="" disabled>Choose...</option>
                    {pitchers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                  <ChevronDown className="select-icon" size={18} />
                </div>
              </section>

              <section className="input-group">
                <h3>Opponent Stand</h3>
                <div className="select-wrapper">
                  <select value={opponentStand} onChange={e => setOpponentStand(e.target.value)}>
                    <option value="both">Both</option>
                    <option value="left">vs LHB</option>
                    <option value="right">vs RHB</option>
                  </select>
                  <ChevronDown className="select-icon" size={18} />
                </div>
              </section>

              {selectedPitcher && (
                <section className="input-group">
                  <div className="flex-header">
                    <h3>Pitch Types</h3>
                    <button className="text-btn" onClick={() => {
                      if (selectedPitches.length === selectedPitcher.pitch_types.length)
                        setSelectedPitches([]);
                      else
                        setSelectedPitches([...selectedPitcher.pitch_types]);
                    }}>
                      Toggle All
                    </button>
                  </div>
                  <div className="pitch-list">
                    {selectedPitcher.pitch_types.map(pitch => (
                      <label key={pitch} className={`pitch-item ${selectedPitches.includes(pitch) ? 'active' : ''}`}>
                        <input type="checkbox" checked={selectedPitches.includes(pitch)} onChange={() => {
                          setSelectedPitches(prev =>
                            prev.includes(pitch) ? prev.filter(p => p !== pitch) : [...prev, pitch]
                          );
                        }} />
                        <div className="checkbox-ui">
                          {selectedPitches.includes(pitch) && <Check size={12} />}
                        </div>
                        <span
                          className="pitch-dot"
                          style={{ background: colorMap[pitch] || '#8A95A3' }}
                        />
                        <span>{pitch}</span>
                      </label>
                    ))}
                  </div>
                </section>
              )}

              <div className="actions">
                <button
                  className="btn-secondary"
                  onClick={handleDownload}
                  disabled={!selectedPitcher || pitchData.length === 0}
                  title="각 차트를 PNG로 저장합니다"
                >
                  <Download size={18} /> Download Charts (PNG)
                </button>
                <button
                  className={`btn-toggle ${isAutoUpdate ? 'active' : ''}`}
                  onClick={() => setIsAutoUpdate(!isAutoUpdate)}
                >
                  {isAutoUpdate ? <Pause size={18} /> : <Play size={18} />}
                  <span>{isAutoUpdate ? `${countdown}s` : 'Auto Update'}</span>
                </button>
              </div>
            </>
          )}

          {loading && <div className="loading-bar" />}
          {error && <div className="error-box">{error}</div>}
        </div>

        <div className="content">
          {pitchData.length > 0 ? (
            <div className="dashboard">
              {/* 차트 3개 */}
              <div className="charts-row">
                <div className="chart-card">
                  <h4>Movement Profile</h4>
                  <Plot
                    ref={movePlotRef}
                    data={moveTraces as any}
                    layout={{
                      ...commonLayout,
                      width: 380, height: 400,
                      xaxis: { range: [-24, 24], title: { text: 'HB (in)' }, gridcolor: '#eee', zeroline: true, zerolinecolor: '#aaa' },
                      yaxis: { range: [-24, 24], title: { text: 'IVB (in)' }, gridcolor: '#eee', zeroline: true, zerolinecolor: '#aaa' },
                      shapes: [
                        { type: 'circle', x0: -24, y0: -24, x1: 24, y1: 24, line: { color: '#C8D0DC', dash: 'dash', width: 1 } },
                      ],
                    }}
                    config={{ displayModeBar: false }}
                  />
                </div>

                <div className="chart-card">
                  <h4>Pitch Location (Catcher View)</h4>
                  <Plot
                    ref={zonePlotRef}
                    data={zoneTraces as any}
                    layout={{
                      ...commonLayout,
                      width: 380, height: 400,
                      xaxis: { range: [-2.5, 2.5], title: { text: '← Glove  |  Arm →' }, fixedrange: true, gridcolor: '#eee' },
                      yaxis: { range: [0, 5], title: { text: 'Height (ft)' }, fixedrange: true, gridcolor: '#eee' },
                      shapes: [
                        { type: 'rect', x0: -0.83, y0: 1.5, x1: 0.83, y1: 3.5, line: { color: '#0D1B2A', width: 2 } },
                        { type: 'line', x0: -0.83, y0: 1.5, x1: -0.28, y1: 1.5, line: { color: '#0D1B2A', width: 2 } },
                        { type: 'line', x0:  0.28, y0: 1.5, x1:  0.83, y1: 1.5, line: { color: '#0D1B2A', width: 2 } },
                        { type: 'path', path: 'M -0.71 0.15 L 0.71 0.15 L 0.71 0 L 0 -0.22 L -0.71 0 Z', fillcolor: '#C8D0DC', line: { color: '#0D1B2A' } },
                      ],
                    }}
                    config={{ displayModeBar: false }}
                  />
                </div>

                <div className="chart-card">
                  <h4>Release Point</h4>
                  <Plot
                    ref={releasePlotRef}
                    data={releaseTraces as any}
                    layout={{
                      ...commonLayout,
                      width: 380, height: 400,
                      xaxis: { range: [-4, 4], title: { text: 'Release X (ft)' }, gridcolor: '#eee', zeroline: true, zerolinecolor: '#aaa' },
                      yaxis: { range: [3, 8], title: { text: 'Release Z (ft)' }, gridcolor: '#eee' },
                    }}
                    config={{ displayModeBar: false }}
                  />
                </div>
              </div>

              {/* 통계 테이블 */}
              {stats.length > 0 && (
                <div className="data-table-card">
                  <h4>Pitching Statistics</h4>
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          {Object.keys(stats[0]).map(k => <th key={k}>{k}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {stats.map((row, i) => (
                          <tr key={i}>
                            {Object.entries(row).map(([k, v], j) => (
                              <td key={k} style={j === 0 ? {
                                fontWeight: 600,
                                borderLeft: `4px solid ${colorMap[v?.toString().split(' ')[0] ?? ''] || '#ccc'}`,
                                paddingLeft: '10px',
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
                <div className="data-table-card">
                  <h4>Batted Ball Events <span className="ev-note">(EV ≥ 95 mph highlighted)</span></h4>
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr><th>Pitch</th><th>Batter</th><th>Event</th><th>EV (mph)</th><th>LA (°)</th></tr>
                      </thead>
                      <tbody>
                        {bipData.map((d, i) => (
                          <tr key={i}>
                            <td style={{ borderLeft: `4px solid ${colorMap[d.pitch_name] || '#ccc'}`, paddingLeft: '10px', fontWeight: 600 }}>
                              {d.pitch_name}
                            </td>
                            <td>{d.batter_name}</td>
                            <td>{d.events}</td>
                            <td style={{ color: (d.launch_speed ?? 0) >= 95 ? '#E63946' : 'inherit', fontWeight: (d.launch_speed ?? 0) >= 95 ? 700 : 400 }}>
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
              <RotateCcw size={48} />
              <p>게임 데이터를 불러오고 투수를 선택하세요</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
