import pandas as pd
import numpy as np

df = pd.read_csv('pitchdata.csv')
df['arm angle'] = np.degrees(np.arctan2(df['vz0'], abs(df['vx0'])))

print(df['arm angle'])