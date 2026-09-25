(()=>{"use strict";
const $=id=>document.getElementById(id);
const DEFAULT_TOKEN="corddsbase-vzgr9t";
const SEGMENT_MS=120000;
const S={room:null,role:null,tokenId:DEFAULT_TOKEN,roomName:"",cameras:new Map(),markers:new Map(),alerts:[],alertCooldown:new Map(),collisions:new Map(),removedCameras:new Set(),ai:{running:false,cameras:new Map(),timers:new Map(),busy:new Map(),frames:new Map(),agentOnline:false},map:null,watchId:null,db:null,audioCtx:null,accidentApi:"http://127.0.0.1:8000",face:{detector:null,loading:false}};
const COCO=["person","bicycle","car","motorcycle","airplane","bus","train","truck","boat","traffic light","fire hydrant","stop sign","parking meter","bench","bird","cat","dog","horse","sheep","cow","elephant","bear","zebra","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball","kite","baseball bat","baseball glove","skateboard","surfboard","tennis racket","bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple","sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair","couch","potted plant","bed","dining table","toilet","tv","laptop","mouse","remote","keyboard","cell phone","microwave","oven","toaster","sink","refrigerator","book","clock","vase","scissors","teddy bear","hair drier","toothbrush"];
function setStatus(t){$("status").textContent=t}function setVisionBadge(t,mode=""){const b=$("visionAgentBadge");if(b){b.textContent=t;b.className=mode}}
function identity(p){return p+"-"+Math.random().toString(36).slice(2,10)}
function tokenSource(){if(!window.LivekitClient)throw Error("LiveKit SDK did not load. Refresh the page.");if(!LivekitClient.TokenSource?.developmentTokenServer)throw Error("LiveKit TokenSource API is unavailable. Refresh the page.");return LivekitClient.TokenSource.developmentTokenServer(DEFAULT_TOKEN)}
function sendData(obj){if(!S.room?.localParticipant)return;try{const bytes=new TextEncoder().encode(JSON.stringify(obj));S.room.localParticipant.publishData(bytes,{reliable:true})}catch(e){console.warn("data publish",e)}}
function showApp(role){$("gate").hidden=true;$("app").hidden=false;S.role=role;$("operatorPanel").hidden=role!=="operator";$("cameraPanel").hidden=role!=="camera";$("title").textContent=role==="operator"?"Cameras":"Camera";setStatus(role.toUpperCase())}
function showView(view){document.querySelectorAll(".view").forEach(v=>v.hidden=v.id!=="view-"+view);document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("active",b.dataset.view===view));const names={cameras:"Cameras",map:"Live Map",alerts:"Alerts",storage:"Video Storage",ai:"Vision Agent",settings:"Settings"};$("title").textContent=names[view];if(view==="map"&&S.map)setTimeout(()=>S.map.invalidateSize(),50);if(view==="storage")refreshStorage()}
function initMap(){if(S.map||!window.L)return;S.map=L.map("map").setView([20,0],2);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(S.map)}
function upsertMarker(id,lat,lon,name){initMap();if(!S.map)return;let m=S.markers.get(id);if(!m){m=L.marker([lat,lon]).addTo(S.map);m.bindPopup(name);S.markers.set(id,m)}else m.setLatLng([lat,lon]);m.setPopupContent("<b>"+escapeHtml(name)+"</b><br>"+lat.toFixed(5)+", "+lon.toFixed(5))}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
function refreshCameraSelect(){const s=$("aiCamera"),old=s.value;s.innerHTML='<option value="">No camera selected</option>';for(const [id,c] of S.cameras){const o=document.createElement("option");o.value=id;o.textContent=c.name||id;s.appendChild(o)}if(S.cameras.has(old))s.value=old}
function updateCounts(){$("cameraCount").textContent=S.cameras.size;$("alertCount").textContent=S.alerts.length}
function cameraCard(id,name,video){let c=S.cameras.get(id);if(c?.card)return c.card;const card=document.createElement("div");card.className="cam";card.dataset.camera=id;const wrap=document.createElement("div");wrap.className="camVideoWrap";const overlay=document.createElement("canvas");overlay.className="overlay";wrap.appendChild(video);wrap.appendChild(overlay);const meta=document.createElement("div");meta.className="meta";meta.innerHTML="<b>"+escapeHtml(name)+"</b><span class=\"online\">● ONLINE</span>";const tools=document.createElement("div");tools.className="camTools";const ai=document.createElement("button");ai.textContent="AI DETECT";ai.onclick=()=>{showView("ai");$("aiCamera").value=id};tools.append(ai);const accidentStatus=document.createElement("span");accidentStatus.className="small";accidentStatus.textContent="ACCIDENT AI: "+(S.accidentApi?"MONITORING":"NOT CONFIGURED");tools.append(accidentStatus);if(S.role==="operator"){const remove=document.createElement("button");remove.textContent="REMOVE CAMERA";remove.className="dangerBtn";remove.onclick=()=>removeCamera(id,true);tools.append(remove)}const loc=document.createElement("span");loc.className="small";loc.textContent="GPS: waiting";tools.append(loc);card.append(wrap,meta,tools);$("remoteArea").appendChild(card);S.cameras.set(id,{id,name,video,overlay,card,loc,recorder:null,recordTimer:null,recording:false,accidentStatus:accidentStatus});refreshCameraSelect();updateCounts();if(video.readyState>=1)startRecording(id);else video.addEventListener("loadedmetadata",()=>startRecording(id),{once:true});return card}
async function loadFaceBlur(){if(S.face.detector||S.face.loading)return S.face.detector;S.face.loading=true;try{const vision=await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision");const fileset=await vision.FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm");S.face.detector=await vision.FaceDetector.createFromOptions(fileset,{baseOptions:{modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",delegate:"CPU"},runningMode:"VIDEO",minDetectionConfidence:.35,minSuppressionThreshold:.3});return S.face.detector}catch(e){console.error("face blur",e);return null}finally{S.face.loading=false}}
async function startRecording(id){
const c=S.cameras.get(id);if(!c||c.recording)return;const video=c.video;const capture=video.captureStream?.bind(video)||video.mozCaptureStream?.bind(video);if(!capture){c.loc.textContent="Recording unavailable in this browser";return}
const mime=["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm","video/mp4"].find(x=>MediaRecorder.isTypeSupported(x));if(!mime){c.loc.textContent="No supported recording format";return}
const privacy=window.CORDDS_VIEW_ROLE==="operator";
try{
let stream,canvas,ctx,raf=0,faces=[],lastFaceTime=-1;
if(privacy){
const detector=await loadFaceBlur();if(!detector){c.loc.textContent="Privacy recorder unavailable";return}
canvas=document.createElement("canvas");canvas.width=video.videoWidth||1280;canvas.height=video.videoHeight||720;ctx=canvas.getContext("2d");stream=canvas.captureStream(30);c.recording=true;
const render=()=>{if(!c.recording)return;ctx.filter="none";ctx.drawImage(video,0,0,canvas.width,canvas.height);if(video.readyState>=2&&video.currentTime!==lastFaceTime){try{lastFaceTime=video.currentTime;faces=(detector.detectForVideo(video,performance.now()).detections||[]).map(d=>d.boundingBox).filter(Boolean)}catch(e){}}for(const b of faces){const pad=Math.max(10,Math.round(Math.min(b.width,b.height)*.25));const sx=Math.max(0,b.originX-pad),sy=Math.max(0,b.originY-pad),sw=Math.min(canvas.width-sx,b.width+pad*2),sh=Math.min(canvas.height-sy,b.height+pad*2);ctx.save();ctx.filter="blur(20px)";ctx.drawImage(canvas,sx,sy,sw,sh,sx,sy,sw,sh);ctx.restore()}raf=requestAnimationFrame(render)};render();
}else{stream=capture();c.recording=true}
let chunks=[],started=Date.now();
const begin=()=>{chunks=[];started=Date.now();c.recorder=new MediaRecorder(stream,{mimeType});c.recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};c.recorder.onstop=async()=>{const blob=new Blob(chunks,{type:mime});if(blob.size>1000)await saveRecording({camera:c.name,started,ended:Date.now(),blob,type:mime});if(c.recording)begin()};c.recorder.start(1000);c.recordTimer=setTimeout(()=>{if(c.recorder?.state==="recording")c.recorder.stop()},SEGMENT_MS)};begin();
}catch(e){c.recording=false;c.loc.textContent="Recording error"}}

function openDb(){return new Promise((resolve,reject)=>{if(S.db)return resolve(S.db);const r=indexedDB.open("corddsbase-storage",1);r.onupgradeneeded=()=>r.result.createObjectStore("segments",{keyPath:"id",autoIncrement:true});r.onsuccess=()=>{S.db=r.result;resolve(S.db)};r.onerror=()=>reject(r.error)})}
async function saveRecording(x){try{const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction("segments","readwrite");tx.objectStore("segments").add(x);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});refreshStorage()}catch(e){console.warn("recording save",e)}}
async function listRecordings(){const db=await openDb();return new Promise((res,rej)=>{const r=db.transaction("segments").objectStore("segments").getAll();r.onsuccess=()=>res(r.result.sort((a,b)=>b.started-a.started));r.onerror=()=>rej(r.error)})}
async function refreshStorage(){const list=$("storageList");const rows=await listRecordings();$("recordingCount").textContent=rows.length;if(!rows.length){list.className="list empty";list.textContent="No recordings yet.";return}list.className="list";list.innerHTML="";for(const x of rows){const item=document.createElement("div");item.className="recordItem";const meta=document.createElement("div");meta.className="recordMeta";meta.innerHTML="<b>"+escapeHtml(x.camera)+"</b><span>"+new Date(x.started).toLocaleString()+" · 2-minute segment</span>";const actions=document.createElement("div");actions.className="recordActions";const dl=document.createElement("button");dl.textContent="DOWNLOAD";dl.onclick=()=>{const u=URL.createObjectURL(x.blob);const a=document.createElement("a");a.href=u;a.download="CORDDS_"+x.camera.replace(/\W+/g,"_")+"_"+x.started+"."+((x.type||"").includes("mp4")?"mp4":"webm");a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};const del=document.createElement("button");del.textContent="DELETE";del.onclick=async()=>{const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction("segments","readwrite");tx.objectStore("segments").delete(x.id);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});refreshStorage()};actions.append(dl,del);item.append(meta,actions);list.appendChild(item)}}
function unlockAlertAudio(){try{if(!S.audioCtx)S.audioCtx=new (window.AudioContext||window.webkitAudioContext)();if(S.audioCtx.state==="suspended")S.audioCtx.resume()}catch(e){console.warn("alert audio",e)}}
function setAccidentApi(url){S.accidentApi=(url||"").trim().replace(/\/$/,"");if(S.accidentApi)localStorage.setItem("cordds_accident_api",S.accidentApi);const el=$("accidentApiStatus");if(el)el.textContent=S.accidentApi?"ACCIDENT AI BACKEND CONFIGURED":"ACCIDENT AI BACKEND NOT CONFIGURED"}
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
    if(data.accident){reportCollision(c,"AI-"+Math.floor(Date.now()/8000),Math.max(.20,Math.min(.99,Number(data.confidence)||.20)));}
    if(c.accidentStatus)c.accidentStatus.textContent=data.accident?"ACCIDENT CONFIRMED · "+Math.round(data.confidence*100)+"%":"AI MONITORING · "+Math.round((Number(data.confidence)||0)*100)+"%";
  }catch(e){if(c.accidentStatus)c.accidentStatus.textContent="ACCIDENT AI OFFLINE";}
  finally{c.accidentBusy=false;}
}
function startAccidentAIForCamera(id){const c=S.cameras.get(id);if(!c||!S.accidentApi||c.accidentTimer)return;const loop=()=>{if(!c.accidentTimer)return;sendAccidentFrame(id).finally(()=>{if(c.accidentTimer)requestAnimationFrame(loop)})};c.accidentTimer=true;loop()}
function stopAccidentAIForCamera(id){const c=S.cameras.get(id);if(c)c.accidentTimer=null}
function playAlertSound(){try{unlockAlertAudio();const ctx=S.audioCtx;if(!ctx)return;const now=ctx.currentTime;const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type="square";osc.frequency.setValueAtTime(880,now);osc.frequency.setValueAtTime(660,now+.10);gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.18,now+.015);gain.gain.exponentialRampToValueAtTime(.0001,now+.28);osc.connect(gain);gain.connect(ctx.destination);osc.start(now);osc.stop(now+.30)}catch(e){console.warn("alert sound",e)}}
function addAlert(camera,label,score){const key=camera+"|"+label;const now=Date.now();const last=S.alertCooldown.get(key)||0;if(now-last<10000)return;S.alertCooldown.set(key,now);const a={camera,label,score,time:now};S.alerts.unshift(a);S.alerts=S.alerts.slice(0,200);updateCounts();renderAlerts()}
function reportCollision(c,pairKey,score,reason){
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
setVisionBadge("VISION AGENT: COLLISION","alert");
setTimeout(()=>{if(S.ai.agentOnline)setVisionBadge("VISION AGENT: ONLINE","online")},3500);
addAlert(c.name||"Camera","VEHICLE COLLISION"+(reason?" · "+reason:""),score);
playAlertTone();
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
async function checkVisionAgent(){
try{
const r=await fetch(S.accidentApi+"/health",{cache:"no-store"});
const h=await r.json();
S.ai.agentOnline=!!h.ok;
setVisionBadge(h.ok?"VISION AGENT: ONLINE":"VISION AGENT: OFFLINE",h.ok?"online":"");
$("aiStatus").textContent=h.ok?"VISION AGENT ONLINE · watching connected cameras":"VISION AGENT OFFLINE · start the accident AI server";
$("aiStatus").className="aiStatus "+(h.ok?"ready":"error");
$("toggleAi").disabled=!h.ok;
return h.ok;
}catch(e){
S.ai.agentOnline=false;
setVisionBadge("VISION AGENT: OFFLINE","");
$("aiStatus").textContent="VISION AGENT OFFLINE · "+(e.message||"server unavailable");
$("aiStatus").className="aiStatus error";
$("toggleAi").disabled=true;
return false;
}}
function captureAgentFrame(video){
const w=Math.min(640,video.videoWidth||640),h=Math.max(1,Math.round(w*(video.videoHeight||360)/(video.videoWidth||640)));
const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
canvas.getContext("2d",{alpha:false}).drawImage(video,0,0,w,h);
return canvas.toDataURL("image/jpeg",0.72).split(",")[1];
}
async function sendVisionFrame(id){
const c=S.cameras.get(id);
if(!S.ai.running||!c||!c.video||c.video.readyState<2||S.ai.busy.get(id))return;
S.ai.busy.set(id,true);
try{
const jpeg=captureAgentFrame(c.video);
const r=await fetch(S.accidentApi+"/frame",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({camera_id:id,timestamp:Date.now()/1000,jpeg_base64:jpeg})});
const data=await r.json();
if(!r.ok)throw new Error(data.detail||"vision agent request failed");
c.accidentStatus&&(c.accidentStatus.textContent=data.collision_visible?"ACCIDENT AI: COLLISION VISIBLE":"ACCIDENT AI: MONITORING");
const count=Number(data.vehicle_count||0);
$("aiStatus").textContent="VISION AGENT ONLINE · "+S.cameras.size+" camera(s) · "+count+" vehicle(s) in latest frame";
if(data.accident)reportCollision(c,id,Number(data.confidence||0),data.reason||"Vision agent detected a collision");
}catch(e){
console.warn("vision agent",e);
c.accidentStatus&&(c.accidentStatus.textContent="ACCIDENT AI: SERVER ERROR");
}finally{S.ai.busy.set(id,false)}}
function scheduleVision(id){
if(!S.ai.running)return;
clearTimeout(S.ai.timers.get(id));
S.ai.timers.set(id,setTimeout(async()=>{await sendVisionFrame(id);scheduleVision(id)},250));
}
async function startAIForCamera(id){
if(!S.cameras.has(id))return;
S.ai.cameras.set(id,true);
if(!S.ai.running)S.ai.running=true;
scheduleVision(id);
}
function stopAIForCamera(id){
S.ai.cameras.delete(id);clearTimeout(S.ai.timers.get(id));S.ai.timers.delete(id);S.ai.busy.delete(id);
if(!S.ai.cameras.size)S.ai.running=false;
}
async function startAI(){
if(!(await checkVisionAgent()))return;
S.ai.running=true;
for(const id of S.cameras.keys())startAIForCamera(id);
$("toggleAi").textContent="PAUSE VISION AGENT";
}
function stopAI(){
S.ai.running=false;
for(const id of [...S.ai.cameras.keys()]){clearTimeout(S.ai.timers.get(id));S.ai.timers.delete(id);S.ai.busy.delete(id)}
S.ai.cameras.clear();
$("toggleAi").textContent="START VISION AGENT";
$("aiStatus").textContent="VISION AGENT PAUSED.";setVisionBadge("VISION AGENT: PAUSED","");
}
async function connect(roomName,role){const L=LivekitClient;const source=tokenSource();if(S.room){try{await S.room.disconnect()}catch(e){}}S.room=new L.Room({adaptiveStream:true,dynacast:true});S.roomName=roomName;S.room.on(L.RoomEvent.TrackSubscribed,(track,publication,participant)=>{if(role!=="operator"||track.kind!=="video")return;const video=track.attach();video.autoplay=true;video.playsInline=true;const id=participant.identity;if(S.removedCameras.has(id)){track.detach();return}const name=participant?.name||participant?.identity||"Camera";cameraCard(id,name,video);if(S.ai.running)startAIForCamera(participant.identity);video.addEventListener("loadedmetadata",()=>startRecording(participant.identity),{once:true})});S.room.on(L.RoomEvent.TrackUnsubscribed,(track,publication,participant)=>{const id=participant?.identity;track.detach();if(id)removeCamera(id)});S.room.on(L.RoomEvent.DataReceived,(payload,participant)=>{
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
try{setAccidentApi(localStorage.getItem("cordds_accident_api")||"http://127.0.0.1:8000")}catch(e){setAccidentApi("http://127.0.0.1:8000")}
$("operatorBtn").onclick=async()=>{try{unlockAlertAudio();const n=$("room").value.trim()||("cb-"+Math.random().toString(36).slice(2,7));$("room").value=n;await connect(n,"operator");showApp("operator");initMap();showView("cameras");startAI()}catch(e){$("gateMsg").textContent="Operator connection error: "+(e.message||e);setStatus("ERROR");console.error(e)}};
$("createRoom").onclick=async()=>{try{unlockAlertAudio();localStorage.setItem("cordds_room",$("room").value.trim());const n=$("room").value.trim()||("cb-"+Math.random().toString(36).slice(2,7));$("room").value=n;await connect(n,"operator");showApp("operator");if(window.CORDDS_VIEW_ROLE==="legal")setStatus("LEGAL ONLINE");initMap();showView("cameras");startAI()}catch(e){$("roomState").textContent="ERROR: "+(e.message||e);setStatus("ERROR");console.error(e)}};
$("cameraBtn").onclick=()=>showApp("camera");
$("startCamera").onclick=async()=>{const n=$("cameraRoom").value.trim();if(!n){$("cameraMsg").textContent="Enter the operator room ID.";return}let stream;try{$("cameraMsg").textContent="Requesting camera permission…";stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false});$("localVideo").srcObject=stream;$("cameraMsg").textContent="Camera granted. Connecting…";await connect(n,"camera");sendData({type:"camera:hello",name:"Camera",id:S.room.localParticipant.identity});const video=stream.getVideoTracks()[0];if(!video)throw Error("No camera video track was available.");const track=new LivekitClient.LocalVideoTrack(video);await S.room.localParticipant.publishTrack(track,{name:"security-camera"});$("cameraMsg").textContent="Camera is LIVE. Keep this page open."}catch(e){if(stream)stream.getTracks().forEach(t=>t.stop());$("cameraMsg").textContent="Camera error: "+(e.message||e.name);setStatus("ERROR");console.error(e)}};
$("loadAi").onclick=checkVisionAgent;$("toggleAi").onclick=()=>S.ai.running?stopAI():startAI();$("aiCamera").onchange=()=>{};
$("clearAlerts").onclick=()=>{S.alerts=[];updateCounts();renderAlerts()};$("deleteAllRecordings").onclick=async()=>{if(!confirm("Delete all saved recordings from this browser?"))return;const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction("segments","readwrite");tx.objectStore("segments").clear();tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});refreshStorage()};
$("leave").onclick=async()=>{try{S.collisions.clear();S.removedCameras.clear();stopAI();if(S.watchId!=null)navigator.geolocation.clearWatch(S.watchId);for(const c of S.cameras.values()){if(c.recordTimer)clearTimeout(c.recordTimer);if(c.recorder?.state==="recording")c.recorder.stop()}if(S.room)await S.room.disconnect()}catch(e){}location.reload()};
})();