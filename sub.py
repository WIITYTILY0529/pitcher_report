import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import matplotlib.patches as mpatches
import seaborn as sns
import os
from matplotlib.gridspec import GridSpec, GridSpecFromSubplotSpec
from matplotlib.lines import Line2D
from matplotlib.patches import Ellipse

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
- Visualization: Radar movement plot + Hexbin L/R location split (from main.py)
"""

# ── Pitch-type color palette ──────────────────────────────────────────────
PITCH_PALETTE = [
    "#E63946", "#2A9D8F", "#E9C46A", "#457B9D",
    "#F4A261", "#8338EC", "#06D6A0", "#FFB703", "#FB5607",
]


class PitcherReportGenerator:
    def __init__(self, df):
        self.df = df.copy()
        self._prepare_data()

    def _prepare_data(self):
        # 1. Nationality Logic (Using team_fielding)
        if 'team_fielding' in self.df.columns:
            self.df['nationality'] = self.df['team_fielding']
        else:
            self.df['nationality'] = 'Unknown'

        # 2. Strike & Whiff judgement
        if 'call' in self.df.columns:
            self.df['is_strike'] = self.df['call'].str.upper().isin(['S', 'X'])
        else:
            self.df['is_strike'] = False

        if 'description' in self.df.columns:
            self.df['is_whiff'] = (self.df['description'] == 'Swinging Strike')
        else:
            self.df['is_whiff'] = False

        # 3. VAA Calculation
        if 'vaa' not in self.df.columns:
            required_cols = ['vy0', 'ay', 'vz0', 'az']
            if all(col in self.df.columns for col in required_cols):
                y0, yf = 50, 17 / 12
                vy_f = -np.sqrt(np.abs(self.df['vy0'] ** 2 - (2 * self.df['ay'] * (y0 - yf))))
                t    = (vy_f - self.df['vy0']) / self.df['ay']
                vz_f = self.df['vz0'] + (self.df['az'] * t)
                self.df['vaa'] = -np.arctan(vz_f / vy_f) * (180 / np.pi)
            else:
                self.df['vaa'] = np.nan

    # ── Radar-style movement plot ─────────────────────────────────────────
    def _plot_movement_radar(self, pdf, ax, pitch_types, color_map):
        """
        Data-driven zoom radar chart.
        Uses breakXInches (HB) and breakZInducedInches (IVB).
        """
        BG_COL = "#deeef7"

        valid = pdf.dropna(subset=['breakXInches', 'breakZInducedInches'])
        if valid.empty:
            ax.set_visible(False)
            return

        # ── Fixed ±24 inch scale (consistent across all pitchers) ───────────
        MAX_R = 24

        ax.set_facecolor(BG_COL)
        ax.set_xlim(-MAX_R, MAX_R)
        ax.set_ylim(-MAX_R, MAX_R)
        ax.set_aspect("equal")

        # Background circle
        bg = plt.Circle((0, 0), MAX_R, color=BG_COL, zorder=0)
        ax.add_patch(bg)

        # Fixed concentric rings at 6, 12, 18, 24 inches
        for r in [6, 12, 18, 24]:
            ring = plt.Circle((0, 0), r, color="#9bbfce",
                               fill=False, lw=1.0, ls="--", zorder=1)
            ax.add_patch(ring)
            ax.text(0, r + 0.6, f'{r}"', ha='center', va='bottom',
                    fontsize=9, color="#4a7a8a", zorder=2)

        # Crosshair at origin
        ax.axhline(0, color="#7aaabb", lw=1.3, zorder=1)
        ax.axvline(0, color="#7aaabb", lw=1.3, zorder=1)

        # Direction labels
        lbl = MAX_R * 0.90
        ax.text(0,    lbl,  "MORE RISE ▲", ha='center', va='top',
                fontsize=10, fontweight='bold', color="#1a4a6e", zorder=3)
        ax.text(0,   -lbl,  "▼ MORE DROP", ha='center', va='bottom',
                fontsize=10, fontweight='bold', color="#1a4a6e", zorder=3)
        ax.text( lbl,  0,   "ARM ▶",  ha='right', va='center',
                fontsize=10, fontweight='bold', color="#1a4a6e", rotation=90, zorder=3)
        ax.text(-lbl,  0,   "◀ GLOVE", ha='left', va='center',
                fontsize=10, fontweight='bold', color="#1a4a6e", rotation=90, zorder=3)

        # Per-pitch: 1-sigma ellipse + scatter
        for pt in pitch_types:
            sub = valid[valid['pitch_name'] == pt]
            if sub.empty:
                continue
            col = color_map[pt]
            x   = sub['breakXInches'].values
            z   = sub['breakZInducedInches'].values

            if len(sub) >= 3:
                ex, ez = x.mean(), z.mean()
                sx, sz = x.std(), z.std()
                min_dim = MAX_R * 0.08
                ell = Ellipse((ex, ez),
                              width=2 * max(sx, min_dim),
                              height=2 * max(sz, min_dim),
                              angle=0, color=col, alpha=0.22, zorder=2)
                ax.add_patch(ell)

            ax.scatter(x, z, s=65, color=col, edgecolors='white',
                       linewidths=0.6, alpha=0.88, label=pt, zorder=4)

        ax.set_xticks([]); ax.set_yticks([])
        for spine in ax.spines.values():
            spine.set_visible(False)

        ax.set_title("Movement Profile  (Induced Break)",
                     fontsize=14, fontweight='bold', color="#1a1a2e", pad=10)
        ax.legend(fontsize=9, framealpha=0.88, title="Pitch type",
                  title_fontsize=9, loc='center left', bbox_to_anchor=(1, 0.5))

    # ── Strike zone drawing ───────────────────────────────────────────────
    @staticmethod
    def _draw_strike_zone_simple(ax, zone_grid=True):
        sz = dict(x0=-0.83, x1=0.83, z0=1.5, z1=3.5)
        xs = [sz['x0'], sz['x1'], sz['x1'], sz['x0'], sz['x0']]
        zs = [sz['z0'], sz['z0'], sz['z1'], sz['z1'], sz['z0']]
        ax.plot(xs, zs, color="#1a1a2e", lw=2.0, zorder=5)
        if zone_grid:
            w3 = (sz['x1'] - sz['x0']) / 3
            h3 = (sz['z1'] - sz['z0']) / 3
            for i in range(1, 3):
                ax.plot([sz['x0'] + w3 * i] * 2, [sz['z0'], sz['z1']],
                        color="#444", lw=0.7, ls="--", zorder=5)
                ax.plot([sz['x0'], sz['x1']], [sz['z0'] + h3 * i] * 2,
                        color="#444", lw=0.7, ls="--", zorder=5)

    # ── Pitch location panel (Hexbin + scatter, L/R split) ────────────────
    def _plot_pitch_location(self, pdf, parent_ax, pitch_types, color_map):
        parent_ax.axis("off")
        parent_ax.set_title("Pitch Location  ·  vs LHB (left)  |  vs RHB (right)",
                            fontsize=14, fontweight="bold", pad=8,
                            loc="center", color="#1a1a2e")

        fig      = parent_ax.get_figure()
        inner_gs = GridSpecFromSubplotSpec(
            1, 2, subplot_spec=parent_ax.get_subplotspec(), wspace=0.28)

        XLIM, YLIM = (-2.5, 2.5), (0.5, 5.0)

        for col_idx, (stance, label) in enumerate([("L", "vs LHB"), ("R", "vs RHB")]):
            ax  = fig.add_subplot(inner_gs[0, col_idx])
            sub = pdf[pdf['stand'] == stance] if 'stand' in pdf.columns else pdf

            # Hexbin density background
            if len(sub) >= 5:
                hb = ax.hexbin(sub['plate_x'], sub['plate_z'],
                               gridsize=14, cmap="YlOrRd", mincnt=1,
                               alpha=0.55,
                               extent=[XLIM[0], XLIM[1], YLIM[0], YLIM[1]],
                               zorder=1)
                cb = fig.colorbar(hb, ax=ax, pad=0.02, shrink=0.75,
                                  label="Pitch count")
                cb.ax.tick_params(labelsize=8)

            # Scatter by pitch type
            for pt in pitch_types:
                pt_sub = sub[sub['pitch_name'] == pt] if 'pitch_name' in sub.columns else sub
                if pt_sub.empty:
                    continue
                ax.scatter(pt_sub['plate_x'], pt_sub['plate_z'],
                           s=30, color=color_map.get(pt, "#888"),
                           edgecolors="white", linewidths=0.4,
                           alpha=0.82, label=pt, zorder=3)

            self._draw_strike_zone_simple(ax, zone_grid=True)
            ax.plot([-0.71, 0.71], [0.5, 0.5], color="#1a1a2e", lw=2.0, zorder=4)

            # Inside / outside shading
            in_color  = "#d0f0ff" if stance == "L" else "#fff0d0"
            out_color = "#fff0d0" if stance == "L" else "#d0f0ff"
            in_x  = (0.0,  0.83) if stance == "L" else (-0.83, 0.0)
            out_x = (-0.83, 0.0) if stance == "L" else (0.0,   0.83)
            for shade_x, shade_c in [(in_x, in_color), (out_x, out_color)]:
                ax.axvspan(shade_x[0], shade_x[1],
                           ymin=(1.5 - 0.5) / 4.5, ymax=(3.5 - 0.5) / 4.5,
                           color=shade_c, alpha=0.18, zorder=0)

            ax.set_title(f"{label}  (n={len(sub)})", fontsize=12, color="#1a1a2e")
            ax.set_xlim(*XLIM); ax.set_ylim(*YLIM)
            ax.set_aspect("equal")
            ax.set_xlabel("Plate X  (ft, catcher view)", fontsize=9)
            ax.set_ylabel("Plate Z  (ft)", fontsize=9)
            ax.tick_params(labelsize=8)

            if col_idx == 1:
                handles = [
                    Line2D([0], [0], marker='o', color='w',
                           markerfacecolor=color_map.get(pt, "#888"),
                           markersize=7, label=pt)
                    for pt in pitch_types
                ]
                ax.legend(handles=handles, fontsize=7, loc='center left', bbox_to_anchor=(1, 0.5),
                          framealpha=0.85, title="Pitch", title_fontsize=7)

    # ── Main report ───────────────────────────────────────────────────────
    def create_report(self, pitcher_name):
        pdf = self.df[self.df['pitcher_name'] == pitcher_name].copy()
        if pdf.empty:
            return

        nat = pdf['nationality'].iloc[0]

        pitch_types = pdf['pitch_name'].dropna().unique().tolist()
        color_map   = {pt: PITCH_PALETTE[i % len(PITCH_PALETTE)]
                       for i, pt in enumerate(pitch_types)}

        # ── Detailed Stats Table Aggregation ─────────────────────────────
        stats_list = []
        for pt in pitch_types:
            for stance in ['L', 'R']:
                sub = pdf[(pdf['pitch_name'] == pt) & (pdf['stand'] == stance)]
                if sub.empty:
                    continue
                row = {
                    'Pitch':    pt,
                    'Side':     stance,
                    'VAA min':  round(sub['vaa'].min(), 1),
                    'VAA max':  round(sub['vaa'].max(), 1),
                    'VAA avg':  round(sub['vaa'].mean(), 1),
                    'Velo':     round(sub['start_speed'].mean(), 1),
                    'IVB':      round(sub['breakZInducedInches'].mean(), 1),
                    'HB':       round(sub['breakXInches'].mean(), 1),
                    'Spin':     round(sub['spin_rate'].mean(), 0),
                    'Ext':      round(sub['extension'].mean(), 1),
                    'Whiff%':   round((sub['is_whiff'].sum() / len(sub)) * 100, 1),
                    'Strike%':  round((sub['is_strike'].sum() / len(sub)) * 100, 1),
                    'Count':    len(sub),
                }
                stats_list.append(row)

        stats = pd.DataFrame(stats_list)

        # ── BIP stats ─────────────────────────────────────────────────────
        bip_df    = pdf.dropna(subset=['events', 'launch_speed', 'launch_angle'])
        bip_stats = bip_df[['pitch_name', 'events', 'launch_speed', 'launch_angle']].head(15).round(1)

        # ── Figure Layout ─────────────────────────────────────────────────
        fig = plt.figure(figsize=(20, 17), facecolor="#f8f9fb")
        fig.suptitle(f"Pitcher Report:  {pitcher_name}  ({nat})",
                     fontsize=24, fontweight='bold', y=0.99, color="#1a1a2e")

        gs = GridSpec(4, 2, height_ratios=[1.5, 0.85, 0.5, 0.5],
                      figure=fig, hspace=0.36, wspace=0.28)

        # 1. Movement radar
        ax1 = fig.add_subplot(gs[0, 0])
        if 'breakXInches' in pdf.columns and 'breakZInducedInches' in pdf.columns:
            self._plot_movement_radar(pdf, ax1, pitch_types, color_map)

        # 2. Pitch location
        ax2 = fig.add_subplot(gs[0, 1])
        self._plot_pitch_location(pdf, ax2, pitch_types, color_map)

        # 3. Stats table
        ax3 = fig.add_subplot(gs[1, :])
        ax3.axis('off')
        if not stats.empty:
            tbl = ax3.table(cellText=stats.values, colLabels=stats.columns,
                            cellLoc='center', loc='center')
            tbl.auto_set_font_size(False)
            tbl.set_fontsize(10)
            tbl.scale(1, 2.2)
            for j in range(len(stats.columns)):
                tbl[(0, j)].set_facecolor("#1a1a2e")
                tbl[(0, j)].set_text_props(color="white", fontweight="bold",
                                            fontsize=10)
            ax3.set_title("Pitching Statistics  (VAA · Velo · IVB · HB · Spin · Whiff%)",
                          fontsize=15, pad=22, color="#1a1a2e", fontweight="bold")

        # 4. BIP table
        ax4 = fig.add_subplot(gs[2:, :])
        ax4.axis('off')
        if not bip_stats.empty:
            tbl2 = ax4.table(cellText=bip_stats.values,
                             colLabels=bip_stats.columns,
                             cellLoc='center', loc='center')
            tbl2.auto_set_font_size(False)
            tbl2.set_fontsize(11)
            tbl2.scale(1, 1.8)
            for j in range(len(bip_stats.columns)):
                tbl2[(0, j)].set_facecolor("#1a1a2e")
                tbl2[(0, j)].set_text_props(color="white", fontweight="bold",
                                             fontsize=11)
            ax4.set_title(f"Batted Ball Events: EV & LA  (n={len(bip_stats)})",
                          fontsize=15, pad=12, color="#1a1a2e", fontweight="bold")
        else:
            ax4.text(0.5, 0.5, "No Batted Ball Data Available",
                     ha='center', fontsize=14, color="#555")

        plt.tight_layout(rect=[0, 0.02, 1, 0.97])
        file_name = f"Report_{pitcher_name.replace(', ', '_').replace(' ', '_')}_Final.png"
        plt.savefig(file_name, dpi=150, facecolor=fig.get_facecolor())
        plt.close()
        print(f"Report generated: {file_name}")


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