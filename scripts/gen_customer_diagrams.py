# -*- coding: utf-8 -*-
"""生成客户版三张架构图（无技术术语）"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch

plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'Source Han Serif SC']
plt.rcParams['axes.unicode_minus'] = False

def box(ax, x, y, w, h, text, fc, ec, fs=12, bold=False, text_color='#333333'):
    bbox = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.02",
                          facecolor=fc, edgecolor=ec, linewidth=1.8, zorder=2)
    ax.add_patch(bbox)
    weight = 'bold' if bold else 'normal'
    ax.text(x + w/2, y + h/2, text, ha='center', va='center', fontsize=fs,
            color=text_color, zorder=3, fontweight=weight, linespacing=1.6)

def arrow(ax, x1, y1, x2, y2, color='#666666', lw=2, style='-|>', connectionstyle='arc3,rad=0'):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=style, color=color, lw=lw,
                                connectionstyle=connectionstyle),
                zorder=1)

# ============================================================
# 方案一：钉钉表格方案（客户版）
# ============================================================
fig, ax = plt.subplots(figsize=(12, 8))
ax.set_xlim(0, 12)
ax.set_ylim(0, 8)
ax.axis('off')

ax.text(6, 7.6, "方案一：钉钉表格方案", fontsize=16, color='#2E7D32', fontweight='bold', ha='center')
ax.text(6, 7.1, "系统装在公司电脑上，数据存在钉钉表格里", fontsize=11, color='#555555', ha='center')

# 电脑
box(ax, 0.8, 4.2, 4.4, 2.4, "", '#E8F4FD', '#1E88E5', 0)
ax.text(3.0, 6.3, "公司电脑", fontsize=13, color='#1565C0', fontweight='bold', ha='center')
box(ax, 1.2, 5.0, 3.6, 1.0, "对账系统\n（上传单据、看结果）", '#FFFFFF', '#1E88E5', 11, bold=True)
box(ax, 1.2, 4.4, 3.6, 0.5, "无需安装其他软件", '#F1F8E9', '#7CB342', 9)

# 钉钉
box(ax, 7.0, 3.8, 4.4, 3.0, "", '#E8F5E9', '#43A047', 0)
ax.text(9.2, 6.5, "钉钉表格（云端）", fontsize=13, color='#2E7D32', fontweight='bold', ha='center')
box(ax, 7.4, 5.2, 3.6, 1.0, "存对账数据\n任务、金额、单据", '#FFFFFF', '#43A047', 10)
box(ax, 7.4, 4.2, 3.6, 0.7, "钉钉官方托管", '#F1F8E9', '#7CB342', 9)

# 箭头
arrow(ax, 5.2, 5.5, 7.0, 5.5, color='#43A047', lw=2.5)
ax.text(6.1, 5.65, "数据存入", fontsize=10, color='#2E7D32', fontweight='bold', ha='center')

# 底部说明
ax.text(6, 2.2, "谁维护？", fontsize=12, color='#333333', fontweight='bold', ha='center')
ax.text(6, 1.7, "系统装好后日常使用即可，数据自动存到钉钉", fontsize=10, color='#555555', ha='center')
ax.text(6, 1.2, "无需购买服务器，无需专人维护", fontsize=10, color='#2E7D32', ha='center')

plt.tight_layout()
plt.savefig('docs/customer_plan_dingtalk.png', dpi=150, bbox_inches='tight', facecolor='#FFFFFF')
plt.close()

# ============================================================
# 方案二：飞书表格方案（客户版）
# ============================================================
fig, ax = plt.subplots(figsize=(12, 8))
ax.set_xlim(0, 12)
ax.set_ylim(0, 8)
ax.axis('off')

ax.text(6, 7.6, "方案二：飞书表格方案", fontsize=16, color='#1D39C4', fontweight='bold', ha='center')
ax.text(6, 7.1, "系统装在公司电脑上，数据存在飞书表格里", fontsize=11, color='#555555', ha='center')

box(ax, 0.8, 4.2, 4.4, 2.4, "", '#E8F4FD', '#3370FF', 0)
ax.text(3.0, 6.3, "公司电脑", fontsize=13, color='#1D39C4', fontweight='bold', ha='center')
box(ax, 1.2, 5.0, 3.6, 1.0, "对账系统\n（上传单据、看结果）", '#FFFFFF', '#3370FF', 11, bold=True)
box(ax, 1.2, 4.4, 3.6, 0.5, "无需安装其他软件", '#F1F8E9', '#7CB342', 9)

box(ax, 7.0, 3.8, 4.4, 3.0, "", '#E6F7FF', '#3370FF', 0)
ax.text(9.2, 6.5, "飞书表格（云端）", fontsize=13, color='#1D39C4', fontweight='bold', ha='center')
box(ax, 7.4, 5.2, 3.6, 1.0, "存对账数据\n任务、金额、单据", '#FFFFFF', '#3370FF', 10)
box(ax, 7.4, 4.2, 3.6, 0.7, "飞书官方托管", '#F1F8E9', '#7CB342', 9)

arrow(ax, 5.2, 5.5, 7.0, 5.5, color='#3370FF', lw=2.5)
ax.text(6.1, 5.65, "数据存入", fontsize=10, color='#1D39C4', fontweight='bold', ha='center')

ax.text(6, 2.2, "谁维护？", fontsize=12, color='#333333', fontweight='bold', ha='center')
ax.text(6, 1.7, "系统装好后日常使用即可，数据自动存到飞书", fontsize=10, color='#555555', ha='center')
ax.text(6, 1.2, "无需购买服务器，无需专人维护", fontsize=10, color='#1D39C4', ha='center')

plt.tight_layout()
plt.savefig('docs/customer_plan_feishu.png', dpi=150, bbox_inches='tight', facecolor='#FFFFFF')
plt.close()

# ============================================================
# 方案三：服务器方案（客户版）
# ============================================================
fig, ax = plt.subplots(figsize=(12, 8))
ax.set_xlim(0, 12)
ax.set_ylim(0, 8)
ax.axis('off')

ax.text(6, 7.6, "方案三：服务器方案", fontsize=16, color='#8E24AA', fontweight='bold', ha='center')
ax.text(6, 7.1, "系统部署在云服务器上，大家用浏览器访问", fontsize=11, color='#555555', ha='center')

# 客户端
box(ax, 0.6, 3.8, 4.6, 3.0, "", '#F3E5F5', '#8E24AA', 0)
ax.text(2.9, 6.5, "团队电脑（浏览器）", fontsize=12, color='#6A1B9A', fontweight='bold', ha='center')
box(ax, 1.0, 5.4, 3.8, 0.8, "同事 A · 同事 B · 同事 C", '#FFFFFF', '#8E24AA', 10)
box(ax, 1.0, 4.3, 3.8, 0.8, "打开浏览器就能用\n无需安装任何软件", '#F3E5F5', '#8E24AA', 10)

# 服务器
box(ax, 7.0, 3.8, 4.6, 3.0, "", '#E8F4FD', '#1565C0', 0)
ax.text(9.3, 6.5, "云服务器", fontsize=12, color='#1565C0', fontweight='bold', ha='center')
box(ax, 7.4, 5.4, 3.8, 0.8, "对账系统 + 数据存储", '#FFFFFF', '#1565C0', 10)
box(ax, 7.4, 4.3, 3.8, 0.8, "7×24 小时在线运行", '#E8F4FD', '#1565C0', 10)

arrow(ax, 5.2, 5.2, 7.0, 5.2, color='#1565C0', lw=2.5)
ax.text(6.1, 5.35, "访问系统", fontsize=10, color='#1565C0', fontweight='bold', ha='center')

ax.text(6, 2.2, "谁维护？", fontsize=12, color='#333333', fontweight='bold', ha='center')
ax.text(6, 1.7, "需要一台云服务器（每年约几百元）", fontsize=10, color='#555555', ha='center')
ax.text(6, 1.2, "需要定期备份，专人负责运维", fontsize=10, color='#8E24AA', ha='center')

plt.tight_layout()
plt.savefig('docs/customer_plan_server.png', dpi=150, bbox_inches='tight', facecolor='#FFFFFF')
plt.close()

print("OK: customer_plan_*.png generated")
