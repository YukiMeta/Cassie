#!/usr/bin/env bash
# Local fallback for "find a subject by name" when no SAM 3 service is running.
# Creates .cassie-cache/detect-venv (reusing a system torch if present) and caches the OWLv2 weights.
set -euo pipefail
cd "$(dirname "$0")/.."
venv=.cassie-cache/detect-venv
python3 -m venv --system-site-packages "$venv"
"$venv/bin/python" -m pip install -q --upgrade pip
"$venv/bin/python" -c "import torch" 2>/dev/null || "$venv/bin/python" -m pip install -q torch
"$venv/bin/python" -m pip install -q "transformers>=4.44,<5" pillow
"$venv/bin/python" - <<'PY'
from transformers import Owlv2ForObjectDetection, Owlv2Processor
m = "google/owlv2-base-patch16-ensemble"
Owlv2Processor.from_pretrained(m); Owlv2ForObjectDetection.from_pretrained(m)
print("OWLv2 ready")
PY
