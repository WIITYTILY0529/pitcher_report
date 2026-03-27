import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Search, RotateCcw, Play, Pause, ChevronDown, Check } from 'lucide-react';
import './App.css';

const API_BASE_URL = import.meta.env.MODE === 'development' 
  ? 'http://localhost:8000' 
  : window.location.origin;

interface Pitcher {
  name: string;
  pitch_types: string[];
}

function App() {
  const [url, setUrl] = useState('');
  const [gamePk, setGamePk] = useState('');
  const [pitchers, setPitchers] = useState<Pitcher[]>([]);
  const [selectedPitcher, setSelectedPitcher] = useState<Pitcher | null>(null);
  const [selectedPitches, setSelectedPitches] = useState<string[]>([]);
  const [opponentStand, setOpponentStand] = useState('both');
  const [reportUrl, setReportUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [isAutoUpdate, setIsAutoUpdate] = useState(false);
  const [countdown, setCountdown] = useState(15);
  const [error, setError] = useState('');

  const autoUpdateRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Handle URL Fetch
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

  // Handle Report Generation
  const handleGenerateReport = async (pName?: string, pTypes?: string[], stand?: string) => {
    const pitcherToUse = pName || selectedPitcher?.name;
    const pitchesToUse = pTypes || selectedPitches;
    const standToUse = stand || opponentStand;

    if (!gamePk || !pitcherToUse) return;

    setLoading(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/api/generate`, {
        game_pk: gamePk,
        pitcher_name: pitcherToUse,
        selected_pitches: pitchesToUse.length > 0 ? pitchesToUse : null,
        opponent_stand: standToUse
      });
      // Append timestamp to break cache
      setReportUrl(`${API_BASE_URL}${response.data.image_url}?t=${new Date().getTime()}`);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to generate report');
    } finally {
      setLoading(false);
    }
  };

  // Auto Update logic
  useEffect(() => {
    if (isAutoUpdate && gamePk && selectedPitcher) {
      autoUpdateRef.current = setInterval(async () => {
        setCountdown((prev) => {
          if (prev <= 1) {
            // Trigger update
            handleFetchGame().then(() => {
              handleGenerateReport();
            });
            return 15;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (autoUpdateRef.current) clearInterval(autoUpdateRef.current);
      setCountdown(15);
    }

    return () => {
      if (autoUpdateRef.current) clearInterval(autoUpdateRef.current);
    };
  }, [isAutoUpdate, gamePk, selectedPitcher, opponentStand, selectedPitches]);

  // Handle Download
  const handleDownload = async () => {
    if (!reportUrl) return;
    try {
      const response = await fetch(reportUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      // Extract filename from URL
      const fileName = reportUrl.split('/').pop()?.split('?')[0] || 'pitcher_report.png';

      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      link.parentNode?.removeChild(link);
    } catch (err) {
      console.error('Download failed', err);
      setError('Failed to download image');
    }
  };

  const togglePitchSelection = (pitch: string) => {
    setSelectedPitches((prev) => 
      prev.includes(pitch) ? prev.filter(p => p !== pitch) : [...prev, pitch]
    );
  };

  const handleSelectAllPitches = () => {
    if (!selectedPitcher) return;
    if (selectedPitches.length === selectedPitcher.pitch_types.length) {
      setSelectedPitches([]);
    } else {
      setSelectedPitches([...selectedPitcher.pitch_types]);
    }
  };

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
              <input 
                type="text" 
                placeholder="https://baseballsavant.mlb.com/gf?game_pk=..." 
                value={url}
                onChange={(e) => setUrl(e.target.value)}
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
                    onChange={(e) => {
                      const p = pitchers.find(pit => pit.name === e.target.value);
                      setSelectedPitcher(p || null);
                      setSelectedPitches([]); // Reset pitches on pitcher change
                    }}
                  >
                    <option value="" disabled>Choose a pitcher</option>
                    {pitchers.map(p => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="select-icon" size={18} />
                </div>
              </section>

              <section className="input-group">
                <h3>Opponent Stand</h3>
                <div className="select-wrapper">
                  <select 
                    value={opponentStand}
                    onChange={(e) => setOpponentStand(e.target.value)}
                  >
                    <option value="both">Both (LHB & RHB)</option>
                    <option value="left">Left Handed Batters</option>
                    <option value="right">Right Handed Batters</option>
                  </select>
                  <ChevronDown className="select-icon" size={18} />
                </div>
              </section>

              {selectedPitcher && (
                <section className="input-group">
                  <div className="flex-header">
                    <h3>Pitch Types</h3>
                    <button className="text-btn" onClick={handleSelectAllPitches}>
                      {selectedPitches.length === selectedPitcher.pitch_types.length ? 'Deselect All' : 'Select All'}
                    </button>
                  </div>
                  <div className="pitch-list">
                    {selectedPitcher.pitch_types.map(pitch => (
                      <label key={pitch} className={`pitch-item ${selectedPitches.includes(pitch) ? 'active' : ''}`}>
                        <input 
                          type="checkbox" 
                          checked={selectedPitches.includes(pitch)}
                          onChange={() => togglePitchSelection(pitch)}
                        />
                        <div className="checkbox-ui">
                          {selectedPitches.includes(pitch) && <Check size={12} />}
                        </div>
                        <span>{pitch}</span>
                      </label>
                    ))}
                  </div>
                </section>
              )}


              <div className="actions">
                <button 
                  className="btn-primary" 
                  onClick={() => handleGenerateReport()} 
                  disabled={loading || !selectedPitcher}
                >
                  {loading ? 'Generating...' : 'Generate Report'}
                </button>

                {reportUrl && (
                  <button 
                    className="btn-secondary" 
                    onClick={handleDownload}
                  >
                    Download Report (PNG)
                  </button>
                )}
                
                <div className="auto-update">
                  <button 
                    className={`btn-toggle ${isAutoUpdate ? 'active' : ''}`}
                    onClick={() => setIsAutoUpdate(!isAutoUpdate)}
                    disabled={!selectedPitcher}
                  >
                    {isAutoUpdate ? <Pause size={18} /> : <Play size={18} />}
                    <span>{isAutoUpdate ? `Auto Update (${countdown}s)` : 'Auto Update'}</span>
                  </button>
                </div>
              </div>
            </>
          )}

          {error && <div className="error-box">{error}</div>}
        </div>

        <div className="content">
          {reportUrl ? (
            <div className="report-container">
              <img src={reportUrl} alt="Pitcher Report" />
            </div>
          ) : (
            <div className="empty-state">
              <RotateCcw size={48} />
              <p>Fetch game data and generate a report to see results</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
