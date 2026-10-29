"""Open-vocabulary object detection on one video frame (OWLv2, on-device).

usage: detect.py input.mp4 frame [query,query,...]
Prints {"objects":[{"label","box":[x,y,w,h],"score"}]} with boxes in source pixels, top-left origin.
Without queries a general vocabulary of everyday objects is used.
"""
import json
import subprocess
import sys

import torch
from PIL import Image
from transformers import Owlv2ForObjectDetection, Owlv2Processor

VOCABULARY = [
    "person", "face", "hand", "bottle", "skincare bottle", "cosmetic jar", "lipstick", "perfume", "cup", "mug", "glass",
    "laptop", "keyboard", "computer mouse", "monitor", "phone", "tablet", "headphones", "vr headset", "watch", "camera",
    "desk", "table", "chair", "sofa", "bed", "lamp", "plant", "vase", "book", "notebook", "pen", "pencil holder",
    "banana", "apple", "bowl", "plate", "box", "bag", "backpack", "shoe", "hat", "glasses", "earring", "necklace",
    "car", "bicycle", "spaceship", "dog", "cat", "bird", "tree", "window", "door", "picture frame", "clock", "pillow",
]


def frame(path: str, index: int) -> Image.Image:
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path]))
    w, h = probe["streams"][0]["width"], probe["streams"][0]["height"]
    raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", path, "-vf", f"select=eq(n\\,{index})", "-vsync", "0", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
    if len(raw) != w * h * 3:
        raise SystemExit(f"frame {index} not found")
    return Image.frombytes("RGB", (w, h), raw)


def iou(a, b):
    ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9)


def main():
    path, index = sys.argv[1], int(sys.argv[2])
    queries = [q.strip() for q in sys.argv[3].split(",") if q.strip()] if len(sys.argv) > 3 else VOCABULARY
    image = frame(path, index)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    name = "google/owlv2-base-patch16-ensemble"
    processor, model = Owlv2Processor.from_pretrained(name), Owlv2ForObjectDetection.from_pretrained(name).to(device).eval()
    inputs = processor(text=[queries], images=image, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs = model(**inputs)
    # OWLv2 pads to a square; post-process against the padded size, then clip to the real frame.
    side = max(image.size)
    result = processor.post_process_object_detection(outputs, threshold=0.12 if len(sys.argv) <= 3 else 0.05, target_sizes=torch.tensor([[side, side]]))[0]
    found = []
    for score, label, box in sorted(zip(result["scores"].tolist(), result["labels"].tolist(), result["boxes"].tolist()), reverse=True):
        x0, y0 = max(0.0, box[0]), max(0.0, box[1])
        x1, y1 = min(float(image.width), box[2]), min(float(image.height), box[3])
        b = [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)]
        if b[2] < 12 or b[3] < 12 or any(iou(b, f["box"]) > 0.7 for f in found):
            continue
        found.append({"label": queries[label], "box": b, "score": round(score, 3)})
    print(json.dumps({"frame": index, "width": image.width, "height": image.height, "objects": found[:24], "backend": name}))


if __name__ == "__main__":
    main()
