import requests
import pandas as pd
import re
from urllib.parse import urlparse, parse_qs

def extract_game_pk(url):
    """URL에서 gamePk 값을 추출합니다."""
    # 1. 쿼리 스트링에서 추출 (gamePk=831786)
    parsed_url = urlparse(url)
    params = parse_qs(parsed_url.query)
    if 'gamePk' in params:
        return params['gamePk'][0]
    
    # 2. 해시 태그 뒤에서 추출 (#831786)
    match = re.search(r'#(\d+)', url)
    if match:
        return match.group(1)
    
    # 3. 숫자만 있는 경우 처리
    if url.isdigit():
        return url
        
    return None

def fetch_and_save_game_data(url):
    game_pk = extract_game_pk(url)
    if not game_pk:
        print(f"Error: URL에서 gamePk를 찾을 수 없습니다: {url}")
        return

    api_url = f"https://baseballsavant.mlb.com/gf?game_pk={game_pk}"
    print(f"\n[Game {game_pk}] 데이터 수집 중: {api_url}")
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    try:
        response = requests.get(api_url, headers=headers)
        response.raise_for_status()
        data = response.json()
        
        # 홈/어웨이 데이터 통합
        all_pitches = data.get('team_home', []) + data.get('team_away', [])
        
        if not all_pitches:
            print(f"No pitch data found for game {game_pk}.")
            return
            
        df = pd.DataFrame(all_pitches)
        
        # 정렬 (전체 투구 순서대로)
        if 'game_total_pitches' in df.columns:
            df = df.sort_values('game_total_pitches', ascending=True)
        elif 'inning' in df.columns and 'ab_number' in df.columns and 'pitch_number' in df.columns:
            df = df.sort_values(['inning', 'ab_number', 'pitch_number'], ascending=[True, True, True])
        
        # 파일 저장
        output_file = f"complete_pitchdata_{game_pk}.csv"
        df.to_csv(output_file, index=False)
        print(f"성공! {len(df)}개의 투구 데이터가 '{output_file}'에 저장되었습니다.")
        
    except Exception as e:
        print(f"데이터 수집 중 오류 발생: {e}")

if __name__ == "__main__":
    # 사용자로부터 URL 입력 받기 (또는 인자로 받을 수 있게 확장 가능)
    import sys
    if len(sys.argv) > 1:
        input_url = sys.argv[1]
    else:
        input_url = input("Baseball Savant URL을 입력하세요: ").strip()
        
    if input_url:
        fetch_and_save_game_data(input_url)
    else:
        print("URL이 입력되지 않았습니다.")
