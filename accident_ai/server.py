import base64, math, os, time
from collections import defaultdict, deque
from typing import Dict, List

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO

app = FastAPI(title="CORDDSBase Local YOLO11 Collision AI")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

MODEL_PATH = os.getenv("YOLO_MODEL", "yolo11n.pt")
FRAME_SIZE = int(os.getenv("YOLO_SIZE", "640"))
DETECT_CONF = float(os.getenv("YOLO_CONF", "0.20"))
MAX_DET = int(os.getenv("YOLO_MAX_DET", "30"))
TRACK_MAX_MISSES = int(os.getenv("TRACK_MAX_MISSES", "8"))
ALERT_COOLDOWN = float(os.getenv("ALERT_COOLDOWN", "5.0"))

# COCO vehicle classes: car, motorcycle, bus, truck.
VEHICLE_CLASSES = {2, 3, 5, 7}

# One tracker state per camera. Keeping state separate is important because
# persistent tracking state must not leak between unrelated camera streams.
camera_states: Dict[str, "CameraState"] = {}


class Frame(BaseModel):
    camera_id: str
    timestamp: float
    jpeg_base64: str


class Track:
    def __init__(self, track_id: int, cls: int, box, score: float, now: float):
        self.id = track_id
        self.cls = cls
        self.box = np.asarray(box, dtype=np.float32)
        self.score = float(score)
        self.cx, self.cy = center(self.box)
        self.vx = 0.0
        self.vy = 0.0
        self.prev_speed = 0.0
        self.speed = 0.0
        self.age = 1
        self.misses = 0
        self.last_time = now
        self.contact_speed = 0.0

    def update(self, box, score, now):
        old_cx, old_cy = self.cx, self.cy
        dt = max(1 / 30, min(0.5, now - self.last_time))
        self.prev_speed = self.speed
        self.box = np.asarray(box, dtype=np.float32)
        self.score = float(score)
        self.cx, self.cy = center(self.box)
        raw_vx = (self.cx - old_cx) / dt
        raw_vy = (self.cy - old_cy) / dt
        # Smooth velocity to reduce detector jitter.
        self.vx = self.vx * 0.45 + raw_vx * 0.55
        self.vy = self.vy * 0.45 + raw_vy * 0.55
        self.speed = math.hypot(self.vx, self.vy)
        self.age += 1
        self.misses = 0
        self.last_time = now


class PairState:
    def __init__(self):
        self.evidence = deque(maxlen=12)
        self.contact_streak = 0
        self.approach_streak = 0
        self.cooldown_until = 0.0
        self.last_distance = None
        self.last_time = None
        self.last_confidence = 0.0
        self.last_reason = "monitoring"


class CameraState:
    def __init__(self):
        self.next_id = 1
        self.tracks: Dict[int, Track] = {}
        self.pairs: Dict[str, PairState] = {}
        self.frames = 0
        self.last_alert = 0.0


model = YOLO(MODEL_PATH)


def center(box):
    x1, y1, x2, y2 = [float(x) for x in box]
    return (0.5 * (x1 + x2), 0.5 * (y1 + y2))


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    x1, y1 = max(ax1, bx1), max(ay1, by1)
    x2, y2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    aa = max(1.0, (ax2 - ax1) * (ay2 - ay1))
    ab = max(1.0, (bx2 - bx1) * (by2 - by1))
    return inter / max(1.0, aa + ab - inter)


def edge_gap(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    gx = max(0.0, max(bx1 - ax2, ax1 - bx2))
    gy = max(0.0, max(by1 - ay2, ay1 - by2))
    return math.hypot(gx, gy)


def normalized_gap(a, b, width, height):
    scale = max(1.0, math.hypot(width, height))
    return edge_gap(a, b) / scale


def association_cost(track: Track, det, width, height):
    box, cls = det["box"], det["class"]
    if track.cls != cls:
        return 999.0
    px = track.cx + track.vx / 30.0
    py = track.cy + track.vy / 30.0
    dcx, dcy = center(box)
    distance = math.hypot(dcx - px, dcy - py) / max(1.0, math.hypot(width, height))
    overlap = iou(track.box, box)
    old_area = max(1.0, (track.box[2] - track.box[0]) * (track.box[3] - track.box[1]))
    new_area = max(1.0, (box[2] - box[0]) * (box[3] - box[1]))
    size_delta = min(1.0, abs(math.log(new_area / old_area)))
    return distance * 3.0 + (1.0 - overlap) * 0.45 + size_delta * 0.15


def update_tracks(state: CameraState, detections, width, height, now):
    candidates = []
    for tid, track in state.tracks.items():
        for i, det in enumerate(detections):
            cost = association_cost(track, det, width, height)
            # Allow larger matching distance for fast-moving vehicles.
            max_dist = min(
                0.20,
                max(0.045, 0.055 + track.speed / max(1.0, math.hypot(width, height)) * 2.0),
            )
            if cost < 999 and cost < 0.70 and (
                iou(track.box, det["box"]) > 0.01 or
                math.hypot(
                    center(det["box"])[0] - track.cx,
                    center(det["box"])[1] - track.cy,
                ) / max(1.0, math.hypot(width, height)) < max_dist
            ):
                candidates.append((cost, tid, i))

    candidates.sort(key=lambda x: x[0])
    used_tracks, used_dets = set(), set()

    for _, tid, i in candidates:
        if tid in used_tracks or i in used_dets:
            continue
        det = detections[i]
        state.tracks[tid].update(det["box"], det["score"], now)
        used_tracks.add(tid)
        used_dets.add(i)

    for tid, track in list(state.tracks.items()):
        if tid not in used_tracks:
            track.misses += 1
            track.vx *= 0.90
            track.vy *= 0.90
            track.speed = math.hypot(track.vx, track.vy)
            if track.misses > TRACK_MAX_MISSES:
                del state.tracks[tid]

    for i, det in enumerate(detections):
        if i in used_dets:
            continue
        tid = state.next_id
        state.next_id += 1
        state.tracks[tid] = Track(tid, det["class"], det["box"], det["score"], now)

    return [t for t in state.tracks.values() if t.misses == 0 and t.age >= 2]


def pair_key(a, b):
    return f"{min(a.id, b.id)}:{max(a.id, b.id)}"


def collision_score(a: Track, b: Track, width, height, pair: PairState, now):
    dx = b.cx - a.cx
    dy = b.cy - a.cy
    distance = math.hypot(dx, dy)
    if distance < 1:
        distance = 1.0
    ux, uy = dx / distance, dy / distance

    # Positive means the two tracked vehicles are moving toward each other.
    relative_closing = (a.vx - b.vx) * ux + (a.vy - b.vy) * uy
    closing = max(
        0.0,
        min(
            1.0,
            relative_closing / max(1.0, math.hypot(width, height) * 0.035),
        ),
    )

    gap = normalized_gap(a.box, b.box, width, height)
    overlap = iou(a.box, b.box)

    # Contact is intentionally stricter than simple box overlap.
    # Perspective/occlusion can create overlap without physical contact.
    contact = max(
        min(1.0, overlap / 0.20),
        max(0.0, 1.0 - gap / 0.018),
    )

    speed_drop_a = max(
        0.0, min(1.0, (a.prev_speed - a.speed) / max(40.0, a.prev_speed * 0.70))
    )
    speed_drop_b = max(
        0.0, min(1.0, (b.prev_speed - b.speed) / max(40.0, b.prev_speed * 0.70))
    )
    impact = max(speed_drop_a, speed_drop_b)

    # A collision-like event normally has approach -> contact -> motion change.
    approach = closing
    if approach > 0.45:
        pair.approach_streak = min(pair.approach_streak + 1, 8)
    else:
        pair.approach_streak = max(0, pair.approach_streak - 1)

    if contact > 0.55:
        pair.contact_streak = min(pair.contact_streak + 1, 8)
    else:
        pair.contact_streak = max(0, pair.contact_streak - 1)

    sequence_bonus = 0.0
    if pair.approach_streak >= 2 and contact > 0.45:
        sequence_bonus = 0.18
    if pair.contact_streak >= 2 and impact > 0.35:
        sequence_bonus = max(sequence_bonus, 0.22)

    # Do not trigger from proximity alone. Require either a clear approach plus
    # contact, or contact plus a significant motion change.
    score = (
        0.34 * contact
        + 0.30 * approach
        + 0.24 * impact
        + sequence_bonus
        + 0.12 * min(1.0, max(a.score, b.score))
    )
    score = max(0.0, min(0.99, score))

    now_distance = distance
    if pair.last_distance is not None and pair.last_time is not None:
        dt = max(1 / 30, now - pair.last_time)
        distance_velocity = (pair.last_distance - now_distance) / dt
        if distance_velocity > math.hypot(width, height) * 0.01:
            pair.approach_streak = min(pair.approach_streak + 1, 8)

    pair.last_distance = now_distance
    pair.last_time = now
    pair.last_confidence = score

    reasons = []
    if approach > 0.55:
        reasons.append("closing motion")
    if contact > 0.60:
        reasons.append("contact/proximity")
    if impact > 0.35:
        reasons.append("sudden motion change")
    if pair.approach_streak >= 2:
        reasons.append("multi-frame approach")
    reason = ", ".join(reasons) if reasons else "monitoring"

    return score, reason, contact, impact, approach


def analyze_collisions(state: CameraState, tracks, width, height, now):
    best = None
    seen = set()
    for i, a in enumerate(tracks):
        for b in tracks[i + 1:]:
            key = pair_key(a, b)
            seen.add(key)
            pair = state.pairs.setdefault(key, PairState())
            score, reason, contact, impact, approach = collision_score(
                a, b, width, height, pair, now
            )
            pair.evidence.append(score)

            # Require multiple frames and a meaningful physical/motion sequence.
            strong = (
                len(pair.evidence) >= 2
                and max(pair.evidence) >= 0.62
                and (
                    (contact >= 0.60 and approach >= 0.45)
                    or (contact >= 0.70 and impact >= 0.40)
                )
            )
            if strong and now >= pair.cooldown_until:
                pair.cooldown_until = now + ALERT_COOLDOWN
                pair.evidence.clear()
                confidence = min(0.99, max(score, 0.68))
                candidate = {
                    "accident": True,
                    "confidence": confidence,
                    "reason": reason,
                    "pair": f"CAR #{a.id} + CAR #{b.id}",
                }
                if best is None or candidate["confidence"] > best["confidence"]:
                    best = candidate

    # Remove pairs that no longer exist so stale evidence cannot fire later.
    for key in list(state.pairs):
        if key not in seen:
            del state.pairs[key]

    return best or {
        "accident": False,
        "confidence": 0.0,
        "reason": "no confirmed collision",
        "pair": None,
    }


@app.get("/health")
def health():
    return {
        "ok": True,
        "detector": "YOLO11 local",
        "tracker": "per-camera motion tracker",
        "final_judge": "local multi-frame collision reasoning",
        "paid_services": False,
        "cloud_vlm": False,
    }


@app.post("/frame")
def frame(f: Frame):
    try:
        jpeg = base64.b64decode(f.jpeg_base64)
        image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("invalid JPEG")
    except Exception as e:
        raise HTTPException(400, "Invalid frame: " + str(e))

    now = float(f.timestamp) if math.isfinite(float(f.timestamp)) else time.time()
    height, width = image.shape[:2]
    state = camera_states.setdefault(f.camera_id, CameraState())

    result = model.predict(
        image,
        classes=sorted(VEHICLE_CLASSES),
        conf=DETECT_CONF,
        imgsz=FRAME_SIZE,
        max_det=MAX_DET,
        verbose=False,
    )[0]

    detections = []
    if result.boxes is not None:
        for box, cls, conf in zip(
            result.boxes.xyxy.cpu().numpy(),
            result.boxes.cls.cpu().numpy(),
            result.boxes.conf.cpu().numpy(),
        ):
            detections.append(
                {
                    "class": int(cls),
                    "score": float(conf),
                    "box": [float(x) for x in box],
                }
            )

    tracks = update_tracks(state, detections, width, height, now)
    collision = analyze_collisions(state, tracks, width, height, now)
    state.frames += 1

    output_tracks = [
        {
            "id": t.id,
            "class": t.cls,
            "confidence": round(t.score, 3),
            "box": [round(float(x), 2) for x in t.box],
            "vx": round(float(t.vx), 2),
            "vy": round(float(t.vy), 2),
        }
        for t in tracks
    ]

    return {
        **collision,
        "tracks": output_tracks,
        "window_frames": min(state.frames, 12),
        "window_seconds": round(min(state.frames, 12) / 30.0, 2),
        "frames_received": state.frames,
        "detector_confidence": DETECT_CONF,
        "model": MODEL_PATH,
        "paid_services": False,
    }
