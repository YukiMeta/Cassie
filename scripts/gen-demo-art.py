#!/usr/bin/env python3
"""NOCTURNE 演示素材 · 插画风图层渲染（PIL）

三幕（每帧可被明确描述）：
1. 巴黎夜景：深蓝紫渐变夜空、月亮星点、埃菲尔铁塔剪影、暖色亮窗、路灯光晕
2. 人物 Mia：夜景街道上，剪影从左侧走进、双腿交替、停住
3. 香水瓶：棚拍聚光下的紫玻璃瓶（金盖、高光、标签 NOCTURNE）

输出分层 PNG → apps/web/public/demo/art/，由 gen-demo-media.sh 用 ffmpeg 组装。
"""
from __future__ import annotations

import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1080, 1920
OUT = "apps/web/public/demo/art"
FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
rng = random.Random(7)  # 固定种子：可复现

os.makedirs(OUT, exist_ok=True)


def vgrad(size, top, bottom, stops=None):
    """垂直线性渐变。stops: [(位置0-1, (r,g,b,a)), ...]"""
    w, h = size
    stops = stops or [(0, top), (1, bottom)]
    img = Image.new("RGBA", size)
    px = img.load()
    for y in range(h):
        t = y / (h - 1)
        # 找区间
        c0, c1 = stops[0], stops[-1]
        for i in range(len(stops) - 1):
            if stops[i][0] <= t <= stops[i + 1][0]:
                c0, c1 = stops[i], stops[i + 1]
                break
        f = 0 if c0[0] == c1[0] else (t - c0[0]) / (c1[0] - c0[0])
        color = tuple(int(c0[1][j] + (c1[1][j] - c0[1][j]) * f) for j in range(4))
        for x in range(w):
            px[x, y] = color
    return img


def rgrad(size, center, radius, color, peak_alpha=255):
    """径向渐变光晕（中心 → 透明）。"""
    w, h = size
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for r in range(radius, 0, -2):
        a = int(peak_alpha * (1 - r / radius) ** 1.7)
        if a <= 0:
            continue
        draw.ellipse([center[0] - r, center[1] - r, center[0] + r, center[1] + r],
                     fill=(*color, a))
    return img


def blur(img, radius):
    return img.filter(ImageFilter.GaussianBlur(radius))


def save(img, name):
    img.save(f"{OUT}/{name}.png")
    print(f"  ✓ {name}.png")


def starfield(n=70):
    stars = Image.new("RGBA", (W, int(H * 0.6)), (0, 0, 0, 0))
    d = ImageDraw.Draw(stars)
    for _ in range(n):
        x = rng.randint(0, W - 1)
        y = rng.randint(0, int(H * 0.55))
        r = rng.choice([1, 1, 1, 2])
        a = rng.randint(90, 220)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 246, 224, a))
    return stars


def eiffel(draw, cx, base_y, height, color=(16, 18, 34, 255)):
    """埃菲尔铁塔剪影（多边形层叠 + 横梁）。"""
    top_w = height * 0.05
    base_w = height * 0.42
    # 塔身：分段梯形
    segs = [(0.0, 1.0), (0.3, 0.86), (0.62, 0.62), (0.9, 0.4)]
    for i in range(len(segs) - 1):
        y0 = base_y - height * segs[i][0]
        y1 = base_y - height * segs[i + 1][0]
        k0 = 1 - (1 - segs[i][1]) * 0.5
        k1 = 1 - (1 - segs[i + 1][1]) * 0.5
        w0, w1 = base_w * k0, base_w * k1
        draw.polygon([(cx - w0 / 2, y0), (cx + w0 / 2, y0), (cx + w1 / 2, y1), (cx - w1 / 2, y1)], fill=color)
    # 天线
    draw.line([(cx, base_y - height), (cx, base_y - height * 1.12)], fill=color, width=6)
    # 观景台横梁
    for yf in (0.62, 0.86):
        y = base_y - height * yf
        k = 1 - (1 - (segs[2][1] if yf == 0.62 else segs[1][1])) * 0.5
        w_ = base_w * k
        draw.line([(cx - w_ / 2 - 14, y), (cx + w_ / 2 + 14, y)], fill=color, width=8)
    # 拱脚
    draw.arc([cx - base_w / 2, base_y - height * 0.14, cx + base_w / 2, base_y + height * 0.14],
             start=180, end=360, fill=color, width=14)


def building_row(draw, base_y, color, heights, window_chance, seed_windows, seed_off):
    """一排建筑剪影 + 随机亮窗。返回 (亮窗坐标列表)。"""
    lit = []
    x = -20
    for h in heights:
        bw = rng.randint(90, 160)
        bh = rng.randint(*h)
        draw.rectangle([x, base_y - bh, x + bw, base_y], fill=color)
        for wy in range(base_y - bh + 18, base_y - 14, 46):
            for wx in range(x + 14, x + bw - 20, 42):
                if rng.random() < window_chance:
                    c = (255, 190, 110, rng.randint(120, 230))
                    lit.append((wx, wy, c))
        x += bw + rng.randint(4, 16)
    return lit


def windows_layer(lit_coords):
    """把亮窗画成独立图层（可替换/闪烁）。"""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for (x, y, c) in lit_coords:
        d.rectangle([x, y, x + 16, y + 22], fill=c)
    return blur(img, 1.2)


# ================= 1. 巴黎夜景 =================

def scene_night():
    print("scene: night")
    # 天空
    sky = vgrad((W, H), (10, 14, 36, 255), (36, 26, 69, 255),
                stops=[(0, (8, 10, 28, 255)), (0.55, (18, 20, 48, 255)), (0.8, (38, 28, 74, 255))])
    sky.alpha_composite(starfield())
    # 月亮 + 光晕
    moon_glow = blur(rgrad((W, W), (W * 0.76, H * 0.16), 240, (255, 240, 200), 90), 40)
    sky.alpha_composite(moon_glow)
    d = ImageDraw.Draw(sky)
    d.ellipse([W * 0.76 - 52, H * 0.16 - 52, W * 0.76 + 52, H * 0.16 + 52], fill=(255, 246, 220, 255))
    # 埃菲尔铁塔（远景，居中偏右）
    eiffel(d, W * 0.55, int(H * 0.68), int(H * 0.5), color=(14, 16, 36, 255))
    # 远景建筑带
    lit_far = building_row(d, int(H * 0.72), (20, 22, 44, 255),
                           [(60, 130)] * 9, 0.25, 0, 0)
    # 塞纳河面：暗带 + 暖色反光
    d.rectangle([0, int(H * 0.72), W, int(H * 0.86)], fill=(10, 12, 28, 255))
    for i in range(14):
        x = rng.randint(20, W - 80)
        w = rng.randint(40, 120)
        alpha = rng.randint(14, 40)
        d.rectangle([x, int(H * 0.73), x + w, int(H * 0.86)], fill=(255, 170, 90, alpha))
    # 前景街道
    d.rectangle([0, int(H * 0.86), W, H], fill=(12, 10, 24, 255))
    # 前景建筑 + 亮窗（两种闪烁变体）
    base_y = int(H * 0.86)
    lit_a = building_row(d, base_y, (8, 8, 18, 255), [(120, 300), (90, 260), (140, 320)] * 3, 0.5, 0, 0)
    save(sky, "night_bg")
    save(windows_layer(lit_a), "night_windows_a")
    # 变体 B：重新采样一部分窗
    lit_b = [(x, y, c) if rng.random() > 0.45 else (x, y, (255, 190, 110, rng.randint(120, 230))) for (x, y, c) in lit_a]
    save(windows_layer(lit_b), "night_windows_b")
    # 路灯光晕（左右两盏）
    lamps = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for lx, ly, r in [(W * 0.22, H * 0.84, 260), (W * 0.8, H * 0.84, 220)]:
        lamps.alpha_composite(blur(rgrad((W, H), (lx, ly), r, (255, 180, 90), 130), 30))
    # 灯杆
    dd = ImageDraw.Draw(lamps)
    for lx, ly in [(W * 0.22, H * 0.84), (W * 0.8, H * 0.84)]:
        dd.line([(lx, ly), (lx, H)], fill=(8, 8, 16, 255), width=10)
        dd.ellipse([lx - 16, ly - 18, lx + 16, ly + 14], fill=(255, 190, 110, 240))
    save(lamps, "night_lamps")
    # 薄雾层（缓慢漂移）
    fog = blur(vgrad((W * 2, 300), (255, 255, 255, 26), (255, 255, 255, 0)), 60)
    save(fog, "night_fog")


# ================= 2. 人物 Mia =================

def mia_figure(leg_phase):
    """Mia 剪影：大衣、盘发、挎包，双腿两种摆动相位。返回 RGBA 图层（约 420×900）。"""
    fw, fh = 420, 900
    img = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    coat = (22, 22, 38, 255)
    rim = (255, 190, 120, 90)  # 暖色轮廓光
    cx = fw / 2
    # 大衣（含头肩）
    d.polygon([
        (cx - 60, 210), (cx + 60, 210), (cx + 92, 320), (cx + 58, 700),
        (cx + 46, 880), (cx - 46, 880), (cx - 58, 700), (cx - 92, 320),
    ], fill=coat)
    # 头部 + 盘发
    d.ellipse([cx - 52, 120, cx + 52, 236], fill=(36, 32, 48, 255))
    d.ellipse([cx - 42, 96, cx + 42, 150], fill=(28, 26, 40, 255))
    d.ellipse([cx - 46, 92, cx + 46, 138], fill=(20, 18, 30, 255))
    # 面部略亮
    d.ellipse([cx - 34, 148, cx + 34, 222], fill=(62, 56, 74, 255))
    # 领口/腰带
    d.line([(cx - 26, 330), (cx + 26, 330)], fill=(16, 15, 26, 255), width=8)
    # 挎包
    d.rounded_rectangle([cx + 30, 420, cx + 96, 540], radius=12, fill=(16, 15, 26, 255))
    d.line([(cx + 52, 420), (cx + 46, 372)], fill=(16, 15, 26, 255), width=6)
    # 腿（两种相位）
    if leg_phase == 0:
        d.line([(cx - 14, 700), (cx - 44, 880)], fill=coat, width=44)
        d.line([(cx + 16, 700), (cx + 58, 880)], fill=coat, width=44)
    else:
        d.line([(cx - 14, 700), (cx - 58, 880)], fill=coat, width=44)
        d.line([(cx + 16, 700), (cx + 42, 880)], fill=coat, width=44)
    # 鞋
    d.ellipse([cx - 64, 866, cx - 24, 892], fill=(12, 11, 20, 255))
    d.ellipse([cx + 26, 866, cx + 72, 892], fill=(12, 11, 20, 255))
    # 右缘暖色轮廓光
    d.line([(cx + 60, 214), (cx + 88, 330), (cx + 55, 690)], fill=rim, width=5)
    d.line([(cx + 34, 152), (cx + 50, 224)], fill=rim, width=4)
    return img


def scene_mia():
    print("scene: mia")
    # 街道背景（独立色相：更深、暖灯地面光池）
    bg = vgrad((W, H), (8, 8, 20, 255), (24, 18, 40, 255),
               stops=[(0, (6, 6, 16, 255)), (0.6, (16, 14, 32, 255)), (1, (28, 22, 44, 255))])
    d = ImageDraw.Draw(bg)
    building_row(d, int(H * 0.72), (9, 9, 20, 255), [(140, 420), (100, 340), (160, 460)], 0.4, 0, 0)
    d.rectangle([0, int(H * 0.72), W, H], fill=(10, 9, 20, 255))
    # 地面光池（暖色椭圆渐变）
    pool = blur(rgrad((W, H), (W * 0.5, H * 0.86), 420, (255, 175, 90), 70), 50)
    bg.alpha_composite(pool)
    # 路灯
    d.line([(W * 0.5, H * 0.5), (W * 0.5, H)], fill=(10, 9, 20, 255), width=9)
    bg.alpha_composite(blur(rgrad((W, H), (W * 0.5, H * 0.52), 200, (255, 185, 100), 140), 26))
    d.ellipse([W * 0.5 - 14, H * 0.5 - 16, W * 0.5 + 14, H * 0.5 + 12], fill=(255, 195, 115, 255))
    save(bg, "mia_bg")
    save(mia_figure(0), "mia_a")
    save(mia_figure(1), "mia_b")


# ================= 3. 香水瓶 =================

def scene_bottle():
    print("scene: bottle")
    # 棚拍背景：顶部聚光 + 地面反光
    bg = vgrad((W, H), (16, 12, 26, 255), (10, 8, 18, 255))
    bg.alpha_composite(blur(rgrad((W, H), (W / 2, H * 0.1), 900, (140, 100, 220), 90), 80))
    d = ImageDraw.Draw(bg)
    d.rectangle([0, int(H * 0.82), W, H], fill=(12, 10, 20, 255))
    d.line([(0, int(H * 0.82)), (W, int(H * 0.82))], fill=(90, 70, 150, 255), width=4)
    # 地面反光条
    for i in range(9):
        x = W / 2 + (rng.random() - 0.5) * 500
        w = rng.randint(60, 200)
        d.rectangle([x, int(H * 0.84 + i * 26), x + w, int(H * 0.84 + i * 26 + 8)],
                    fill=(120, 95, 190, rng.randint(10, 40)))
    save(bg, "bottle_bg")

    # 瓶身（1024×1560 画布，居中 900 高）
    bw, bh = 1024, 1560
    bot = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    d = ImageDraw.Draw(bot)
    cx = bw / 2
    glass_top = (170, 130, 235, 235)
    glass_bot = (86, 60, 160, 245)
    body_w, body_h = 340, 760
    by = 520
    # 玻璃瓶身（线性渐变）
    body = vgrad((body_w, body_h), glass_top, glass_bot,
                 stops=[(0, (185, 145, 245, 240)), (0.25, (140, 105, 220, 245)), (1, (84, 58, 158, 250))])
    # 圆角瓶身 mask
    mask = Image.new("L", (body_w, body_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, body_w, body_h], radius=46, fill=255)
    body.putalpha(mask)
    bot.alpha_composite(body, (int(cx - body_w / 2), by))
    # 瓶肩（梯形）+ 瓶口
    d.polygon([(cx - 100, by + 40), (cx + 100, by + 40), (cx + 52, by - 40), (cx - 52, by - 40)], fill=(150, 118, 230, 245))
    d.rectangle([cx - 46, by - 150, cx + 46, by - 40], fill=(168, 138, 240, 250))
    d.rectangle([cx - 52, by - 176, cx + 52, by - 150], fill=(120, 92, 200, 255))
    # 金色瓶盖
    cap = vgrad((108, 96), (232, 200, 120, 255), (160, 120, 60, 255))
    bot.alpha_composite(cap, (int(cx - 54), by - 272))
    d.rounded_rectangle([cx - 54, by - 272, cx + 54, by - 176], radius=14, outline=(120, 88, 40, 255), width=4)
    # 液面 + 液体
    d.rounded_rectangle([cx - 132, by + 90, cx + 132, by + 660], radius=30, fill=(96, 66, 175, 120))
    # 高光条（左侧亮线 + 右侧窄光）
    hl = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.rounded_rectangle([cx - 128, by + 40, cx - 96, by + 700], radius=16, fill=(255, 255, 255, 120))
    hd.rounded_rectangle([cx - 84, by + 44, cx - 70, by + 696], radius=10, fill=(255, 255, 255, 46))
    hd.rounded_rectangle([cx + 96, by + 50, cx + 122, by + 680], radius=12, fill=(255, 255, 255, 60))
    bot.alpha_composite(blur(hl, 6))
    # 标签
    label = Image.new("RGBA", (300, 300), (245, 242, 250, 252))
    ld = ImageDraw.Draw(label)
    brand = ImageFont.truetype(FONT_PATH, 62)
    sub = ImageFont.truetype(FONT_PATH, 26)
    ld.text((150, 40), "NOCTURNE", font=brand, fill=(36, 26, 69, 255), anchor="ma")
    ld.line([(40, 130), (260, 130)], fill=(109, 75, 216, 255), width=3)
    ld.text((150, 170), "EAU DE NUIT", font=sub, fill=(109, 75, 216, 255), anchor="ma")
    ld.text((150, 230), "PARIS", font=sub, fill=(140, 120, 180, 255), anchor="ma")
    bot.alpha_composite(label, (int(cx - 150), by + 250))
    # 底部阴影
    bot.alpha_composite(blur(rgrad((bw, bh), (cx, by + 780), 260, (0, 0, 0), 150), 26), (0, 0))
    save(bot, "bottle")

    # 呼吸光晕（两种强度，交替产生脉冲）
    for i, peak in enumerate([90, 140]):
        glow = blur(rgrad((W, H), (W / 2, H * 0.52), 520, (150, 110, 235), peak), 60)
        save(glow, f"bottle_glow_{i}")


if __name__ == "__main__":
    scene_night()
    scene_mia()
    scene_bottle()
    print("art layers done →", OUT)
