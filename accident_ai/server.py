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
FRAME_SIZE=int(os.getenv("YOLO_SIZE","640"))
WINDOW_FRAMES=40
INPUT_FPS=15
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

TOUCH_PX=int(os.getenv("TOUCH_PX","8"))

# Crash = detected car boxes touching at an edge or within a tiny gap.
# Positive rectangle overlap is explicitly NOT a crash.
def edge_touch(a,b):
    ax1,ay1,ax2,ay2=a;bx1,by1,bx2,by2=b
    x_overlap=min(ax2,bx2)-max(ax1,bx1)
    y_overlap=min(ay2,by2)-max(ay1,by1)
    gap_x=max(0.0,max(bx1-ax2,ax1-bx2))
    gap_y=max(0.0,max(by1-ay2,ay1-by2))
    horizontal=gap_x<=TOUCH_PX and y_overlap>0 and x_overlap<=0
    vertical=gap_y<=TOUCH_PX and x_overlap>0 and y_overlap<=0
    return horizontal or vertical

def current_edge_collision(tracks):
    cars=[t for t in tracks if t["class"]==2]
    for i,a in enumerate(cars):
        for b in cars[i+1:]:
            if edge_touch(a["box"],b["box"]):
                return True, "CAR #{} + CAR #{}".format(a["id"],b["id"])
    return False,None

def anchor(box):
    x1,y1,x2,y2=box
    return ((x1+x2)*0.5,y2)

def anchor_distance(a,b):
    ax,ay=anchor(a); bx,by=anchor(b)
    return float(((ax-bx)**2+(ay-by)**2)**0.5)

def score_window(cam):
    items=list(cam)
    if not items: return 0.0,"waiting",None
    hit,pair=current_edge_collision(items[-1]["tracks"])
    if hit: return 0.10,"car box edges touching",pair
    return 0.0,"no edge contact",None

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
    result=model.track(image,persist=True,tracker="botsort.yaml",classes=[2,3,5,7],conf=0.20,imgsz=FRAME_SIZE,max_det=30,verbose=False)[0]
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
    now=time.time();accident=confidence>0 and now-last_alert.get(f.camera_id,0)>ALERT_COOLDOWN
    if accident:last_alert[f.camera_id]=now
    return {"accident":accident,"confidence":round(confidence,3),"reason":reason,"pair":pair,"tracks":tracks,"window_frames":len(cam),"window_seconds":round(len(cam)/INPUT_FPS,2),"touch_tolerance_px":TOUCH_PX}
