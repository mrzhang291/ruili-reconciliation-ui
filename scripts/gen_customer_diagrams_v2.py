# -*- coding: utf-8 -*-
"""重新生成三张客户版架构图 - 大尺寸高颜值"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch

plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'Source Han Serif SC']
plt.rcParams['axes.unicode_minus'] = False

def shadow_box(ax, x, y, w, h, fc, ec, lw=2.5, radius=0.06):
    """简洁圆角矩形（无阴影）"""
    box = FancyBboxPatch((x, y), w, h,
                         boxstyle=f"round,pad=0.02,rounding_size={radius}",
                         facecolor=fc, edgecolor=ec, linewidth=lw, zorder=2)
    ax.add_patch(box)
    return box

def box(ax, x, y, w, h, text, fc, ec, fs=16, bold=False, text_color='#2b2b2b', lw=2.5):
    shadow_box(ax, x, y, w, h, fc, ec, lw=lw)
    weight = 'bold' if bold else 'normal'
    ax.text(x + w/2, y + h/2, text, ha='center', va='center', fontsize=fs,
            color=text_color, zorder=4, fontweight=weight, linespacing=1.7)

def container(ax, x, y, w, h, fc, ec, lw=3, alpha=0.25):
    box = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.03,rounding_size=0.02",
                         facecolor=fc, edgecolor=ec, linewidth=lw, zorder=1, alpha=alpha)
    ax.add_patch(box)

def arrow(ax, x1, y1, x2, y2, color='#5b8def', lw=4, style='-|>', connectionstyle='arc3,rad=0', ms=28):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=style, color=color, lw=lw,
                                connectionstyle=connectionstyle, mutation_scale=ms),
                zorder=3)

# ============================================================
# 图1：钉钉表格方案
# ============================================================
fig, ax = plt.subplots(figsize=(15, 10))
ax.set_xlim(0, 15)
ax.set_ylim(0, 10)
ax.axis('off')

# 背景渐变效果
ax.set_facecolor('#f8faff')

# 标题
ax.text(7.5, 9.4, "方案一：钉钉表格方案", fontsize=24, color='#1a7a3d', fontweight='bold', ha='center')
ax.text(7.5, 8.9, "系统装在电脑上，数据存到钉钉，团队都能看", fontsize=14, color='#666666', ha='center')

# 左侧：公司电脑
container(ax, 0.8, 4.2, 6.0, 4.2, '#e8f4fd', '#2b6cb0')
ax.text(3.8, 8.0, "公司电脑", fontsize=18, color='#2b6cb0', fontweight='bold', ha='center')

box(ax, 1.4, 5.4, 4.8, 2.2, "对账系统\n\n上传单据 · 自动对账 · 看结果", '#ffffff', '#2b6cb0', fs=17, bold=True)
# 加个小标签
box(ax, 1.4, 4.55, 2.3, 0.7, "需安装一次", '#e8f4fd', '#2b6cb0', fs=12)

# 右侧：钉钉
container(ax, 8.4, 4.2, 5.8, 4.2, '#e8f8ec', '#1a7a3d')
ax.text(11.3, 8.0, "钉钉表格（云端）", fontsize=18, color='#1a7a3d', fontweight='bold', ha='center')

box(ax, 9.0, 5.4, 4.6, 1.7, "存对账数据\n\n任务 · 金额 · 单据附件", '#ffffff', '#1a7a3d', fs=15)
box(ax, 9.0, 4.55, 2.3, 0.7, "钉钉官方托管", '#e8f8ec', '#1a7a3d', fs=12)

# 箭头
arrow(ax, 6.8, 6.4, 8.4, 6.4, color='#1a7a3d', lw=5)
ax.text(7.6, 6.65, "数据存入", fontsize=14, color='#1a7a3d', fontweight='bold', ha='center')

# 底部说明 - 团队可见
box(ax, 1.4, 1.7, 12.2, 1.6,
    "团队可见：所有对账结果，团队在钉钉表格里都能看、都能改",
    '#fff7e6', '#d69e2e', fs=16, bold=True)
ax.text(7.5, 0.9, "多台电脑各自发起对账：每台电脑装一套系统即可", fontsize=13, color='#888888', ha='center')

plt.tight_layout()
plt.savefig('docs/customer_plan_dingtalk.png', dpi=200, bbox_inches='tight', facecolor='#f8faff')
plt.close()
print("OK: customer_plan_dingtalk.png")

# ============================================================
# 图2：飞书表格方案
# ============================================================
fig, ax = plt.subplots(figsize=(15, 10))
ax.set_xlim(0, 15)
ax.set_ylim(0, 10)
ax.axis('off')
ax.set_facecolor('#f8faff')

ax.text(7.5, 9.4, "方案二：飞书表格方案", fontsize=24, color='#1d39c4', fontweight='bold', ha='center')
ax.text(7.5, 8.9, "系统装在电脑上，数据存到飞书，团队都能看", fontsize=14, color='#666666', ha='center')

container(ax, 0.8, 4.2, 6.0, 4.2, '#eef1fe', '#3370ff')
ax.text(3.8, 8.0, "公司电脑", fontsize=18, color='#3370ff', fontweight='bold', ha='center')

box(ax, 1.4, 5.4, 4.8, 2.2, "对账系统\n\n上传单据 · 自动对账 · 看结果", '#ffffff', '#3370ff', fs=17, bold=True)
box(ax, 1.4, 4.55, 2.3, 0.7, "需安装一次", '#eef1fe', '#3370ff', fs=12)

container(ax, 8.4, 4.2, 5.8, 4.2, '#eef4ff', '#3370ff')
ax.text(11.3, 8.0, "飞书表格（云端）", fontsize=18, color='#3370ff', fontweight='bold', ha='center')

box(ax, 9.0, 5.4, 4.6, 1.7, "存对账数据\n\n任务 · 金额 · 单据附件", '#ffffff', '#3370ff', fs=15)
box(ax, 9.0, 4.55, 2.3, 0.7, "飞书官方托管", '#eef4ff', '#3370ff', fs=12)

arrow(ax, 6.8, 6.4, 8.4, 6.4, color='#3370ff', lw=5)
ax.text(7.6, 6.65, "数据存入", fontsize=14, color='#3370ff', fontweight='bold', ha='center')

box(ax, 1.4, 1.7, 12.2, 1.6,
    "团队可见：所有对账结果，团队在飞书表格里都能看、都能改",
    '#fff7e6', '#d69e2e', fs=16, bold=True)
ax.text(7.5, 0.9, "多台电脑各自发起对账：每台电脑装一套系统即可", fontsize=13, color='#888888', ha='center')

plt.tight_layout()
plt.savefig('docs/customer_plan_feishu.png', dpi=200, bbox_inches='tight', facecolor='#f8faff')
plt.close()
print("OK: customer_plan_feishu.png")

# ============================================================
# 图3：服务器方案
# ============================================================
fig, ax = plt.subplots(figsize=(15, 10))
ax.set_xlim(0, 15)
ax.set_ylim(0, 10)
ax.axis('off')
ax.set_facecolor('#faf7ff')

ax.text(7.5, 9.4, "方案三：服务器方案", fontsize=24, color='#6b21a8', fontweight='bold', ha='center')
ax.text(7.5, 8.9, "系统部署在云端，任何电脑打开浏览器就能用", fontsize=14, color='#666666', ha='center')

# 左侧：团队电脑（多台）
container(ax, 0.6, 3.8, 6.4, 4.6, '#f3e8ff', '#6b21a8')
ax.text(3.8, 7.9, "团队电脑（浏览器）", fontsize=17, color='#6b21a8', fontweight='bold', ha='center')

box(ax, 1.0, 5.6, 2.6, 1.6, "同事 A", '#ffffff', '#6b21a8', fs=18, bold=True)
box(ax, 3.9, 5.6, 2.6, 1.6, "同事 B", '#ffffff', '#6b21a8', fs=18, bold=True)
box(ax, 2.45, 4.1, 2.6, 1.2, "同事 C…", '#ffffff', '#6b21a8', fs=15)
ax.text(3.8, 3.3, "无需安装任何软件", fontsize=13, color='#6b21a8', ha='center')

# 中间：互联网
box(ax, 6.9, 5.3, 1.9, 1.3, "互联网\nHTTPS", '#e8f4fd', '#2b6cb0', fs=13, bold=True)

# 右侧：云服务器
container(ax, 8.7, 3.8, 5.7, 4.6, '#e8f4fd', '#1565c0')
ax.text(11.55, 7.9, "云服务器", fontsize=18, color='#1565c0', fontweight='bold', ha='center')

box(ax, 9.2, 5.4, 4.6, 1.9, "对账系统 + 数据存储\n\n7×24 小时在线", '#ffffff', '#1565c0', fs=16, bold=True)
box(ax, 9.2, 4.2, 2.6, 0.8, "集中备份管理", '#e8f4fd', '#1565c0', fs=12)

# 箭头
arrow(ax, 5.0, 6.3, 6.9, 6.0, color='#2b6cb0', lw=4)
arrow(ax, 8.8, 6.0, 10.0, 6.4, color='#1565c0', lw=4)

box(ax, 1.4, 1.7, 12.2, 1.6,
    "最省心：任何人、任何电脑，打开浏览器就能发起对账",
    '#fff7e6', '#d69e2e', fs=16, bold=True)
ax.text(7.5, 0.9, "需要一台云服务器（费用按配置核算），需专人维护备份", fontsize=13, color='#888888', ha='center')

plt.tight_layout()
plt.savefig('docs/customer_plan_server.png', dpi=200, bbox_inches='tight', facecolor='#faf7ff')
plt.close()
print("OK: customer_plan_server.png")
