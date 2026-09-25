import base64, os, time
from collections import defaultdict, deque
from typing import Dict
import cv2, numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO

app = FastAPI(title="CORDDSBase Small Temporal Accident AI")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

MODEL_PATH = os.getenv("YOLO_MODEL", "yolo11n.pt")
FRAME_SIZE = int(os.getenv("YOLO_SIZE", "640"))
FPS_WINDOW = 8
WINDOW_FRAMES = 40
ALERT_COOLDOWN = 6.0
model = YOLO(MODEL_PATH)
history: Dict[str, deque] = defaultdict(lambda: deque(maxlen=WINDOW_FRAMES))
last_alert: Dict[str, float] = {}

class Frame(BaseModel):
    camera_id: str
    timestamp: float
    jpeg_base64: str

def box_gap(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    gx = max(0.0, max(bx1 - ax2, ax1 - bx2))
    gy = max(0.0, max(by1 - ay2, ay1 - by2))
    return float((gx * gx + gy * gy) ** 0.5)

def overlap_ratio(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    iw = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    ih = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = iw * ih
    aa = max(1.0, (ax2-ax1)*(ay2-ay1))
    ab = max(1.0, (bx2-bx1)*(by2-by1))
    return float(inter / min(aa, ab))

def temporal_score(cam):
    items = list(cam)
    if len(items) < 8:
        return 0.0, "warming up", None

    diffs = np.array([x["diff"] for x in items], dtype=np.float32)
    if len(diffs) >= 5:
        smooth = np.convolve(diffs, np.ones(5, dtype=np.float32)/5.0, mode="same")
    else:
        smooth = diffs

    base = np.median(diffs[:-3]) if len(diffs) > 3 else np.median(diffs)
    mad = np.median(np.abs(diffs - np.median(diffs))) + 1e-6
    peak_raw = float((diffs[-1] - base) / (1.4826 * mad + 1e-6))
    peak_smooth = float((smooth[-1] - np.median(smooth[:-3])) / (1.4826 * (np.median(np.abs(smooth[:-3] - np.median(smooth[:-3]))) + 1e-6))) if len(smooth) > 4 else 0.0
    peak = max(0.0, min(1.0, max(peak_raw, peak_smooth) / 6.0))

    pair_best = 0.0
    pair_name = None
    recent_pairs = {}
    for item in items[-20:]:
        tracks = item["tracks"]
        for i, a in enumerate(tracks):
            if a["class"] != 2:
                continue
            for b in tracks[i+1:]:
                if b["class"] != 2:
                    continue
                key = tuple(sorted((a["id"], b["id"])))
                gap = box_gap(a["box"], b["box"])
                size = max(1.0, min(a["box"][2]-a["box"][0], a["box"][3]-a["box"][1], b["box"][2]-b["box"][0], b["box"][3]-b["box"][1]))
                contact = max(overlap_ratio(a["box"], b["box"]), max(0.0, 1.0-gap/(0.08*size)))
                recent_pairs[key] = max(recent_pairs.get(key, 0.0), contact)
    if recent_pairs:
        key, pair_best = max(recent_pairs.items(), key=lambda kv: kv[1])
        pair_name = f"CAR #{key[0]} + CAR #{key[1]}"

    flow = float(np.mean([x["flow"] for x in items[-4:]]))
    flow_base = float(np.median([x["flow"] for x in items[:-4]]) + 1e-6)
    flow_jump = max(0.0, min(1.0, (flow/flow_base - 1.0)/3.0))

    # A collision can exist for only one frame. The event score therefore
    # uses the instantaneous motion spike plus the strongest car-pair contact
    # anywhere in the rolling 5-second window.
    confidence = min(0.99, 0.52*peak + 0.28*flow_jump + 0.20*pair_best)
    reason = f"5s temporal spike {peak:.2f}, motion jump {flow_jump:.2f}"
    if pair_name:
        reason += f", nearest pair {pair_name} contact {pair_best:.2f}"
    return confidence, reason, pair_name

@app.get("/health")
def health():
    return {"ok": True, "detector": "YOLO11n", "tracker": "BoT-SORT", "temporal_window": "40 frames / 5 seconds", "sampling_fps": FPS_WINDOW}

@app.post("/frame")
def frame(f: Frame):
    try:
        jpeg = base64.b64decode(f.jpeg_base64)
        image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("invalid JPEG")
    except Exception as e:
        raise HTTPException(400, "Invalid frame: " + str(e))

    small = cv2.resize(image, (min(FRAME_SIZE, image.shape[1]), min(FRAME_SIZE, image.shape[0]))) if image.shape[1] > FRAME_SIZE else image
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    cam = history[f.camera_id]
    previous = cam[-1]["gray"] if cam else None

    result = model.track(
        image,
        persist=True,
        tracker="botsort.yaml",
        classes=[2, 3, 5, 7],
        conf=0.20,
        imgsz=FRAME_SIZE,
        verbose=False
    )[0]

    tracks = []
    if result.boxes is not None:
        ids = result.boxes.id
        for i, box in enumerate(result.boxes.xyxy.cpu().numpy()):
            tid = int(ids[i]) if ids is not None else i
            tracks.append({
                "id": tid,
                "class": int(result.boxes.cls[i]),
                "confidence": float(result.boxes.conf[i]),
                "box": [float(x) for x in box]
            })

    diff = float(np.mean(cv2.absdiff(gray, previous))) if previous is not None else 0.0
    if previous is not None:
        flow = cv2.calcOpticalFlowFarneback(previous, gray, None, 0.5, 2, 15, 2, 5, 1.2, 0)
        flow_mag = cv2.magnitude(flow[...,0], flow[...,1])
        flow_value = float(np.percentile(flow_mag, 90))
    else:
        flow_value = 0.0

    cam.append({"t": f.timestamp, "tracks": tracks, "diff": diff, "flow": flow_value, "gray": gray})

    confidence, reason, pair_name = temporal_score(cam)
    now = time.time()
    accident = confidence >= 0.58 and len(cam) >= 12 and (now - last_alert.get(f.camera_id, 0)) > ALERT_COOLDOWN
    if accident:
        last_alert[f.camera_id] = now

    return {
        "accident": accident,
        "confidence": round(confidence, 3),
        "reason": reason,
        "pair": pair_name,
        "tracks": tracks,
        "window_frames": len(cam),
        "window_seconds": round(len(cam) / FPS_WINDOW, 2)
    }
