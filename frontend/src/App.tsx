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
  pitch_name: string;
  plate_x: number;
  plate_z: number;
  breakXInches: number;
  breakZInducedInches: number;
  start_speed: number;
  spin_rate: number;
  stand: string;
  events: string | null;
  launch_speed: number | null;
  launch_angle: number | null;
  description: string;
}

const PITCH_COLORS: Record<string, string> = {
  '4-Seam Fastball': '#E63946',
  'Sinker': '#E63946',
  'Cutter': '#2A9D8F',
  'Slider': '#E9C46A',
  'Sweeper': '#E9C46A',
  'Curveball': '#457B9D',
  'Knuckle Curve': '#457B9D',
  'Changeup': '#F4A261',
  'Splitter': '#8338EC',
};

function App() {
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

  const handleFetchGame = async () => {
    if (!url) return;
    setLoading(true);
    setError('');
    try {
      const response = await axios.post(`${API_BASE_URL}/api/fetch`, { url });
      setGamePk(response.data.game_pk);
      setPitchers(response.data.pitchers);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to fetch game data');
    } finally {
      setLoading(false);
    }
  };

  const fetchDataAndGenerate = async () => {
    if (!gamePk || !selectedPitcher) return;
    setLoading(true);
    try {
      // 1. Fetch raw data for Plotly
      const dataResponse = await axios.post(`${API_BASE_URL}/api/pitch-data`, {
        game_pk: gamePk,
        pitcher_name: selectedPitcher.name,
        selected_pitches: selectedPitches.length > 0 ? selectedPitches : null,
        opponent_stand: opponentStand
      });
      setPitchData(dataResponse.data);
      setError('');
    } catch (err: any) {
      setError('Failed to refresh data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (gamePk && selectedPitcher) {
      fetchDataAndGenerate();
    }
  }, [gamePk, selectedPitcher, selectedPitches, opponentStand]);

  useEffect(() => {
    if (isAutoUpdate && gamePk && selectedPitcher) {
      autoUpdateRef.current = setInterval(async () => {
        setCountdown((prev) => {
          if (prev <= 1) {
            handleFetchGame().then(() => fetchDataAndGenerate());
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

  const handleDownload = async () => {
    if (!selectedPitcher || !gamePk) return;
    setLoading(true);
    try {
      // 1. Trigger PNG generation only when user wants to download
      await axios.post(`${API_BASE_URL}/api/generate`, {
        game_pk: gamePk,
        pitcher_name: selectedPitcher.name,
        selected_pitches: selectedPitches.length > 0 ? selectedPitches : null,
        opponent_stand: opponentStand
      });

      const fileName = `Report_${selectedPitcher.name.replace(/,?\s+/g, '_')}_Final.png`;
      const url = `${API_BASE_URL}/reports/${fileName}?t=${new Date().getTime()}`;
      const res = await fetch(url);
      const blob = await res.blob();
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = fileName;
      link.click();
    } catch (err) { setError('Download failed'); }
    finally { setLoading(false); }
  };

  const getPitchColor = (name: string) => PITCH_COLORS[name] || '#8A95A3';

  // Plotly: Strike Zone
  const zoneTraces: any[] = [];
  const pitchTypes = Array.from(new Set(pitchData.map(d => d.pitch_name)));
  pitchTypes.forEach(pt => {
    const subset = pitchData.filter(d => d.pitch_name === pt);
    zoneTraces.push({
      x: subset.map(d => d.plate_x),
      y: subset.map(d => d.plate_z),
      mode: 'markers',
      name: pt,
      type: 'scatter',
      marker: {
        size: 10,
        color: getPitchColor(pt),
        line: { color: 'white', width: 0.5 }
      },
      text: subset.map(d => `${d.pitch_name}<br>Velo: ${d.start_speed}mph<br>Spin: ${d.spin_rate}rpm`),
      hovertemplate: '%{text}<extra></extra>'
    });
  });

  // Plotly: Movement
  const moveTraces: any[] = [];
  pitchTypes.forEach(pt => {
    const subset = pitchData.filter(d => d.pitch_name === pt);
    moveTraces.push({
      x: subset.map(d => d.breakXInches),
      y: subset.map(d => d.breakZInducedInches),
      mode: 'markers',
      name: pt,
      type: 'scatter',
      marker: {
        size: 10,
        color: getPitchColor(pt),
        line: { color: 'white', width: 0.5 }
      },
      text: subset.map(d => `${d.pitch_name}<br>IVB: ${d.breakZInducedInches}"<br>HB: ${d.breakXInches}"`),
      hovertemplate: '%{text}<extra></extra>'
    });
  });

  return (
    <div className="container">
      <header>
        <h1>Pitcher Report Generator</h1>
      </header>

      <main>
        <div className="sidebar">
          <section className="input-group">
            <h3>Baseball Savant URL</h3>
            <div className="search-box">
              <input type="text" placeholder="URL..." value={url} onChange={(e)=>setUrl(e.target.value)} />
              <button onClick={handleFetchGame} disabled={loading}><Search size={18}/></button>
            </div>
          </section>

          {pitchers.length > 0 && (
            <>
              <section className="input-group">
                <h3>Select Pitcher</h3>
                <div className="select-wrapper">
                  <select value={selectedPitcher?.name || ''} onChange={(e)=>{
                    const p = pitchers.find(pit=>pit.name===e.target.value);
                    setSelectedPitcher(p || null);
                    setSelectedPitches([]);
                  }}>
                    <option value="" disabled>Choose...</option>
                    {pitchers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                  <ChevronDown className="select-icon" size={18} />
                </div>
              </section>

              <section className="input-group">
                <h3>Opponent Stand</h3>
                <div className="select-wrapper">
                  <select value={opponentStand} onChange={(e)=>setOpponentStand(e.target.value)}>
                    <option value="both">Both</option>
                    <option value="left">Left Handed</option>
                    <option value="right">Right Handed</option>
                  </select>
                  <ChevronDown className="select-icon" size={18} />
                </div>
              </section>

              {selectedPitcher && (
                <section className="input-group">
                  <div className="flex-header">
                    <h3>Pitch Types</h3>
                    <button className="text-btn" onClick={() => {
                      if (selectedPitches.length === selectedPitcher.pitch_types.length) setSelectedPitches([]);
                      else setSelectedPitches([...selectedPitcher.pitch_types]);
                    }}>
                      Toggle All
                    </button>
                  </div>
                  <div className="pitch-list">
                    {selectedPitcher.pitch_types.map(pitch => (
                      <label key={pitch} className={`pitch-item ${selectedPitches.includes(pitch)?'active':''}`}>
                        <input type="checkbox" checked={selectedPitches.includes(pitch)} onChange={()=>{
                          setSelectedPitches(prev=>prev.includes(pitch)?prev.filter(p=>p!==pitch):[...prev, pitch]);
                        }}/>
                        <div className="checkbox-ui">{selectedPitches.includes(pitch) && <Check size={12}/>}</div>
                        <span>{pitch}</span>
                      </label>
                    ))}
                  </div>
                </section>
              )}

              <div className="actions">
                <button className="btn-secondary" onClick={handleDownload} disabled={!selectedPitcher}>
                  <Download size={18} /> Download PNG
                </button>
                <button className={`btn-toggle ${isAutoUpdate?'active':''}`} onClick={()=>setIsAutoUpdate(!isAutoUpdate)}>
                  {isAutoUpdate ? <Pause size={18}/> : <Play size={18}/>}
                  <span>{isAutoUpdate ? `${countdown}s` : 'Auto Update'}</span>
                </button>
              </div>
            </>
          )}

          {error && <div className="error-box">{error}</div>}
        </div>

        <div className="content">
          {pitchData.length > 0 ? (
            <div className="dashboard">
              <div className="charts-row">
                <div className="chart-card">
                  <h4>Strike Zone (Catcher View)</h4>
                  <Plot 
                    data={zoneTraces}
                    layout={{
                      width: 450, height: 500,
                      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
                      xaxis: { range: [-2.5, 2.5], title: { text: 'Glove <-> Arm' }, fixedrange: true },
                      yaxis: { range: [0, 5], title: { text: 'Height' }, fixedrange: true },
                      shapes: [
                        { type: 'rect', x0: -0.83, y0: 1.5, x1: 0.83, y1: 3.5, line: { color: '#1a1a2e', width: 2 } },
                        { type: 'path', path: 'M -0.71 0.15 L 0.71 0.15 L 0.71 0 L 0 -0.22 L -0.71 0 Z', fillcolor: '#C8D0DC', line: { color: '#0D1B2A' } }
                      ],
                      showlegend: false, margin: { l: 40, r: 20, t: 30, b: 40 }
                    }}
                    config={{ displayModeBar: false }}
                  />
                </div>
                <div className="chart-card">
                  <h4>Movement Profile</h4>
                  <Plot 
                    data={moveTraces}
                    layout={{
                      width: 450, height: 500,
                      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
                      xaxis: { range: [-24, 24], title: { text: 'HB (in)' }, gridcolor: '#eee' },
                      yaxis: { range: [-24, 24], title: { text: 'IVB (in)' }, gridcolor: '#eee' },
                      shapes: [
                        { type: 'circle', x0: -24, y0: -24, x1: 24, y1: 24, line: { color: '#C8D0DC', dash: 'dash' } },
                        { type: 'line', x0: -24, y0: 0, x1: 24, y1: 0, line: { color: '#C8D0DC' } },
                        { type: 'line', x0: 0, y0: -24, x1: 0, y1: 24, line: { color: '#C8D0DC' } }
                      ],
                      showlegend: true, legend: { orientation: 'h', y: -0.2 },
                      margin: { l: 40, r: 20, t: 30, b: 40 }
                    }}
                    config={{ displayModeBar: false }}
                  />
                </div>
              </div>

              <div className="data-table-card">
                <h4>Recent Batted Balls (EV &gt;= 95 in Red)</h4>
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Pitch</th><th>Event</th><th>EV (mph)</th><th>LA (°)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pitchData.filter(d => d.events).slice(0, 10).map((d, i) => (
                        <tr key={i}>
                          <td>{d.pitch_name}</td>
                          <td>{d.events}</td>
                          <td style={{ color: (d.launch_speed || 0) >= 95 ? '#E63946' : 'inherit', fontWeight: (d.launch_speed || 0) >= 95 ? 'bold' : 'normal' }}>
                            {d.launch_speed}
                          </td>
                          <td>{d.launch_angle}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              <RotateCcw size={48} />
              <p>Fetch game data and select a pitcher to see interactive charts</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
