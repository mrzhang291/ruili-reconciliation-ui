# -*- coding: utf-8 -*-
"""生成服务器方案架构图"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch

plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'Source Han Serif SC']
plt.rcParams['axes.unicode_minus'] = False

C_BG = '#FFFFFF'
C_CLIENT = '#F3E5F5'     # 客户端 - 浅紫
C_BORDER = '#8E24AA'
C_SERVER = '#E8F4FD'     # 服务器 - 浅蓝
C_SERVER_B = '#1565C0'
C_DB = '#E8F5E9'         # 数据库 - 浅绿
C_DB_B = '#2E7D32'
C_AGENT = '#FFF8E1'
C_ARROW = '#666666'

def box(ax, x, y, w, h, text, fc, ec, fs=11, bold=False, text_color='#333333'):
    bbox = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.02",
                          facecolor=fc, edgecolor=ec, linewidth=1.5, zorder=2)
    ax.add_patch(bbox)
    weight = 'bold' if bold else 'normal'
    ax.text(x + w/2, y + h/2, text, ha='center', va='center', fontsize=fs,
            color=text_color, zorder=3, fontweight=weight, linespacing=1.6)

def arrow(ax, x1, y1, x2, y2, color=C_ARROW, lw=1.8, style='-|>', connectionstyle='arc3,rad=0'):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=style, color=color, lw=lw,
                                connectionstyle=connectionstyle),
                zorder=1)

# ============================================================
# 服务器方案架构图
# ============================================================
fig, ax = plt.subplots(figsize=(13, 9))
ax.set_xlim(0, 13)
ax.set_ylim(0, 9)
ax.axis('off')

# 顶部：客户端（浏览器访问）
client_box = FancyBboxPatch((0.5, 6.8), 12.0, 1.7, boxstyle="round,pad=0.05",
                             facecolor=C_CLIENT, edgecolor=C_BORDER, linewidth=2, alpha=0.4)
ax.add_patch(client_box)
ax.text(6.5, 8.0, "客户团队（浏览器访问，无需安装）", fontsize=13, color='#6A1B9A', fontweight='bold', ha='center')

box(ax, 1.0, 7.0, 2.6, 0.8, "客户电脑 1\n浏览器", '#FFFFFF', C_BORDER, 9)
box(ax, 5.0, 7.0, 2.6, 0.8, "客户电脑 2\n浏览器", '#FFFFFF', C_BORDER, 9)
box(ax, 9.0, 7.0, 2.6, 0.8, "客户电脑 N\n浏览器", '#FFFFFF', C_BORDER, 9)

# 互联网
box(ax, 5.5, 5.6, 2.0, 0.9, "互联网\nHTTPS", '#E1F5FE', '#0288D1', 10, bold=True)
arrow(ax, 3.6, 7.4, 6.5, 6.5, color='#0288D1', lw=1.8)
arrow(ax, 7.6, 7.4, 6.5, 6.5, color='#0288D1', lw=1.8)
arrow(ax, 9.0, 7.0, 7.5, 6.5, color='#0288D1', lw=1.8, connectionstyle='arc3,rad=0.2')

# ===== 服务器（中间）=====
server_box = FancyBboxPatch((0.5, 1.8), 8.0, 3.4, boxstyle="round,pad=0.05",
                             facecolor=C_SERVER, edgecolor=C_SERVER_B, linewidth=2, alpha=0.4)
ax.add_patch(server_box)
ax.text(1.0, 4.7, "部署服务器（一台云服务器）", fontsize=13, color=C_SERVER_B, fontweight='bold', zorder=3)

box(ax, 1.0, 3.3, 2.6, 1.0, "前端 (React)\n静态资源", '#FFFFFF', C_SERVER_B, 9)
box(ax, 4.0, 3.3, 2.6, 1.0, "后端 (Express)\n对账编排\nAPI", '#FFFFFF', C_SERVER_B, 9)
box(ax, 7.0, 3.3, 1.6, 1.0, "CherryStudio\nAgent", C_AGENT, '#F9A825', 8.5, bold=True)

# 数据库
db_box = FancyBboxPatch((9.0, 2.2), 3.5, 2.8, boxstyle="round,pad=0.05",
                          facecolor=C_DB, edgecolor=C_DB_B, linewidth=2, alpha=0.4)
ax.add_patch(db_box)
ax.text(10.75, 4.5, "数据库", fontsize=12, color=C_DB_B, fontweight='bold', ha='center')
box(ax, 9.3, 3.0, 2.9, 1.1, "PostgreSQL / SQLite\n任务 · 明细 · 文件路径", '#FFFFFF', C_DB_B, 8.5)
box(ax, 9.3, 2.4, 2.9, 0.5, "本地磁盘存储文件", '#FFFFFF', C_DB_B, 8)

# 箭头 后端->数据库
arrow(ax, 6.6, 3.8, 9.0, 3.8, color=C_DB_B, lw=2)
ax.text(7.8, 3.95, "读写", fontsize=9, color=C_DB_B, fontweight='bold')

# 箭头 后端->Agent
arrow(ax, 6.6, 3.8, 7.0, 3.9, color='#F9A825', lw=1.5, connectionstyle='arc3,rad=-0.2')

# ===== 底部说明 =====
box(ax, 0.5, 0.3, 12.0, 1.0,
    "团队通过浏览器访问服务器地址，无需安装任何软件\n所有数据集中存储在服务器，统一管理、备份、升级",
    '#FFF8E1', '#F9A825', 9.5, bold=True)

# 图例
legend_items = [
    mpatches.Patch(facecolor=C_CLIENT, edgecolor=C_BORDER, label='客户浏览器'),
    mpatches.Patch(facecolor=C_SERVER, edgecolor=C_SERVER_B, label='部署服务器'),
    mpatches.Patch(facecolor=C_DB, edgecolor=C_DB_B, label='数据库/存储'),
]
ax.legend(handles=legend_items, loc='lower left', fontsize=10, framealpha=0.9,
          bbox_to_anchor=(0.02, -0.08), ncol=3)

plt.tight_layout()
plt.savefig('docs/server_architecture.png', dpi=150, bbox_inches='tight', facecolor=C_BG)
plt.close()

print("OK: server_architecture.png generated")
