# -*- coding: utf-8 -*-
"""生成飞书版数据流转图 - PostgreSQL 三表 → 飞书多维表格"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch

plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'Source Han Serif SC']
plt.rcParams['axes.unicode_minus'] = False

fig, ax = plt.subplots(figsize=(13, 7.5))
ax.set_xlim(0, 13)
ax.set_ylim(0, 7.5)
ax.axis('off')

def box(ax, x, y, w, h, title, fields, fc, ec, title_color):
    bbox = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.02",
                          facecolor=fc, edgecolor=ec, linewidth=2, zorder=2)
    ax.add_patch(bbox)
    ax.add_patch(FancyBboxPatch((x, y+h-0.6), w, 0.6, boxstyle="round,pad=0.005",
                                 facecolor=ec, edgecolor='none', zorder=3))
    ax.text(x+w/2, y+h-0.3, title, ha='center', va='center', fontsize=11,
            color='white', fontweight='bold', zorder=4)
    for i, f in enumerate(fields):
        ax.text(x+w/2, y+h-1.0 - i*0.42, f, ha='center', va='center', fontsize=9,
                color=title_color, zorder=4)

def arrow(ax, x1, y1, x2, y2, color, label='', lw=2):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='-|>', color=color, lw=lw,
                                connectionstyle='arc3,rad=0.1'),
                zorder=5)
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx+0.3, my+0.1, label, fontsize=9, color=color, fontweight='bold',
                ha='center', va='center', zorder=6,
                bbox=dict(boxstyle='round,pad=0.15', facecolor='white', edgecolor=color, alpha=0.9))

# ===== 标题 =====
ax.text(6.5, 7.1, "数据流转：PostgreSQL → 飞书多维表格", fontsize=15, color='#333333',
        fontweight='bold', ha='center')

# ===== 左侧：PostgreSQL（删除）=====
pg_box = FancyBboxPatch((0.4, 0.8), 4.8, 5.8, boxstyle="round,pad=0.05",
                          facecolor='#FDEAEA', edgecolor='#E53935', linewidth=2, alpha=0.5)
ax.add_patch(pg_box)
ax.text(2.8, 6.2, "PostgreSQL（删除）", fontsize=12, color='#C62828', fontweight='bold', ha='center')
ax.text(2.8, 5.8, "旧方案", fontsize=9, color='#E53935', ha='center', style='italic')

# ReconciliationTask
box(ax, 0.8, 4.2, 4.0, 1.7, "ReconciliationTask",
    ["任务表", "settlementFileId (FK)", "erpFileId (FK)", "reviewItems (1:N)"],
    '#FFEBEE', '#E53935', '#B71C1C')
# File
box(ax, 0.8, 2.6, 4.0, 1.3, "File",
    ["文件表", "storedPath (本地路径)"],
    '#F3E5F5', '#8E24AA', '#4A148C')
# ReconciliationReviewItem
box(ax, 0.8, 1.0, 4.0, 1.3, "ReconciliationReviewItem",
    ["审核明细表", "taskId (FK)"],
    '#FFF3E0', '#FB8C00', '#E65100')

# ===== 中间箭头 =====
arrow(ax, 4.8, 5.0, 7.6, 5.7, '#3370FF', '表映射')
arrow(ax, 4.8, 3.2, 7.6, 4.3, '#3370FF', '附件上传')
arrow(ax, 4.8, 1.7, 7.6, 2.6, '#3370FF', '表映射')

# ===== 右侧：飞书多维表格（新增）=====
lark_box = FancyBboxPatch((7.8, 0.8), 4.8, 5.8, boxstyle="round,pad=0.05",
                           facecolor='#E6F7FF', edgecolor='#3370FF', linewidth=2, alpha=0.5)
ax.add_patch(lark_box)
ax.text(10.2, 6.2, "飞书多维表格（新增）", fontsize=12, color='#1D39C4', fontweight='bold', ha='center')
ax.text(10.2, 5.8, "新方案", fontsize=9, color='#3370FF', ha='center', style='italic')

box(ax, 8.2, 4.5, 4.0, 1.5, "对账任务表",
    ["任务ID · 商城 · 账期", "ERP金额 · 结算金额 · 差额", "状态 · 附件 · 完成时间"],
    '#E6F7FF', '#3370FF', '#1D39C4')
box(ax, 8.2, 2.7, 4.0, 1.3, "审核明细表",
    ["明细ID · 任务ID", "差异金额 · 描述 · 状态"],
    '#E6F7FF', '#3370FF', '#1D39C4')
box(ax, 8.2, 1.0, 4.0, 1.2, "附件字段",
    ["结算文件 · ERP文件", "(存于任务记录附件)"],
    '#E6F7FF', '#3370FF', '#1D39C4')

# 关联标注
ax.text(10.2, 4.2, "1 : N", fontsize=10, color='#E53935', fontweight='bold', ha='center')

# 底部说明
ax.text(6.5, 0.35, "文件附件从本地 storedPath 迁移到飞书附件字段，前端展示时从飞书读取",
        fontsize=9, color='#555555', ha='center', style='italic')

plt.tight_layout()
plt.savefig('docs/lark_data_flow.png', dpi=150, bbox_inches='tight', facecolor='#FFFFFF')
plt.close()
print("OK: lark_data_flow.png generated")
