import base64
import io
import os
import time
import urllib.request
from typing import Dict, List

import cv2
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

app = FastAPI(title="CORDDSBase RT-DETR Collision Detector")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_local_network_access_header(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
MODEL_PATH = os.getenv(
    "RTDETR_MODEL_PATH",
    os.path.join(MODEL_DIR, "rtdetrv2_s_640_int8_kenosis.onnx"),
)
MODEL_URL = os.getenv(
    "RTDETR_MODEL_URL",
    "https://huggingface.co/CoreEpoch/rtdetrv2-s-int8-onnx/resolve/main/"
    "rtdetrv2_s_640_int8_kenosis.onnx?download=true",
)
MODEL_SHA256 = "2fbea12f3a66da22be0c0404f78d378f0d6c4f2c8107a5444ee00c6ab717974d"
INPUT_SIZE = 640
CAR_CLASS = 2
DETECTION_THRESHOLD = float(os.getenv("RTDETR_CONFIDENCE", "0.28"))
TRACK_MAX_MISSED = int(os.getenv("TRACK_MAX_MISSED", "6"))
ALERT_COOLDOWN = float(os.getenv("COLLISION_ALERT_COOLDOWN", "4"))
CONFIRM_FRAMES = int(os.getenv("COLLISION_CONFIRM_FRAMES", "3"))

COCO = [
    "person", "bicycle", "car", "motorbike", "aeroplane", "bus", "train",
    "truck", "boat", "traffic light", "fire hydrant", "stop sign",
    "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep",
    "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard",
    "sports ball", "kite", "baseball bat", "baseball glove", "skateboard",
    "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork",
    "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv",
    "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave",
    "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush",
]

session = None
model_error = None
tracks_by_camera: Dict[str, Dict[int, dict]] = {}
next_track_id_by_camera: Dict[str, int] = {}
last_alert_by_camera: Dict[str, float] = {}
last_timestamp_by_camera: Dict[str, float] = {}


class Frame(BaseModel):
    camera_id: str
    timestamp: float
    jpeg_base64: str


def sha256_file(path: str) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_model():
    global model_error
    if os.path.exists(MODEL_PATH):
        try:
            if sha256_file(MODEL_PATH).lower() == MODEL_SHA256.lower():
                return
            os.remove(MODEL_PATH)
        except Exception as e:
            model_error = "Existing detector model could not be verified: " + str(e)
            raise RuntimeError(model_error)

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    tmp = MODEL_PATH + ".download"
    try:
        print("Downloading RT-DETRv2-S INT8 detector (~33 MB)...")
        urllib.request.urlretrieve(MODEL_URL, tmp)
        digest = sha256_file(tmp)
        if digest.lower() != MODEL_SHA256.lower():
            raise RuntimeError("Downloaded detector checksum does not match.")
        os.replace(tmp, MODEL_PATH)
    except Exception as e:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        model_error = "Detector download failed: " + str(e)
        raise


def load_model():
    global session, model_error
    if session is not None:
        return session
    ensure_model()
    try:
        session = ort.InferenceSession(
            MODEL_PATH,
            providers=["CPUExecutionProvider"],
            sess_options=ort.SessionOptions(),
        )
        model_error = None
        return session
    except Exception as e:
        model_error = "RT-DETR model failed to load: " + str(e)
        raise RuntimeError(model_error)


def decode_jpeg(jpeg_base64: str):
    try:
        raw = base64.b64decode(jpeg_base64, validate=True)
        arr = np.frombuffer(raw, dtype=np.uint8)
        image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("JPEG could not be decoded")
        return image
    except Exception as e:
        raise HTTPException(400, "Invalid JPEG: " + str(e))


def preprocess(image):
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb).resize((INPUT_SIZE, INPUT_SIZE), Image.Resampling.BILINEAR)
    x = np.asarray(pil, dtype=np.float32) / 255.0
    return np.transpose(x, (2, 0, 1))[None, ...]


def sigmoid(x):
    x = np.clip(x, -60, 60)
    return 1.0 / (1.0 + np.exp(-x))


def detect_cars(image):
    sess = load_model()
    original_h, original_w = image.shape[:2]
    inputs = sess.get_inputs()
    input_name = inputs[0].name
    outputs = sess.run(None, {input_name: preprocess(image)})

    logits = np.asarray(outputs[0])[0]
    boxes = np.asarray(outputs[1])[0]
    scores = sigmoid(logits)

    # The published RT-DETRv2-S INT8 graph returns 300 normalized cxcywh boxes.
    # Keep only COCO "car" detections. A lower threshold is intentional here:
    # collision confirmation happens later using tracking and geometry.
    detections = []
    for q in range(min(len(boxes), scores.shape[0])):
        car_score = float(scores[q, CAR_CLASS])
        if car_score < DETECTION_THRESHOLD:
            continue
        cx, cy, bw, bh = [float(v) for v in boxes[q]]
        x1 = max(0.0, (cx - bw / 2.0) * original_w)
        y1 = max(0.0, (cy - bh / 2.0) * original_h)
        x2 = min(float(original_w), (cx + bw / 2.0) * original_w)
        y2 = min(float(original_h), (cy + bh / 2.0) * original_h)
        if x2 - x1 < 8 or y2 - y1 < 8:
            continue
        detections.append({
            "box": [x1, y1, x2, y2],
            "score": car_score,
            "label": "car",
        })

    detections.sort(key=lambda d: d["score"], reverse=True)
    return detections[:20]


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    aa = max(1.0, (ax2 - ax1) * (ay2 - ay1))
    ab = max(1.0, (bx2 - bx1) * (by2 - by1))
    return inter / (aa + ab - inter)


def center(box):
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


def box_size(box):
    return max(1.0, box[2] - box[0]), max(1.0, box[3] - box[1])


def edge_gap(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    dx = max(bx1 - ax2, ax1 - bx2, 0.0)
    dy = max(by1 - ay2, ay1 - by2, 0.0)
    return float((dx * dx + dy * dy) ** 0.5)


def update_tracks(camera_id, detections, timestamp):
    tracks = tracks_by_camera.setdefault(camera_id, {})
    next_id = next_track_id_by_camera.get(camera_id, 1)
    matched_tracks = set()
    matched_dets = set()

    candidates = []
    for tid, t in tracks.items():
        for di, d in enumerate(detections):
            ov = iou(t["box"], d["box"])
            c1, c2 = center(t["box"]), center(d["box"])
            dist = ((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2) ** 0.5
            w, h = box_size(t["box"])
            gate = max(35.0, 0.8 * ((w * w + h * h) ** 0.5))
            if ov >= 0.12 or dist <= gate:
                candidates.append((max(ov, 1.0 - dist / max(gate, 1.0)), tid, di))

    for _, tid, di in sorted(candidates, reverse=True):
        if tid in matched_tracks or di in matched_dets:
            continue
        t = tracks[tid]
        old_center = center(t["box"])
        new_box = detections[di]["box"]
        new_center = center(new_box)
        dt = max(0.033, timestamp - t["timestamp"])
        t["prev_box"] = t["box"]
        t["prev_center"] = old_center
        t["box"] = new_box
        t["center"] = new_center
        t["vx"] = (new_center[0] - old_center[0]) / dt
        t["vy"] = (new_center[1] - old_center[1]) / dt
        t["timestamp"] = timestamp
        t["score"] = detections[di]["score"]
        t["missed"] = 0
        t["hits"] += 1
        matched_tracks.add(tid)
        matched_dets.add(di)

    for tid, t in list(tracks.items()):
        if tid not in matched_tracks:
            t["missed"] += 1
            if t["missed"] > TRACK_MAX_MISSED:
                del tracks[tid]

    for di, d in enumerate(detections):
        if di in matched_dets:
            continue
        c = center(d["box"])
        tracks[next_id] = {
            "id": next_id,
            "box": d["box"],
            "prev_box": d["box"],
            "center": c,
            "prev_center": c,
            "vx": 0.0,
            "vy": 0.0,
            "timestamp": timestamp,
            "score": d["score"],
            "missed": 0,
            "hits": 1,
            "contact_frames": {},
        }
        next_id += 1

    next_track_id_by_camera[camera_id] = next_id
    return [t for t in tracks.values() if t["missed"] == 0]


def collision_geometry(tracks):
    pairs = []
    confirmed = False
    reason = "vehicles separated"

    live = [t for t in tracks if t["hits"] >= 2]
    for i in range(len(live)):
        for j in range(i + 1, len(live)):
            a, b = live[i], live[j]
            gap = edge_gap(a["box"], b["box"])
            ov = iou(a["box"], b["box"])
            aw, ah = box_size(a["box"])
            bw, bh = box_size(b["box"])
            scale = min(aw, ah, bw, bh)
            near_threshold = max(4.0, scale * 0.075)
            touching = ov > 0.015 or gap <= near_threshold

            old_dist = ((a["prev_center"][0] - b["prev_center"][0]) ** 2 +
                        (a["prev_center"][1] - b["prev_center"][1]) ** 2) ** 0.5
            new_dist = ((a["center"][0] - b["center"][0]) ** 2 +
                        (a["center"][1] - b["center"][1]) ** 2) ** 0.5
            approaching = new_dist < old_dist - max(0.5, scale * 0.01)

            key = str(min(a["id"], b["id"])) + ":" + str(max(a["id"], b["id"]))
            if touching:
                a["contact_frames"][key] = a["contact_frames"].get(key, 0) + 1
            else:
                a["contact_frames"][key] = 0

            contact_count = a["contact_frames"].get(key, 0)
            # Require repeated geometric contact. Approaching motion is helpful,
            # but not mandatory because a stationary rear-end contact is still contact.
            is_confirmed = contact_count >= CONFIRM_FRAMES
            if is_confirmed:
                confirmed = True
                reason = "tracked vehicle boxes in physical contact"

            pairs.append({
                "track_a": a["id"],
                "track_b": b["id"],
                "gap_px": round(gap, 1),
                "iou": round(ov, 3),
                "approaching": approaching,
                "touching": touching,
                "contact_frames": contact_count,
                "confirmed": is_confirmed,
            })
    return confirmed, reason, pairs


@app.get("/health")
def health():
    global model_error
    try:
        load_model()
        return {
            "ok": True,
            "agent": "RT-DETRv2-S INT8 + tracker + collision geometry",
            "model": "RT-DETRv2-S INT8",
            "vehicle_identifier": "RT-DETR car detector",
            "paid_services": False,
            "inference": "ONNX Runtime CPU",
            "model_size_mb": 32.7,
            "confidence_threshold": DETECTION_THRESHOLD,
        }
    except Exception as e:
        model_error = str(e)
        return {
            "ok": False,
            "agent": "RT-DETRv2-S INT8 + tracker + collision geometry",
            "model": "RT-DETRv2-S INT8",
            "vehicle_identifier": "RT-DETR car detector",
            "paid_services": False,
            "inference": "ONNX Runtime CPU",
            "error": model_error,
        }


@app.post("/frame")
def frame(f: Frame):
    image = decode_jpeg(f.jpeg_base64)
    now = float(f.timestamp or time.time())
    if now <= 0:
        now = time.time()

    previous_ts = last_timestamp_by_camera.get(f.camera_id, 0.0)
    if previous_ts and now < previous_ts - 2:
        tracks_by_camera.pop(f.camera_id, None)
    last_timestamp_by_camera[f.camera_id] = now

    try:
        detections = detect_cars(image)
    except Exception as e:
        raise HTTPException(503, "RT-DETR detector error: " + str(e))

    tracks = update_tracks(f.camera_id, detections, now)
    collision_visible, reason, pairs = collision_geometry(tracks)

    wall_now = time.time()
    last_alert = last_alert_by_camera.get(f.camera_id, 0.0)
    accident = False
    if collision_visible and wall_now - last_alert >= ALERT_COOLDOWN:
        last_alert_by_camera[f.camera_id] = wall_now
        accident = True

    return {
        "accident": accident,
        "collision_visible": collision_visible,
        "confidence": round(max([t["score"] for t in tracks], default=0.0), 3),
        "vehicle_count": len(tracks),
        "vehicles": [
            {"id": t["id"], "box": [round(v, 1) for v in t["box"]], "confidence": round(t["score"], 3)}
            for t in tracks
        ],
        "pairs": pairs,
        "reason": reason,
        "camera_id": f.camera_id,
        "frame_timestamp": now,
        "model": "RT-DETRv2-S INT8",
        "agent": "RT-DETRv2-S INT8 + tracker + collision geometry",
    }
