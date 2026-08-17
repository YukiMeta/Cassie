#!/usr/bin/env python3
"""渲染瓶身紫光晕 PNG（静态径向渐变），替代逐帧 geq，编码速度提升两个数量级。"""
from PIL import Image, ImageDraw

W, H = 1080, 1920
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

cx, cy = W / 2, H / 2
R = 620
# 径向渐变：中心紫色 → 透明
for r in range(R, 0, -4):
    a = int(46 * (1 - r / R) ** 1.6)
    if a <= 0:
        continue
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(109, 75, 216, a))

out = "apps/web/public/demo/glow.png"
img.save(out)
print(f"✓ {out}")
