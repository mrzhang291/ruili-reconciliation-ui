# -*- coding: utf-8 -*-
"""生成数据表结构图 + API额度统计图"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch
import numpy as np

plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'Source Han Serif SC']
plt.rcParams['axes.unicode_minus'] = False

def box(ax, x, y, w, h, text, fc, ec, fs=11, bold=False, text_color='#333333'):
    bbox = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.02",
                          facecolor=fc, edgecolor=ec, linewidth=1.5, zorder=2)
    ax.add_patch(bbox)
    weight = 'bold' if bold else 'normal'
    ax.text(x + w/2, y + h/2, text, ha='center', va='center', fontsize=fs,
            color=text_color, zorder=3, fontweight=weight, linespacing=1.6)

# ============================================================
# 图3：数据表结构 ER 图
# ============================================================
fig, ax = plt.subplots(figsize=(13, 8))
ax.set_xlim(0, 13)
ax.set_ylim(0, 8)
ax.axis('off')

ax.text(6.5, 7.5, "飞书多维表格 - 数据模型", fontsize=16, color='#1D39C4', fontweight='bold', ha='center')

# 表1：对账任务表
box(ax, 0.8, 4.6, 5.2, 2.4, "", '#FFFFFF', '#3370FF', 0)
ax.add_patch(mpatches.FancyBboxPatch((0.8, 4.6), 5.2, 2.4, boxstyle="round,pad=0.02",
                                      facecolor='#FFFFFF', edgecolor='#3370FF', linewidth=2))
ax.text(3.4, 6.5, "表1：对账任务表", fontsize=13, color='#1D39C4', fontweight='bold', ha='center')
fields1 = [
    "任务ID (文本, 主键)       商城名称 (文本)",
    "账期 (文本 YYYY-MM)       ERP金额 (货币)",
    "结算金额 (货币)            差额 (货币, ±)",
    "状态 (单选)                结算文件 (附件)",
    "ERP文件 (附件)            完成时间 (日期)",
    "备注 (文本)",
]
for i, f in enumerate(fields1):
    ax.text(1.1, 6.1 - i*0.42, f, fontsize=9, color='#333333', va='center')

# 表2：审核明细表
box(ax, 7.0, 4.0, 5.0, 3.0, "", '#FFFFFF', '#3370FF', 0)
ax.add_patch(mpatches.FancyBboxPatch((7.0, 4.0), 5.0, 3.0, boxstyle="round,pad=0.02",
                                      facecolor='#FFFFFF', edgecolor='#3370FF', linewidth=2))
ax.text(9.5, 6.6, "表2：审核明细表", fontsize=13, color='#1D39C4', fontweight='bold', ha='center')
fields2 = [
    "明细ID (文本, 主键)",
    "任务ID (文本, 关联表1)",
    "商城名称 (文本, 冗余)",
    "差异金额 (货币)",
    "差异描述 (文本)",
    "处理状态 (单选: 待处理/通过/忽略)",
    "建议 (文本)",
    "创建时间 (日期)",
]
for i, f in enumerate(fields2):
    ax.text(7.3, 6.2 - i*0.55, f, fontsize=9, color='#333333', va='center')

# 关联箭头
arrow = ax.annotate('', xy=(6.9, 5.5), xytext=(6.1, 5.6),
                     arrowprops=dict(arrowstyle='-|>', color='#E53935', lw=2.5, connectionstyle='arc3,rad=0.2'))
ax.text(6.0, 6.1, "1 : N", fontsize=11, color='#E53935', fontweight='bold')

# 中间状态说明
box(ax, 1.0, 1.6, 4.8, 1.6, "内存 Map（不落库）\ntaskId → {status, progressLogs, result}\n服务重启即丢失，任务需重新上传", '#FFF8E1', '#F9A825', 9)
# 文件存储说明
box(ax, 7.0, 1.6, 4.8, 1.6, "原始文件存储\n对账前：本地临时目录\n对账后：上传至飞书附件字段\n前端展示时从飞书读取单据", '#F1F8E9', '#7CB342', 9)

plt.tight_layout()
plt.savefig('docs/data_model.png', dpi=150, bbox_inches='tight', facecolor='#FFFFFF')
plt.close()

# ============================================================
# 图4：API 额度使用分析
# ============================================================
fig, ax = plt.subplots(figsize=(11, 6))
ax.set_xlim(0, 11)
ax.set_ylim(0, 6)
ax.axis('off')

ax.text(5.5, 5.6, "飞书 API 月额度分析 (标准版)", fontsize=15, color='#1D39C4', fontweight='bold', ha='center')

# 数据
tasks_month = 100
calls_per_task = 15
total_calls = tasks_month * calls_per_task
quota = 5000
usage_pct = total_calls / quota * 100

# 左侧：调用量柱状图
ax.text(2.0, 5.1, "预估月调用量", fontsize=12, color='#333333', fontweight='bold', ha='center')
categories = ['任务创建', '附件上传', '明细写入', '状态更新', '查询读取']
values = [100, 200, 500, 300, 400]
colors = ['#3370FF', '#3370FF', '#FB8C00', '#E53935', '#8E24AA']
bars_x = [1.0, 2.0, 3.0, 4.0, 5.0]
for x, v, c in zip(bars_x, values, colors):
    bar = mpatches.FancyBboxPatch((x-0.28, 0.6), 0.56, v/500*3.0, boxstyle="round,pad=0.005",
                                   facecolor=c, edgecolor='none', linewidth=0.5)
    ax.add_patch(bar)
    ax.text(x, v/500*3.0 + 0.25, str(v), ha='center', fontsize=9, color=c, fontweight='bold')

ax.set_xlim(0, 6.2)
ax.text(3.0, 0.3, "类别", ha='center', fontsize=9, color='#666666')
for x, name in zip(bars_x, categories):
    ax.text(x, 0.05, name, ha='center', fontsize=7.5, color='#555555')

# 右侧：额度环形图
ax.text(8.2, 5.1, "月额度消耗", fontsize=12, color='#333333', fontweight='bold', ha='center')
# 环形图 (matplotlib pie)
sizes = [total_calls, quota - total_calls]
explode = (0.05, 0)
colors_pie = ['#FB8C00', '#E0E0E0']
wedges, _ = ax.pie(sizes, colors=colors_pie, startangle=90, radius=1.1,
                   wedgeprops=dict(width=0.35, edgecolor='white'))
ax.text(8.2, 3.0, f"{usage_pct:.0f}%", fontsize=20, color='#E65100', fontweight='bold', ha='center')
ax.text(8.2, 2.5, f"{total_calls} / {quota} 次", fontsize=10, color='#666666', ha='center')
ax.text(8.2, 2.1, "剩余 {:.0f}%".format(100-usage_pct), fontsize=10, color='#3370FF', ha='center')

# 底部说明
ax.text(5.5, 0.2, "单任务约 10-20 次 API 调用（含任务/附件/明细/状态），100 任务/月约 1500 次，在免费额度内",
        fontsize=9, color='#666666', ha='center')

plt.tight_layout()
plt.savefig('docs/api_quota.png', dpi=150, bbox_inches='tight', facecolor='#FFFFFF')
plt.close()

print("OK: data_model.png + api_quota.png generated")
