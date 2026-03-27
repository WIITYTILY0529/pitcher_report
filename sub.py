import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import os
from matplotlib.gridspec import GridSpec
from matplotlib.lines import Line2D
from matplotlib.patches import Ellipse, FancyBboxPatch, Polygon
from matplotlib.transforms import Bbox

"""
Refactored Professional Pitcher Report Generator (sub.py)
--------------------------------------------------------------
- Source: complete_pitchdata_788095.csv
- Pitcher Name: pitcher_name
- Strike logic: call column ('S', 'X' -> Strike, 'B' -> Ball)
- Whiff logic: description column ('Swinging Strike')
- Movement: breakZInducedInches (Induced Vertical Break) & breakXInches
- VAA Stats: min, max, mean
- Output: Single PNG per pitcher.
"""

# ── Design tokens ──────────────────────────────────────────────────────────
NAVY      = "#0D1B2A"
NAVY_MID  = "#1B3A5C"
CREAM     = "#F5F6FA"
GRAY_LITE = "#EEF1F7"
GRAY_MID  = "#C8D0DC"
GRAY_DARK = "#8A95A3"
GOLD_ACC  = "#F4B942"

PITCH_PALETTE = [
    "#E63946", "#2A9D8F", "#E9C46A", "#457B9D",
    "#F4A261", "#8338EC", "#06D6A0", "#FFB703", "#FB5607",
]

# ── Dynamic-height constants (inches) ─────────────────────────────────────
_ROW_H   = 0.38
_HDR_H   = 0.50
_PLOTS_H = 8.00
_PAD_H   = 0.50


class PitcherReportGenerator:
    def __init__(self, df):
        self.df = df.copy()
        self._prepare_data()

    # ── Data prep (unchanged) ────────────────────────────────────────────
    def _prepare_data(self):
        if 'team_fielding' in self.df.columns:
            self.df['nationality'] = self.df['team_fielding']
        else:
            self.df['nationality'] = 'Unknown'

        if 'call' in self.df.columns:
            self.df['is_strike'] = self.df['call'].str.upper().isin(['S', 'X'])
        else:
            self.df['is_strike'] = False

        if 'description' in self.df.columns:
            self.df['is_whiff'] = (self.df['description'] == 'Swinging Strike')
        else:
            self.df['is_whiff'] = False

        if 'vaa' not in self.df.columns:
            required_cols = ['vy0', 'ay', 'vz0', 'az']
            if all(col in self.df.columns for col in required_cols):
                y0, yf = 50, 17 / 12
                vy_f = -np.sqrt(np.abs(
                    self.df['vy0']**2 - (2 * self.df['ay'] * (y0 - yf))))
                t    = (vy_f - self.df['vy0']) / self.df['ay']
                vz_f = self.df['vz0'] + (self.df['az'] * t)
                self.df['vaa'] = -np.arctan(vz_f / vy_f) * (180 / np.pi)
            else:
                self.df['vaa'] = np.nan

    # ── Strike zone + home plate ─────────────────────────────────────────
    @staticmethod
    def _draw_zone(ax):
        sz = dict(x0=-0.83, x1=0.83, z0=1.5, z1=3.5)
        xs = [sz['x0'], sz['x1'], sz['x1'], sz['x0'], sz['x0']]
        zs = [sz['z0'], sz['z0'], sz['z1'], sz['z1'], sz['z0']]
        ax.plot(xs, zs, color=NAVY, lw=2.0, zorder=6)
        w3 = (sz['x1'] - sz['x0']) / 3
        h3 = (sz['z1'] - sz['z0']) / 3
        for i in range(1, 3):
            ax.plot([sz['x0'] + w3*i]*2, [sz['z0'], sz['z1']],
                    color=GRAY_MID, lw=0.7, ls='--', zorder=5)
            ax.plot([sz['x0'], sz['x1']], [sz['z0'] + h3*i]*2,
                    color=GRAY_MID, lw=0.7, ls='--', zorder=5)

    @staticmethod
    def _draw_plate(ax):
        plate = Polygon(
            [[-0.71, 0.15], [0.71, 0.15], [0.71, 0.0],
             [0.0, -0.22], [-0.71, 0.0]],
            closed=True, facecolor=GRAY_LITE,
            edgecolor=NAVY, lw=1.4, zorder=6
        )
        ax.add_patch(plate)

    # ── Pitch-location panel (scouting style) ────────────────────────────
    def _plot_location_panel(self, ax, sub, pitch_types, color_map, title):
        XLIM, YLIM = (-2.5, 2.5), (-0.5, 5.2)
        ax.set_facecolor("#FAFBFD")
        ax.set_xlim(*XLIM)
        ax.set_ylim(*YLIM)
        ax.set_aspect('equal')

        # Subtle background grid
        for xg in np.arange(-2.5, 3.0, 0.5):
            ax.axvline(xg, color=GRAY_LITE, lw=0.4, zorder=0)
        for zg in np.arange(0.0, 5.5, 0.5):
            ax.axhline(zg, color=GRAY_LITE, lw=0.4, zorder=0)

        for pt in pitch_types:
            pt_sub = (sub[sub['pitch_name'] == pt]
                      if 'pitch_name' in sub.columns else sub)
            if pt_sub.empty:
                continue
            col = color_map.get(pt, '#888')
            x = pt_sub['plate_x'].dropna().values
            z = pt_sub['plate_z'].dropna().values
            if len(x) < 2:
                continue

            mx, mz = x.mean(), z.mean()
            sx     = max(x.std(), 0.10)
            sz_val = max(z.std(), 0.10)

            ax.add_patch(Ellipse((mx, mz), 2*sx, 2*sz_val,
                                  facecolor=col, edgecolor='none',
                                  alpha=0.16, zorder=2))
            ax.add_patch(Ellipse((mx, mz), 2*sx, 2*sz_val,
                                  facecolor='none', edgecolor=col,
                                  alpha=0.55, zorder=3, lw=1.3, ls='--'))
            ax.scatter(x, z, s=20, color=col,
                       edgecolors='white', linewidths=0.3,
                       alpha=0.60, zorder=4)
            ax.scatter([mx], [mz], s=150, color=col,
                       edgecolors='white', linewidths=2.2,
                       zorder=5, marker='o')

        self._draw_zone(ax)
        self._draw_plate(ax)

        ax.set_title(title, fontsize=11, fontweight='bold',
                     color=NAVY, pad=5)
        ax.set_xlabel("← Glove   Arm →", fontsize=7.5, color=GRAY_DARK)
        ax.set_ylabel("Height (ft)",       fontsize=7.5, color=GRAY_DARK)
        ax.tick_params(labelsize=7, colors=GRAY_DARK)
        for sp in ax.spines.values():
            sp.set_edgecolor(GRAY_MID)

    # ── Movement radar ───────────────────────────────────────────────────
    def _plot_movement_radar(self, pdf, ax, pitch_types, color_map):
        BG_COL = "#EEF4FA"
        valid  = pdf.dropna(subset=['breakXInches', 'breakZInducedInches'])
        if valid.empty:
            ax.set_visible(False)
            return

        MAX_R = 24
        ax.set_facecolor(BG_COL)
        ax.set_xlim(-MAX_R, MAX_R)
        ax.set_ylim(-MAX_R, MAX_R)
        ax.set_aspect("equal")

        ax.add_patch(plt.Circle((0, 0), MAX_R, color=BG_COL, zorder=0))
        ax.add_patch(plt.Circle((0, 0), MAX_R, color=GRAY_MID,
                                  fill=False, lw=1.5, zorder=1))

        for r in [6, 12, 18]:
            ax.add_patch(plt.Circle((0, 0), r, color=GRAY_MID,
                                     fill=False, lw=0.8, ls='--', zorder=1))
            ax.text(0.5, r + 0.8, f'{r}"',
                    ha='left', va='bottom', fontsize=8,
                    color=GRAY_DARK, zorder=2)

        ax.plot([-MAX_R, MAX_R], [-MAX_R, MAX_R],
                color=GRAY_MID, lw=0.9, ls=':', alpha=0.5, zorder=1)
        ax.axhline(0, color=GRAY_MID, lw=1.0, zorder=1)
        ax.axvline(0, color=GRAY_MID, lw=1.0, zorder=1)

        lbl = MAX_R * 0.88
        lkw = dict(fontsize=9, fontweight='bold', color=NAVY_MID, zorder=3)
        ax.text(0,    lbl,  "MORE RISE ▲", ha='center', va='top',    **lkw)
        ax.text(0,   -lbl,  "▼ MORE DROP", ha='center', va='bottom', **lkw)
        ax.text( lbl,  0,   "ARM →",       ha='right',  va='center',
                rotation=90, **lkw)
        ax.text(-lbl,  0,   "← GLOVE",     ha='left',   va='center',
                rotation=90, **lkw)

        for pt in pitch_types:
            sub = valid[valid['pitch_name'] == pt]
            if sub.empty:
                continue
            col = color_map[pt]
            x   = sub['breakXInches'].values
            z   = sub['breakZInducedInches'].values

            if len(sub) >= 3:
                ex, ez = x.mean(), z.mean()
                sx_e   = max(x.std(), MAX_R * 0.035)
                sz_e   = max(z.std(), MAX_R * 0.035)
                ax.add_patch(Ellipse((ex, ez), 2*sx_e, 2*sz_e,
                                     facecolor=col, alpha=0.18, zorder=2))
                ax.add_patch(Ellipse((ex, ez), 2*sx_e, 2*sz_e,
                                     facecolor='none', edgecolor=col,
                                     alpha=0.55, zorder=3, lw=1.2, ls='--'))

            ax.scatter(x, z, s=50, color=col,
                       edgecolors='white', linewidths=0.5,
                       alpha=0.85, zorder=4)
            ax.scatter([x.mean()], [z.mean()], s=170, color=col,
                       edgecolors='white', linewidths=2.2, zorder=5)

        ax.set_xticks([-18, -12, -6, 0, 6, 12, 18])
        ax.set_yticks([-18, -12, -6, 0, 6, 12, 18])
        ax.tick_params(labelsize=7, colors=GRAY_DARK)
        ax.set_xlabel("Horizontal Break (in)",         fontsize=8, color=GRAY_DARK)
        ax.set_ylabel("Induced Vertical Break (in)",   fontsize=8, color=GRAY_DARK)
        for sp in ax.spines.values():
            sp.set_edgecolor(GRAY_MID)
        ax.set_title("Pitch Breaks", fontsize=12,
                     fontweight='bold', color=NAVY, pad=8)

    # ── Table renderer (pure data-coord, no transform mixing) ────────────
    @staticmethod
    def _render_table(ax, df, title, pitch_types=None, color_map=None,
                      fontsize=9.5):
        """
        Draw a styled table entirely in data coordinates (xlim=0..n_cols,
        ylim=0..n_rows+1).  No transAxes transform — fully stable.
        """
        ax.axis('off')
        if df.empty:
            ax.text(0.5, 0.5, "No data available",
                    ha='center', va='center',
                    fontsize=12, color=GRAY_DARK,
                    transform=ax.transAxes)
            return

        n_rows, n_cols = df.shape
        # coordinate space: x in [0, n_cols], y in [0, n_rows+1]
        ax.set_xlim(0, n_cols)
        ax.set_ylim(0, n_rows + 1)

        # ── Header row (y = n_rows .. n_rows+1) ──────────────────────
        ax.add_patch(plt.Rectangle(
            (0, n_rows), n_cols, 1,
            facecolor=NAVY, edgecolor='none', zorder=0))

        for j, col_name in enumerate(df.columns):
            ax.text(j + 0.5, n_rows + 0.5, str(col_name),
                    ha='center', va='center',
                    fontsize=fontsize - 0.5, fontweight='bold', color='White',
                    zorder=1)

        # ── Data rows ────────────────────────────────────────────────
        for i, (_, row) in enumerate(df.iterrows()):
            y = n_rows - 1 - i          # row 0 is at the bottom
            stripe = GRAY_LITE if i % 2 == 0 else 'white'

            # Full-row stripe
            ax.add_patch(plt.Rectangle(
                (0, y), n_cols, 1,
                facecolor=stripe, edgecolor='none', alpha=0.7, zorder=0))

            # Pitch-type accent on first cell
            pt_val = str(row.iloc[0])
            if pitch_types and color_map and pt_val in color_map:
                ax.add_patch(plt.Rectangle(
                    (0, y), 1, 1,
                    facecolor=color_map[pt_val],
                    edgecolor='none', alpha=0.25, zorder=1))

            # Row divider line
            ax.plot([0, n_cols], [y, y],
                    color=GRAY_MID, lw=0.5, zorder=2)

            # Cell text
            for j, val in enumerate(row):
                fw   = 'bold' if j == 0 else 'normal'
                tcol = NAVY   if j == 0 else '#2C3E50'
                ax.text(j + 0.5, y + 0.5, str(val),
                        ha='center', va='center',
                        fontsize=fontsize, fontweight=fw, color=tcol,
                        zorder=3)

        # Outer border
        ax.add_patch(plt.Rectangle(
            (0, 0), n_cols, n_rows + 1,
            facecolor='none', edgecolor=GRAY_MID, lw=1.0, zorder=4))

        # Column separators
        for j in range(1, n_cols):
            ax.plot([j, j], [0, n_rows + 1],
                    color=GRAY_MID, lw=0.4, zorder=3)

        ax.set_title(title, fontsize=12, fontweight='bold',
                     color=NAVY, pad=8, loc='left')

    # ── Main report ───────────────────────────────────────────────────────
    def create_report(self, pitcher_name, boxscore_stats=None, selected_pitches=None, opponent_stand='both'):
        pdf = self.df[self.df['pitcher_name'] == pitcher_name].copy()
        if pdf.empty:
            print(f"No pitch data found for {pitcher_name}")
            return

        if selected_pitches:
            pdf = pdf[pdf['pitch_name'].isin(selected_pitches)]
            if pdf.empty:
                print(f"No pitch data found for {pitcher_name} with selected pitches {selected_pitches}")
                return

        if opponent_stand and opponent_stand != 'both':
            stand_code = 'L' if opponent_stand.lower() == 'left' else 'R'
            pdf = pdf[pdf['stand'] == stand_code]
            if pdf.empty:
                print(f"No data for {pitcher_name} vs {opponent_stand}")
                return

        nat = pdf['nationality'].iloc[0]
        pitch_types = pdf['pitch_name'].dropna().unique().tolist()
        color_map   = {pt: PITCH_PALETTE[i % len(PITCH_PALETTE)]
                       for i, pt in enumerate(pitch_types)}

        # ── Stats aggregation ─────────────────────────────────────────────
        stats_list = []
        for pt in pitch_types:
            stances = ['L', 'R'] if opponent_stand == 'both' else [pdf['stand'].iloc[0]]
            for stance in stances:
                sub = pdf[(pdf['pitch_name'] == pt) & (pdf['stand'] == stance)]
                if sub.empty: continue
                vaa_clean = sub['vaa'].dropna()
                pitch_label = f"{pt} ({stance})" if opponent_stand == 'both' else pt
                row = {
                    'Pitch':   pitch_label,
                    'VAA min': round(vaa_clean.min(), 1) if not vaa_clean.empty else 0,
                    'VAA max': round(vaa_clean.max(), 1) if not vaa_clean.empty else 0,
                    'Velo':    round(sub['start_speed'].mean(), 1),
                    'IVB':     round(sub['breakZInducedInches'].mean(), 1),
                    'HB':      round(sub['breakXInches'].mean(), 1),
                    'Spin':    round(sub['spin_rate'].mean(), 0),
                    'Ext':     round(sub['extension'].mean(), 1),
                    'Whiff%':  round((sub['is_whiff'].sum() / len(sub)) * 100, 1),
                    'Strike%': round((sub['is_strike'].sum() / len(sub)) * 100, 1),
                    'Count':   len(sub),
                }
                stats_list.append(row)
        stats = pd.DataFrame(stats_list)

        bip_df    = pdf.dropna(subset=['events', 'batter_name', 'launch_speed', 'launch_angle'])
        bip_stats = (bip_df[['pitch_name', 'batter_name', 'events', 'launch_speed', 'launch_angle']]
                     .head(15).round(1).reset_index(drop=True))
        bip_stats = bip_stats.rename(columns={'launch_speed': 'EV', 'launch_angle': 'LA'})

        # ── Dynamic figure height ──────────────────────────────────────
        n_stat  = len(stats)
        n_bip   = len(bip_stats) if not bip_stats.empty else 0
        has_box = boxscore_stats is not None

        title_h = 1.6 if has_box else 1.1
        stat_h  = _HDR_H + n_stat * _ROW_H + _PAD_H
        bip_h   = (_HDR_H + n_bip * _ROW_H + _PAD_H) if n_bip > 0 else 1.0
        total_h = title_h + _PLOTS_H + stat_h + bip_h
        fig_h   = float(np.clip(total_h, 16, 34))

        hr = [_PLOTS_H / total_h,
              stat_h  / total_h,
              bip_h   / total_h]

        # ── Figure ────────────────────────────────────────────────────
        fig = plt.figure(figsize=(22, fig_h), facecolor=CREAM)

        # Dark header band via axes spanning the full width at the top
        ax_hdr = fig.add_axes([0, 1 - title_h/fig_h, 1, title_h/fig_h])
        ax_hdr.set_facecolor(NAVY)
        ax_hdr.axis('off')

        # Title text
        title_y_center = 1 - (title_h * 0.28) / fig_h
        fig.text(0.5, title_y_center, pitcher_name,
                 fontsize=27, fontweight='bold', ha='center', va='center',
                 color='black')
        fig.text(0.5, 1 - (title_h * 0.60) / fig_h,
                 f"Pitcher Report  ·  {nat}",
                 fontsize=13, ha='center', va='center', color='black')

        if has_box:
            # Build a small horizontal table for boxscore
            box_cols = ['IP', 'H', 'R', 'ER', 'BB', 'K', 'NP', 'S']
            box_vals = [
                str(boxscore_stats.get('inningsPitched', '0.0')),
                str(boxscore_stats.get('hits', 0)),
                str(boxscore_stats.get('runs', 0)),
                str(boxscore_stats.get('earnedRuns', 0)),
                str(boxscore_stats.get('baseOnBalls', 0)),
                str(boxscore_stats.get('strikeOuts', 0)),
                str(boxscore_stats.get('numberOfPitches', 0)),
                str(boxscore_stats.get('strikes', 0))
            ]
            note = boxscore_stats.get('note', '')
            
            # Draw boxscore table in the header
            box_y = 1 - (title_h * 0.78) / fig_h
            box_w = 0.45
            ax_box = fig.add_axes([0.5 - box_w/2, box_y - 0.25/fig_h, box_w, 0.45/fig_h])
            ax_box.axis('off')
            
            # Draw cells
            cell_w = 1.0 / len(box_cols)
            for j, (col, val) in enumerate(zip(box_cols, box_vals)):
                # Header
                ax_box.text(j*cell_w + cell_w/2, 0.7, col, ha='center', va='center', 
                            fontsize=9, color='black', fontweight='bold')
                # Value
                ax_box.text(j*cell_w + cell_w/2, 0.2, val, ha='center', va='center', 
                            fontsize=12, color=GOLD_ACC, fontweight='bold')
            
            if note:
                fig.text(0.5, 1 - (title_h * 0.94) / fig_h, note,
                         fontsize=10, ha='center', va='center', color=GOLD_ACC, alpha=0.9)

        # ── GridSpec for the three content rows ───────────────────────
        gs = GridSpec(
            3, 3,
            height_ratios=hr,
            figure=fig,
            top=1 - title_h/fig_h - 0.012,
            bottom=0.025,
            left=0.035, right=0.975,
            hspace=0.14,
            wspace=0.20,
        )

        # Row 0: LHB location | Movement | RHB location
        ax_lhb = fig.add_subplot(gs[0, 0])
        ax_mov = fig.add_subplot(gs[0, 1])
        ax_rhb = fig.add_subplot(gs[0, 2])

        sub_l = pdf[pdf['stand'] == 'L'] if 'stand' in pdf.columns else pdf
        sub_r = pdf[pdf['stand'] == 'R'] if 'stand' in pdf.columns else pdf

        self._plot_location_panel(ax_lhb, sub_l, pitch_types, color_map,
                                   f"vs LHB  (n={len(sub_l)})")
        self._plot_movement_radar(pdf, ax_mov, pitch_types, color_map)
        self._plot_location_panel(ax_rhb, sub_r, pitch_types, color_map,
                                   f"vs RHB  (n={len(sub_r)})")

        # Shared legend below movement plot
        legend_handles = [
            Line2D([0], [0], marker='o', color='w',
                   markerfacecolor=color_map[pt], markersize=11,
                   label=pt, markeredgecolor='white', markeredgewidth=1.5)
            for pt in pitch_types
        ]
        ax_mov.legend(
            handles=legend_handles, fontsize=9,
            framealpha=0.92, edgecolor=GRAY_MID,
            loc='lower center', bbox_to_anchor=(0.5, -0.22),
            ncol=min(len(pitch_types), 4),
        )

        # Row 1: Pitching stats table
        ax_stat = fig.add_subplot(gs[1, :])
        self._render_table(
            ax_stat, stats,
            "Pitching Statistics  ·  VAA · Velo · IVB · HB · Spin · Whiff%",
            pitch_types=pitch_types, color_map=color_map,
            fontsize=9.5,
        )

        # Row 2: BIP table
        ax_bip = fig.add_subplot(gs[2, :])
        if not bip_stats.empty:
            self._render_table(
                ax_bip, bip_stats,
                f"Batted Ball Events  ·  EV & LA  (n={len(bip_stats)})",
                fontsize=10,
            )
        else:
            ax_bip.axis('off')
            ax_bip.text(0.5, 0.5, "No Batted Ball Data Available",
                        ha='center', va='center',
                        fontsize=13, color=GRAY_DARK,
                        transform=ax_bip.transAxes)

        # ── Save ──────────────────────────────────────────────────────
        output_dir = "pitcher_reports"
        os.makedirs(output_dir, exist_ok=True)
        file_name = (f"Report_"
                     f"{pitcher_name.replace(', ', '_').replace(' ', '_')}"
                     f"_Final.png")
        file_path = os.path.join(output_dir, file_name)
        plt.savefig(file_path, dpi=150, facecolor=CREAM, bbox_inches='tight')
        plt.close('all') # 모든 피겨를 닫아 메모리 즉시 해제
        import gc
        gc.collect() # 가비지 컬렉션 강제 실행
        print(f"Report generated: {file_path}")


def main():
    csv_file = 'complete_pitchdata_831820.csv'
    if not os.path.exists(csv_file):
        print(f"Error: {csv_file} not found.")
        return

    df = pd.read_csv(csv_file)
    report_gen = PitcherReportGenerator(df)

    pitchers = sorted(report_gen.df['pitcher_name'].dropna().unique())
    for p in pitchers:
        print(f"Generating report for: {p}")
        report_gen.create_report(p)


if __name__ == "__main__":
    main()