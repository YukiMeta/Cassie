#!/usr/bin/env bash
# 生成 Cassie 演示素材（NOCTURNE 香水广告）
# 图层由 gen-demo-art.py（PIL 插画风）渲染，本脚本用 ffmpeg 组装动画。
# 注意：本机 ffmpeg 8.1.2 精简版——滤镜表达式里的逗号必须转义；
# -loop 1 PNG 叠加需 shortest=1 + -t 防 EOF 死锁。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=apps/web/public/demo
ART=$OUT/art
mkdir -p "$OUT" "$ART"
FPS=30

python3 scripts/gen-demo-art.py

# 1. 巴黎夜景：星空铁塔 + 亮窗闪烁 + 路灯光晕 + 漂雾（15s）
ffmpeg -y \
  -loop 1 -t 15 -i "$ART/night_bg.png" \
  -loop 1 -t 15 -i "$ART/night_windows_a.png" \
  -loop 1 -t 15 -i "$ART/night_windows_b.png" \
  -loop 1 -t 15 -i "$ART/night_lamps.png" \
  -loop 1 -t 15 -i "$ART/night_fog.png" \
  -filter_complex "[0:v][1:v]overlay=0:0:enable='lt(mod(t\,1.4)\,0.7)'[a];[a][2:v]overlay=0:0:enable='gte(mod(t\,1.4)\,0.7)'[b];[b][3:v]overlay=0:0[c];[4:v]format=rgba[fog];[c][fog]overlay=x='-300+40*t':y=main_h-340:shortest=1" \
  -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p "$OUT/night.mp4" -loglevel error

# 2. 人物 Mia：街道剪影从左走进，双腿交替，停住（12s）
ffmpeg -y \
  -loop 1 -t 12 -i "$ART/mia_bg.png" \
  -loop 1 -t 12 -i "$ART/mia_a.png" \
  -loop 1 -t 12 -i "$ART/mia_b.png" \
  -filter_complex "[1:v]format=rgba[a1];[2:v]format=rgba[a2];[0:v][a1]overlay=x='min(-480+150*t\,330)':y='820+4*sin(2*PI*t*1.8)':enable='lt(mod(t\,1.1)\,0.55)'[b];[b][a2]overlay=x='min(-480+150*t\,330)':y='820+4*sin(2*PI*t*1.8)':enable='gte(mod(t\,1.1)\,0.55)':shortest=1" \
  -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p "$OUT/mia.mp4" -loglevel error

# 3. 香水瓶：棚拍聚光 + 呼吸光晕 + 微缩放（15s）
ffmpeg -y \
  -loop 1 -t 15 -i "$ART/bottle_bg.png" \
  -loop 1 -t 15 -i "$ART/bottle_glow_0.png" \
  -loop 1 -t 15 -i "$ART/bottle_glow_1.png" \
  -loop 1 -t 15 -i "$ART/bottle.png" \
  -filter_complex "[0:v][1:v]overlay=0:0:enable='lt(mod(t\,3)\,1.5)'[b];[b][2:v]overlay=0:0:enable='gte(mod(t\,3)\,1.5)'[b2];[3:v]scale=w='840*(1+0.02*sin(2*PI*t/15))':h=-2:eval=frame,format=rgba[bot];[b2][bot]overlay=x=(W-w)/2:y=430:shortest=1" \
  -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p "$OUT/bottle.mp4" -loglevel error

# 4. 配乐：双正弦 + 慢颤音，深夜电子氛围
ffmpeg -y -f lavfi -i "sine=frequency=110:duration=15" \
  -f lavfi -i "sine=frequency=164.81:duration=15" \
  -filter_complex "[0:a]volume=0.32[a0];[1:a]volume=0.2,tremolo=f=0.4:d=0.6[a1];[a0][a1]amix=inputs=2,afade=t=in:d=1.2,afade=t=out:st=13.5:d=1.5" \
  -c:a libmp3lame -q:a 4 "$OUT/music.mp3" -loglevel error

# 5. 片段缩略图（时间线质感）
mkdir -p "$OUT/thumbs"
for f in night mia bottle; do
  ffmpeg -y -ss 6 -i "$OUT/$f.mp4" -frames:v 1 -vf scale=180:-1 -q:v 4 "$OUT/thumbs/$f.jpg" -loglevel error
done

echo "✓ demo media → $OUT"
ls -la "$OUT"/*.mp4 "$OUT"/*.mp3 "$OUT/thumbs/"
