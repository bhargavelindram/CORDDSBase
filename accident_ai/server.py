import base64, json, os, re, time
from typing import Dict

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="CORDDSBase Local Vision Collision Agent")
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
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "llava:7b")
FRAME_TIMEOUT = max(180.0, float(os.getenv("VISION_TIMEOUT", "180")))
ALERT_COOLDOWN = float(os.getenv("VISION_ALERT_COOLDOWN", "2"))
last_alert_by_camera: Dict[str, float] = {}

class Frame(BaseModel):
    camera_id: str
    timestamp: float
    jpeg_base64: str

PROMPT = """You are CORDDSBase's live security-camera collision vision agent.
Inspect this single camera frame for a vehicle collision.
Return ONLY JSON: {"collision":false,"confidence":0.0,"vehicle_count":0,"vehicles":[],"reason":"no collision"}
Set collision=true only if two visible road vehicles are physically touching/colliding. Do not infer motion or treat perspective overlap as collision. Keep reason very short."""

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
    payload = {
        "model": VISION_MODEL,
        "prompt": PROMPT,
        "images": [jpeg_base64],
        "stream": False,
        "format": "json",
        "keep_alive": "10m",
        "options": {
            "temperature": 0,
            "num_predict": 16,
            "num_ctx": 768,
        },
    }
    try:
        r = requests.post(
            OLLAMA_URL + "/api/generate",
            json=payload,
            timeout=FRAME_TIMEOUT,
        )
        if r.status_code >= 400:
            raise HTTPException(502, "Ollama error: " + r.text[:500])
        body = r.json()
        result = parse_json(body.get("response", ""))
        if not isinstance(result, dict):
            raise HTTPException(502, "Local vision agent returned invalid JSON.")
        return {
            "collision": bool(result.get("collision", False)),
            "confidence": max(0.0, min(1.0, float(result.get("confidence", 0.0)))),
            "vehicle_count": max(0, int(result.get("vehicle_count", 0))),
            "vehicles": result.get("vehicles", []) if isinstance(result.get("vehicles", []), list) else [],
            "reason": str(result.get("reason", "vision agent decision")),
            "model": VISION_MODEL,
        }
    except HTTPException:
        raise
    except requests.RequestException as e:
        raise HTTPException(502, "Ollama request failed: " + str(e))

@app.get("/health")
def health():
    try:
        r = requests.get(OLLAMA_URL + "/api/tags", timeout=3)
        r.raise_for_status()
        models = r.json().get("models", [])
        names = [m.get("name", "") for m in models]
        installed = VISION_MODEL in names or any(n.split(":")[0] == VISION_MODEL.split(":")[0] for n in names)
        return {
            "ok": installed,
            "agent": "local Ollama vision collision agent",
            "model": VISION_MODEL,
            "vehicle_identifier": "vision agent",
            "paid_services": False,
            "ollama": OLLAMA_URL,
        }
    except requests.RequestException:
        return {
            "ok": False,
            "agent": "local Ollama vision collision agent",
            "model": VISION_MODEL,
            "vehicle_identifier": "vision agent",
            "paid_services": False,
            "ollama": OLLAMA_URL,
            "error": "Ollama is not reachable",
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
        "agent": "local Ollama vision collision agent",
    }
