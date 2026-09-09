# -*- coding: utf-8 -*-
"""生成飞书多维表格版架构图 - 目标架构 + 对账流程"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch

plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'Source Han Serif SC']
plt.rcParams['axes.unicode_minus'] = False

# 飞书品牌配色（蓝/青）
C_BG = '#FFFFFF'
C_CLIENT = '#E8F4FD'
C_BORDER = '#3370FF'
C_TITLE = '#1D39C4'
C_AGENT = '#FFF8E1'
C_LARK = '#E6F7FF'
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
# 图1：目标架构图（飞书 = 纯数据库）
# ============================================================
fig, ax = plt.subplots(figsize=(13, 9))
ax.set_xlim(0, 13)
ax.set_ylim(0, 9)
ax.axis('off')

# 客户电脑容器
win_box = FancyBboxPatch((0.3, 1.8), 7.4, 6.6, boxstyle="round,pad=0.05",
                          facecolor=C_CLIENT, edgecolor=C_BORDER, linewidth=2, alpha=0.4)
ax.add_patch(win_box)
ax.text(0.6, 7.9, "客户电脑", fontsize=14, color=C_TITLE, fontweight='bold', zorder=3)

# 前端（展示结果 - 高亮）
box(ax, 0.8, 6.3, 2.4, 1.3, "前端 (React)\n上传文件\n展示对账结果", '#E6F7FF', C_BORDER, 10, bold=True)
# 后端
box(ax, 3.7, 6.3, 2.2, 1.3, "后端 (Express)\n处理上传\n读写飞书数据", '#FFFFFF', C_BORDER, 10)
# 内存Map
box(ax, 6.4, 6.3, 1.3, 1.3, "内存 Map\n中间状态\n(可丢失)", '#FFF8E1', '#F9A825', 9)

# 箭头 前端->后端
arrow(ax, 3.2, 6.95, 3.7, 6.95)
# 箭头 后端->内存
arrow(ax, 5.9, 6.95, 6.4, 6.95)

# 本地临时目录
box(ax, 0.8, 4.7, 2.8, 0.9, "本地临时目录\n.runtime/tasks/<ID>/", '#F1F8E9', '#7CB342', 9)
# Agent
box(ax, 3.7, 4.7, 2.2, 0.9, "CherryStudio\nAgent (MCP)", C_AGENT, '#F9A825', 10, bold=True)
# lark-base
box(ax, 6.4, 4.7, 1.9, 0.9, "lark-base\nlark-cli", '#E6F7FF', '#3370FF', 9)

# 箭头 后端->Agent
arrow(ax, 4.8, 6.3, 4.8, 5.6)
# 箭头 本地->Agent
arrow(ax, 2.2, 4.7, 3.7, 5.15, color='#7CB342')
# 箭头 Agent->lark-base
arrow(ax, 5.9, 5.15, 6.4, 5.15)

# ===== 飞书多维表格（纯数据库）=====
lark_box = FancyBboxPatch((8.2, 2.6), 4.5, 5.2, boxstyle="round,pad=0.05",
                           facecolor='#E6F7FF', edgecolor='#3370FF', linewidth=2, alpha=0.35)
ax.add_patch(lark_box)
ax.text(10.45, 7.4, "飞书多维表格（数据库）", fontsize=13, color='#1D39C4', fontweight='bold', zorder=3, ha='center')
ax.text(10.45, 7.0, "仅作存储，不对团队展示", fontsize=9, color='#555555', zorder=3, ha='center', style='italic')

# 任务表
box(ax, 8.5, 5.0, 3.9, 1.5, "对账任务表\n任务ID · 商城 · 账期\nERP金额 · 结算金额 · 差额\n状态 · 附件 · 完成时间", '#FFFFFF', '#3370FF', 8.5)
# 明细表
box(ax, 8.5, 3.3, 3.9, 1.4, "审核明细表\n明细ID · 任务ID\n差异金额 · 描述 · 状态", '#FFFFFF', '#3370FF', 8.5)

# 箭头 lark-base -> 飞书表
arrow(ax, 8.2, 5.15, 8.5, 5.6, color='#3370FF', lw=2)
ax.text(8.0, 5.4, "写入", fontsize=8, color='#1D39C4', ha='center', rotation=90)

# ===== 后端 <-> 飞书 读写（双向）=====
arrow(ax, 8.2, 4.2, 5.9, 6.8, color='#3370FF', lw=2, style='<|-|>', connectionstyle='arc3,rad=-0.25')
ax.text(6.6, 5.0, "读写数据", fontsize=9, color='#1D39C4', fontweight='bold')

# 标注：前端展示结果，不去飞书
box(ax, 0.8, 2.3, 5.1, 1.3, "前端展示最终结果\n任务列表 · 详情 · 统计\n团队在系统内查看，不去飞书", '#E6F7FF', '#1D39C4', 9.5, bold=True)
# 前端 -> 后端读取数据展示
arrow(ax, 2.0, 6.3, 2.0, 3.6, color='#1D39C4', lw=1.8, style='<|-|>')
ax.text(2.25, 4.9, "读数据展示", fontsize=8, color='#1D39C4', va='center', rotation=90)

# 图例
legend_items = [
    mpatches.Patch(facecolor=C_CLIENT, edgecolor=C_BORDER, label='客户本机'),
    mpatches.Patch(facecolor=C_AGENT, edgecolor='#F9A825', label='Agent / MCP'),
    mpatches.Patch(facecolor='#E6F7FF', edgecolor='#3370FF', label='飞书云端（纯存储）'),
]
ax.legend(handles=legend_items, loc='lower left', fontsize=10, framealpha=0.9,
          bbox_to_anchor=(0.02, -0.02), ncol=3)

plt.tight_layout()
plt.savefig('docs/lark_architecture_target.png', dpi=150, bbox_inches='tight', facecolor=C_BG)
plt.close()

# ============================================================
# 图2：对账流程图（前端展示结果）
# ============================================================
fig, ax = plt.subplots(figsize=(12, 10))
ax.set_xlim(0, 12)
ax.set_ylim(0, 10)
ax.axis('off')

# 泳道
lanes = [
    (0.3, 0.5, 11.4, 0.6, "用户", '#E6F7FF', '#3370FF'),
    (0.3, 1.1, 11.4, 3.2, "前端 (React)", '#E1F5FE', '#0288D1'),
    (0.3, 4.3, 11.4, 2.6, "后端 (Express)", '#E8F4FD', '#1D39C4'),
    (0.3, 6.9, 11.4, 2.0, "CherryStudio Agent", '#FFF8E1', '#F9A825'),
    (0.3, 8.9, 11.4, 0.8, "飞书多维表格（数据库）", '#E6F7FF', '#3370FF'),
]
for x, y, w, h, label, fc, ec in lanes:
    lane = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02",
                          facecolor=fc, edgecolor=ec, linewidth=1.2, alpha=0.35)
    ax.add_patch(lane)
    ax.text(x + 0.2, y + h - 0.35, label, fontsize=12, color=ec, fontweight='bold', zorder=3)

# 用户泳道
box(ax, 3.5, 0.55, 5, 0.5, "上传结算单 + ERP 文件", '#FFFFFF', '#3370FF', 10)

# 前端泳道
box(ax, 1.0, 3.3, 3.2, 0.75, "2. 提交文件到后端\n   显示进度", '#FFFFFF', '#0288D1', 9)
box(ax, 7.5, 3.3, 3.5, 0.75, "5. 轮询 /api/tasks/:id\n   展示对账结果", '#E1F5FE', '#0288D1', 9, bold=True)

# 后端泳道
box(ax, 1.0, 5.6, 3.0, 0.8, "1. 校验文件类型\n   保存本地临时目录", '#FFFFFF', '#1D39C4', 9)
box(ax, 4.8, 5.6, 3.0, 0.8, "3. 创建内存任务\n   QUEUED→PROCESSING", '#FFFFFF', '#1D39C4', 9)
box(ax, 8.5, 5.6, 3.0, 0.8, "6. 校验 Agent 返回\n   更新内存状态", '#FFFFFF', '#1D39C4', 9)

# Agent 泳道
box(ax, 1.0, 7.4, 3.0, 1.0, "4. 读文件 → MinerU\n   计算 difference", C_AGENT, '#F9A825', 9, bold=True)
box(ax, 4.8, 7.4, 3.6, 1.0, "调 lark-base 写结果\n插入记录\n任务+附件+明细", '#E6F7FF', '#3370FF', 9)
box(ax, 8.5, 7.4, 3.0, 1.0, "返回 JSON\n{matched, difference,\nissues, period, name}", '#FFFFFF', '#F9A825', 9)

# 飞书泳道
box(ax, 6.0, 8.9, 4.0, 0.5, "存储任务 + 附件 + 明细", '#FFFFFF', '#3370FF', 9, bold=True)

# 箭头
arrow(ax, 6.0, 1.05, 2.5, 3.3)                # 用户->前端2
arrow(ax, 4.2, 3.65, 2.5, 5.6)                # 前端->后端1
arrow(ax, 4.0, 6.0, 4.8, 6.0)                 # 后端1->后端3
arrow(ax, 7.8, 6.0, 2.5, 7.4)                 # 后端3->Agent4
arrow(ax, 4.0, 7.9, 4.8, 7.9)                 # Agent4->写lark
arrow(ax, 8.4, 7.9, 8.5, 7.9)                 # 写lark->返回
arrow(ax, 9.0, 7.4, 9.0, 6.4)                 # 返回->后端6
arrow(ax, 9.0, 6.4, 9.0, 9.1, color='#3370FF', lw=1.5)  # 后端->飞书存
arrow(ax, 9.0, 9.1, 9.0, 4.05, color='#0288D1', lw=1.5, style='<|-|>')  # 飞书->前端5读展示
arrow(ax, 8.0, 4.3, 7.5, 4.3, color='#0288D1', lw=1.5)  # 读->前端5

plt.tight_layout()
plt.savefig('docs/lark_reconciliation_flow.png', dpi=150, bbox_inches='tight', facecolor=C_BG)
plt.close()

print("OK: lark_architecture_target.png + lark_reconciliation_flow.png generated")
