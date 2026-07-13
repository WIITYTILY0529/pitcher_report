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
Professional Pitcher Report Generator
--------------------------------------------------------------
- Nationality: Bot -> Away, Top -> Home.
- Movement: Radar-style polar chart (Baseball Savant style).
- Pitch Location: Hexbin + scatter, L/R split.
- Tables: abbreviated column names.
"""

# ── Pitch-type color palette (consistent across all plots) ──────────────────
PITCH_PALETTE = [
    "#E63946", "#2A9D8F", "#E9C46A", "#457B9D",
    "#F4A261", "#8338EC", "#06D6A0", "#FFB703", "#FB5607",
]

# ── Abbreviated column rename map (applied after groupby flatten) ────────────
COL_RENAME = {
    "pitch_name_":                       "pitch",
    "stand_":                            "stand",
    "vaa_min":                           "vaa_min",
    "vaa_max":                           "vaa_max",
    "release_speed_min":                 "min_velo",
    "release_speed_max":                 "max_velo",
    "release_speed_mean":                "avg_velo",
    "api_break_x_arm_mean":              "h-move",
    "api_break_z_with_gravity_mean":     "z-move",
    "release_spin_rate_mean":            "spin",
    "release_extension_mean":            "ext",
    "is_whiff_sum":                      "whiff",
    "is_strike_sum":                     "strike",
    "type_count":                        "count",
}


class PitcherReportGenerator:
    def __init__(self, df):
        self.df = df.copy()
        self._prepare_data()

    def _prepare_data(self):
        def get_nat(row):
            if str(row['inning_topbot']).lower() == 'bot':
                return row['away_team']
            else:
                return row['home_team']
        self.df['nationality'] = self.df.apply(get_nat, axis=1)

        if 'vaa' not in self.df.columns:
            required_cols = ['vy0', 'ay', 'vz0', 'az']
            if all(col in self.df.columns for col in required_cols):
                y0, yf = 50, 17 / 12
                vy_f = -np.sqrt(self.df['vy0'] ** 2 - (2 * self.df['ay'] * (y0 - yf)))
                t    = (vy_f - self.df['vy0']) / self.df['ay']
                vz_f = self.df['vz0'] + (self.df['az'] * t)
                self.df['vaa'] = -np.arctan(vz_f / vy_f) * (180 / np.pi)
            else:
                self.df['vaa'] = np.nan

        if 'description' in self.df.columns:
            self.df['is_strike'] = self.df['description'].str.contains(
                'strike|foul|miss|hit_into_play', case=False, na=False)
            self.df['is_whiff'] = self.df['description'].str.contains(
                'swinging_strike', case=False, na=False)
        else:
            self.df['is_strike'] = False
            self.df['is_whiff'] = False

    # ── Radar-style movement plot (Baseball Savant style) ────────────────────
    def _plot_movement_radar(self, pdf, ax, pitch_types, color_map):
        """
        Polar-flavoured cartesian scatter with data-driven zoom.
        Axis limits derived from actual data range so pitch clusters are prominent.
        """
        BG_COL = "#deeef7"

        # ── Data-driven view limits ──────────────────────────────────────────
        valid = pdf.dropna(subset=['api_break_x_arm', 'api_break_z_with_gravity'])
        if valid.empty:
            ax.set_visible(False)
            return

        all_x = valid['api_break_x_arm'].values
        all_z = valid['api_break_z_with_gravity'].values

        # Centre on data centroid
        view_cx = np.mean(all_x)
        view_cz = np.mean(all_z)

        # Half-width = max spread from centroid + 55% padding
        max_spread = max(
            np.max(np.abs(all_x - view_cx)),
            np.max(np.abs(all_z - view_cz)),
            3.0
        )
        MAX_R = max_spread * 1.55

        ax.set_facecolor(BG_COL)
        ax.set_xlim(view_cx - MAX_R, view_cx + MAX_R)
        ax.set_ylim(view_cz - MAX_R, view_cz + MAX_R)
        ax.set_aspect("equal")

        # Background circle
        bg = plt.Circle((view_cx, view_cz), MAX_R, color=BG_COL, zorder=0)
        ax.add_patch(bg)

        # Concentric rings: 3-4 nice steps that fit inside MAX_R
        ring_step = max(1, round(MAX_R / 3.5))
        rings = [ring_step * i for i in range(1, 5) if ring_step * i < MAX_R]
        for r in rings:
            ring = plt.Circle((view_cx, view_cz), r, color="#9bbfce",
                               fill=False, lw=1.0, ls="--", zorder=1)
            ax.add_patch(ring)
            ax.text(view_cx, view_cz + r + MAX_R * 0.025,
                    f'{r}"', ha='center', va='bottom',
                    fontsize=9, color="#4a7a8a", zorder=2)

        # Crosshair through data centroid
        ax.axhline(view_cz, color="#7aaabb", lw=1.3, zorder=1)
        ax.axvline(view_cx, color="#7aaabb", lw=1.3, zorder=1)

        # Direction labels
        lbl = MAX_R * 0.90
        ax.text(view_cx, view_cz + lbl, "MORE RISE ▲",
                ha='center', va='top', fontsize=10, fontweight='bold',
                color="#1a4a6e", zorder=3)
        ax.text(view_cx, view_cz - lbl, "▼ MORE DROP",
                ha='center', va='bottom', fontsize=10, fontweight='bold',
                color="#1a4a6e", zorder=3)
        ax.text(view_cx + lbl, view_cz, "ARM ▶",
                ha='right', va='center', fontsize=10, fontweight='bold',
                color="#1a4a6e", rotation=90, zorder=3)
        ax.text(view_cx - lbl, view_cz, "◀ GLOVE",
                ha='left', va='center', fontsize=10, fontweight='bold',
                color="#1a4a6e", rotation=90, zorder=3)

        # Per-pitch-type: 1-sigma ellipse + scatter
        for pt in pitch_types:
            sub = valid[valid['pitch_name'] == pt]
            if sub.empty:
                continue
            col = color_map[pt]
            x   = sub['api_break_x_arm'].values
            z   = sub['api_break_z_with_gravity'].values

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
                  title_fontsize=9, loc="lower right")

    # ── Strike zone drawing ──────────────────────────────────────────────────
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
                ax.plot([sz['x0'] + w3*i]*2, [sz['z0'], sz['z1']],
                        color="#444", lw=0.7, ls="--", zorder=5)
                ax.plot([sz['x0'], sz['x1']], [sz['z0'] + h3*i]*2,
                        color="#444", lw=0.7, ls="--", zorder=5)

    # ── Pitch location panel ─────────────────────────────────────────────────
    def _plot_pitch_location(self, pdf, parent_ax, pitch_types, color_map):
        parent_ax.axis("off")
        parent_ax.set_title(
            "Pitch Location  ·  vs LHB (left)  |  vs RHB (right)",
            fontsize=14, fontweight="bold", pad=8, color="#1a1a2e")

        fig      = parent_ax.get_figure()
        inner_gs = GridSpecFromSubplotSpec(
            1, 2, subplot_spec=parent_ax.get_subplotspec(), wspace=0.28)

        XLIM, YLIM = (-2.5, 2.5), (0.5, 5.0)

        for col_idx, (stance, label) in enumerate([("L","vs LHB"),("R","vs RHB")]):
            ax  = fig.add_subplot(inner_gs[0, col_idx])
            sub = pdf[pdf['stand'] == stance] if 'stand' in pdf.columns else pdf

            if len(sub) >= 5:
                hb = ax.hexbin(sub['plate_x'], sub['plate_z'],
                               gridsize=14, cmap="YlOrRd", mincnt=1,
                               alpha=0.55,
                               extent=[XLIM[0], XLIM[1], YLIM[0], YLIM[1]],
                               zorder=1)
                cb = fig.colorbar(hb, ax=ax, pad=0.02, shrink=0.75,
                                  label="Pitch count")
                cb.ax.tick_params(labelsize=8)

            for pt in pitch_types:
                pt_sub = sub[sub['pitch_name'] == pt] if 'pitch_name' in sub.columns else sub
                if pt_sub.empty: continue
                ax.scatter(pt_sub['plate_x'], pt_sub['plate_z'],
                           s=30, color=color_map.get(pt,"#888"),
                           edgecolors="white", linewidths=0.4,
                           alpha=0.82, label=pt, zorder=3)

            self._draw_strike_zone_simple(ax, zone_grid=True)
            ax.plot([-0.71, 0.71], [0.5, 0.5], color="#1a1a2e", lw=2.0, zorder=4)

            in_c  = "#d0f0ff" if stance == "L" else "#fff0d0"
            out_c = "#fff0d0" if stance == "L" else "#d0f0ff"
            in_x  = (0.0,  0.83) if stance == "L" else (-0.83, 0.0)
            out_x = (-0.83, 0.0) if stance == "L" else (0.0,   0.83)
            for sx, sc in [(in_x, in_c), (out_x, out_c)]:
                ax.axvspan(sx[0], sx[1],
                           ymin=(1.5-0.5)/4.5, ymax=(3.5-0.5)/4.5,
                           color=sc, alpha=0.18, zorder=0)

            ax.set_title(f"{label}  (n={len(sub)})", fontsize=12, color="#1a1a2e")
            ax.set_xlim(*XLIM); ax.set_ylim(*YLIM)
            ax.set_aspect("equal")
            ax.set_xlabel("Plate X  (ft, catcher view)", fontsize=9)
            ax.set_ylabel("Plate Z  (ft)", fontsize=9)
            ax.tick_params(labelsize=8)

            if col_idx == 1:
                handles = [
                    Line2D([0],[0], marker='o', color='w',
                           markerfacecolor=color_map.get(pt,"#888"),
                           markersize=8, label=pt)
                    for pt in pitch_types
                ]
                ax.legend(handles=handles, fontsize=9, loc="upper right",
                          framealpha=0.88, title="Pitch", title_fontsize=9)

    # ── Main report ──────────────────────────────────────────────────────────
    def create_report(self, pitcher_name):
        pdf = self.df[self.df['player_name'] == pitcher_name].copy()
        if pdf.empty: return

        nat = pdf['nationality'].iloc[0]

        pitch_types = pdf['pitch_name'].dropna().unique().tolist() \
            if 'pitch_name' in pdf.columns else []
        color_map = {pt: PITCH_PALETTE[i % len(PITCH_PALETTE)]
                     for i, pt in enumerate(pitch_types)}

        # ── Aggregation ─────────────────────────────────────────────────────
        agg_dict = {
            'vaa':                          ['min', 'max'],
            'release_speed':                ['min', 'max', 'mean'],
            'api_break_x_arm':              'mean',
            'api_break_z_with_gravity':     'mean',
            'release_spin_rate':            'mean',
            'release_extension':            'mean',
            'is_whiff':                     'sum',
            'is_strike':                    'sum',
            'type':                         'count',
        }
        actual_agg = {k: v for k, v in agg_dict.items() if k in pdf.columns}
        stats = pdf.groupby(['pitch_name', 'stand']).agg(actual_agg).reset_index()

        # Flatten multi-level columns
        stats.columns = [
            f"{c[0]}_{c[1]}".strip('_') if isinstance(c, tuple) and c[1] else
            (c[0] if isinstance(c, tuple) else c)
            for c in stats.columns.values
        ]

        # Apply abbreviation rename
        stats.rename(columns=COL_RENAME, inplace=True)

        # Round numeric cols
        num_cols = stats.select_dtypes(include='number').columns
        stats[num_cols] = stats[num_cols].round(1)

        # ── BIP stats ───────────────────────────────────────────────────────
        bip_cols = ['pitch_name', 'events', 'launch_speed', 'launch_angle']
        avail     = [c for c in bip_cols if c in pdf.columns]
        bip_stats = pdf.dropna(subset=avail)[avail].head(15).round(1)

        # ── Figure ──────────────────────────────────────────────────────────
        fig = plt.figure(figsize=(20, 17), facecolor="#f8f9fb")
        fig.suptitle(f"Pitcher Report:  {pitcher_name}  ({nat})",
                     fontsize=24, fontweight='bold', y=0.99, color="#1a1a2e")

        gs = GridSpec(4, 2, height_ratios=[1.5, 0.85, 0.5, 0.5],
                      figure=fig, hspace=0.36, wspace=0.28)

        # 1. Movement radar
        ax1 = fig.add_subplot(gs[0, 0])
        if 'api_break_x_arm' in pdf.columns and \
           'api_break_z_with_gravity' in pdf.columns:
            self._plot_movement_radar(pdf, ax1, pitch_types, color_map)

        # 2. Pitch location
        ax2 = fig.add_subplot(gs[0, 1])
        self._plot_pitch_location(pdf, ax2, pitch_types, color_map)

        # 3. Stats table
        ax3 = fig.add_subplot(gs[1, :])
        ax3.axis('off')
        tbl = ax3.table(cellText=stats.values, colLabels=stats.columns,
                        cellLoc='center', loc='center')
        tbl.auto_set_font_size(False)
        tbl.set_fontsize(10)
        tbl.scale(1, 2.2)
        for j in range(len(stats.columns)):
            tbl[(0, j)].set_facecolor("#1a1a2e")
            tbl[(0, j)].set_text_props(color="white", fontweight="bold",
                                        fontsize=10)
        ax3.set_title("Pitching Statistics  (VAA · Velo · Spin · Ext · Whiff)",
                      fontsize=16, pad=22, color="#1a1a2e", fontweight="bold")

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
            ax4.set_title(
                f"Batted Ball Events: EV & LA  (n={len(bip_stats)})",
                fontsize=16, pad=12, color="#1a1a2e", fontweight="bold")
        else:
            ax4.text(0.5, 0.5, "No Batted Ball Data (EV/LA) Available",
                     ha='center', fontsize=14, color="#555")

        plt.tight_layout(rect=[0, 0.02, 1, 0.97])
        file_name = f"{pitcher_name.replace(', ','_').replace(' ','_')}.png"
        plt.savefig(f'pitcher_report/{file_name}', dpi=150, facecolor=fig.get_facecolor())
        plt.close()
        print(f"Report generated: {file_name}")


def main():
    if not os.path.exists('pitchdata.csv'):
        print("Error: pitchdata.csv not found.")
        return

    df = pd.read_csv('pitchdata.csv')
    report_gen   = PitcherReportGenerator(df)
    processed_df = report_gen.df

    nationalities = sorted(processed_df['nationality'].unique(), reverse=True)
    for nat in nationalities:
        print(f"\nProcessing Nationality Group: {nat}")
        pitchers = processed_df[processed_df['nationality'] == nat]['player_name'].unique()
        for p in pitchers:
            report_gen.create_report(p)


if __name__ == "__main__":
    main()