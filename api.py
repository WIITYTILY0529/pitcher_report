from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional, Dict
import os
import pandas as pd
import unicodedata
from all_crawler import fetch_game_data
from sub import PitcherReportGenerator

app = FastAPI()

# Enable CORS for React frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class FetchRequest(BaseModel):
    url: str

class ReportRequest(BaseModel):
    game_pk: str
    pitcher_name: str
    selected_pitches: Optional[List[str]] = None

def normalize_name(name):
    return "".join(c for c in unicodedata.normalize('NFD', name)
                  if unicodedata.category(c) != 'Mn').lower()

@app.post("/api/fetch")
async def fetch_game(request: FetchRequest):
    try:
        df, game_pk, box_stats = fetch_game_data(request.url)
        if df is None:
            raise HTTPException(status_code=400, detail="Could not fetch game data")
        
        pitchers_data = []
        pitcher_names = sorted(df['pitcher_name'].dropna().unique())
        
        for p in pitcher_names:
            p_df = df[df['pitcher_name'] == p]
            pitch_types = sorted(p_df['pitch_name'].dropna().unique().tolist())
            pitchers_data.append({
                "name": p,
                "pitch_types": pitch_types
            })
            
        return {
            "game_pk": game_pk,
            "pitchers": pitchers_data
        class ReportRequest(BaseModel):
            game_pk: str
            pitcher_name: str
            selected_pitches: Optional[List[str]] = None
            opponent_stand: Optional[str] = 'both'

        @app.post("/api/generate")
        async def generate_report(request: ReportRequest):
            try:
                csv_file = f"complete_pitchdata_{request.game_pk}.csv"
                if not os.path.exists(csv_file):
                    raise HTTPException(status_code=404, detail="Game data CSV not found. Please fetch first.")

                df = pd.read_csv(csv_file)
                from all_crawler import get_boxscore_pitching_stats
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

# Serve React static files (for production)
DIST_DIR = os.path.join("frontend", "dist")
if os.path.exists(DIST_DIR):
    app.mount("/", StaticFiles(directory=DIST_DIR, html=True), name="frontend")
else:
    @app.get("/")
    async def root():
        return {"message": "API is running. Frontend dist not found. Build the frontend for the web UI."}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
