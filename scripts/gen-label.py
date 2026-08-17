#!/usr/bin/env python3
"""渲染 NOCTURNE 香水标签 PNG（透明底），供 gen-demo-media.sh 叠加到瓶身。"""
from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
W, H = 640, 500
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

brand = ImageFont.truetype(FONT, 148)
sub = ImageFont.truetype(FONT, 56)

# NOCTURNE（深紫）
bbox = draw.textbbox((0, 0), "NOCTURNE", font=brand)
w = bbox[2] - bbox[0]
A = 240  # 整体透明度 0.94
draw.text(((W - w) / 2 - bbox[0], 30), "NOCTURNE", font=brand, fill=(36, 26, 69, A))

# EAU DE NUIT（紫灰）
bbox2 = draw.textbbox((0, 0), "EAU DE NUIT", font=sub)
w2 = bbox2[2] - bbox2[0]
draw.text(((W - w2) / 2 - bbox2[0], 280), "EAU DE NUIT", font=sub, fill=(150, 120, 200, A))

# 装饰线
draw.rectangle([90, 260, W - 90, 264], fill=(109, 75, 216, 180))

out = "apps/web/public/demo/label.png"
img.save(out)
print(f"✓ {out}")
