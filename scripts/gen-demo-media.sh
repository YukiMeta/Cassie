#!/usr/bin/env bash
# 生成 Cassie 演示素材（NOCTURNE 香水广告：夜景 / 人物 / 香水瓶 / 配乐）
# 输出到 apps/web/public/demo/，提交脚本不提交产物。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=apps/web/public/demo
mkdir -p "$OUT"
FONT="/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
FPS=30

# 1. 夜景：深蓝渐变 + 移动暖光路灯 + 地面反光
ffmpeg -y -f lavfi -i "color=c=#0a0e1a:s=1080x1920:r=${FPS}:d=15" \
  -vf "geq=r='r(X,Y)+40*(1-Y/1920)+10*sin(2*PI*T/15)':g='g(X,Y)+28*(1-Y/1920)+6*sin(2*PI*T/15)':b='b(X,Y)+58*(1-Y/1920)+14*sin(2*PI*T/15)',
drawbox=x='iw*0.25+260*sin(2*PI*t/15)':y='ih*0.52':w=36:h=150:color=#ffb84d@0.85:t=fill,
drawbox=x='iw*0.62-260*sin(2*PI*t/15)':y='ih*0.58':w=36:h=150:color=#ffb84d@0.7:t=fill,
drawbox=x='iw*0.82':y='ih*0.66':w=28:h=120:color=#ffb84d@0.55:t=fill,
drawbox=x=0:y='ih*0.78':w=iw:h='ih*0.22':color=#101530@0.9:t=fill,
drawbox=x=0:y='ih*0.80':w=iw:h=6:color=#ffb84d@0.25:t=fill" \
  -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p "$OUT/night.mp4" -loglevel error

# 2. 人物剪影：从左侧走进，停下（0-10s 内容）
ffmpeg -y -f lavfi -i "color=c=#06070f:s=1080x1920:r=${FPS}:d=12" \
  -vf "geq=r='r(X,Y)+6*(1-Y/1920)':g='g(X,Y)+4*(1-Y/1920)':b='b(X,Y)+10*(1-Y/1920)',
drawbox=x='iw*0.28+iw*0.34*min(t/6,1)-48':y='ih*0.30-52':w=96:h=104:color=#0b0d18:t=fill,
drawbox=x='iw*0.28+iw*0.34*min(t/6,1)-52':y='ih*0.30+50':w=104:h=430:color=#0b0d18:t=fill,
drawbox=x='iw*0.28+iw*0.34*min(t/6,1)-58':y='ih*0.30+250':w=20:h=190:color=#0b0d18:t=fill,
drawbox=x='iw*0.28+iw*0.34*min(t/6,1)+42':y='ih*0.30+250':w=20:h=190:color=#0b0d18:t=fill,
drawbox=x='iw*0.28+iw*0.34*min(t/6,1)-30':y='ih*0.30+52':w=60:h=110:color=#ffd9a0@0.18:t=fill" \
  -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p "$OUT/mia.mp4" -loglevel error

# 3. 香水瓶：紫玻璃瓶身 + NOCTURNE 标签 + 光晕（全部 PNG 叠加，无逐帧 geq）
python3 "$(dirname "$0")/gen-label.py"
python3 "$(dirname "$0")/gen-glow.py"
ffmpeg -y -f lavfi -i "color=c=#0d0a16:s=1080x1920:r=${FPS}:d=15" -loop 1 -i "$OUT/glow.png" -loop 1 -i "$OUT/label.png" \
  -filter_complex "[0:v]
drawbox=x='iw*0.5-26':y='ih*0.24':w=52:h=46:color=#d8c6ff:t=fill,
drawbox=x='iw*0.5-24':y='ih*0.29':w=48:h=14:color=#2a1f4d:t=fill,
drawbox=x='iw*0.5-190':y='ih*0.31':w=380:h=760:color=#6d4bd8@0.92:t=fill,
drawbox=x='iw*0.5-190':y='ih*0.31':w=380:h=760:color=#e8dcff@0.16:t=fill,
drawbox=x='iw*0.5-160':y='ih*0.72':w=320:h=250:color=#f5f0ff@0.96:t=fill,
drawbox=x='iw*0.5-160':y='ih*0.98':w=320:h=90:color=#0d0a16:t=fill[base];
[1:v]format=rgba[glow];
[base][glow]overlay=0:0[b1];
[2:v]scale=560:440,format=rgba[label];
[b1][label]overlay=x=(W-w)/2:y=main_h*0.68" \
  -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p "$OUT/bottle.mp4" -loglevel error

# 4. 配乐：双正弦 + 慢颤音，深夜电子氛围
ffmpeg -y -f lavfi -i "sine=frequency=110:duration=15" \
  -f lavfi -i "sine=frequency=164.81:duration=15" \
  -filter_complex "[0:a]volume=0.32[a0];[1:a]volume=0.2,tremolo=f=0.4:d=0.6[a1];[a0][a1]amix=inputs=2,afade=t=in:d=1.2,afade=t=out:st=13.5:d=1.5" \
  -c:a libmp3lame -q:a 4 "$OUT/music.mp3" -loglevel error

echo "✓ demo media → $OUT"
ls -la "$OUT"
