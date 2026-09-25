import base64, os, time
from collections import defaultdict, deque
from typing import Dict
import cv2, numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from ultralytics import YOLO

app = FastAPI(title="CORDDSBase YOLO11x + Qwen3-VL-8B Accident AI")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

MODEL_PATH=os.getenv("YOLO_MODEL","yolo11x.pt")
FRAME_SIZE=int(os.getenv("YOLO_SIZE","640"))
WINDOW_FRAMES=1
INPUT_FPS=30
ALERT_COOLDOWN=0.0
VLM_URL=os.getenv("VLM_URL","http://127.0.0.1:30000/v1/chat/completions")
VLM_MODEL=os.getenv("VLM_MODEL","Qwen/Qwen3-VL-8B-Instruct")
VLM_ENABLED=os.getenv("VLM_ENABLED","true").lower()=="true"
VLM_MIN_CONFIDENCE=float(os.getenv("VLM_MIN_CONFIDENCE","0.20"))
vlm_busy:Dict[str,bool]=defaultdict(bool)
vlm_last:Dict[str,dict]={}
frame_counts:Dict[str,int]=defaultdict(int)
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
    if hit: return 0.10,"edge contact candidate",pair
    return 0.0,"no edge contact",None

def parse_vlm(text):
    import json,re
    try:
        m=re.search(r"\{.*?\}",text,re.S)
        if m:
            obj=json.loads(m.group(0))
            return bool(obj.get("accident",False)),float(obj.get("confidence",0)),str(obj.get("reason",""))
    except Exception:
        pass
    return False,0.0,text[:240]

def ask_vlm(items):
    if not VLM_ENABLED:
        return False,0.0,"VLM disabled"
    import requests
    # Send the newest available camera image directly to Qwen. There is no 48-frame
    # batching delay: Qwen is the final contact judge for each image it receives.
    item=items[-1]
    image={"type":"image_url","image_url":{"url":"data:image/jpeg;base64,"+item["jpeg"]}}
    prompt=("You are the final real-time CCTV collision judge. Inspect this single camera frame. "
            "Decide ONLY whether two visible cars are physically touching each other right now. "
            "Do not count bounding-box overlap caused by perspective, detector boxes, occlusion, "
            "or cars that are merely close. If the visible car bodies/vehicles are actually in "
            "physical contact, set accident=true. Otherwise set accident=false. "
            "Return ONLY JSON: {\"accident\":true/false,\"confidence\":0 to 1,\"reason\":\"short\"}.")
    payload={"model":VLM_MODEL,"messages":[{"role":"user","content":[{"type":"text","text":prompt},image]}],"temperature":0,"max_tokens":120}
    r=requests.post(VLM_URL,json=payload,timeout=20)
    r.raise_for_status()
    return parse_vlm(r.json()["choices"][0]["message"]["content"])

def run_vlm_window(camera_id,items):
    if not items or vlm_busy[camera_id]:
        return None
    vlm_busy[camera_id]=True
    try:
        accident,confidence,reason=ask_vlm(items)
        result={"accident":accident and confidence>=VLM_MIN_CONFIDENCE,
                "confidence":round(confidence,3),"reason":reason,"model":VLM_MODEL,"frames":len(items)}
        vlm_last[camera_id]=result
        return result
    except Exception as e:
        result={"accident":False,"confidence":0.0,"reason":"VLM error: "+str(e)[:180],"model":VLM_MODEL,"frames":len(items)}
        vlm_last[camera_id]=result
        return result
    finally:
        vlm_busy[camera_id]=False

@app.get("/health")
def health():
    return {"ok":True,"detector":"YOLO11x","tracker":"BoT-SORT","window":"single frame / immediate Qwen review","input_rate":"camera-rate (best effort)","final_judge":VLM_MODEL,"vlm_enabled":VLM_ENABLED}

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
    ok,encoded=cv2.imencode(".jpg",small,[int(cv2.IMWRITE_JPEG_QUALITY),65])
    frame_jpeg=base64.b64encode(encoded.tobytes()).decode("ascii") if ok else ""
    gray=cv2.cvtColor(small,cv2.COLOR_BGR2GRAY)
    cam=history[f.camera_id];previous=cam[-1]["gray"] if cam else None
    motion=float(np.mean(cv2.absdiff(gray,previous))) if previous is not None else 0.0
    flow_value=0.0
    if previous is not None:
        flow=cv2.calcOpticalFlowFarneback(previous,gray,None,0.5,2,15,2,5,1.2,0)
        flow_value=float(np.percentile(cv2.magnitude(flow[...,0],flow[...,1]),90))
    cam.append({"t":f.timestamp,"tracks":tracks,"motion":motion,"flow":flow_value,"gray":gray,"jpeg":frame_jpeg})
    frame_counts[f.camera_id]+=1
    vlm_result=None
    # Start a Qwen review for every newly received frame. If Qwen is still processing
    # the previous frame, this frame is skipped rather than queued indefinitely.
    import threading
    items=[cam[-1]]
    if not vlm_busy[f.camera_id]:
        threading.Thread(target=run_vlm_window,args=(f.camera_id,items),daemon=True).start()
        vlm_result={"started":True}
    latest=vlm_last.get(f.camera_id,{"accident":False,"confidence":0.0,"reason":"waiting for Qwen frame review","model":VLM_MODEL,"frames":len(cam)})
    now=time.time()
    accident=bool(latest.get("accident")) and now-last_alert.get(f.camera_id,0)>ALERT_COOLDOWN
    if accident:last_alert[f.camera_id]=now
    return {"accident":accident,"confidence":float(latest.get("confidence",0)),"reason":latest.get("reason",""),"pair":None,"tracks":tracks,"window_frames":len(cam),"window_seconds":round(len(cam)/INPUT_FPS,2),"frames_received":frame_counts[f.camera_id],"touch_tolerance_px":TOUCH_PX,"vlm":latest,"vlm_reviewed":vlm_result is not None}
