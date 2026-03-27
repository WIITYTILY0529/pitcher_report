from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
import os
import requests
import re
import unicodedata
from urllib.parse import urlparse, parse_qs

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

NEEDED_COLS = [
    'pitcher_name', 'pitch_name', 'stand',
    'plate_x', 'plate_z',
    'breakXInches', 'breakZInducedInches',
    'start_speed', 'spin_rate', 'extension',
    'release_pos_x', 'release_pos_z',
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


def extract_game_pk(value: str) -> Optional[str]:
    value = value.strip()
    if value.isdigit():
        return value
    parsed = urlparse(value)
    params = {k.lower(): v for k, v in parse_qs(parsed.query).items()}
    if 'gamepk' in params:
        return params['gamepk'][0]
    if 'game_pk' in params:
        return params['game_pk'][0]
    m = re.search(r'#(\d+)', value)
    if m:
        return m.group(1)
    m = re.search(r'/(\d{6,})', value)
    if m:
        return m.group(1)
    return None


def fetch_raw(game_pk: str) -> list[dict]:
    url = f"https://baseballsavant.mlb.com/gf?game_pk={game_pk}"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get('team_home', []) + data.get('team_away', [])


def clean_record(record: dict) -> dict:
    """필요한 컬럼만 추출하고 NaN/Inf 제거"""
    out = {}
    for k in NEEDED_COLS:
        v = record.get(k)
        if isinstance(v, float):
            import math
            if math.isnan(v) or math.isinf(v):
                v = None
        out[k] = v
    return out


@app.post("/api/fetch")
async def fetch_game(request: FetchRequest):
    try:
        game_pk = extract_game_pk(request.url)
        if not game_pk:
            raise HTTPException(status_code=400, detail="유효한 game_pk 또는 URL을 입력하세요.")

        pitches = fetch_raw(game_pk)
        if not pitches:
            raise HTTPException(status_code=404, detail="투구 데이터가 없습니다.")

        pitcher_pitches: dict[str, set] = {}
        for p in pitches:
            name = p.get('pitcher_name')
            pitch = p.get('pitch_name')
            if name:
                pitcher_pitches.setdefault(name, set())
                if pitch:
                    pitcher_pitches[name].add(pitch)

        pitchers = [
            {"name": name, "pitch_types": sorted(pts)}
            for name, pts in sorted(pitcher_pitches.items())
        ]
        return {"game_pk": game_pk, "pitchers": pitchers}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/pitch-data")
async def get_pitch_data(request: PitchDataRequest):
    try:
        pitches = fetch_raw(request.game_pk)

        result = []
        for p in pitches:
            if p.get('pitcher_name') != request.pitcher_name:
                continue
            if request.selected_pitches and p.get('pitch_name') not in request.selected_pitches:
                continue
            if request.opponent_stand and request.opponent_stand != 'both':
                code = 'L' if request.opponent_stand.lower() == 'left' else 'R'
                if p.get('stand') != code:
                    continue
            result.append(clean_record(p))

        if not result:
            raise HTTPException(status_code=404, detail="해당 투수의 데이터가 없습니다.")
        return result

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# React 빌드 서빙
DIST_DIR = os.path.join("frontend", "dist")
if os.path.exists(DIST_DIR):
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
else:
    @app.get("/")
    async def root():
        return {"message": "API running. Build frontend for web UI."}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
