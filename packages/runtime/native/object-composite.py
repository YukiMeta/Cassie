"""Replace one object inside its box, leaving every pixel outside the object untouched.

usage: object-composite.py source.mp4 candidate.mp4 output.mp4 job.json
job: {start, frames, fps, srcBoxes, candBoxes, scale, feather}
Boxes are [x,y,w,h] per frame in each video's pixels. SAM (box prompt) cuts the old and new object;
the new object is moved and scaled onto the old box, then blended with a feathered mask of both shapes.
"""
import json
import subprocess
import sys

import numpy as np
import torch
from PIL import Image, ImageFilter
from transformers import SamModel, SamProcessor


def probe(path):
    s = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path]))["streams"][0]
    return s["width"], s["height"]


def frames(path, start, count):
    w, h = probe(path)
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", f"select=gte(n\\,{start})", "-vsync", "0", "-frames:v", str(count), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    for _ in range(count):
        raw = p.stdout.read(w * h * 3)
        if len(raw) < w * h * 3:
            break
        yield np.frombuffer(raw, np.uint8).reshape(h, w, 3)
    p.stdout.close()
    p.wait()


def main():
    src, cand, out, job = sys.argv[1], sys.argv[2], sys.argv[3], json.load(open(sys.argv[4]))
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = SamModel.from_pretrained("facebook/sam-vit-base").to(dev).eval()
    proc = SamProcessor.from_pretrained("facebook/sam-vit-base")

    def mask(img, box):
        x, y, w, h = map(float, box)
        inp = proc(Image.fromarray(img), input_boxes=[[[x, y, x + w, y + h]]], return_tensors="pt")
        feed = {k: v.to(dev, torch.float32) if v.is_floating_point() else v.to(dev) for k, v in inp.items() if k in ("pixel_values", "input_boxes")}
        with torch.no_grad():
            o = model(**feed, multimask_output=True)
        m = proc.image_processor.post_process_masks(o.pred_masks.cpu(), inp["original_sizes"].cpu(), inp["reshaped_input_sizes"].cpu())[0][0]
        best = int(o.iou_scores[0, 0].argmax())
        return m[best].numpy().astype(np.float32)

    w, h = probe(src)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(job["fps"]), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", out], stdin=subprocess.PIPE)
    cands = list(frames(cand, 0, job["frames"]))
    n = 0
    for i, s in enumerate(frames(src, job["start"], job["frames"])):
        sb, cb = job["srcBoxes"][i], job["candBoxes"][min(i, len(job["candBoxes"]) - 1)]
        c = cands[min(i, len(cands) - 1)]
        if not sb or not cb:
            enc.stdin.write(s.tobytes())
            continue
        k = job["scale"]
        cm = mask(c, cb)
        cimg = Image.fromarray(c).resize((round(c.shape[1] * k), round(c.shape[0] * k)), Image.LANCZOS)
        cmi = Image.fromarray((cm * 255).astype(np.uint8)).resize(cimg.size, Image.BILINEAR)
        dx = round(sb[0] + sb[2] / 2 - (cb[0] + cb[2] / 2) * k)
        dy = round(sb[1] + sb[3] / 2 - (cb[1] + cb[3] / 2) * k)
        layer, lm = Image.new("RGB", (w, h)), Image.new("L", (w, h))
        layer.paste(cimg, (dx, dy))
        lm.paste(cmi, (dx, dy))
        new = np.asarray(lm, np.float32) / 255
        x0, y0 = max(0, int(sb[0] - 40)), max(0, int(sb[1] - 40))
        x1, y1 = min(w, int(sb[0] + sb[2] + 40)), min(h, int(sb[1] + sb[3] + 40))
        clip = np.zeros((h, w), np.float32)
        clip[y0:y1, x0:x1] = 1
        m = new * clip
        m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(job.get("feather", 3))), np.float32)[..., None] / 255
        o = s.astype(np.float32) * (1 - m) + np.asarray(layer, np.float32) * m
        enc.stdin.write(o.clip(0, 255).astype(np.uint8).tobytes())
        n += 1
    enc.stdin.close()
    enc.wait()
    print(json.dumps({"composited": n, "backend": "sam-vit-base"}))


if __name__ == "__main__":
    main()
