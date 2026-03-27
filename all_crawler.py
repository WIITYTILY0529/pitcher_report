import requests
import pandas as pd
import re
import os
import statsapi
from urllib.parse import urlparse, parse_qs
from sub import PitcherReportGenerator

def extract_game_pk(url):
    """URL에서 gamePk 값을 추출합니다."""
    # 1. 쿼리 스트링에서 추출 (gamePk=831786 or game_pk=831786)
    parsed_url = urlparse(url)
    params = {k.lower(): v for k, v in parse_qs(parsed_url.query).items()}
    if 'gamepk' in params:
        return params['gamepk'][0]
    if 'game_pk' in params:
        return params['game_pk'][0]
    
    # 2. 해시 태그 뒤에서 추출 (#831786)
    match = re.search(r'#(\d+)', url)
    if match:
        return match.group(1)
    
    # 3. 숫자만 있는 경우 처리
    if url.isdigit():
        return url
        
    return None

def get_boxscore_pitching_stats(game_pk):
    """statsapi를 사용하여 투수들의 박스스코어 스탯을 가져옵니다."""
    try:
        data = statsapi.get('game_boxscore', {'gamePk': game_pk})
        pitching_stats = {}
        for team_name in ['away', 'home']:
            team = data['teams'][team_name]
            for p_id, p_data in team['players'].items():
                if 'pitching' in p_data['stats'] and p_data['stats']['pitching']:
                    name = p_data['person']['fullName']
                    pitching_stats[name] = p_data['stats']['pitching']
                    # 성+이름 순서가 다를 수 있으므로 다양한 키로 저장 고려 (선택사항)
        return pitching_stats
    except Exception as e:
        print(f"박스스코어 수집 중 오류 발생: {e}")
        return {}

def fetch_game_data(url):
    game_pk = extract_game_pk(url)
    if not game_pk:
        print(f"Error: URL에서 gamePk를 찾을 수 없습니다: {url}")
        return None, None, None

    api_url = f"https://baseballsavant.mlb.com/gf?game_pk={game_pk}"
    print(f"\n[Game {game_pk}] 데이터 수집 중: {api_url}")
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    
    response = requests.get(api_url, headers=headers)
    response.raise_for_status()
    data = response.json()
    
    # 홈/어웨이 데이터 통합
    all_pitches = data.get('team_home', []) + data.get('team_away', [])
    
    if not all_pitches:
        print(f"No pitch data found for game {game_pk}.")
        return None, game_pk, None
        
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
    
    # 박스스코어 데이터 가져오기
    box_stats = get_boxscore_pitching_stats(game_pk)
    
    return df, game_pk, box_stats

def fetch_and_save_game_data(url):
    df, game_pk, box_stats = fetch_game_data(url)
    if df is None:
        return

    # 리포트 자동 생성
    print("\n리포트 생성을 시작합니다...")
    report_gen = PitcherReportGenerator(df)
    pitchers = sorted(report_gen.df['pitcher_name'].dropna().unique())
    
    import unicodedata
    def normalize_name(name):
        return "".join(c for c in unicodedata.normalize('NFD', name)
                      if unicodedata.category(c) != 'Mn').lower()

    for p in pitchers:
        match_stats = None
        norm_p = normalize_name(p)
        
        for box_name, stats in box_stats.items():
            norm_box = normalize_name(box_name)
            
            if ',' in p:
                last, first = [part.strip() for part in p.split(',')]
                norm_last = normalize_name(last)
                norm_first = normalize_name(first)
                if norm_first in norm_box and norm_last in norm_box:
                    match_stats = stats
                    break
            elif norm_p in norm_box or norm_box in norm_p:
                match_stats = stats
                break
        
        if match_stats:
            print(f"Generating report for: {p} (Boxscore found!)")
        else:
            print(f"Generating report for: {p} (Boxscore NOT found)")
            
        report_gen.create_report(p, boxscore_stats=match_stats)

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
