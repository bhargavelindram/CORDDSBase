import base64, json, os, re, time
from typing import Dict

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="CORDDSBase Vision Collision Agent")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
VISION_MODEL = os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna")
FRAME_TIMEOUT = float(os.getenv("VISION_TIMEOUT", "8"))
ALERT_COOLDOWN = float(os.getenv("VISION_ALERT_COOLDOWN", "2"))
last_alert_by_camera: Dict[str, float] = {}

class Frame(BaseModel):
    camera_id: str
    timestamp: float
    jpeg_base64: str

def parse_json(text: str):
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:
        match = re.search(r"\{.*\}", text, re.S)
        if match:
            try:
                return json.loads(match.group(0))
            except Exception:
                pass
    return None

def ask_vision(jpeg_base64: str):
    if not OPENAI_API_KEY:
        raise HTTPException(503, "OPENAI_API_KEY is not configured on the accident AI server.")

    prompt = """You are CORDDSBase's live security-camera collision vision agent.
Inspect ONLY this single camera frame.

Return ONLY valid JSON:
{"collision":false,"confidence":0.0,"vehicle_count":0,"vehicles":[],"reason":"no visible collision"}

Rules:
- Identify visible road vehicles yourself. Do not assume that every object is a car.
- A collision is TRUE only when the image visibly shows two or more vehicles physically colliding/contacting each other, or the unmistakable immediate result of that contact in this frame.
- Cars merely driving close together, overlapping in perspective, parked close together, or being occluded are NOT a collision.
- Do not invent motion that is not visible.
- If there are two cars and they visibly clash, set collision=true immediately.
- confidence is 0 to 1 and should reflect how clearly the frame supports the decision.
- vehicle_count is the number of visible relevant vehicles.
- vehicles should contain short labels such as car, truck, bus, motorcycle.
- reason must be short and factual."""
    payload = {
        "model": VISION_MODEL,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": "data:image/jpeg;base64," + jpeg_base64, "detail": "low"},
            ],
        }],
    }
    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={"Authorization": "Bearer " + OPENAI_API_KEY, "Content-Type": "application/json"},
            json=payload,
            timeout=FRAME_TIMEOUT,
        )
        if r.status_code >= 400:
            raise HTTPException(502, "Vision API error: " + r.text[:500])
        body = r.json()
        text = body.get("output_text", "")
        if not text:
            parts = []
            for item in body.get("output", []):
                for content in item.get("content", []):
                    if content.get("type") in ("output_text", "text"):
                        parts.append(content.get("text", ""))
            text = "".join(parts)
        result = parse_json(text)
        if not isinstance(result, dict):
            raise HTTPException(502, "Vision agent returned invalid JSON.")
        return {
            "collision": bool(result.get("collision", False)),
            "confidence": max(0.0, min(1.0, float(result.get("confidence", 0.0)))),
            "vehicle_count": int(result.get("vehicle_count", 0)),
            "vehicles": result.get("vehicles", []) if isinstance(result.get("vehicles", []), list) else [],
            "reason": str(result.get("reason", "vision agent decision")),
            "model": VISION_MODEL,
        }
    except HTTPException:
        raise
    except requests.RequestException as e:
        raise HTTPException(502, "Vision API request failed: " + str(e))

@app.get("/health")
def health():
    return {
        "ok": bool(OPENAI_API_KEY),
        "agent": "OpenAI vision collision agent",
        "model": VISION_MODEL,
        "vehicle_identifier": "vision agent",
        "paid_services": True,
    }

@app.post("/frame")
def frame(f: Frame):
    now = time.time()
    try:
        base64.b64decode(f.jpeg_base64, validate=True)
    except Exception as e:
        raise HTTPException(400, "Invalid JPEG base64: " + str(e))

    result = ask_vision(f.jpeg_base64)
    alerted = False
    if result["collision"]:
        last = last_alert_by_camera.get(f.camera_id, 0.0)
        if now - last >= ALERT_COOLDOWN:
            last_alert_by_camera[f.camera_id] = now
            alerted = True

    return {
        "accident": alerted,
        "collision_visible": result["collision"],
        "confidence": result["confidence"],
        "vehicle_count": result["vehicle_count"],
        "vehicles": result["vehicles"],
        "reason": result["reason"],
        "camera_id": f.camera_id,
        "frame_timestamp": f.timestamp,
        "model": result["model"],
        "yolo": False,
        "agent": "OpenAI vision collision agent",
    }
