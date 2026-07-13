import requests
import pandas as pd
import json

def fetch_comprehensive_pitches(game_pk):
    url = f"https://baseballsavant.mlb.com/gf?game_pk={game_pk}"
    print(f"Fetching comprehensive game data from: {url}")
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    response = requests.get(url, headers=headers)
    if response.status_code != 200:
        print(f"Failed. Status code: {response.status_code}")
        return None
    
    data = response.json()
    
    # Combine home and away team pitches
    home_pitches = data.get('team_home', [])
    away_pitches = data.get('team_away', [])
    all_pitches = home_pitches + away_pitches
    
    if not all_pitches:
        return None
        
    df = pd.DataFrame(all_pitches)
    
    # In this dataset, 'game_total_pitches' or a combination of 'inning', 'ab_number', 'pitch_number' can be used for sorting
    # 'game_total_pitches' seems like the most direct global order
    if 'game_total_pitches' in df.columns:
        df = df.sort_values('game_total_pitches', ascending=True)
    elif 'inning' in df.columns and 'ab_number' in df.columns and 'pitch_number' in df.columns:
        df = df.sort_values(['inning', 'ab_number', 'pitch_number'], ascending=[True, True, True])
        
    return df

def main():
    game_pk = "788095"
    df = fetch_comprehensive_pitches(game_pk)
    
    if df is not None and not df.empty:
        # Mapping for the display table based on the user's request and identified JSON keys
        mapping = {
            'game_total_pitches': 'Index',
            'pitcher_name': 'Pitcher',
            'batter_name': 'Batter',
            'inning': 'Inning',
            'outs': 'Outs',
            'balls': 'Balls',
            'strikes': 'Strikes',
            'call_name': 'Call',
            'pitch_name': 'Pitch Type',
            'start_speed': 'Velocity',
            'spin_rate': 'Spin Rate',
            'breakZWithGravityInches': 'V-Break',
            'breakXInches': 'H-Break'
        }
        
        display_cols = [c for c in mapping.keys() if c in df.columns]
        df_display = df[display_cols].rename(columns=mapping)
        
        print(f"\n--- Complete Pitch-by-Pitch Data for Game {game_pk} (First 20 pitches) ---")
        # Set index to start from 1 to match user's tr-1, tr-2... expectation
        df_display.index = range(1, len(df_display) + 1)
        print(df_display.head(20).to_markdown())
        
        output_file = f"complete_pitchdata_{game_pk}.csv"
        df.to_csv(output_file, index=False)
        print(f"\nFull data ({len(df)} total pitches) saved to: {output_file}")
    else:
        print("No pitch data found.")

if __name__ == "__main__":
    main()
