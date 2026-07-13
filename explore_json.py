import requests
import json
import sys

def explore_json(game_pk):
    url = f"https://baseballsavant.mlb.com/gf?game_pk={game_pk}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        data = response.json()
        print("Keys in the JSON response:")
        for key in data.keys():
            if isinstance(data[key], list):
                print(f"- {key}: list with {len(data[key])} items")
            elif isinstance(data[key], dict):
                print(f"- {key}: dict with keys {list(data[key].keys())}")
            else:
                print(f"- {key}: {type(data[key])}")
        
        if 'boxscore' in data and 'teams' in data['boxscore']:
            box_teams = data['boxscore']['teams']
            for side in ['home', 'away']:
                team_data = box_teams[side]
                if 'pitchers' in team_data:
                    print(f"\nPitchers in {side} team: {team_data['pitchers']}")
                    for pid in team_data['pitchers']:
                        p_key = f"ID{pid}"
                        if p_key in team_data['players']:
                            player = team_data['players'][p_key]
                            name = player.get('person', {}).get('fullName')
                            stats = player.get('stats', {}).get('pitching', {})
                            print(f"  - {name} ({pid}): {stats}")
                        else:
                            print(f"  - Player {p_key} not found in players dict")

    else:
        print(f"Failed to fetch data: {response.status_code}")

if __name__ == "__main__":
    game_pk = "831547" # From the user's URL
    explore_json(game_pk)
