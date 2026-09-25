import base64, os, time, json
from collections import defaultdict, deque
from typing import Dict
import cv2, numpy as np, requests
from fastapi import FastAPI, HTTPException\nfrom fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO

app = FastAPI(title="CORDDSBase Accident AI")\napp.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])
MODEL_PATH = os.getenv("YOLO_MODEL", "yolo11x.pt")
VLM_URL = os.getenv("VLM_URL", "http://127.0.0.1:30000/v1/chat/completions")
VLM_MODEL = os.getenv("VLM_MODEL", "Qwen/Qwen3-VL-32B-Instruct")
SAMPLE_WINDOW = 8
model = YOLO(MODEL_PATH)
history: Dict[str, deque] = defaultdict(lambda: deque(maxlen=24))
incidents: Dict[str, float] = {}

class Frame(BaseModel):
    camera_id: str
    timestamp: float
    jpeg_base64: str

def image_data_url(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()

def vlm_accident_check(frames):
    content = [{"type":"text","text":(
        "You are the final accident verifier for a fixed CCTV camera. "
        "Analyze these consecutive frames. Decide whether a REAL vehicle collision occurred, "
        "not merely close driving, perspective overlap, occlusion, or a normal maneuver. "
        "Return JSON only: {\"accident\":true|false,\"confidence\":0-1,\"reason\":\"short\"}. "
        "Require multi-frame visual evidence of impact or an abrupt post-impact change."
    )}]
    for jpeg in frames[-SAMPLE_WINDOW:]:
        content.append({"type":"image_url","image_url":{"url":image_data_url(jpeg)}})
    payload={"model":VLM_MODEL,"temperature":0.0,"max_tokens":120,
             "messages":[{"role":"user","content":content}]}
    try:
        r=requests.post(VLM_URL,json=payload,timeout=30)
        r.raise_for_status()
        text=r.json()["choices"][0]["message"]["content"]
        start=text.find("{"); end=text.rfind("}")
        if start>=0 and end>start:
            return json.loads(text[start:end+1])
    except Exception as e:
        return {"accident":False,"confidence":0,"reason":"VLM unavailable"}
    return {"accident":False,"confidence":0,"reason":"Invalid VLM response"}

@app.get("/health")
def health():
    return {"ok":True,"detector":"YOLO11x","tracker":"BoT-SORT","vlm":VLM_MODEL}

@app.post("/frame")
def frame(f: Frame):
    try:
        jpeg=base64.b64decode(f.jpeg_base64)
        image=cv2.imdecode(np.frombuffer(jpeg,np.uint8),cv2.IMREAD_COLOR)
        if image is None: raise ValueError("invalid JPEG")
    except Exception as e:
        raise HTTPException(400,"Invalid frame: "+str(e))

    result=model.track(image,persist=True,tracker="botsort.yaml",
                       classes=[2,3,5,7],conf=0.20,imgsz=1280,verbose=False)[0]
    tracks=[]
    if result.boxes is not None:
        ids=result.boxes.id
        for i,box in enumerate(result.boxes.xyxy.cpu().numpy()):
            tid=int(ids[i]) if ids is not None else i
            tracks.append({"id":tid,"class":int(result.boxes.cls[i]),
                           "confidence":float(result.boxes.conf[i]),
                           "box":[float(x) for x in box]})

    cam=history[f.camera_id]
    cam.append({"t":f.timestamp,"tracks":tracks,"jpeg":jpeg})
    candidate=False
    for i,a in enumerate(tracks):
        for b in tracks[i+1:]:
            ax=(a["box"][0]+a["box"][2])/2; ay=(a["box"][1]+a["box"][3])/2
            bx=(b["box"][0]+b["box"][2])/2; by=(b["box"][1]+b["box"][3])/2
            aw=a["box"][2]-a["box"][0]; ah=a["box"][3]-a["box"][1]
            bw=b["box"][2]-b["box"][0]; bh=b["box"][3]-b["box"][1]
            distance=((ax-bx)**2+(ay-by)**2)**0.5
            scale=max(1,(aw*ah*bw*bh)**0.25)
            if distance < scale*1.25: candidate=True

    if candidate and len(cam)>=4 and time.time()-incidents.get(f.camera_id,0)>8:
        recent=[x["jpeg"] for x in list(cam)[-SAMPLE_WINDOW:]]
        verdict=vlm_accident_check(recent)
        if verdict.get("accident") and float(verdict.get("confidence",0))>=0.60:
            incidents[f.camera_id]=time.time()
            return {"accident":True,"confidence":float(verdict["confidence"]),
                    "reason":verdict.get("reason",""),"tracks":tracks}
    return {"accident":False,"confidence":0,"tracks":tracks}
