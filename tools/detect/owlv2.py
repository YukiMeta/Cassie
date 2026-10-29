"""Open-vocabulary detector for Cassie concept tracking.

Usage: owlv2.py request.json
Request:  {"prompt": "phone", "frames": ["/abs/frame-0.png", ...], "threshold": 0.15}
Stdout:   {"backend": "...", "detections": [[{"box": [x, y, w, h], "score": s, "label": "phone"}, ...] per frame]}

Boxes are in the pixels of each input frame, best first. Runs offline from the local model cache.
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")

import torch
from PIL import Image
from transformers import Owlv2ForObjectDetection, Owlv2Processor

MODEL = "google/owlv2-base-patch16-ensemble"


def main() -> None:
    request = json.load(open(sys.argv[1]))
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    processor = Owlv2Processor.from_pretrained(MODEL, local_files_only=True)
    model = Owlv2ForObjectDetection.from_pretrained(MODEL, local_files_only=True).to(device).eval()
    prompts = [p.strip() for p in str(request["prompt"]).split(",") if p.strip()]
    threshold = float(request.get("threshold", 0.15))
    out = []
    for path in request["frames"]:
        image = Image.open(path).convert("RGB")
        inputs = processor(text=[[f"a photo of a {p}" for p in prompts]], images=image, return_tensors="pt").to(device)
        with torch.no_grad():
            result = model(**inputs)
        # OWLv2 pads to a square; boxes come back relative to the padded side.
        side = max(image.size)
        found = processor.post_process_object_detection(result, threshold=threshold, target_sizes=torch.tensor([[side, side]]))[0]
        dets = []
        for score, box, label in zip(found["scores"].tolist(), found["boxes"].tolist(), found["labels"].tolist()):
            x0, y0 = max(0.0, box[0]), max(0.0, box[1])
            x1, y1 = min(float(image.width), box[2]), min(float(image.height), box[3])
            if x1 - x0 > 2 and y1 - y0 > 2:
                dets.append({"box": [round(x0), round(y0), round(x1 - x0), round(y1 - y0)], "score": round(score, 4), "label": prompts[label]})
        out.append(sorted(dets, key=lambda d: -d["score"]))
    json.dump({"backend": f"owlv2/{MODEL.split('/')[-1]}", "detections": out}, sys.stdout)


if __name__ == "__main__":
    main()
