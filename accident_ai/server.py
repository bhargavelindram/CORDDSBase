import base64, os, time
from collections import defaultdict, deque
from typing import Dict
import cv2, numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO

app = FastAPI(title="CORDDSBase YOLO11x Temporal Accident AI")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

MODEL_PATH=os.getenv("YOLO_MODEL","yolo11x.pt")
FRAME_SIZE=int(os.getenv("YOLO_SIZE","1280"))
WINDOW_FRAMES=40
INPUT_FPS=8
ALERT_COOLDOWN=6.0
model=YOLO(MODEL_PATH)
history:Dict[str,deque]=defaultdict(lambda:deque(maxlen=WINDOW_FRAMES))
last_alert:Dict[str,float]={}

class Frame(BaseModel):
    camera_id:str
    timestamp:float
    jpeg_base64:str

def gap(a,b):
    ax1,ay1,ax2,ay2=a;bx1,by1,bx2,by2=b
    gx=max(0.0,max(bx1-ax2,ax1-bx2));gy=max(0.0,max(by1-ay2,ay1-by2))
    return float((gx*gx+gy*gy)**0.5)

def overlap(a,b):
    ax1,ay1,ax2,ay2=a;bx1,by1,bx2,by2=b
    iw=max(0.0,min(ax2,bx2)-max(ax1,bx1));ih=max(0.0,min(ay2,by2)-max(ay1,by1))
    inter=iw*ih
    aa=max(1.0,(ax2-ax1)*(ay2-ay1));ab=max(1.0,(bx2-bx1)*(by2-by1))
    return float(inter/min(aa,ab))

def spike(values):
    if len(values)<8:return 0.0
    base=np.asarray(values[:-4],dtype=np.float32)
    med=float(np.median(base));mad=float(np.median(np.abs(base-med)))+1e-5
    return max(0.0,min(1.0,float((values[-1]-med)/(6.0*1.4826*mad))))

def anchor(box):
    x1,y1,x2,y2=box
    return ((x1+x2)*0.5,y2)

def anchor_distance(a,b):
    ax,ay=anchor(a); bx,by=anchor(b)
    return float(((ax-bx)**2+(ay-by)**2)**0.5)

def score_window(cam):
    items=list(cam)
    if len(items)<12:return 0.0,"warming up",None

    motion_spike=spike([x["motion"] for x in items])
    flow_spike=spike([x["flow"] for x in items])

    # Bounding-box overlap is deliberately NOT treated as physical contact.
    # Perspective can make two separate cars overlap in image space.
    # Instead, use bottom-center ground-contact proxies plus closing motion.
    pair_best=0.0;pair_name=None
    pair_details={}

    for item in items[-20:]:
        cars=[t for t in item["tracks"] if t["class"]==2]
        for i,a in enumerate(cars):
            for b in cars[i+1:]:
                key=tuple(sorted((a["id"],b["id"])))
                scale=max(1.0,min(
                    a["box"][2]-a["box"][0], a["box"][3]-a["box"][1],
                    b["box"][2]-b["box"][0], b["box"][3]-b["box"][1]
                ))
                d=anchor_distance(a["box"],b["box"])
                proximity=max(0.0,min(1.0,1.0-d/(0.42*scale)))
                detail=pair_details.setdefault(key,{"latest":d,"prev":None,"min_proximity":0.0,"closing":0.0})
                if detail["prev"] is not None:
                    closing=max(0.0,(detail["prev"]-d)/(0.16*scale))
                    detail["closing"]=max(detail["closing"],min(1.0,closing))
                detail["prev"]=d
                detail["latest"]=d
                detail["min_proximity"]=max(detail["min_proximity"],proximity)

    for key,detail in pair_details.items():
        # Require BOTH close ground-contact points and meaningful closing motion.
        # A stationary projected overlap therefore cannot trigger a crash.
        event=min(detail["min_proximity"],detail["closing"])
        if event>pair_best:
            pair_best=event
            pair_name=f"CAR #{key[0]} + CAR #{key[1]}"

    confidence=min(0.99,0.35*motion_spike+0.25*flow_spike+0.40*pair_best)
    reason=f"5-second/40-frame window; motion spike {motion_spike:.2f}; optical-flow spike {flow_spike:.2f}"
    if pair_name:
        d=pair_details[tuple(sorted(map(int,pair_name.replace("CAR #","").replace(" + CAR #"," ").split())))]
        reason+=f"; ground-contact pair {pair_name} proximity {d['min_proximity']:.2f}; closing {d['closing']:.2f}"
    else:
        reason+="; no physical-contact motion pattern"

    return confidence,reason,pair_name

@app.get("/health")
def health():
    return {"ok":True,"detector":"YOLO11x","tracker":"BoT-SORT","window":"40 frames / 5 seconds","input_rate":"8 FPS"}

@app.post("/frame")
def frame(f:Frame):
    try:
        jpeg=base64.b64decode(f.jpeg_base64)
        image=cv2.imdecode(np.frombuffer(jpeg,np.uint8),cv2.IMREAD_COLOR)
        if image is None:raise ValueError("invalid JPEG")
    except Exception as e:
        raise HTTPException(400,"Invalid frame: "+str(e))
    result=model.track(image,persist=True,tracker="botsort.yaml",classes=[2,3,5,7],conf=0.20,imgsz=FRAME_SIZE,verbose=False)[0]
    tracks=[]
    if result.boxes is not None:
        ids=result.boxes.id
        for i,box in enumerate(result.boxes.xyxy.cpu().numpy()):
            tid=int(ids[i]) if ids is not None else i
            tracks.append({"id":tid,"class":int(result.boxes.cls[i]),"confidence":float(result.boxes.conf[i]),"box":[float(x) for x in box]})
    small=cv2.resize(image,(640,360))
    gray=cv2.cvtColor(small,cv2.COLOR_BGR2GRAY)
    cam=history[f.camera_id];previous=cam[-1]["gray"] if cam else None
    motion=float(np.mean(cv2.absdiff(gray,previous))) if previous is not None else 0.0
    flow_value=0.0
    if previous is not None:
        flow=cv2.calcOpticalFlowFarneback(previous,gray,None,0.5,2,15,2,5,1.2,0)
        flow_value=float(np.percentile(cv2.magnitude(flow[...,0],flow[...,1]),90))
    cam.append({"t":f.timestamp,"tracks":tracks,"motion":motion,"flow":flow_value,"gray":gray})
    confidence,reason,pair=score_window(cam)
    now=time.time();accident=confidence>=0.58 and len(cam)>=12 and now-last_alert.get(f.camera_id,0)>ALERT_COOLDOWN
    if accident:last_alert[f.camera_id]=now
    return {"accident":accident,"confidence":round(confidence,3),"reason":reason,"pair":pair,"tracks":tracks,"window_frames":len(cam),"window_seconds":round(len(cam)/INPUT_FPS,2)}
