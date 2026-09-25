(()=>{"use strict";
const $=id=>document.getElementById(id);
const DEFAULT_TOKEN="corddsbase-vzgr9t";
const YOLO_THRESHOLD=.20;
const YOLO_MODEL="https://huggingface.co/webnn/yolo11n/resolve/main/onnx/yolo11n.onnx?download=true";
const SEGMENT_MS=120000;
const S={room:null,role:null,tokenId:DEFAULT_TOKEN,roomName:"",cameras:new Map(),markers:new Map(),alerts:[],alertCooldown:new Map(),collisions:new Map(),removedCameras:new Set(),ai:{session:null,loading:false,running:false,cameras:new Map(),timers:new Map(),ort:null},map:null,watchId:null,db:null,audioCtx:null,accidentApi:""};
const COCO=["person","bicycle","car","motorcycle","airplane","bus","train","truck","boat","traffic light","fire hydrant","stop sign","parking meter","bench","bird","cat","dog","horse","sheep","cow","elephant","bear","zebra","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball","kite","baseball bat","baseball glove","skateboard","surfboard","tennis racket","bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple","sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair","couch","potted plant","bed","dining table","toilet","tv","laptop","mouse","remote","keyboard","cell phone","microwave","oven","toaster","sink","refrigerator","book","clock","vase","scissors","teddy bear","hair drier","toothbrush"];
function setStatus(t){$("status").textContent=t}
function identity(p){return p+"-"+Math.random().toString(36).slice(2,10)}
function tokenSource(){if(!window.LivekitClient)throw Error("LiveKit SDK did not load. Refresh the page.");if(!LivekitClient.TokenSource?.developmentTokenServer)throw Error("LiveKit TokenSource API is unavailable. Refresh the page.");return LivekitClient.TokenSource.developmentTokenServer(DEFAULT_TOKEN)}
function sendData(obj){if(!S.room?.localParticipant)return;try{const bytes=new TextEncoder().encode(JSON.stringify(obj));S.room.localParticipant.publishData(bytes,{reliable:true})}catch(e){console.warn("data publish",e)}}
function showApp(role){$("gate").hidden=true;$("app").hidden=false;S.role=role;$("operatorPanel").hidden=role!=="operator";$("cameraPanel").hidden=role!=="camera";$("title").textContent=role==="operator"?"Cameras":"Camera";setStatus(role.toUpperCase())}
function showView(view){document.querySelectorAll(".view").forEach(v=>v.hidden=v.id!=="view-"+view);document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("active",b.dataset.view===view));const names={cameras:"Cameras",map:"Live Map",alerts:"Alerts",storage:"Video Storage",ai:"YOLO11 Detection",settings:"Settings"};$("title").textContent=names[view];if(view==="map"&&S.map)setTimeout(()=>S.map.invalidateSize(),50);if(view==="storage")refreshStorage()}
function initMap(){if(S.map||!window.L)return;S.map=L.map("map").setView([20,0],2);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(S.map)}
function upsertMarker(id,lat,lon,name){initMap();if(!S.map)return;let m=S.markers.get(id);if(!m){m=L.marker([lat,lon]).addTo(S.map);m.bindPopup(name);S.markers.set(id,m)}else m.setLatLng([lat,lon]);m.setPopupContent("<b>"+escapeHtml(name)+"</b><br>"+lat.toFixed(5)+", "+lon.toFixed(5))}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
function refreshCameraSelect(){const s=$("aiCamera"),old=s.value;s.innerHTML='<option value="">No camera selected</option>';for(const [id,c] of S.cameras){const o=document.createElement("option");o.value=id;o.textContent=c.name||id;s.appendChild(o)}if(S.cameras.has(old))s.value=old}
function updateCounts(){$("cameraCount").textContent=S.cameras.size;$("alertCount").textContent=S.alerts.length}
function cameraCard(id,name,video){let c=S.cameras.get(id);if(c?.card)return c.card;const card=document.createElement("div");card.className="cam";card.dataset.camera=id;const wrap=document.createElement("div");wrap.className="camVideoWrap";const overlay=document.createElement("canvas");overlay.className="overlay";wrap.appendChild(video);wrap.appendChild(overlay);const meta=document.createElement("div");meta.className="meta";meta.innerHTML="<b>"+escapeHtml(name)+"</b><span class=\"online\">● ONLINE</span>";const tools=document.createElement("div");tools.className="camTools";const ai=document.createElement("button");ai.textContent="AI DETECT";ai.onclick=()=>{showView("ai");$("aiCamera").value=id};tools.append(ai);const accidentStatus=document.createElement("span");accidentStatus.className="small";accidentStatus.textContent="ACCIDENT AI: "+(S.accidentApi?"MONITORING":"NOT CONFIGURED");tools.append(accidentStatus);if(S.role==="operator"){const remove=document.createElement("button");remove.textContent="REMOVE CAMERA";remove.className="dangerBtn";remove.onclick=()=>removeCamera(id,true);tools.append(remove)}const loc=document.createElement("span");loc.className="small";loc.textContent="GPS: waiting";tools.append(loc);card.append(wrap,meta,tools);$("remoteArea").appendChild(card);S.cameras.set(id,{id,name,video,overlay,card,loc,recorder:null,recordTimer:null,recording:false,accidentStatus:null});refreshCameraSelect();updateCounts();if(video.readyState>=1)startRecording(id);else video.addEventListener("loadedmetadata",()=>startRecording(id),{once:true});return card}
async function startRecording(id){const c=S.cameras.get(id);if(!c||c.recording)return;const video=c.video;const capture=video.captureStream?.bind(video)||video.mozCaptureStream?.bind(video);if(!capture){c.loc.textContent="Recording unavailable in this browser";return}const mime=["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm","video/mp4"].find(x=>MediaRecorder.isTypeSupported(x));if(!mime){c.loc.textContent="No supported recording format";return}
try{const stream=capture();let chunks=[];let started=Date.now();const begin=()=>{chunks=[];started=Date.now();c.recording=true;c.recorder=new MediaRecorder(stream,{mimeType:mime});c.recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};c.recorder.onstop=async()=>{const blob=new Blob(chunks,{type:mime});if(blob.size>1000)await saveRecording({camera:c.name,started,ended:Date.now(),blob,type:mime});if(c.recording)begin()};c.recorder.start(1000);c.recordTimer=setTimeout(()=>{if(c.recorder?.state==="recording")c.recorder.stop()},SEGMENT_MS)};begin()}catch(e){c.loc.textContent="Recording error"}}
function openDb(){return new Promise((resolve,reject)=>{if(S.db)return resolve(S.db);const r=indexedDB.open("corddsbase-storage",1);r.onupgradeneeded=()=>r.result.createObjectStore("segments",{keyPath:"id",autoIncrement:true});r.onsuccess=()=>{S.db=r.result;resolve(S.db)};r.onerror=()=>reject(r.error)})}
async function saveRecording(x){try{const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction("segments","readwrite");tx.objectStore("segments").add(x);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});refreshStorage()}catch(e){console.warn("recording save",e)}}
async function listRecordings(){const db=await openDb();return new Promise((res,rej)=>{const r=db.transaction("segments").objectStore("segments").getAll();r.onsuccess=()=>res(r.result.sort((a,b)=>b.started-a.started));r.onerror=()=>rej(r.error)})}
async function refreshStorage(){const list=$("storageList");const rows=await listRecordings();$("recordingCount").textContent=rows.length;if(!rows.length){list.className="list empty";list.textContent="No recordings yet.";return}list.className="list";list.innerHTML="";for(const x of rows){const item=document.createElement("div");item.className="recordItem";const meta=document.createElement("div");meta.className="recordMeta";meta.innerHTML="<b>"+escapeHtml(x.camera)+"</b><span>"+new Date(x.started).toLocaleString()+" · 2-minute segment</span>";const actions=document.createElement("div");actions.className="recordActions";const dl=document.createElement("button");dl.textContent="DOWNLOAD";dl.onclick=()=>{const u=URL.createObjectURL(x.blob);const a=document.createElement("a");a.href=u;a.download="CORDDS_"+x.camera.replace(/\W+/g,"_")+"_"+x.started+"."+((x.type||"").includes("mp4")?"mp4":"webm");a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};const del=document.createElement("button");del.textContent="DELETE";del.onclick=async()=>{const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction("segments","readwrite");tx.objectStore("segments").delete(x.id);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});refreshStorage()};actions.append(dl,del);item.append(meta,actions);list.appendChild(item)}}
function unlockAlertAudio(){try{if(!S.audioCtx)S.audioCtx=new (window.AudioContext||window.webkitAudioContext)();if(S.audioCtx.state==="suspended")S.audioCtx.resume()}catch(e){console.warn("alert audio",e)}}
function setAccidentApi(url){S.accidentApi=(url||"").trim().replace(/\\/$/,"");if(S.accidentApi)localStorage.setItem("cordds_accident_api",S.accidentApi);const el=$("accidentApiStatus");if(el)el.textContent=S.accidentApi?"ACCIDENT AI BACKEND CONFIGURED":"ACCIDENT AI BACKEND NOT CONFIGURED"}
async function sendAccidentFrame(id){
  const c=S.cameras.get(id);if(!c||!S.accidentApi||!c.video||c.video.readyState<2)return;
  if(c.accidentBusy)return;c.accidentBusy=true;
  try{
    const canvas=document.createElement("canvas"),vw=c.video.videoWidth||640,vh=c.video.videoHeight||360;
    const scale=Math.min(960/vw,540/vh);canvas.width=Math.max(1,Math.round(vw*scale));canvas.height=Math.max(1,Math.round(vh*scale));
    canvas.getContext("2d").drawImage(c.video,0,0,canvas.width,canvas.height);
    const b64=canvas.toDataURL("image/jpeg",.72).split(",")[1];
    const r=await fetch(S.accidentApi+"/frame",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({camera_id:id,timestamp:Date.now()/1000,jpeg_base64:b64})});
    if(!r.ok)throw Error("backend "+r.status);const data=await r.json();
    c.remoteTracks=data.tracks||[];
    if(data.accident){reportCollision(c,"AI-"+Math.floor(Date.now()/8000),Math.max(.60,Math.min(.99,Number(data.confidence)||.60)));}
    if(c.accidentStatus)c.accidentStatus.textContent=data.accident?"ACCIDENT CONFIRMED · "+Math.round(data.confidence*100)+"%":"AI MONITORING";
  }catch(e){if(c.accidentStatus)c.accidentStatus.textContent="ACCIDENT AI OFFLINE";}
  finally{c.accidentBusy=false;}
}
function startAccidentAIForCamera(id){const c=S.cameras.get(id);if(!c||!S.accidentApi||c.accidentTimer)return;c.accidentTimer=setInterval(()=>sendAccidentFrame(id),1000);sendAccidentFrame(id)}
function stopAccidentAIForCamera(id){const c=S.cameras.get(id);if(c?.accidentTimer)clearInterval(c.accidentTimer);if(c)c.accidentTimer=null}
function playAlertSound(){try{unlockAlertAudio();const ctx=S.audioCtx;if(!ctx)return;const now=ctx.currentTime;const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type="square";osc.frequency.setValueAtTime(880,now);osc.frequency.setValueAtTime(660,now+.10);gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.18,now+.015);gain.gain.exponentialRampToValueAtTime(.0001,now+.28);osc.connect(gain);gain.connect(ctx.destination);osc.start(now);osc.stop(now+.30)}catch(e){console.warn("alert sound",e)}}
function addAlert(camera,label,score){const key=camera+"|"+label;const now=Date.now();const last=S.alertCooldown.get(key)||0;if(now-last<10000)return;S.alertCooldown.set(key,now);const a={camera,label,score,time:now};S.alerts.unshift(a);S.alerts=S.alerts.slice(0,200);updateCounts();renderAlerts()}
function reportCollision(c,pairKey,score){
const id=c.id+"|"+pairKey;
const now=Date.now();
const existing=S.collisions.get(id);
if(existing&&now-existing.lastSeen<8000){
  existing.lastSeen=now;
  existing.score=Math.max(existing.score,score);
  return;
}
const incident={id,camera:c.name||"Camera",score,time:now,lastSeen:now,status:"ACTIVE"};
S.collisions.set(id,incident);
addAlert(c.name||"Camera","ACCIDENT DETECTED",score);
playAlertSound();
renderCollisionControl();
}
function acknowledgeCollision(id){
const x=S.collisions.get(id);if(!x)return;
x.status="ACKNOWLEDGED";renderCollisionControl();
}
function clearCollision(id){
S.collisions.delete(id);renderCollisionControl();
}
function renderCollisionControl(){
const el=$("collisionOps");if(!el)return;
const active=[...S.collisions.values()].filter(x=>x.status!=="CLEARED");
if(!active.length){el.className="collisionOps empty";el.textContent="No active collision incidents.";return}
el.className="collisionOps";
el.innerHTML=active.map(x=>'<div class="collisionIncident"><div><strong>VEHICLE COLLISION</strong><div class="small">'+escapeHtml(x.camera)+' · '+Math.round(x.score*100)+'% · '+new Date(x.time).toLocaleTimeString()+'</div><div class="small">Status: '+escapeHtml(x.status)+'</div></div><div class="recordActions"><button data-ack="'+escapeHtml(x.id)+'">'+(x.status==="ACKNOWLEDGED"?"ACKNOWLEDGED":"ACKNOWLEDGE")+'</button><button class="dangerBtn" data-clear="'+escapeHtml(x.id)+'">CLEAR</button></div></div>').join("");
el.querySelectorAll("[data-ack]").forEach(b=>b.onclick=()=>acknowledgeCollision(b.dataset.ack));
el.querySelectorAll("[data-clear]").forEach(b=>b.onclick=()=>clearCollision(b.dataset.clear));
}
function renderAlerts(){renderCollisionControl();const el=$("alertsList");if(!S.alerts.length){el.className="list empty";el.textContent="No detection alerts yet.";return}el.className="list";el.innerHTML=S.alerts.map(a=>'<div class="alertItem"><div><strong>'+escapeHtml(a.label)+'</strong><div class="small">'+escapeHtml(a.camera)+' · '+Math.round(a.score*100)+'% confidence</div></div><span class="small">'+new Date(a.time).toLocaleTimeString()+'</span></div>').join("")}
async function loadAI(){if(S.ai.loading||S.ai.session)return;S.ai.loading=true;$("loadAi").disabled=true;$("aiStatus").textContent="Loading YOLO11n engine…";$("aiStatus").className="aiStatus";try{const ort=await import("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/+esm");S.ai.ort=ort;S.ai.session=await ort.InferenceSession.create(YOLO_MODEL,{executionProviders:["wasm"],graphOptimizationLevel:"all"});$("aiStatus").textContent="YOLO11 ONLINE · automatic detection enabled · ≥20% confidence";$("aiStatus").className="aiStatus ready";for(const id of S.cameras.keys())startAIForCamera(id)}catch(e){console.error("YOLO11 load",e);S.ai.session=null;$("aiStatus").textContent="YOLO11 load failed: "+(e.message||e);$("aiStatus").className="aiStatus error"}finally{S.ai.loading=false}}
function letterbox(video,size=640){const vw=video.videoWidth||640,vh=video.videoHeight||360,scale=Math.min(size/vw,size/vh),nw=Math.max(1,Math.round(vw*scale)),nh=Math.max(1,Math.round(vh*scale));const canvas=document.createElement("canvas");canvas.width=size;canvas.height=size;const ctx=canvas.getContext("2d",{willReadFrequently:true});ctx.fillStyle="#000";ctx.fillRect(0,0,size,size);const dx=Math.floor((size-nw)/2),dy=Math.floor((size-nh)/2);ctx.drawImage(video,0,0,vw,vh,dx,dy,nw,nh);return{canvas,scale,dx,dy,vw,vh}}
function tensorFromCanvas(canvas){const im=canvas.getContext("2d",{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height).data;const area=canvas.width*canvas.height,chw=new Float32Array(area*3);for(let p=0;p<area;p++){chw[p]=im[p*4]/255;chw[area+p]=im[p*4+1]/255;chw[2*area+p]=im[p*4+2]/255}return new S.ai.ort.Tensor("float32",chw,[1,3,canvas.height,canvas.width])}
function iou(a,b){const x1=Math.max(a.xmin,b.xmin),y1=Math.max(a.ymin,b.ymin),x2=Math.min(a.xmax,b.xmax),y2=Math.min(a.ymax,b.ymax),inter=Math.max(0,x2-x1)*Math.max(0,y2-y1),aa=Math.max(0,a.xmax-a.xmin)*Math.max(0,a.ymax-a.ymin),ab=Math.max(0,b.xmax-b.xmin)*Math.max(0,b.ymax-b.ymin);return inter/(aa+ab-inter||1)}
function nms(dets,limit=.45){const out=[],sorted=[...dets].sort((a,b)=>b.score-a.score);while(sorted.length){const best=sorted.shift();out.push(best);for(let i=sorted.length-1;i>=0;i--)if(sorted[i].label===best.label&&iou(sorted[i].box,best.box)>limit)sorted.splice(i,1)}return out}
function drawDetections(c,dets){
const v=c.video,canvas=c.overlay;
if(!v||!canvas)return;
const w=v.videoWidth||640,h=v.videoHeight||360;
if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
const ctx=canvas.getContext("2d");
ctx.clearRect(0,0,w,h);
ctx.font="700 "+Math.max(14,Math.round(w/65))+"px Arial";

const cars=dets.filter(d=>d.label==="car");
if(!c.tracks)c.tracks=new Map();
if(!c.nextTrackId)c.nextTrackId=1;
if(!c.trackFrame)c.trackFrame=0;
c.trackFrame++;

const now=performance.now();
const observations=cars.map(d=>{
const b=d.box;
return {...d,cx:(b.xmin+b.xmax)/2,cy:(b.ymin+b.ymax)/2,
px:(b.xmin+b.xmax)/2,py:b.ymax,
bw:Math.max(1,b.xmax-b.xmin),bh:Math.max(1,b.ymax-b.ymin)};
});

// Predict stored cars forward before matching. Every ID belongs to one persistent
// car record and IDs are never recycled during this camera session.
const predicted=[...c.tracks.values()].map(t=>{const dt=Math.max(.05,Math.min(.8,(now-(t.lastTime||now))/1000));return {...t,pcx:t.cx+(t.vx||0)*dt,pcy:t.cy+(t.vy||0)*dt,pbw:t.bw||Math.max(1,t.box.xmax-t.box.xmin),pbh:t.bh||Math.max(1,t.box.ymax-t.box.ymin)}});
const candidates=[];
for(const t of predicted)for(let i=0;i<observations.length;i++){const o=observations[i],dist=Math.hypot(o.cx-t.pcx,o.cy-t.pcy)/Math.max(w,h),pb={xmin:t.pcx-t.pbw/2,ymin:t.pcy-t.pbh/2,xmax:t.pcx+t.pbw/2,ymax:t.pcy+t.pbh/2},ov=iou(pb,o.box),sizeDiff=Math.abs(Math.log((o.bw*o.bh)/Math.max(1,t.pbw*t.pbh))),cost=dist*2.8+(1-ov)*.55+Math.min(1,sizeDiff)*.35,maxDist=Math.min(.22,Math.max(.07,.065+Math.hypot(t.vx||0,t.vy||0)/Math.max(w,h)*1.5));if(dist<maxDist&&(ov>.001||dist<.11))candidates.push({t,i,cost})}
candidates.sort((a,b)=>a.cost-b.cost);const usedTracks=new Set(),usedObs=new Set(),updated=new Map();
for(const m of candidates){if(usedTracks.has(m.t.id)||usedObs.has(m.i))continue;const o=observations[m.i],t=m.t,dt=Math.max(.05,Math.min(1,(now-(t.lastTime||now))/1000));updated.set(t.id,{...o,id:t.id,cx:o.cx,cy:o.cy,vx:(o.cx-t.cx)/dt,vy:(o.cy-t.cy)/dt,bw:o.bw,bh:o.bh,box:o.box,miss:0,age:(t.age||0)+1,lastTime:now,lastSeen:now,predicted:false,prevVx:t.vx||0,prevVy:t.vy||0,prevSpeed:Math.hypot(t.vx||0,t.vy||0)});usedTracks.add(t.id);usedObs.add(m.i)}
// Keep cars in memory through longer detector dropouts/occlusion.
for(const t of predicted)if(!usedTracks.has(t.id)){const miss=(t.miss||0)+1;if(miss<=60){const cx=t.pcx,cy=t.pcy,bw=t.pbw,bh=t.pbh;updated.set(t.id,{...t,cx,cy,box:{xmin:Math.max(0,cx-bw/2),ymin:Math.max(0,cy-bh/2),xmax:Math.min(w,cx+bw/2),ymax:Math.min(h,cy+bh/2)},bw,bh,miss,lastTime:now,predicted:true,vx:(t.vx||0)*.92,vy:(t.vy||0)*.92})}}
for(let i=0;i<observations.length;i++)if(!usedObs.has(i)){const o=observations[i],id=c.nextTrackId++;updated.set(id,{...o,id,cx:o.cx,cy:o.cy,vx:0,vy:0,bw:o.bw,bh:o.bh,box:o.box,miss:0,age:1,lastTime:now,lastSeen:now,predicted:false,prevVx:0,prevVy:0,prevSpeed:0})}
c.tracks=updated;

// Draw boxes only. Trajectory lines are intentionally disabled.
for(const t of c.tracks.values()){const b=t.box,x=b.xmin,y=b.ymin,bw=b.xmax-b.xmin,bh=b.ymax-b.ymin;ctx.strokeStyle=t.predicted?"#ffffff":"#ff0000";ctx.lineWidth=Math.max(2,Math.round(w/500));ctx.setLineDash(t.predicted?[8,6]:[]);ctx.strokeRect(x,y,bw,bh);ctx.setLineDash([]);const label="CAR #"+t.id+(t.predicted?" · TRACKING":"")+" "+Math.round((t.score||0)*100)+"%";const tw=ctx.measureText(label).width+12,th=24;ctx.fillStyle=t.predicted?"#ffffff":"#ff0000";ctx.fillRect(x,Math.max(0,y-th),tw,th);ctx.fillStyle=t.predicted?"#000000":"#ffffff";ctx.fillText(label,x+6,Math.max(17,y-6))}

// Temporal accident reasoning: do not alert merely because boxes touch.
// We combine persistent IDs, closing motion, sudden deceleration/direction change,
// relative approach, proximity/overlap, and multi-frame persistence.
if(!c.accidentPairs)c.accidentPairs=new Map();
const tracks=[...c.tracks.values()].filter(t=>!t.predicted&&t.age>=2);
const seenPairs=new Set();
const nowMs=performance.now();
const frameScale=Math.max(w,h);
for(let i=0;i<tracks.length;i++)for(let j=i+1;j<tracks.length;j++){
  const a=tracks[i],b=tracks[j];
  const key=[Math.min(a.id,b.id),Math.max(a.id,b.id)].join(":");
  seenPairs.add(key);
  const ax=(a.box.xmin+a.box.xmax)/2, ay=(a.box.ymin+a.box.ymax)/2;
  const bx=(b.box.xmin+b.box.xmax)/2, by=(b.box.ymin+b.box.ymax)/2;
  const dx=bx-ax, dy=by-ay, dist=Math.hypot(dx,dy)||1;
  const ux=dx/dist, uy=dy/dist;
  const avx=a.vx||0, avy=a.vy||0, bvx=b.vx||0, bvy=b.vy||0;
  const closing=((avx-bvx)*ux+(avy-bvy)*uy);
  const aSpeed=Math.hypot(avx,avy), bSpeed=Math.hypot(bvx,bvy);
  const aPrev=a.prevSpeed||aSpeed, bPrev=b.prevSpeed||bSpeed;
  const decelA=Math.max(0,(aPrev-aSpeed)/Math.max(1,aPrev));
  const decelB=Math.max(0,(bPrev-bSpeed)/Math.max(1,bPrev));
  const accelA=Math.hypot((a.vx||0)-(a.prevVx||a.vx||0),(a.vy||0)-(a.prevVy||a.vy||0))/frameScale;
  const accelB=Math.hypot((b.vx||0)-(b.prevVx||b.vx||0),(b.vy||0)-(b.prevVy||b.vy||0))/frameScale;
  const xOverlap=Math.min(a.box.xmax,b.box.xmax)-Math.max(a.box.xmin,b.box.xmin);
  const yOverlap=Math.min(a.box.ymax,b.box.ymax)-Math.max(a.box.ymin,b.box.ymin);
  const overlapW=Math.max(0,xOverlap), overlapH=Math.max(0,yOverlap);
  const inter=overlapW*overlapH;
  const areaA=Math.max(1,a.bw*a.bh), areaB=Math.max(1,b.bw*b.bh);
  const overlapRatio=inter/Math.min(areaA,areaB);
  const edgeGapX=Math.max(0,Math.max(b.box.xmin-a.box.xmax,a.box.xmin-b.box.xmax));
  const edgeGapY=Math.max(0,Math.max(b.box.ymin-a.box.ymax,a.box.ymin-b.box.ymax));
  const gap=Math.hypot(edgeGapX,edgeGapY)/frameScale;
  const proximity=Math.max(0,1-Math.min(1,gap/.10));
  const closingScore=Math.max(0,Math.min(1,closing/(frameScale*.025)));
  const impactMotion=Math.max(decelA,decelB,Math.min(1,accelA*8),Math.min(1,accelB*8));
  const contactScore=Math.max(overlapRatio,proximity);
  const pair=c.accidentPairs.get(key)||{streak:0,peak:0,lastContact:0};
  const evidence=0.38*contactScore+0.28*closingScore+0.24*impactMotion+0.10*Math.max(decelA,decelB);
  if(evidence>=.42) pair.streak++; else pair.streak=Math.max(0,pair.streak-1);
  pair.peak=Math.max(pair.peak,evidence);
  pair.lastContact=evidence;
  c.accidentPairs.set(key,pair);
  if(pair.streak>=3 && pair.peak>=.62){
    reportCollision(c,key,Math.min(.99,pair.peak));
    pair.streak=0;
    pair.peak=0;
  }
}
for(const key of c.accidentPairs.keys())if(!seenPairs.has(key))c.accidentPairs.delete(key);
}function decodeYOLO(output,meta){const data=output.data,dims=output.dims,channels=dims[1],count=dims[2],transposed=channels!==84,attrs=transposed?count:channels,n=transposed?channels:count;const get=(a,c)=>transposed?data[c*attrs+a]:data[a*n+c];const dets=[];for(let c=0;c<n;c++){let score=0,cls=-1;for(let a=4;a<attrs;a++){const v=get(a,c);if(v>score){score=v;cls=a-4}}if(score<YOLO_THRESHOLD||cls!==2)continue;const cx=get(0,c),cy=get(1,c),bw=get(2,c),bh=get(3,c);const box={xmin:Math.max(0,Math.min(meta.vw,(cx-bw/2-meta.dx)/meta.scale)),ymin:Math.max(0,Math.min(meta.vh,(cy-bh/2-meta.dy)/meta.scale)),xmax:Math.max(0,Math.min(meta.vw,(cx+bw/2-meta.dx)/meta.scale)),ymax:Math.max(0,Math.min(meta.vh,(cy+bh/2-meta.dy)/meta.scale))};if(box.xmax>box.xmin&&box.ymax>box.ymin)dets.push({score,label:COCO[cls]||("class "+cls),box})}return nms(dets,.70)}
async function detectFrame(id){const c=S.cameras.get(id);if(!S.ai.running||!S.ai.session||!c)return;if(!c.video||c.video.readyState<2){scheduleDetect(id);return}try{const meta=letterbox(c.video),input=tensorFromCanvas(meta.canvas),feeds={};feeds[S.ai.session.inputNames[0]]=input;const result=await S.ai.session.run(feeds),output=result[S.ai.session.outputNames[0]];drawDetections(c,decodeYOLO(output,meta))}catch(e){console.warn("YOLO11 inference",e)}scheduleDetect(id)}
function scheduleDetect(id){if(S.ai.running){clearTimeout(S.ai.timers.get(id));S.ai.timers.set(id,setTimeout(()=>detectFrame(id),250))}}
function startAIForCamera(id){if(!S.ai.session||!S.cameras.has(id))return;startAccidentAIForCamera(id);S.ai.running=true;S.ai.cameras.set(id,true);$("aiStatus").textContent="YOLO11 ONLINE · detecting all connected cameras · ≥20% confidence";detectFrame(id)}
function stopAIForCamera(id){stopAccidentAIForCamera(id);S.ai.cameras.delete(id);clearTimeout(S.ai.timers.get(id));S.ai.timers.delete(id);const c=S.cameras.get(id);if(c?.overlay){const ctx=c.overlay.getContext("2d");ctx.clearRect(0,0,c.overlay.width,c.overlay.height)}if(!S.ai.cameras.size)S.ai.running=false}
function startAI(){for(const id of S.cameras.keys())startAIForCamera(id)}
function stopAI(){S.ai.running=false;for(const id of [...S.ai.cameras.keys()])stopAIForCamera(id);$("aiStatus").textContent=S.ai.session?"YOLO11 ONLINE · automatic detection paused.":"AI engine not loaded."}
async function connect(roomName,role){const L=LivekitClient;const source=tokenSource();if(S.room){try{await S.room.disconnect()}catch(e){}}S.room=new L.Room({adaptiveStream:true,dynacast:true});S.roomName=roomName;S.room.on(L.RoomEvent.TrackSubscribed,(track,publication,participant)=>{if(role!=="operator"||track.kind!=="video")return;const video=track.attach();video.autoplay=true;video.playsInline=true;const id=participant.identity;if(S.removedCameras.has(id)){track.detach();return}const name=participant?.name||participant?.identity||"Camera";cameraCard(id,name,video);if(S.ai.session)startAIForCamera(participant.identity);video.addEventListener("loadedmetadata",()=>startRecording(participant.identity),{once:true})});S.room.on(L.RoomEvent.TrackUnsubscribed,(track,publication,participant)=>{const id=participant?.identity;track.detach();if(id)removeCamera(id)});S.room.on(L.RoomEvent.DataReceived,(payload,participant)=>{
let msg;try{msg=JSON.parse(new TextDecoder().decode(payload))}catch(e){return}
if(msg.type==="camera:remove"&&role==="camera"&&msg.target===S.room?.localParticipant?.identity){
for(const p of [...S.room.localParticipant.trackPublications.values()]){
try{awaitMaybeUnpublish(p)}catch(e){}
}
$("cameraMsg").textContent="Camera removed by operator.";
setStatus("REMOVED");
return;
}
if(role==="operator")handleCameraData(msg,participant)
});S.room.on(L.RoomEvent.ParticipantDisconnected,participant=>{if(role==="operator")removeCamera(participant.identity)});S.room.on(L.RoomEvent.Disconnected,()=>{setStatus("OFFLINE");$("roomState").textContent="DISCONNECTED"});const r=await source.fetch({roomName,participantIdentity:identity(role),participantName:role==="operator"?"Operator":"Camera"});if(!r?.serverUrl||!r?.participantToken)throw Error("LiveKit returned incomplete connection details.");await S.room.connect(r.serverUrl,r.participantToken);$("roomState").textContent=roomName+" · CONNECTED";setStatus(role==="operator"?"OPERATOR ONLINE":"CAMERA ONLINE");if(role==="camera")startGps()}
function handleCameraData(msg,participant){const id=participant?.identity||msg.id;if(!id)return;if(msg.type==="camera:hello"){if(!S.cameras.has(id))S.cameras.set(id,{id,name:msg.name||"Camera",loc:null});refreshCameraSelect();updateCounts()}if(msg.type==="gps"&&Number.isFinite(msg.lat)&&Number.isFinite(msg.lon)){const c=S.cameras.get(id)||{id,name:"Camera"};c.lat=msg.lat;c.lon=msg.lon;c.locText=msg.lat.toFixed(5)+", "+msg.lon.toFixed(5);S.cameras.set(id,c);upsertMarker(id,msg.lat,msg.lon,c.name||"Camera");const card=c.card;if(card)c.loc.textContent="GPS: "+c.locText;$("mapHint").textContent="GPS updated: "+(c.name||"Camera");if(S.cameras.size===1&&S.map)S.map.setView([msg.lat,msg.lon],15)}}
function removeCamera(id,operatorAction=false){
const c=S.cameras.get(id);if(!c)return;
if(operatorAction&&S.role==="operator"){
try{
const bytes=new TextEncoder().encode(JSON.stringify({type:"camera:remove",target:id}));
S.room?.localParticipant?.publishData(bytes,{reliable:true,destinationIdentities:[id]});
}catch(e){console.warn("camera remove signal",e)}
S.removedCameras.add(id);
}
if(c.recordTimer)clearTimeout(c.recordTimer);
if(c.recorder?.state==="recording")c.recorder.stop();
c.recording=false;
c.card?.remove();
S.cameras.delete(id);
stopAIForCamera(id);
const m=S.markers.get(id);if(m){m.remove();S.markers.delete(id)}
refreshCameraSelect();updateCounts();
}
function awaitMaybeUnpublish(pub){
try{
if(pub?.track?.mediaStreamTrack)pub.track.mediaStreamTrack.stop();
if(pub?.track&&S.room?.localParticipant?.unpublishTrack)return S.room.localParticipant.unpublishTrack(pub.track);
}catch(e){console.warn("unpublish camera",e)}
}
function startGps(){if(!navigator.geolocation){$("cameraMsg").textContent="This browser does not provide GPS.";return}const publish=pos=>{const lat=pos.coords.latitude,lon=pos.coords.longitude;sendData({type:"gps",lat,lon,accuracy:pos.coords.accuracy||null,id:S.room?.localParticipant?.identity});$("cameraMsg").textContent="Camera LIVE · GPS "+lat.toFixed(5)+", "+lon.toFixed(5)};S.watchId=navigator.geolocation.watchPosition(publish,e=>{$("cameraMsg").textContent="Camera LIVE · GPS unavailable ("+e.message+")"},{enableHighAccuracy:true,maximumAge:5000,timeout:15000})}
document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>showView(b.dataset.view));
try{setAccidentApi(localStorage.getItem("cordds_accident_api")||"")}catch(e){}\n$("operatorBtn").onclick=async()=>{try{unlockAlertAudio();const n=$("room").value.trim()||("cb-"+Math.random().toString(36).slice(2,7));$("room").value=n;await connect(n,"operator");showApp("operator");initMap();showView("cameras");loadAI()}catch(e){$("gateMsg").textContent="Operator connection error: "+(e.message||e);setStatus("ERROR");console.error(e)}};
$("createRoom").onclick=async()=>{try{unlockAlertAudio();const n=$("room").value.trim()||("cb-"+Math.random().toString(36).slice(2,7));$("room").value=n;await connect(n,"operator");showApp("operator");initMap();loadAI()}catch(e){$("roomState").textContent="ERROR: "+(e.message||e);setStatus("ERROR");console.error(e)}};
$("cameraBtn").onclick=()=>showApp("camera");
$("startCamera").onclick=async()=>{const n=$("cameraRoom").value.trim();if(!n){$("cameraMsg").textContent="Enter the operator room ID.";return}let stream;try{$("cameraMsg").textContent="Requesting camera permission…";stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false});$("localVideo").srcObject=stream;$("cameraMsg").textContent="Camera granted. Connecting…";await connect(n,"camera");sendData({type:"camera:hello",name:"Camera",id:S.room.localParticipant.identity});const video=stream.getVideoTracks()[0];if(!video)throw Error("No camera video track was available.");const track=new LivekitClient.LocalVideoTrack(video);await S.room.localParticipant.publishTrack(track,{name:"security-camera"});$("cameraMsg").textContent="Camera is LIVE. Keep this page open."}catch(e){if(stream)stream.getTracks().forEach(t=>t.stop());$("cameraMsg").textContent="Camera error: "+(e.message||e.name);setStatus("ERROR");console.error(e)}};
$("loadAi").onclick=loadAI;$("saveAccidentApi").onclick=()=>{setAccidentApi($("accidentApi").value);for(const id of S.cameras.keys())startAccidentAIForCamera(id)};$("toggleAi").onclick=()=>S.ai.running?stopAI():startAI();$("aiCamera").onchange=()=>{};
$("clearAlerts").onclick=()=>{S.alerts=[];updateCounts();renderAlerts()};$("deleteAllRecordings").onclick=async()=>{if(!confirm("Delete all saved recordings from this browser?"))return;const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction("segments","readwrite");tx.objectStore("segments").clear();tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});refreshStorage()};
$("leave").onclick=async()=>{try{S.collisions.clear();S.removedCameras.clear();stopAI();if(S.watchId!=null)navigator.geolocation.clearWatch(S.watchId);for(const c of S.cameras.values()){if(c.recordTimer)clearTimeout(c.recordTimer);if(c.recorder?.state==="recording")c.recorder.stop()}if(S.room)await S.room.disconnect()}catch(e){}location.reload()};
})();