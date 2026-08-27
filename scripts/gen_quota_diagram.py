# -*- coding: utf-8 -*-
"""重新生成 API 额度分析图 - 用双子图"""
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

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5.5), gridspec_kw={'width_ratios': [1.2, 1]})
fig.suptitle("钉钉 API 月额度分析（标准版）", fontsize=15, color='#1565C0', fontweight='bold', y=0.98)

# ============ 左：月度调用量堆叠柱状图 ============
categories = ['任务创建', '附件上传', '明细写入', '状态更新', '查询读取']
# 按 100 任务估算的单任务调用量
per_task = [1, 2, 5, 3, 4]
total_per_task = sum(per_task)
total_month = total_per_task * 100

bars = ax1.bar(categories, per_task, color=['#1E88E5', '#43A047', '#FB8C00', '#E53935', '#8E24AA'],
               width=0.55, edgecolor='white', linewidth=0.5)
for bar, v in zip(bars, per_task):
    ax1.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.15, str(v),
             ha='center', fontsize=11, color='#333333', fontweight='bold')

ax1.set_ylabel('单任务 API 调用次数', fontsize=11)
ax1.set_title(f'单任务调用构成（约 {total_per_task} 次/任务）', fontsize=12, fontweight='bold')
ax1.set_ylim(0, 6.5)
ax1.tick_params(axis='x', labelsize=9)
ax1.spines['top'].set_visible(False)
ax1.spines['right'].set_visible(False)

# 标注总计
ax1.text(2.0, -1.4, f"100 任务/月 → 约 {total_month} 次调用",
         ha='center', fontsize=11, color='#E65100', fontweight='bold')

# ============ 右：月额度环形图 ============
quota = 5000
used = total_month
remaining = quota - used
pct = used / quota * 100

ax2.pie([used, remaining], colors=['#FB8C00', '#E0E0E0'], startangle=90,
        wedgeprops=dict(width=0.35, edgecolor='white'), labels=None)
# 中心文字
ax2.text(0, 0.12, f"{pct:.0f}%", fontsize=24, color='#E65100', fontweight='bold', ha='center')
ax2.text(0, -0.18, f"已用 {used} / {quota} 次", fontsize=11, color='#555555', ha='center')
ax2.text(0, -0.38, f"剩余 {remaining} 次", fontsize=11, color='#43A047', ha='center')
ax2.set_title('月额度消耗', fontsize=12, fontweight='bold')

# 图例
from matplotlib.lines import Line2D
legend_handles = [
    mpatches.Patch(facecolor='#FB8C00', label=f'已用 ({pct:.0f}%)'),
    mpatches.Patch(facecolor='#E0E0E0', label=f'剩余 ({100-pct:.0f}%)'),
]
ax2.legend(handles=legend_handles, loc='lower center', bbox_to_anchor=(0.5, -0.25), fontsize=9, ncol=2)

plt.tight_layout(rect=[0, 0, 1, 0.93])
plt.savefig('docs/api_quota.png', dpi=150, bbox_inches='tight', facecolor='#FFFFFF')
plt.close()
print("OK: api_quota.png regenerated")
