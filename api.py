from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
import os
import requests
import re
import unicodedata
import pandas as pd
from urllib.parse import urlparse, parse_qs
from sub import PitcherReportGenerator
from all_crawler import get_boxscore_pitching_stats

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 필요한 컬럼만 추출 (메모리 최소화) ──────────────────────────────────────
NEEDED_COLS = [
    'pitcher_name', 'pitch_name', 'stand',
    'plate_x', 'plate_z',
    'breakXInches', 'breakZInducedInches',
    'start_speed', 'spin_rate', 'extension',
    'events', 'batter_name', 'launch_speed', 'launch_angle',
    'description', 'call',
    'vy0', 'ay', 'vz0', 'az',
    'inning', 'ab_number', 'pitch_number', 'game_total_pitches',
    'inning_topbot', 'away_team', 'home_team',
]

class FetchRequest(BaseModel):
    url: str

class PitchDataRequest(BaseModel):
    game_pk: str
    pitcher_name: str
    selected_pitches: Optional[List[str]] = None
    opponent_stand: Optional[str] = 'both'

class ReportRequest(BaseModel):
    game_pk: str
    pitcher_name: str
    selected_pitches: Optional[List[str]] = None
    opponent_stand: Optional[str] = 'both'

def normalize_name(name: str) -> str:
    return "".join(
        c for c in unicodedata.normalize('NFD', name)
        if unicodedata.category(c) != 'Mn'
    ).lower()

def extract_game_pk(value: str) -> Optional[str]:
    """URL 또는 숫자 문자열에서 game_pk 추출"""
    value = value.strip()
    if value.isdigit():
        return value
    parsed = urlparse(value)
    params = {k.lower(): v for k, v in parse_qs(parsed.query).items()}
    if 'gamepk' in params:
        return params['gamepk'][0]
    if 'game_pk' in params:
        return params['game_pk'][0]
    match = re.search(r'#(\d+)', value)
    if match:
        return match.group(1)
    match = re.search(r'/(\d{6,})', value)
    if match:
        return match.group(1)
    return None

def fetch_raw_data(game_pk: str) -> list[dict]:
    """Baseball Savant에서 투구 데이터 가져오기 (dict 리스트 반환)"""
    url = f"https://baseballsavant.mlb.com/gf?game_pk={game_pk}"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get('team_home', []) + data.get('team_away', [])

def filter_cols(record: dict) -> dict:
    """필요한 컬럼만 추출, None 처리"""
    import numpy as np
    def clean_val(v):
        if v is None: return None
        try:
            if isinstance(v, float) and (np.isnan(v) or np.isinf(v)): return None
        except: pass
        return v
    return {k: clean_val(record.get(k)) for k in NEEDED_COLS if k in record}

@app.post("/api/fetch")
async def fetch_game(request: FetchRequest):
    """game_pk로 경기 데이터 수집 → 투수 목록 반환"""
    try:
        game_pk = extract_game_pk(request.url)
        if not game_pk:
            raise HTTPException(status_code=400, detail="유효한 game_pk 또는 URL을 입력하세요.")

        pitches = fetch_raw_data(game_pk)
        if not pitches:
            raise HTTPException(status_code=404, detail="투구 데이터가 없습니다.")

        # 투수별 구종 목록 수집 (pandas 없이 dict로 처리)
        pitcher_pitches: dict[str, set] = {}
        for p in pitches:
            name = p.get('pitcher_name')
            pitch = p.get('pitch_name')
            if name:
                pitcher_pitches.setdefault(name, set())
                if pitch:
                    pitcher_pitches[name].add(pitch)

        pitchers_list = [
            {"name": name, "pitch_types": sorted(pts)}
            for name, pts in sorted(pitcher_pitches.items())
        ]

        return {"game_pk": game_pk, "pitchers": pitchers_list}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/pitch-data")
async def get_pitch_data(request: PitchDataRequest):
    """특정 투수의 투구 데이터를 JSON으로 반환"""
    try:
        pitches = fetch_raw_data(request.game_pk)
        
        result = []
        for p in pitches:
            if p.get('pitcher_name') != request.pitcher_name:
                continue
            if request.selected_pitches and p.get('pitch_name') not in request.selected_pitches:
                continue
            if request.opponent_stand and request.opponent_stand != 'both':
                stand_code = 'L' if request.opponent_stand.lower() == 'left' else 'R'
                if p.get('stand') != stand_code:
                    continue
            result.append(filter_cols(p))

        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate")
async def generate_report(request: ReportRequest):
    """PNG 리포트 생성"""
    try:
        # PNG 생성은 무거운 작업이므로 pandas를 잠깐 사용
        pitches = fetch_raw_data(request.game_pk)
        df = pd.DataFrame(pitches)
        
        # 박스스코어 데이터 가져오기
        box_stats = get_boxscore_pitching_stats(request.game_pk)
        
        report_gen = PitcherReportGenerator(df)
        
        # Match boxscore stats
        match_stats = None
        norm_p = normalize_name(request.pitcher_name)
        for box_name, stats in box_stats.items():
            norm_box = normalize_name(box_name)
            if ',' in request.pitcher_name:
                last, first = [part.strip() for part in request.pitcher_name.split(',')]
                norm_last = normalize_name(last)
                norm_first = normalize_name(first)
                if norm_first in norm_box and norm_last in norm_box:
                    match_stats = stats
                    break
            elif norm_p in norm_box or norm_box in norm_p:
                match_stats = stats
                break
        
        report_gen.create_report(
            request.pitcher_name, 
            boxscore_stats=match_stats, 
            selected_pitches=request.selected_pitches,
            opponent_stand=request.opponent_stand
        )
        
        file_name = (f"Report_"
                     f"{request.pitcher_name.replace(', ', '_').replace(' ', '_')}"
                     f"_Final.png")
        
        return {"image_url": f"/reports/{file_name}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Static files for reports
REPORTS_DIR = "pitcher_reports"
if not os.path.exists(REPORTS_DIR):
    os.makedirs(REPORTS_DIR)
app.mount("/reports", StaticFiles(directory=REPORTS_DIR), name="reports")

# Serve React static files
DIST_DIR = os.path.join("frontend", "dist")
if os.path.exists(DIST_DIR):
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
