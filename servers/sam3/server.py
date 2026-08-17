#!/usr/bin/env python3
"""
Cassie SAM 3 提取服务

封装 facebookresearch/sam3 的视频推理，对外提供 /extract 契约：

POST /extract (multipart/form-data)
  file:    视频文件（mp4）
  prompts: JSON 字符串，概念列表，如 ["perfume bottle", "person"]
→ 200 {
    "candidates": [
      {
        "concept": "perfume bottle",
        "tracks": [
          {
            "track_id": 0,
            "score": 0.93,
            "startUs": 4000000, "endUs": 15000000,
            "boxes": [ {"t": 4000000, "box": [x1,y1,x2,y2]}, ... ]
          }
        ]
      }
    ]
  }

GET /health → {"ok": true, "model": "sam3", "loaded": true}

启动（需先按 README 安装依赖并申请/下载 SAM 3 权重）：
  uvicorn server:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from typing import Any

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from pydantic import BaseModel

app = FastAPI(title="Cassie SAM3 Service")

_predictor = None
_predictor_lock = threading.Lock()


def get_predictor():
    """懒加载 SAM 3 视频预测器（权重加载很重，只加载一次）。"""
    global _predictor
    if _predictor is None:
        with _predictor_lock:
            if _predictor is None:
                from sam3.model_builder import build_sam3_video_predictor

                _predictor = build_sam3_video_predictor()
    return _predictor


class HealthResponse(BaseModel):
    ok: bool
    model: str
    loaded: bool


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True, model="sam3", loaded=_predictor is not None)


def _to_us(seconds: float) -> int:
    return int(round(seconds * 1_000_000))


def _extract_outputs(outputs: dict[str, Any], fps: float) -> list[dict[str, Any]]:
    """把单帧 outputs 归一化为 boxes 列表。

    SAM 3 的 outputs 结构可能随版本变化，这里做防御性解析：
    - outputs["masks"] / ["boxes"] / ["scores"] 数组
    - 或 masklet 格式（按 obj_id 组织）
    """
    boxes = outputs.get("boxes")
    scores = outputs.get("scores")
    if boxes is not None:
        frame_us = _to_us(outputs.get("frame_index", 0) / fps) if "frame_index" in outputs else 0
        out = []
        for i, box in enumerate(boxes):
            b = box.tolist() if hasattr(box, "tolist") else list(box)
            if len(b) != 4:
                continue
            score = float(scores[i]) if scores is not None else 1.0
            out.append({"box": [float(x) for x in b], "score": score, "t": frame_us})
        return out
    # masklet 结构：obj_id → {mask, score}
    out = []
    for obj_id, value in outputs.items():
        if not isinstance(value, dict):
            continue
        score = float(value.get("score", value.get("scores", 1.0)))
        mask = value.get("mask", value.get("masks"))
        if mask is None:
            continue
        mask_np = mask.cpu().numpy() if hasattr(mask, "cpu") else mask
        ys, xs = mask_np.nonzero() if hasattr(mask_np, "nonzero") else ([], [])
        if len(xs) == 0:
            continue
        box = [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]
        out.append({"box": box, "score": score, "obj_id": str(obj_id)})
    return out


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    prompts: str = Form(...),
) -> dict[str, Any]:
    """对视频执行概念提示提取：每个概念 → 全部实例轨迹。"""
    try:
        concept_list = json.loads(prompts)
    except json.JSONDecodeError:
        concept_list = [p.strip() for p in prompts.split(",") if p.strip()]
    if not concept_list:
        return {"candidates": [], "error": "prompts 为空"}

    suffix = os.path.splitext(file.filename or "video.mp4")[1] or ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        video_path = tmp.name

    try:
        predictor = get_predictor()

        # 探测帧率（有 cv2 用 cv2，没有则按 30fps 近似）
        fps = 30.0
        try:
            import cv2

            cap = cv2.VideoCapture(video_path)
            if cap.isOpened():
                fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
                cap.release()
        except Exception:
            pass

        candidates: list[dict[str, Any]] = []
        for concept in concept_list:
            # 每个概念独立 session（SAM 3 状态机：重复 prompt 需 reset）
            session = predictor.handle_request(
                request=dict(type="start_session", resource_path=video_path)
            )
            session_id = session["session_id"]
            try:
                prompt_resp = predictor.handle_request(
                    request=dict(
                        type="add_prompt",
                        session_id=session_id,
                        frame_index=0,
                        text=concept,
                    )
                )
                outputs = prompt_resp.get("outputs", {})
                tracks: dict[Any, dict[str, Any]] = {}

                def ingest(frame_us: int, outs: dict[str, Any]) -> None:
                    for item in _extract_outputs(outs, fps):
                        key = item.get("obj_id", str(len(tracks)))
                        track = tracks.setdefault(
                            key,
                            {"track_id": key, "score": 0.0, "boxes": [], "min_t": None, "max_t": None},
                        )
                        t = item.get("t") if item.get("t") is not None else frame_us
                        track["boxes"].append({"t": t, "box": item["box"]})
                        track["score"] = max(track["score"], float(item.get("score", 0.0)))
                        track["min_t"] = t if track["min_t"] is None else min(track["min_t"], t)
                        track["max_t"] = t if track["max_t"] is None else max(track["max_t"], t)

                ingest(0, outputs)
                for resp in predictor.handle_stream_request(
                    request=dict(type="propagate_in_video", session_id=session_id)
                ):
                    frame_idx = resp.get("frame_index", 0)
                    frame_us = _to_us(frame_idx / fps)
                    ingest(frame_us, resp.get("outputs", {}))

                for track in tracks.values():
                    track["startUs"] = track.pop("min_t", 0) or 0
                    track["endUs"] = track.pop("max_t", 0) or 0
                    track.pop("obj_id", None)
                candidates.append(
                    {"concept": concept, "tracks": sorted(tracks.values(), key=lambda t: t["score"], reverse=True)}
                )
            finally:
                # 会话不主动回收：结束一个概念后重置，避免状态串扰
                try:
                    predictor.handle_request(request=dict(type="reset_session", session_id=session_id))
                except Exception:
                    pass

        return {"candidates": candidates}
    finally:
        try:
            os.unlink(video_path)
        except OSError:
            pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
