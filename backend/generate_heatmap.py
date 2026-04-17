"""
generate_heatmap.py
Generates a voltage heatmap for the IEEE 13-bus system with topology overlay.
Called by Julia: python3 generate_heatmap.py <output_path> <v1> <v2> ... <v13>
"""

import sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.image as mpimg
import matplotlib.patches as mpatches
from matplotlib.lines import Line2D
from scipy.interpolate import griddata


BUS_NAMES = {
    1:'650', 2:'632', 3:'633', 4:'645', 5:'646', 6:'671',
    7:'684', 8:'611', 9:'634', 10:'675', 11:'652', 12:'680', 13:'692',
}

BUS_COORDS = {
    1:  (500, 650),  
    2:  (500, 480),   
    3:  (680, 480),   
    9:  (860, 480),
    4:  (320, 480), 
    5:  (140, 480),  
    6:  (500, 280),   
    13: (680, 280),   
    10: (860, 280), 
    7:  (320, 280),   
    8:  (140, 280), 
    11: (320, 120),   
    12: (500, 120),  
}


LINES = [
    (1,  2,  '650-632'),
    (2,  4,  '632-645'),
    (4,  5,  '645-646'),
    (2,  3,  '632-633'),
    (3,  9,  '633-634'),
    (2,  6,  '632-671'),
    (6,  13, '671-692'),
    (13, 10, '692-675'),
    (6,  7,  '671-684'),
    (7,  8,  '684-611'),
    (7,  11, '684-652'),
    (6,  12, '671-680'),
]

TRANSFORMER_LINES = set()


def generate_heatmap(voltages, output_path, vmin=0.92, vmax=1.06, map_image="13busmap.png", dc_bus_idx=None):

    xs = np.array([BUS_COORDS[i][0] for i in range(1, 14)])
    ys = np.array([BUS_COORDS[i][1] for i in range(1, 14)])
    zs = np.array(voltages)

    xmin_d, xmax_d = -10, 1005
    ymin_d, ymax_d = -10, 705

    x = np.append(xs, [xmin_d, xmin_d, xmax_d, xmax_d])
    y = np.append(ys, [ymin_d, ymax_d, ymin_d, ymax_d])
    z = np.append(zs, [np.mean(zs)] * 4)

    xi = np.linspace(xmin_d, xmax_d, 1000)
    yi = np.linspace(ymin_d, ymax_d, 1000)
    zi = griddata((x, y), z, (xi[None, :], yi[:, None]), method='cubic')

    fig, ax = plt.subplots(figsize=(12, 8), frameon=False)
    ax.set_xlim(xmin_d, xmax_d)
    ax.set_ylim(ymin_d, ymax_d)
    ax.set_aspect('equal')
    ax.set_axis_off()

    # heatmap
    im2 = ax.contourf(xi, yi, zi, levels=20,
                      vmin=vmin, vmax=vmax,
                      cmap='RdYlGn', alpha=0.75, zorder=1)
    ax.contour(xi, yi, zi, levels=10,
               vmin=vmin, vmax=vmax,
               cmap='RdYlGn', alpha=0.3,
               linewidths=0.5, zorder=2)

   
    try:
        img = mpimg.imread(map_image)
        ax.imshow(img[::-1], origin='lower', alpha=0.12, zorder=3,
                  extent=[0, 1005, 0, 705])
    except FileNotFoundError:
        pass

    for (bus_a, bus_b, label) in LINES:
        x1, y1 = BUS_COORDS[bus_a]
        x2, y2 = BUS_COORDS[bus_b]
        is_xfmr = label in TRANSFORMER_LINES
        ls = '--' if is_xfmr else '-'

        ax.plot([x1, x2], [y1, y2],
                color='white', linewidth=7,
                solid_capstyle='round', zorder=4)

        ax.plot([x1, x2], [y1, y2],
                color='#1e293b', linewidth=3,
                linestyle=ls, solid_capstyle='round', zorder=5)

        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        ax.text(mx, my, label, fontsize=5.5, color='#334155',
                ha='center', va='center', zorder=6,
                bbox=dict(fc='white', alpha=0.8, ec='#cbd5e1', pad=1.5))

    # bus nodes on map
    for bus_id, (bx, by) in BUS_COORDS.items():
        v = voltages[bus_id - 1]

        # violation outliens
        if v < 0.95:
            ax.scatter(bx, by, s=500, color='#ef4444', alpha=0.35, zorder=7)
        elif v > 1.05:
            ax.scatter(bx, by, s=500, color='#f59e0b', alpha=0.35, zorder=7)

        #fill color
        t = np.clip((v - vmin) / (vmax - vmin), 0, 1)
        bus_color = plt.cm.RdYlGn(t)

        marker = 's' if bus_id == 1 else 'o'
        ax.scatter(bx, by, s=200, color=bus_color,
                   marker=marker, edgecolors='#1e293b',
                   linewidths=2, zorder=8)

        v_color = '#dc2626' if v < 0.95 else '#d97706' if v > 1.05 else '#166534'
        ax.text(bx, by + 30, f'Bus {bus_id}',
                fontsize=7.5, fontweight='bold', color='#1e293b',
                ha='center', va='bottom', zorder=9,
                bbox=dict(fc='white', alpha=0.8, ec='none', pad=1.5))
        ax.text(bx, by - 30, f'{v:.3f} p.u.',
                fontsize=7.5, fontweight='bold', color=v_color,
                ha='center', va='top', zorder=9,
                bbox=dict(fc='white', alpha=0.8, ec='none', pad=1.5))

    #data center marker
    if dc_bus_idx is not None and dc_bus_idx in BUS_COORDS:
        dcx, dcy = BUS_COORDS[dc_bus_idx]
        
        ax.scatter(dcx, dcy, s=700, color='none',
                   edgecolors='#0891b2', linewidths=3, zorder=10)
        ax.scatter(dcx, dcy, s=900, color='none',
                   edgecolors='#0891b2', linewidths=1, alpha=0.4, zorder=10)
        ax.annotate(
            'DATA CENTER',
            xy=(dcx, dcy), xytext=(dcx, dcy + 65),
            fontsize=8, fontweight='bold', color='#0891b2',
            ha='center', va='bottom', zorder=11,
            bbox=dict(boxstyle='round,pad=0.3', fc='#ecfeff', ec='#0891b2', lw=1.5),
            arrowprops=dict(arrowstyle='->', color='#0891b2', lw=1.5),
        )

    cbar = fig.colorbar(im2, ax=ax, shrink=0.6, pad=0.02, aspect=25)
    cbar.set_label('Voltage (p.u.)', fontsize=10, labelpad=8)
    cbar.ax.tick_params(labelsize=8)
    cbar.ax.axhline(y=(0.95 - vmin) / (vmax - vmin),
                    color='#ef4444', linewidth=1.5, linestyle='--')
    cbar.ax.axhline(y=(1.05 - vmin) / (vmax - vmin),
                    color='#f59e0b', linewidth=1.5, linestyle='--')



    legend_elements = [
        Line2D([0],[0], marker='o', color='w', markerfacecolor='none',
               markersize=12, markeredgecolor='#0891b2', markeredgewidth=2.5,
               label='Data center bus'),
 
        mpatches.Patch(color='#ef4444', alpha=0.5, label='Under-voltage  < 0.95 p.u.'),
        mpatches.Patch(color='#f59e0b', alpha=0.5, label='Over-voltage   > 1.05 p.u.'),
        Line2D([0],[0], marker='s', color='w', markerfacecolor='#6b7280',
               markersize=9, markeredgecolor='#1e293b', label='Substation (Bus 1 = 650)'),
        Line2D([0],[0], marker='o', color='w', markerfacecolor='#6b7280',
               markersize=9, markeredgecolor='#1e293b', label='Load bus'),



        mpatches.Patch(color='none', label=' '),
        mpatches.Patch(color='none', label='Bus index:'),
        mpatches.Patch(color='none', label='1=650  2=632  3=633'),
        mpatches.Patch(color='none', label='4=645  5=646  6=671'),
        mpatches.Patch(color='none', label='7=684  8=611  9=634'),
        mpatches.Patch(color='none', label='10=675 11=652 12=680'),
        
        mpatches.Patch(color='none', label='13=692'),
    ]
    ax.legend(handles=legend_elements, loc='lower right',
              fontsize=6.5, framealpha=0.92, edgecolor='#cbd5e1',
              handlelength=1.5, handleheight=1.0)

    plt.tight_layout(pad=0.3)
    plt.savefig(output_path, format='png', bbox_inches='tight', dpi=150)
    plt.close()
    print(f"[ok] saved {output_path}")


if __name__ == "__main__":
    if len(sys.argv) < 15:
        print("Usage: generate_heatmap.py <output.png> <v1> <v2> ... <v13> [dc_bus_idx]")
        sys.exit(1)
    out      = sys.argv[1]
    volts    = [float(v) for v in sys.argv[2:15]]
    dc_bus   = int(sys.argv[15]) if len(sys.argv) > 15 else None
    generate_heatmap(volts, out, dc_bus_idx=dc_bus)