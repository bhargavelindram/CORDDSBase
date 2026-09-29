(()=>{"use strict";
const $=id=>document.getElementById(id);
const DEFAULT_TOKEN="corddsbase-vzgr9t";
const GLOBAL_REGISTRY_ROOM="CORDDS-GLOBAL-REGISTRY";
const LEGAL_USER="legal";
const LEGAL_PASSWORD="legal";
const OPERATOR_USER="op";
const OPERATOR_PASSWORD="op";
const YOLO_THRESHOLD=.20;
const YOLO_MODEL="https://huggingface.co/webnn/yolo11n/resolve/main/onnx/yolo11n.onnx?download=true";
const SEGMENT_MS=120000;
const S={musicEnabled:true,musicCurrentId:null,musicPaused:false,musicSearchResults:[],musicSearchQuery:"",musicQueue:[],room:null,role:null,tokenId:DEFAULT_TOKEN,roomName:"",cameras:new Map(),markers:new Map(),alerts:[],alertCooldown:new Map(),collisions:new Map(),removedCameras:new Set(),ai:{session:null,loading:false,running:false,cameras:new Map(),timers:new Map(),ort:null},map:null,cameraMap:null,globalMap:null,globalMarkers:new Map(),registryRoom:null,globalCameras:new Map(),watchId:null,db:null,audioCtx:null,audioBeatTimer:null,alarmNodes:new Set(),soundOn:true,hospitalLayer:null,attentionBusy:false,music:[],musicLoaded:false,musicPlayerApi:null,hospitalStatusTimer:null,hospitalDirectory:new Map()};
const COCO=["person","bicycle","car","motorcycle","airplane","bus","train","truck","boat","traffic light","fire hydrant","stop sign","parking meter","bench","bird","cat","dog","horse","sheep","cow","elephant","bear","zebra","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee","skis","snowboard","sports ball","kite","baseball bat","baseball glove","skateboard","surfboard","tennis racket","bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple","sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair","couch","potted plant","bed","dining table","toilet","tv","laptop","mouse","remote","keyboard","cell phone","microwave","oven","toaster","sink","refrigerator","book","clock","vase","scissors","teddy bear","hair drier","toothbrush"];
function setStatus(t){$("status").textContent=t}
function identity(p){return p+"-"+Math.random().toString(36).slice(2,10)}
function tokenSource(){if(!window.LivekitClient)throw Error("LiveKit SDK did not load. Refresh the page.");if(!LivekitClient.TokenSource?.developmentTokenServer)throw Error("LiveKit TokenSource API is unavailable. Refresh the page.");return LivekitClient.TokenSource.developmentTokenServer(DEFAULT_TOKEN)}
function sendData(obj){if(!S.room?.localParticipant)return;try{const bytes=new TextEncoder().encode(JSON.stringify(obj));S.room.localParticipant.publishData(bytes,{reliable:true})}catch(e){console.warn("data publish",e)}}
const TELLAPUR_HOSPITALS=[
{name:"Airaavata Multispeciality Hospital",area:"Tellapur",address:"Near Nallagandla–Tellapur Road, Tellapur, Hyderabad"},
{name:"SSV Hospital",area:"Tellapur",address:"HUDA Colony, Road No. 13, Tellapur, Hyderabad"},
{name:"Medicus Hospital",area:"Tellapur / Nallagandla",address:"Kanchi Gachibowli Road, Tellapur, Hyderabad"},
{name:"Aparna Hospitals",area:"Nallagandla",address:"Navodaya Colony, Kanchi Gachibowli Road, Nallagandla"},
{name:"Aksha Hospitals",area:"Gopanapally / Nallagandla",address:"Gopanapally, Serilingampalle, Hyderabad"},
{name:"Citizens Specialty Hospital",area:"Nallagandla",address:"Nallagandla, Hyderabad"},
{name:"Continental Hospitals",area:"Gachibowli",address:"Financial District / Gachibowli, Hyderabad"},
{name:"AIG Hospitals",area:"Gachibowli",address:"Mindspace Road, Gachibowli, Hyderabad"}
];
const HOSPITAL_STATES=["ACCEPTING","ACCEPTING","LIMITED CAPACITY","ACCEPTING","BUSY","ACCEPTING"];
function hospitalState(name){let h=S.hospitalDirectory.get(name);if(!h){h={index:Math.floor(Math.random()*HOSPITAL_STATES.length),updated:Date.now()};S.hospitalDirectory.set(name,h)}return HOSPITAL_STATES[h.index%HOSPITAL_STATES.length]}
function advanceHospitalStatuses(){for(const h of TELLAPUR_HOSPITALS){const cur=S.hospitalDirectory.get(h.name)||{index:0};cur.index=(cur.index+1)%HOSPITAL_STATES.length;cur.updated=Date.now();S.hospitalDirectory.set(h.name,cur)}refreshIncidentHospitalList();renderCollisionControl()}
function startHospitalStatusSimulation(){if(S.hospitalStatusTimer)return;for(const h of TELLAPUR_HOSPITALS)hospitalState(h.name);S.hospitalStatusTimer=setInterval(advanceHospitalStatuses,12000)}
function refreshIncidentHospitalList(){
const list=$("hospitalList");if(!list)return;
list.innerHTML=TELLAPUR_HOSPITALS.map(h=>'<div class="hospitalRow"><div class="hospitalInfo"><b>'+escapeHtml(h.name)+'</b><div class="small">'+escapeHtml(h.area)+' · '+escapeHtml(h.address)+'</div></div><span class="hospitalStatus '+hospitalState(h.name).toLowerCase().replace(/ /g,"-")+'">'+hospitalState(h.name)+'</span></div>').join("");
}

function showApp(role){$("gate").hidden=true;$("app").hidden=false;S.role=role;$("operatorPanel").hidden=role!=="operator";$("cameraPanel").hidden=role!=="camera";$("operatorNav").hidden=role!=="operator";$("legalNav").hidden=role!=="legal";$("content").classList.toggle("cameraOnlyMode",role==="camera");$("title").textContent=role==="operator"?"Cameras":role==="legal"?"Video Storage":"";setStatus(role.toUpperCase());if(role==="camera"){showView("cameras");initCameraMap()}if(role==="legal"){showView("legal-storage");initGlobalMap();connectGlobalRegistry("legal").catch(e=>console.warn("legal registry",e));refreshLegalStorage()}}
const MUSIC_API_BASES=["http://127.0.0.1:8000","http://localhost:8000"];
function musicBackendStatus(message){const n=$("musicNow");if(n)n.textContent=message;const c=$("musicLibraryCount");if(c)c.textContent=message}
function loadYouTubePlayerApi(){
return new Promise((resolve,reject)=>{
if(window.YT?.Player){resolve();return}
if(window.__ytmApiPromise){window.__ytmApiPromise.then(resolve,reject);return}
window.__ytmApiPromise=new Promise((res,rej)=>{
const old=window.onYouTubeIframeAPIReady;
window.onYouTubeIframeAPIReady=()=>{try{old?.();}catch(e){}res()};
const s=document.createElement("script");s.src="https://www.youtube.com/iframe_api";s.onerror=rej;document.head.appendChild(s);
});
window.__ytmApiPromise.then(resolve,reject);
});
}
function musicThumbnail(x){return x?.videoId?"https://i.ytimg.com/vi/"+encodeURIComponent(x.videoId)+"/hqdefault.jpg":""}
function setMusicUi(x){
const now=$("musicNow"),title=$("musicNowTitle"),artist=$("musicNowArtist"),art=$("musicArtwork");
if(now)now.textContent=x?x.title+" · "+(x.artist||"Unknown artist"):"SELECT A SONG TO PLAY";
if(title)title.textContent=x?.title||"NOT PLAYING";
if(artist)artist.textContent=x?.artist||"Search for a song to begin";
if(art){
const thumb=musicThumbnail(x);
art.innerHTML=thumb?'<img src="'+thumb+'" alt="">':'<span>♪</span>';
}
document.querySelectorAll(".musicItem").forEach(el=>el.classList.toggle("active",String(el.dataset.musicId)===String(x?.id)));
}
function setMusicPlaying(playing){
document.querySelector(".musicPlayerWrap")?.classList.toggle("playing",!!playing);
["musicPlayPause","musicMainPlayPause"].forEach(id=>{const b=$(id);if(b)b.textContent=playing?"PAUSE":"PLAY"});
S.musicPaused=!playing;
}
async function ensureMusicPlayer(){
await loadYouTubePlayerApi();
if(S.musicPlayerApi)return S.musicPlayerApi;
S.musicPlayerApi=new YT.Player("musicPlayer",{
width:"320",height:"200",
playerVars:{autoplay:0,controls:0,playsinline:1,rel:0,iv_load_policy:3,disablekb:1,origin:location.origin},
events:{
onReady:()=>{setMusicPlaying(false)},
onStateChange:e=>{
if(e.data===1)setMusicPlaying(true);
else if(e.data===2)setMusicPlaying(false);
else if(e.data===0){nextMusic()}
},
onAutoplayBlocked:()=>{const n=$("musicNow");if(n)n.textContent="AUTOPLAY BLOCKED · PRESS PLAY";setMusicPlaying(false)},
onError:e=>{
console.warn("YouTube embed error",e.data);
const i=S.musicQueue.findIndex(t=>String(t.id)===String(S.musicCurrentId));
if((e.data===101||e.data===150||e.data===100||e.data===5)&&i>=0&&S.musicQueue.length>1){
const next=S.musicQueue[(i+1)%S.musicQueue.length];
if(next.id!==S.musicCurrentId){playMusic(next.id,true);return}
}
setMusicPlaying(false);
const n=$("musicNow");if(n)n.textContent="THIS SONG CANNOT PLAY IN AN EMBEDDED PLAYER";
}
}
});
return S.musicPlayerApi;
}
function localMusicMatches(q){
const term=String(q||"").trim().toLowerCase();
if(!term)return [];
return (S.music||[]).filter(x=>((x.title||"")+" "+(x.artist||"")).toLowerCase().includes(term)).slice(0,30).map(x=>({...x,source:"corddsbase-library"}));
}
async function searchYouTubeMusic(){
const q=($("musicSearch")?.value||"").trim();
const list=$("musicList"),count=$("musicLibraryCount"),btn=$("musicSearchBtn");
if(!q){
if(list)list.innerHTML='<div class="list empty">SEARCH FOR A SONG OR ARTIST.</div>';
if(count)count.textContent="SEARCH REQUIRED";
return;
}
if(btn){btn.disabled=true;btn.textContent="SEARCHING…";}
if(list)list.innerHTML='<div class="list empty">SEARCHING YOUTUBE MUSIC CATALOGUE…</div>';
try{
let data=null,lastError=null;
for(const base of MUSIC_API_BASES){
try{
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),15000);
const requestUrl=base+"/music/search?q="+encodeURIComponent(q)+"&limit=100";
const fetchOptions={cache:"no-store",signal:controller.signal,mode:"cors"};
if(location.protocol==="https:" && /^(http:\/\/)(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base))fetchOptions.targetAddressSpace="loopback";
const r=await fetch(requestUrl,fetchOptions);
clearTimeout(timer);
if(!r.ok)throw Error("HTTP "+r.status);
data=await r.json();
break;
}catch(err){lastError=err}
}
if(!data){const detail=lastError?.name==="AbortError"?"BACKEND TIMEOUT · START LOCAL MUSIC SERVER":(lastError?.message||"BACKEND CONNECTION FAILED");musicBackendStatus(detail);throw lastError||Error("Music search service unavailable")}
S.musicSearchResults=(data.results||[]).map(x=>({...x,source:"youtube-music"}));
S.musicSearchQuery=q;
S.musicQueue=S.musicSearchResults.slice();
renderMusic();
if(count)count.textContent=S.musicSearchResults.length+" YOUTUBE MUSIC RESULTS";
if(!S.musicSearchResults.length&&list)list.innerHTML='<div class="list empty">NO SONGS FOUND IN YOUTUBE MUSIC.</div>';
}catch(e){
S.musicSearchResults=[];
S.musicQueue=[];
if(list)list.innerHTML='<div class="list empty">YOUTUBE MUSIC SEARCH IS CURRENTLY UNAVAILABLE.<br><small>'+escapeHtml(e?.message||e?.name||"Backend connection failed")+'</small></div>';
if(count)count.textContent="SEARCH UNAVAILABLE";
console.warn("YouTube Music search",e);
}finally{
if(btn){btn.disabled=false;btn.textContent="SEARCH";}
}
}
async function loadMusicLibrary(){
if(S.musicLoaded)return;
try{
const r=await fetch("music.json?v=20260929",{cache:"no-store"});if(!r.ok)throw Error("Music library "+r.status);
const d=await r.json();S.music=d.tracks||[];S.musicLoaded=true;
const count=$("musicLibraryCount");if(count)count.textContent="SEARCH READY";
const list=$("musicList");if(list)list.innerHTML='<div class="list empty">SEARCH FOR A SONG OR ARTIST.</div>';
}catch(e){S.musicLoaded=true;console.warn("music",e)}
}
function renderMusic(){
const el=$("musicList");if(!el)return;
const q=($("musicSearch")?.value||"").trim().toLowerCase();
const source=S.musicSearchResults?.length?S.musicSearchResults:(q?localMusicMatches(q):[]);
S.musicQueue=source.slice();
if(!q){el.innerHTML='<div class="list empty">SEARCH FOR A SONG OR ARTIST.</div>';return}
el.innerHTML=source.slice(0,100).map(x=>{
const thumb=musicThumbnail(x);
return '<div class="musicItem" data-music-id="'+escapeHtml(String(x.id))+'"><div class="musicMain">'+(thumb?'<img class="musicThumb" src="'+thumb+'" alt="">':'<div class="musicThumb"></div>')+'<div class="musicText"><b>'+escapeHtml(x.title)+'</b><span>'+escapeHtml(x.artist||"Unknown artist")+'</span></div></div><div class="musicActions"><small>'+(x.source==="youtube-music"?"YT MUSIC":"CORDDSBASE")+'</small><button data-play-music="'+escapeHtml(String(x.id))+'">PLAY</button></div></div>'
}).join("")||'<div class="list empty">NO SONGS FOUND.</div>';
el.querySelectorAll("[data-play-music]").forEach(b=>b.onclick=()=>playMusic(b.dataset.playMusic));
}
async function playMusic(id,fromError=false){
if(!S.musicEnabled)return;
const x=(S.musicQueue||[]).find(t=>String(t.id)===String(id))||(S.music||[]).find(t=>String(t.id)===String(id));
if(!x)return;
S.musicCurrentId=x.id;S.musicPaused=false;setMusicUi(x);
try{
const player=await ensureMusicPlayer();
if(!x.videoId&&x.playUrl){
try{x.videoId=new URL(x.playUrl).searchParams.get("v")}catch(e){}
}
if(!x.videoId)throw Error("No playable video ID");
player.loadVideoById(x.videoId);
if(!fromError)setMusicPlaying(true);
}catch(e){
console.warn("playMusic",e);
setMusicPlaying(false);
const n=$("musicNow");if(n)n.textContent="PLAYER COULD NOT LOAD THIS SONG";
}
}
function sendMusicCommand(func){
const p=S.musicPlayerApi;if(!p)return;
try{p[func]?.()}catch(e){console.warn("music command",e)}
}
function toggleMusicPlay(){
if(!S.musicEnabled)return;
if(!S.musicCurrentId){const first=S.musicQueue?.[0];if(first)playMusic(first);return}
if(S.musicPaused){sendMusicCommand("playVideo")}else{sendMusicCommand("pauseVideo")}
}
function nextMusic(){
if(!S.musicEnabled||!S.musicQueue?.length)return;
let i=S.musicQueue.findIndex(x=>String(x.id)===String(S.musicCurrentId));i=i<0?0:(i+1)%S.musicQueue.length;playMusic(S.musicQueue[i].id);
}
function previousMusic(){
if(!S.musicEnabled||!S.musicQueue?.length)return;
let i=S.musicQueue.findIndex(x=>String(x.id)===String(S.musicCurrentId));i=i<=0?S.musicQueue.length-1:i-1;playMusic(S.musicQueue[i].id);
}
function showView(view){document.querySelectorAll(".view").forEach(v=>v.hidden=v.id!=="view-"+view);document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("active",b.dataset.view===view));const names={cameras:"Cameras",map:"Live Map",alerts:"Alerts",storage:"Video Storage",ai:"YOLO11 Detection",music:"Music",settings:"Settings","legal-storage":"Video Storage","global-map":"Global Camera Map"};$("title").textContent=names[view];if(view==="map"&&S.map){setTimeout(()=>{S.map.invalidateSize();loadHospitals()},50)}if(view==="global-map"&&S.globalMap)setTimeout(()=>S.globalMap.invalidateSize(),50);if(view==="music")loadMusicLibrary();if(view==="legal-storage")refreshLegalStorage();if(view==="storage")refreshStorage()}
function initMap(){if(S.map||!window.L)return;S.map=L.map("map").setView([17.3850,78.4867],11);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(S.map)}async function loadHospitals(){if(!S.map||!window.L)return;const center=S.map.getCenter();const radius=18000;const q='[out:json][timeout:20];(node["amenity"="hospital"](around:'+radius+','+center.lat+','+center.lng+');way["amenity"="hospital"](around:'+radius+','+center.lat+','+center.lng+'););out center tags;';const btn=$("loadHospitals");if(btn)btn.disabled=true;try{const r=await fetch("https://overpass-api.de/api/interpreter?data="+encodeURIComponent(q));if(!r.ok)throw Error("Hospital map "+r.status);const d=await r.json();if(S.hospitalLayer)S.hospitalLayer.clearLayers();S.hospitalLayer=L.layerGroup().addTo(S.map);let n=0;for(const x of d.elements||[]){const lat=x.lat??x.center?.lat,lon=x.lon??x.center?.lon;if(!Number.isFinite(lat)||!Number.isFinite(lon)||n>=100)continue;const name=x.tags?.name||"Hospital";const icon=L.divIcon({className:"hospitalPlusIcon",html:"<span>+</span>",iconSize:[26,26],iconAnchor:[13,13]});const m=L.marker([lat,lon],{icon});m.bindPopup("<b>"+escapeHtml(name)+"</b><br><span style='color:#ff1738'>✚ Hospital</span>");m.addTo(S.hospitalLayer);n++}$("mapHint").textContent=n+" hospital locations loaded";}catch(e){$("mapHint").textContent="Hospital data unavailable right now";console.warn(e)}finally{if(btn)btn.disabled=false}}

function upsertMarker(id,lat,lon,name){initMap();if(!S.map)return;let m=S.markers.get(id);if(!m){m=L.marker([lat,lon]).addTo(S.map);m.bindPopup(name);S.markers.set(id,m)}else m.setLatLng([lat,lon]);m.setPopupContent("<b>"+escapeHtml(name)+"</b><br>"+lat.toFixed(5)+", "+lon.toFixed(5))}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
function refreshCameraSelect(){const s=$("aiCamera"),old=s.value;s.innerHTML='<option value="">No camera selected</option>';for(const [id,c] of S.cameras){const o=document.createElement("option");o.value=id;o.textContent=c.name||id;s.appendChild(o)}if(S.cameras.has(old))s.value=old}
function updateCounts(){$("cameraCount").textContent=S.cameras.size;$("alertCount").textContent=S.alerts.length}
function cameraCard(id,name,video){let c=S.cameras.get(id);if(c?.card)return c.card;const card=document.createElement("div");card.className="cam";card.dataset.camera=id;const wrap=document.createElement("div");wrap.className="camVideoWrap";const overlay=document.createElement("canvas");overlay.className="overlay";wrap.appendChild(video);wrap.appendChild(overlay);const meta=document.createElement("div");meta.className="meta";meta.innerHTML="<b>"+escapeHtml(name)+"</b><span class=\"online\">● ONLINE</span>";const tools=document.createElement("div");tools.className="camTools";const ai=document.createElement("button");ai.textContent="AI DETECT";ai.onclick=()=>{showView("ai");$("aiCamera").value=id};tools.append(ai);if(S.role==="operator"){const remove=document.createElement("button");remove.textContent="REMOVE CAMERA";remove.className="dangerBtn";remove.onclick=()=>removeCamera(id,true);tools.append(remove)}const loc=document.createElement("span");loc.className="small";loc.textContent="GPS: waiting";tools.append(loc);card.append(wrap,meta,tools);$("remoteArea").appendChild(card);S.cameras.set(id,{id,name,video,overlay,card,loc,recorder:null,recordTimer:null,recording:false});refreshCameraSelect();updateCounts();if(video.readyState>=1){startRecording(id);startAccidentAIForCamera(id)}else video.addEventListener("loadedmetadata",()=>{startRecording(id);startAccidentAIForCamera(id)},{once:true});return card}
async function startRecording(id){
const c=S.cameras.get(id);if(!c||c.recording)return;const video=c.video;const capture=video.captureStream?.bind(video)||video.mozCaptureStream?.bind(video);if(!capture){c.loc.textContent="Recording unavailable in this browser";return}
const mime=["video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm","video/mp4"].find(x=>MediaRecorder.isTypeSupported(x));if(!mime){c.loc.textContent="No supported recording format";return}
try{const stream=capture();const begin=()=>{c.recordChunks=[];c.recordSegmentStarted=Date.now();c.recording=true;c.recordMime=mime;c.recorder=new MediaRecorder(stream,{mimeType:mime});c.recorder.ondataavailable=e=>{if(e.data.size)c.recordChunks.push(e.data)};c.recorder.onstop=async()=>{const blob=new Blob(c.recordChunks,{type:mime});if(blob.size>1000)await saveRecording({camera:c.name,place:c.locText||"Location unavailable",started:c.recordSegmentStarted,ended:Date.now(),blob,type:mime});if(c.recording)begin()};c.recorder.start(1000);c.recordTimer=setTimeout(()=>{if(c.recorder?.state==="recording")c.recorder.stop()},SEGMENT_MS)};begin()}catch(e){c.loc.textContent="Recording error";console.warn(e)}}
async function makeReplay(c,alertTime){
if(!c?.recordChunks?.length)return null;
try{
if(c.recorder?.state==="recording")await new Promise(resolve=>{let done=false;const finish=()=>{if(!done){done=true;resolve()}};c.recorder.addEventListener("dataavailable",finish,{once:true});try{c.recorder.requestData()}catch(e){}setTimeout(finish,700)});
const type=c.recorder?.mimeType||c.recordMime||"video/webm";
const blob=new Blob(c.recordChunks,{type});
if(blob.size<1000)return null;
const offset=Math.max(0,(alertTime-(c.recordSegmentStarted||alertTime))/1000-8);
return {blob,offset};
}catch(e){console.warn("replay capture",e);return null}}

function openDb(){return new Promise((resolve,reject)=>{if(S.db)return resolve(S.db);const r=indexedDB.open("corddsbase-storage",1);r.onupgradeneeded=()=>r.result.createObjectStore("segments",{keyPath:"id",autoIncrement:true});r.onsuccess=()=>{S.db=r.result;resolve(S.db)};r.onerror=()=>reject(r.error)})}
async function saveRecording(x){try{const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction("segments","readwrite");tx.objectStore("segments").add(x);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});refreshStorage()}catch(e){console.warn("recording save",e)}}
async function listRecordings(){const db=await openDb();return new Promise((res,rej)=>{const r=db.transaction("segments").objectStore("segments").getAll();r.onsuccess=()=>res(r.result.sort((a,b)=>b.started-a.started));r.onerror=()=>rej(r.error)})}
async function refreshLegalStorage(){
const list=$("legalStorageList");if(!list)return;const rows=await listRecordings();const date=$("legalDate")?.value||"",from=$("legalFrom")?.value||"",to=$("legalTo")?.value||"",place=($("legalPlace")?.value||"").trim().toLowerCase();
const filtered=rows.filter(x=>{const d=new Date(x.started),ds=d.toISOString().slice(0,10),tm=d.toTimeString().slice(0,5),pl=((x.place||"")+" "+(x.camera||"")).toLowerCase();if(date&&ds!==date)return false;if(from&&tm<from)return false;if(to&&tm>to)return false;if(place&&!pl.includes(place))return false;return true});
$("legalRecordingCount").textContent=filtered.length;if(!filtered.length){list.className="list empty";list.textContent="No recordings match the selected filters.";return}list.className="list";list.innerHTML="";
for(const x of filtered){const item=document.createElement("div");item.className="recordItem";const meta=document.createElement("div");meta.className="recordMeta";meta.innerHTML="<b>"+escapeHtml(x.camera||"Camera")+"</b><span>"+escapeHtml(x.place||"Location unavailable")+" · "+new Date(x.started).toLocaleString()+"</span>";const actions=document.createElement("div");actions.className="recordActions";const play=document.createElement("button");play.textContent="PLAY";play.onclick=()=>{const u=URL.createObjectURL(x.blob);const w=window.open("","_blank");if(w){w.document.write("<title>CORDDS Evidence Replay</title><video controls autoplay style='max-width:100%;width:100%;background:#000' src='"+u+"'></video>");w.document.close()}else URL.revokeObjectURL(u)};const dl=document.createElement("button");dl.textContent="DOWNLOAD";dl.onclick=()=>{const u=URL.createObjectURL(x.blob),a=document.createElement("a");a.href=u;a.download="CORDDS_EVIDENCE_"+(x.camera||"Camera").replace(/\W+/g,"_")+"_"+x.started+"."+((x.type||"").includes("mp4")?"mp4":"webm");a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};actions.append(play,dl);item.append(meta,actions);list.appendChild(item)}
}
async function refreshStorage(){const list=$("storageList");const rows=await listRecordings();$("recordingCount").textContent=rows.length;if(!rows.length){list.className="list empty";list.textContent="No recordings yet.";return}list.className="list";list.innerHTML="";for(const x of rows){const item=document.createElement("div");item.className="recordItem";const meta=document.createElement("div");meta.className="recordMeta";meta.innerHTML="<b>"+escapeHtml(x.camera)+"</b><span>"+new Date(x.started).toLocaleString()+" · 2-minute segment</span>";const actions=document.createElement("div");actions.className="recordActions";const dl=document.createElement("button");dl.textContent="DOWNLOAD";dl.onclick=()=>{const u=URL.createObjectURL(x.blob);const a=document.createElement("a");a.href=u;a.download="CORDDS_"+x.camera.replace(/\W+/g,"_")+"_"+x.started+"."+((x.type||"").includes("mp4")?"mp4":"webm");a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};const del=document.createElement("button");del.textContent="DELETE";del.onclick=async()=>{const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction("segments","readwrite");tx.objectStore("segments").delete(x.id);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});refreshStorage()};actions.append(dl,del);item.append(meta,actions);list.appendChild(item)}}
function unlockAlertAudio(){try{if(!S.audioCtx)S.audioCtx=new (window.AudioContext||window.webkitAudioContext)();if(S.audioCtx.state==="suspended")S.audioCtx.resume()}catch(e){console.warn("audio",e)}}
function startAttentionAudio(){if(S.role!=="operator"||!S.soundOn)return;unlockAlertAudio();if(S.audioBeatTimer)return;let step=0;const notes=[196,220,261.63,293.66,329.63,293.66,261.63,220];S.audioBeatTimer=setInterval(()=>{try{const ctx=S.audioCtx;if(!ctx||ctx.state==="suspended")return;const now=ctx.currentTime;const o=ctx.createOscillator(),g=ctx.createGain();o.type="triangle";o.frequency.value=notes[step++%notes.length];g.gain.setValueAtTime(.0001,now);g.gain.exponentialRampToValueAtTime(.035,now+.02);g.gain.exponentialRampToValueAtTime(.0001,now+.18);o.connect(g);g.connect(ctx.destination);o.start(now);o.stop(now+.20)}catch(e){}},260)}
function stopAttentionAudio(){if(S.audioBeatTimer){clearInterval(S.audioBeatTimer);S.audioBeatTimer=null}}
function stopWarningAlarm(){for(const n of [...(S.alarmNodes||[])]){try{n.stop()}catch(e){}try{n.disconnect()}catch(e){}}S.alarmNodes?.clear();try{window.speechSynthesis?.cancel()}catch(e){}}
function stopIncidentPing(x){if(x?.pingTimer){clearInterval(x.pingTimer);x.pingTimer=null}if(x?.reassignTimer){clearTimeout(x.reassignTimer);x.reassignTimer=null}const another=[...S.collisions.values()].some(y=>y!==x&&y.status==="ACTIVE"&&y.pingTimer);if(!another)stopWarningAlarm()}
function startIncidentPing(x){if(!x||x.status!=="ACTIVE")return;stopIncidentPing(x);playWarningAlarm();x.pingTimer=setInterval(()=>{if(x.status==="ACTIVE")playWarningAlarm();else stopIncidentPing(x)},2200);x.reassignTimer=setTimeout(()=>reassignCollision(x.id),30000)}
function playWarningAlarm(){try{unlockAlertAudio();const ctx=S.audioCtx;if(!ctx)return;const now=ctx.currentTime;for(let i=0;i<5;i++){const o=ctx.createOscillator(),g=ctx.createGain(),t=now+i*.34;o.type="square";o.frequency.setValueAtTime(i%2?520:980,t);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.65,t+.025);g.gain.exponentialRampToValueAtTime(.0001,t+.27);o.connect(g);g.connect(ctx.destination);S.alarmNodes.add(o);o.addEventListener("ended",()=>S.alarmNodes.delete(o),{once:true});o.start(t);o.stop(t+.29)}}catch(e){}try{const u=new SpeechSynthesisUtterance("WARNING. VEHICLE COLLISION DETECTED.");u.rate=.92;u.pitch=.75;u.volume=1;window.speechSynthesis?.cancel();window.speechSynthesis?.speak(u)}catch(e){}}

function reassignCollision(id){
const x=S.collisions.get(id);if(!x||x.status!=="ACTIVE"||!S.room)return;
const peers=[...S.room.remoteParticipants.values()].filter(p=>(p.name==="Operator"||p.identity?.startsWith("operator-"))&&p.identity!==S.room.localParticipant?.identity);
if(!peers.length){x.reassignWaiting=true;x.reassignTimer=setTimeout(()=>reassignCollision(id),5000);renderCollisionControl();return}
const target=peers[0];
x.status="REASSIGNED";stopIncidentPing(x);renderCollisionControl();
const msg={type:"collision:reassign",id:x.id,camera:x.camera,cameraId:x.cameraId,score:x.score,time:x.time};
try{S.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(msg)),{reliable:true,destinationIdentities:[target.identity]})}catch(e){console.warn("collision reassignment",e)}
}
function handleReassignedCollision(msg){
if(!msg?.id)return;
const x={id:msg.id,camera:msg.camera||"Camera",cameraId:msg.cameraId||"",score:Number(msg.score)||0,time:Number(msg.time)||Date.now(),lastSeen:Date.now(),status:"ACTIVE",replay:null,reassigned:true};
S.collisions.set(x.id,x);renderCollisionControl();playWarningAlarm();startIncidentPing(x);
}
function addAlert(camera,label,score){const key=camera+"|"+label;const now=Date.now();const last=S.alertCooldown.get(key)||0;if(now-last<10000)return;S.alertCooldown.set(key,now);const a={camera,label,score,time:now};S.alerts.unshift(a);S.alerts=S.alerts.slice(0,200);updateCounts();renderAlerts()}
async function reportCollision(c,pairKey,score){
const id=c.id+"|"+pairKey,now=Date.now(),existing=S.collisions.get(id);
if(existing&&now-existing.lastSeen<5000){existing.lastSeen=now;existing.score=Math.max(existing.score,score);return}
const incident={id,camera:c.name||"Camera",cameraId:c.id,score,time:now,lastSeen:now,status:"ACTIVE",replay:null};
S.collisions.set(id,incident);addAlert(c.name||"Camera","VEHICLE COLLISION",score);renderCollisionControl();startIncidentPing(incident);showEmergencyBanner(incident);
makeReplay(c,now).then(r=>{if(r){incident.replay=r;renderAlerts()}})}

function loadIncidentHospitals(id){
const x=S.collisions.get(id);if(!x)return;
const sel=$("hospitalSelect"),list=$("hospitalList"),hint=$("hospitalResponseHint");if(!sel||!list)return;
startHospitalStatusSimulation();sel.innerHTML='<option value="">SELECT A HOSPITAL</option>';
for(const h of TELLAPUR_HOSPITALS){const o=document.createElement("option");o.value=JSON.stringify(h);o.textContent=h.name+" · "+h.area;sel.appendChild(o)}
refreshIncidentHospitalList();
hint.textContent="TELLAPUR / HYDERABAD · "+TELLAPUR_HOSPITALS.length+" nearby hospitals · SIMULATED LIVE STATUS";
}function showIncidentResponse(id){const p=$("incidentAckPanel");if(!p)return;p.hidden=false;p.dataset.incident=id;loadIncidentHospitals(id)}
function acknowledgeCollision(id){
const x=S.collisions.get(id);if(!x)return;
x.status="ACKNOWLEDGED";stopIncidentPing(x);$("emergencyBanner").hidden=true;renderCollisionControl();showIncidentResponse(id);
}
function ignoreCollision(id){
const x=S.collisions.get(id);if(!x)return;
x.status="IGNORED";stopIncidentPing(x);if($("emergencyBanner"))$("emergencyBanner").hidden=true;renderCollisionControl();
}
function clearCollision(id){
const x=S.collisions.get(id);if(x)stopIncidentPing(x);S.collisions.delete(id);if($("emergencyBanner"))$("emergencyBanner").hidden=true;renderCollisionControl();
}
function renderCollisionControl(){
const activeEl=$("collisionOps"),ackEl=$("acknowledgedOps"),ignoreEl=$("ignoredOps");
const all=[...S.collisions.values()];
function render(el,items,type){
if(!el)return;
if(!items.length){el.className="collisionOps empty";el.textContent="No "+type.toLowerCase()+" incidents.";return}
el.className="collisionOps";
el.innerHTML=items.map(x=>{
const action=type==="ACTIVE"?'<button data-ack="'+escapeHtml(x.id)+'">ACKNOWLEDGE</button><button class="dangerBtn" data-ignore="'+escapeHtml(x.id)+'">IGNORE</button>':type==="ACKNOWLEDGED"?'<button data-replay="'+escapeHtml(x.id)+'">OPEN REPLAY</button><button class="dangerBtn" data-clear="'+escapeHtml(x.id)+'">CLEAR</button>':'<button data-replay="'+escapeHtml(x.id)+'">OPEN REPLAY</button><button class="dangerBtn" data-clear="'+escapeHtml(x.id)+'">CLEAR</button>';
return '<div class="collisionIncident"><div><strong>VEHICLE COLLISION</strong><div class="small">'+escapeHtml(x.camera)+' · '+Math.round(x.score*100)+'% · '+new Date(x.time).toLocaleTimeString()+'</div><div class="small">Status: '+escapeHtml(x.status)+'</div>'+(x.reassignWaiting?'<div class="incidentState">WAITING FOR ANOTHER OPERATOR</div>':'')+(x.hospital?'<div class="incidentState">HOSPITAL: '+escapeHtml(x.hospital.name)+' · '+escapeHtml(x.hospitalStatus||"PENDING")+'</div>':'')+'</div><div class="recordActions">'+action+'</div></div>'}).join("");
el.querySelectorAll("[data-ack]").forEach(b=>b.onclick=()=>acknowledgeCollision(b.dataset.ack));
el.querySelectorAll("[data-ignore]").forEach(b=>b.onclick=()=>ignoreCollision(b.dataset.ignore));
el.querySelectorAll("[data-clear]").forEach(b=>b.onclick=()=>clearCollision(b.dataset.clear));
el.querySelectorAll("[data-replay]").forEach(b=>b.onclick=()=>{const x=S.collisions.get(b.dataset.replay);if(x)openAlertReplay({camera:x.camera,score:x.score,time:x.time})});
}
render(activeEl,all.filter(x=>x.status==="ACTIVE"),"ACTIVE");
render(ackEl,all.filter(x=>x.status==="ACKNOWLEDGED"),"ACKNOWLEDGED");
render(ignoreEl,all.filter(x=>x.status==="IGNORED"),"IGNORED");
}
function renderAlerts(){renderCollisionControl();const el=$("alertsList");if(!S.alerts.length){el.className="list empty";el.textContent="No detection alerts yet.";return}el.className="list";el.innerHTML=S.alerts.map((a,i)=>'<button class="alertItem alertClickable" data-alert="'+i+'"><div><strong>⚠ VEHICLE COLLISION</strong><div class="small">'+escapeHtml(a.camera)+' · '+Math.round(a.score*100)+'% confidence</div></div><span class="small">'+new Date(a.time).toLocaleTimeString()+' · REPLAY ›</span></button>').join("");el.querySelectorAll("[data-alert]").forEach(b=>b.onclick=()=>openAlertReplay(S.alerts[Number(b.dataset.alert)]))}
function openAlertReplay(alert){const incident=[...S.collisions.values()].find(x=>x.time===alert.time&&x.camera===alert.camera);const modal=$("replayModal"),video=$("replayVideo"),meta=$("replayMeta");if(!modal)return;meta.textContent=alert.camera+" · "+Math.round(alert.score*100)+"% confidence · "+new Date(alert.time).toLocaleString();if(incident?.replay?.blob&&incident.replay.blob.size>1000){if(video.dataset.objectUrl)URL.revokeObjectURL(video.dataset.objectUrl);const u=URL.createObjectURL(incident.replay.blob);video.dataset.objectUrl=u;video.src=u;video.load();video.onloadedmetadata=()=>{try{video.currentTime=Math.min(Math.max(0,incident.replay.offset||0),Math.max(0,video.duration-1))}catch(e){}};video.oncanplay=()=>{video.play().catch(()=>{})};$("replayEmpty").hidden=true;video.hidden=false}else{video.removeAttribute("src");video.hidden=true;$("replayEmpty").hidden=false}modal.hidden=false}
function closeReplay(){const m=$("replayModal"),v=$("replayVideo");if(v?.dataset.objectUrl){URL.revokeObjectURL(v.dataset.objectUrl);delete v.dataset.objectUrl}if(v){v.pause();v.removeAttribute("src");v.load()}if(m)m.hidden=true}
function showEmergencyBanner(incident){const b=$("emergencyBanner");if(!b)return;b.dataset.time=String(incident.time);b.hidden=false;b.classList.remove("flash");void b.offsetWidth;b.classList.add("flash");$("emergencyCamera").textContent=incident.camera;$("emergencyTime").textContent=new Date(incident.time).toLocaleTimeString();setTimeout(()=>{if(b.classList.contains("flash"))b.hidden=true},12000)}
function drawBackendTracks(c,tracks){const canvas=c.overlay,v=c.video;if(!canvas||!v)return;const w=v.videoWidth||640,h=v.videoHeight||360;if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}const ctx=canvas.getContext("2d");ctx.clearRect(0,0,w,h);const sx=w/(c.backendFrameWidth||w),sy=h/(c.backendFrameHeight||h);ctx.font="700 "+Math.max(15,Math.round(w/60))+"px Arial";for(const t of tracks||[]){const b=t.box;if(!b)continue;const x=b[0]*sx,y=b[1]*sy,bw=(b[2]-b[0])*sx,bh=(b[3]-b[1])*sy;ctx.strokeStyle="#ff1738";ctx.lineWidth=Math.max(3,Math.round(w/420));ctx.shadowColor="#ff1738";ctx.shadowBlur=12;ctx.strokeRect(x,y,bw,bh);ctx.shadowBlur=0;const label=(t.class===2?"CAR #":"OBJECT #")+t.id+" "+Math.round((t.confidence||0)*100)+"%";const tw=ctx.measureText(label).width+18;ctx.fillStyle="#ff1738";ctx.fillRect(x,Math.max(0,y-30),tw,30);ctx.fillStyle="#fff";ctx.fillText(label,x+9,Math.max(21,y-8))}}
function setAccidentApi(url){S.accidentApi=(url||"").trim().replace(/\/$/,"");const el=$("accidentApiStatus");if(el)el.textContent=S.accidentApi?"YOLO11x BACKEND CONFIGURED":"YOLO11x BACKEND OFFLINE"}
async function checkAccidentBackend(){try{const r=await fetch(S.accidentApi+"/health",{cache:"no-store"});if(!r.ok)throw Error("HTTP "+r.status);const d=await r.json();$("aiStatus").textContent="YOLO11x ONLINE · BoT-SORT · 1280px · 40-frame temporal analysis";$("aiStatus").className="aiStatus ready";for(const id of S.cameras.keys())startAccidentAIForCamera(id);return true}catch(e){$("aiStatus").textContent="YOLO11x OFFLINE · start the local detector";$("aiStatus").className="aiStatus error";return false}}
async function sendAccidentFrame(id){const c=S.cameras.get(id);if(!c||!S.accidentApi||!c.video||c.video.readyState<2||c.accidentBusy)return;c.accidentBusy=true;try{const canvas=document.createElement("canvas"),vw=c.video.videoWidth||640,vh=c.video.videoHeight||360,scale=Math.min(960/vw,540/vh);canvas.width=Math.max(1,Math.round(vw*scale));canvas.height=Math.max(1,Math.round(vh*scale));canvas.getContext("2d").drawImage(c.video,0,0,canvas.width,canvas.height);const b64=canvas.toDataURL("image/jpeg",.78).split(",")[1];const r=await fetch(S.accidentApi+"/frame",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({camera_id:id,timestamp:Date.now()/1000,jpeg_base64:b64})});if(!r.ok)throw Error("backend "+r.status);const data=await r.json();c.remoteTracks=data.tracks||[];c.backendFrameWidth=canvas.width;c.backendFrameHeight=canvas.height;drawBackendTracks(c,c.remoteTracks);if(c.accidentStatus)c.accidentStatus.textContent=data.accident?"⚠ ACCIDENT CONFIRMED · "+Math.round(data.confidence*100)+"%":"AI MONITORING · "+Math.round((Number(data.confidence)||0)*100)+"%";if(data.accident)await reportCollision(c,"AI-"+Math.floor(Date.now()/8000),Math.max(.60,Math.min(.99,Number(data.confidence)||.60)))}catch(e){if(c.accidentStatus)c.accidentStatus.textContent="YOLO11x OFFLINE"}finally{c.accidentBusy=false}}
function startAccidentAIForCamera(id){const c=S.cameras.get(id);if(!c||!S.accidentApi||c.accidentTimer)return;c.accidentTimer=setInterval(()=>sendAccidentFrame(id),125);sendAccidentFrame(id)}
function stopAccidentAIForCamera(id){const c=S.cameras.get(id);if(c?.accidentTimer)clearInterval(c.accidentTimer);if(c)c.accidentTimer=null}

async function loadAI(){if(S.accidentApi){await checkAccidentBackend();return}if(S.ai.loading||S.ai.session)return;S.ai.loading=true;$("loadAi").disabled=true;$("aiStatus").textContent="Loading YOLO11n engine…";$("aiStatus").className="aiStatus";try{const ort=await import("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/+esm");S.ai.ort=ort;S.ai.session=await ort.InferenceSession.create(YOLO_MODEL,{executionProviders:["wasm"],graphOptimizationLevel:"all"});$("aiStatus").textContent="YOLO11 ONLINE · automatic detection enabled · ≥20% confidence";$("aiStatus").className="aiStatus ready";for(const id of S.cameras.keys())startAIForCamera(id)}catch(e){console.error("YOLO11 load",e);S.ai.session=null;$("aiStatus").textContent="YOLO11 load failed: "+(e.message||e);$("aiStatus").className="aiStatus error"}finally{S.ai.loading=false}}
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
for(const m of candidates){if(usedTracks.has(m.t.id)||usedObs.has(m.i))continue;const o=observations[m.i],t=m.t,dt=Math.max(.05,Math.min(1,(now-(t.lastTime||now))/1000));updated.set(t.id,{...o,id:t.id,cx:o.cx,cy:o.cy,vx:(o.cx-t.cx)/dt,vy:(o.cy-t.cy)/dt,bw:o.bw,bh:o.bh,box:o.box,miss:0,age:(t.age||0)+1,lastTime:now,lastSeen:now,predicted:false});usedTracks.add(t.id);usedObs.add(m.i)}
// Keep cars in memory through longer detector dropouts/occlusion.
for(const t of predicted)if(!usedTracks.has(t.id)){const miss=(t.miss||0)+1;if(miss<=60){const cx=t.pcx,cy=t.pcy,bw=t.pbw,bh=t.pbh;updated.set(t.id,{...t,cx,cy,box:{xmin:Math.max(0,cx-bw/2),ymin:Math.max(0,cy-bh/2),xmax:Math.min(w,cx+bw/2),ymax:Math.min(h,cy+bh/2)},bw,bh,miss,lastTime:now,predicted:true,vx:(t.vx||0)*.92,vy:(t.vy||0)*.92})}}
for(let i=0;i<observations.length;i++)if(!usedObs.has(i)){const o=observations[i],id=c.nextTrackId++;updated.set(id,{...o,id,cx:o.cx,cy:o.cy,vx:0,vy:0,bw:o.bw,bh:o.bh,box:o.box,miss:0,age:1,lastTime:now,lastSeen:now,predicted:false})}
c.tracks=updated;

// Draw boxes only. Trajectory lines are intentionally disabled.
for(const t of c.tracks.values()){const b=t.box,x=b.xmin,y=b.ymin,bw=b.xmax-b.xmin,bh=b.ymax-b.ymin;ctx.strokeStyle=t.predicted?"#ffffff":"#ff0000";ctx.lineWidth=Math.max(2,Math.round(w/500));ctx.setLineDash(t.predicted?[8,6]:[]);ctx.strokeRect(x,y,bw,bh);ctx.setLineDash([]);const label="CAR #"+t.id+(t.predicted?" · TRACKING":"")+" "+Math.round((t.score||0)*100)+"%";const tw=ctx.measureText(label).width+12,th=24;ctx.fillStyle=t.predicted?"#ffffff":"#ff0000";ctx.fillRect(x,Math.max(0,y-th),tw,th);ctx.fillStyle=t.predicted?"#000000":"#ffffff";ctx.fillText(label,x+6,Math.max(17,y-6))}

// Collision = two persistent car boxes touching at their sides, with no overlap.
// A small pixel tolerance handles sub-pixel camera motion.
const tracks=[...c.tracks.values()].filter(t=>!t.predicted&&t.age>=1);if(!c.collisionPairs)c.collisionPairs=new Map();const seenPairs=new Set(),TOUCH_PX=Math.max(5,Math.round(w/220));
for(let i=0;i<tracks.length;i++)for(let j=i+1;j<tracks.length;j++){const a=tracks[i],b=tracks[j],key=[Math.min(a.id,b.id),Math.max(a.id,b.id)].join(":");seenPairs.add(key);const ax1=a.box.xmin,ay1=a.box.ymin,ax2=a.box.xmax,ay2=a.box.ymax,bx1=b.box.xmin,by1=b.box.ymin,bx2=b.box.xmax,by2=b.box.ymax,xOverlap=Math.min(ax2,bx2)-Math.max(ax1,bx1),yOverlap=Math.min(ay2,by2)-Math.max(ay1,by1),gapX=Math.max(bx1-ax2,ax1-bx2,0),gapY=Math.max(by1-ay2,ay1-by2,0),touch=(xOverlap*yOverlap)<=0&&((gapX<=TOUCH_PX&&yOverlap>0)||(gapY<=TOUCH_PX&&xOverlap>0)),prev=c.collisionPairs.get(key),streak=touch?(prev?.streak||0)+1:0;c.collisionPairs.set(key,{streak});if(streak>=1)reportCollision(c,key,Math.max(a.score||0,b.score||0))}
for(const key of c.collisionPairs.keys())if(!seenPairs.has(key))c.collisionPairs.delete(key);
}
function decodeYOLO(output,meta){const data=output.data,dims=output.dims,channels=dims[1],count=dims[2],transposed=channels!==84,attrs=transposed?count:channels,n=transposed?channels:count;const get=(a,c)=>transposed?data[c*attrs+a]:data[a*n+c];const dets=[];for(let c=0;c<n;c++){let score=0,cls=-1;for(let a=4;a<attrs;a++){const v=get(a,c);if(v>score){score=v;cls=a-4}}if(score<YOLO_THRESHOLD||cls!==2)continue;const cx=get(0,c),cy=get(1,c),bw=get(2,c),bh=get(3,c);const box={xmin:Math.max(0,Math.min(meta.vw,(cx-bw/2-meta.dx)/meta.scale)),ymin:Math.max(0,Math.min(meta.vh,(cy-bh/2-meta.dy)/meta.scale)),xmax:Math.max(0,Math.min(meta.vw,(cx+bw/2-meta.dx)/meta.scale)),ymax:Math.max(0,Math.min(meta.vh,(cy+bh/2-meta.dy)/meta.scale))};if(box.xmax>box.xmin&&box.ymax>box.ymin)dets.push({score,label:COCO[cls]||("class "+cls),box})}return nms(dets,.70)}
async function detectFrame(id){const c=S.cameras.get(id);if(!S.ai.running||!S.ai.session||!c||S.accidentApi)return;if(!c.video||c.video.readyState<2){scheduleDetect(id);return}try{const meta=letterbox(c.video),input=tensorFromCanvas(meta.canvas),feeds={};feeds[S.ai.session.inputNames[0]]=input;const result=await S.ai.session.run(feeds),output=result[S.ai.session.outputNames[0]];drawDetections(c,decodeYOLO(output,meta))}catch(e){console.warn("YOLO11 inference",e)}scheduleDetect(id)}
function scheduleDetect(id){if(S.ai.running){clearTimeout(S.ai.timers.get(id));S.ai.timers.set(id,setTimeout(()=>detectFrame(id),250))}}
function startAIForCamera(id){if(!S.ai.session||!S.cameras.has(id))return;S.ai.running=true;S.ai.cameras.set(id,true);$("aiStatus").textContent="YOLO11 ONLINE · detecting all connected cameras · ≥20% confidence";detectFrame(id)}
function stopAIForCamera(id){S.ai.cameras.delete(id);clearTimeout(S.ai.timers.get(id));S.ai.timers.delete(id);const c=S.cameras.get(id);if(c?.overlay){const ctx=c.overlay.getContext("2d");ctx.clearRect(0,0,c.overlay.width,c.overlay.height)}if(!S.ai.cameras.size)S.ai.running=false}
function startAI(){for(const id of S.cameras.keys())startAIForCamera(id)}
function stopAI(){S.ai.running=false;for(const id of [...S.ai.cameras.keys()]){stopAIForCamera(id);stopAccidentAIForCamera(id)}$("aiStatus").textContent=S.ai.session?"YOLO11 ONLINE · automatic detection paused.":"AI engine not loaded."}
async function connect(roomName,role){const L=LivekitClient;const source=tokenSource();if(S.room){try{await S.room.disconnect()}catch(e){}}if(S.registryRoom){try{await S.registryRoom.disconnect()}catch(e){}S.registryRoom=null}S.room=new L.Room({adaptiveStream:true,dynacast:true});S.roomName=roomName;S.room.on(L.RoomEvent.TrackSubscribed,(track,publication,participant)=>{if(role!=="operator"||track.kind!=="video")return;const video=track.attach();video.autoplay=true;video.playsInline=true;const id=participant.identity;if(S.removedCameras.has(id)){track.detach();return}const name=participant?.name||participant?.identity||"Camera";cameraCard(id,name,video);if(S.accidentApi)startAccidentAIForCamera(participant.identity);else if(S.ai.session)startAIForCamera(participant.identity);video.addEventListener("loadedmetadata",()=>startRecording(participant.identity),{once:true})});S.room.on(L.RoomEvent.TrackUnsubscribed,(track,publication,participant)=>{const id=participant?.identity;track.detach();if(id)removeCamera(id)});S.room.on(L.RoomEvent.DataReceived,(payload,participant)=>{
let msg;try{msg=JSON.parse(new TextDecoder().decode(payload))}catch(e){return}
if(msg.type==="camera:remove"&&role==="camera"&&msg.target===S.room?.localParticipant?.identity){
for(const p of [...S.room.localParticipant.trackPublications.values()]){
try{awaitMaybeUnpublish(p)}catch(e){}
}
$("cameraMsg").textContent="Camera removed by operator.";
setStatus("REMOVED");
return;
}
if(role==="operator"){if(msg.type==="collision:reassign")handleReassignedCollision(msg);else handleCameraData(msg,participant)}
});S.room.on(L.RoomEvent.ParticipantDisconnected,participant=>{if(role==="operator")removeCamera(participant.identity)});S.room.on(L.RoomEvent.Disconnected,()=>{setStatus("OFFLINE");$("roomState").textContent="DISCONNECTED"});const r=await source.fetch({roomName,participantIdentity:identity(role),participantName:role==="operator"?"Operator":"Camera"});if(!r?.serverUrl||!r?.participantToken)throw Error("LiveKit returned incomplete connection details.");await S.room.connect(r.serverUrl,r.participantToken);$("roomState").textContent=roomName+" · CONNECTED";setStatus(role==="operator"?"OPERATOR ONLINE":"CAMERA ONLINE");if(role==="camera")startGps()}
async function connectGlobalRegistry(role){
if(S.registryRoom){try{await S.registryRoom.disconnect()}catch(e){}}
const L=LivekitClient,source=tokenSource(),room=new L.Room({adaptiveStream:false,dynacast:false});S.registryRoom=room;
room.on(L.RoomEvent.DataReceived,(payload,participant)=>{let msg;try{msg=JSON.parse(new TextDecoder().decode(payload))}catch(e){return}if(msg.type==="registry:request"&&S.role==="camera"){publishGlobalRegistry()}if(msg.type==="registry:camera"){updateGlobalCamera(msg)}}); 
room.on(L.RoomEvent.ParticipantDisconnected,p=>{if(S.role==="legal"){$("globalMapHint").textContent="Registry participant disconnected; active cameras update automatically."}});
const r=await source.fetch({roomName:GLOBAL_REGISTRY_ROOM,participantIdentity:identity("registry-"+role),participantName:role==="legal"?"Legal Registry Viewer":"Camera Registry"});
if(!r?.serverUrl||!r?.participantToken)throw Error("Global registry token unavailable.");
await room.connect(r.serverUrl,r.participantToken);
if(role==="legal"){const bytes=new TextEncoder().encode(JSON.stringify({type:"registry:request"}));room.localParticipant.publishData(bytes,{reliable:true})}
}
function publishGlobalRegistry(){
if(!S.registryRoom?.localParticipant||S.role!=="camera")return;
const pos={type:"registry:camera",id:S.room?.localParticipant?.identity||identity("camera"),name:"Camera",room:S.roomName||"Unknown room",lat:null,lon:null,online:true,updated:Date.now()};
const msg=new TextEncoder().encode(JSON.stringify(pos));try{S.registryRoom.localParticipant.publishData(msg,{reliable:true})}catch(e){}
}
function updateGlobalCamera(msg){
if(!msg?.id)return;S.globalCameras.set(msg.id,{...S.globalCameras.get(msg.id),...msg,updated:Date.now()});
if(S.role==="legal")renderGlobalCamera(msg);
}
function renderGlobalCamera(msg){
if(!S.globalMap||!window.L)return;
const existing=S.globalMarkers.get(msg.id);
if(Number.isFinite(msg.lat)&&Number.isFinite(msg.lon)){
const popup="<b>CORDDS CAMERA</b><br>"+escapeHtml(msg.name||"Camera")+"<br>Room: "+escapeHtml(msg.room||"Unknown")+"<br>"+(msg.online?"ONLINE":"OFFLINE");
if(existing){existing.setLatLng([msg.lat,msg.lon]);existing.bindPopup(popup)}else{const m=L.circleMarker([msg.lat,msg.lon],{radius:8,color:"#ff3150",weight:2,fillColor:"#ff3150",fillOpacity:.9});m.bindPopup(popup).addTo(S.globalMap);S.globalMarkers.set(msg.id,m)}
}else if(existing){existing.remove();S.globalMarkers.delete(msg.id)}
$("globalCameraCount").textContent=S.globalCameras.size;$("globalCameraCountTop").textContent=S.globalCameras.size;$("globalMapHint").textContent=S.globalCameras.size+" registered CORDDS cameras";
}
function initGlobalMap(){if(S.globalMap||!window.L)return;S.globalMap=L.map("globalMap",{worldCopyJump:true}).setView([20,0],2);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(S.globalMap);setTimeout(()=>S.globalMap.invalidateSize(),100)}
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
function initCameraMap(){if(S.cameraMap||!window.L)return;S.cameraMap=L.map("cameraMap",{zoomControl:true}).setView([20,0],2);L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap contributors"}).addTo(S.cameraMap);setTimeout(()=>S.cameraMap.invalidateSize(),100)}
function updateCameraLocationMap(lat,lon){if(!S.cameraMap||!Number.isFinite(lat)||!Number.isFinite(lon))return;const p=[lat,lon];if(!S.cameraMap._corddsMarker)S.cameraMap._corddsMarker=L.circleMarker(p,{radius:10,color:"#ff3150",weight:3,fillColor:"#ff3150",fillOpacity:.9}).addTo(S.cameraMap);else S.cameraMap._corddsMarker.setLatLng(p);S.cameraMap.setView(p,16);$("cameraGpsStatus").textContent="GPS LOCKED · "+lat.toFixed(5)+", "+lon.toFixed(5)}
function startGps(){if(!navigator.geolocation){$("cameraMsg").textContent="This browser does not provide GPS.";return}const publish=pos=>{const lat=pos.coords.latitude,lon=pos.coords.longitude;sendData({type:"gps",lat,lon,accuracy:pos.coords.accuracy||null,id:S.room?.localParticipant?.identity});if(S.registryRoom?.localParticipant){try{S.registryRoom.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({type:"registry:camera",id:S.room?.localParticipant?.identity,name:"Camera",room:S.roomName,lat,lon,online:true,updated:Date.now()})),{reliable:true})}catch(e){}}$("cameraMsg").textContent="LIVE · ROOM "+S.roomName;$("cameraGpsStatus").textContent="GPS LOCKED";updateCameraLocationMap(lat,lon)};S.watchId=navigator.geolocation.watchPosition(publish,e=>{$("cameraMsg").textContent="Camera LIVE · GPS unavailable ("+e.message+")"},{enableHighAccuracy:true,maximumAge:5000,timeout:15000})}
document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>showView(b.dataset.view));
$("legalBtn").onclick=()=>{$("legalLogin").hidden=!$("legalLogin").hidden;$("operatorLogin").hidden=true;$("legalMsg").textContent="Authorized legal access only.";setTimeout(()=>$("legalUser")?.focus(),50)};
$("legalSignIn").onclick=async()=>{const u=$("legalUser").value.trim().toLowerCase(),p=$("legalPass").value;if(u!==LEGAL_USER||p!==LEGAL_PASSWORD){$("legalMsg").textContent="SIGN IN DENIED";return}const b=$("legalSignIn");if(b)b.disabled=true;showApp("legal");$("legalUser").value="";$("legalPass").value="";if(b)b.disabled=false};
$("operatorBtn").onclick=()=>{$("operatorLogin").hidden=!$("operatorLogin").hidden;$("legalLogin").hidden=true;$("operatorMsg").textContent="Operator credentials required.";setTimeout(()=>$("operatorUser")?.focus(),50)};
$("operatorSignIn").onclick=async()=>{const u=$("operatorUser").value.trim().toLowerCase(),p=$("operatorPass").value;if(u!==OPERATOR_USER||p!==OPERATOR_PASSWORD){$("operatorMsg").textContent="SIGN IN DENIED";return}const b=$("operatorSignIn");if(b){b.disabled=true;b.textContent="CONNECTING…"}showApp("operator");$("operatorMsg").textContent="OPERATOR AUTHENTICATED · CONNECTING…";try{try{unlockAlertAudio();startAttentionAudio()}catch(e){console.warn("Audio unlock",e)}const n=$("room").value.trim()||("cb-"+Math.random().toString(36).slice(2,7));$("room").value=n;initMap();showView("cameras");await Promise.race([connect(n,"operator"),new Promise((_,reject)=>setTimeout(()=>reject(Error("Live camera service timed out. The dashboard is still open.")),12000))]);loadAI();$("operatorUser").value="";$("operatorPass").value="";$("operatorMsg").textContent="OPERATOR CONNECTED · READY";}catch(e){$("operatorMsg").textContent="DASHBOARD OPEN · CONNECTION ERROR: "+(e.message||e);setStatus("ERROR");console.error(e)}finally{if(b){b.disabled=false;b.textContent="AUTHENTICATE"}}};
$("createRoom").onclick=async()=>{try{unlockAlertAudio();const n=$("room").value.trim()||("cb-"+Math.random().toString(36).slice(2,7));$("room").value=n;await connect(n,"operator");showApp("operator");initMap();loadAI()}catch(e){$("roomState").textContent="ERROR: "+(e.message||e);setStatus("ERROR");console.error(e)}};
$("cameraBtn").onclick=()=>showApp("camera");
$("startCamera").onclick=async()=>{const n=$("cameraRoom").value.trim();if(!n){$("cameraMsg").textContent="Enter the operator room ID.";return}let stream;try{$("cameraMsg").textContent="Requesting camera permission…";stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false});$("localVideo").srcObject=stream;$("cameraMsg").textContent="Camera granted. Connecting…";await connect(n,"camera");await connectGlobalRegistry("camera");if(S.watchId!==null){navigator.geolocation.clearWatch(S.watchId);S.watchId=null}startGps();publishGlobalRegistry();sendData({type:"camera:hello",name:"Camera",id:S.room.localParticipant.identity});const video=stream.getVideoTracks()[0];if(!video)throw Error("No camera video track was available.");const track=new LivekitClient.LocalVideoTrack(video);await S.room.localParticipant.publishTrack(track,{name:"security-camera"});$("cameraMsg").textContent="Camera is LIVE. Keep this page open."}catch(e){if(stream)stream.getTracks().forEach(t=>t.stop());$("cameraMsg").textContent="Camera error: "+(e.message||e.name);setStatus("ERROR");console.error(e)}};
$("loadAi").onclick=loadAI;$("toggleAi").onclick=()=>S.ai.running?stopAI():startAI();$("aiCamera").onchange=()=>{};
$("clearAlerts").onclick=()=>{S.alerts=[];updateCounts();renderAlerts()};$("deleteAllRecordings").onclick=async()=>{if(!confirm("Delete all saved recordings from this browser?"))return;const db=await openDb();await new Promise((res,rej)=>{const tx=db.transaction("segments","readwrite");tx.objectStore("segments").clear();tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});refreshStorage()};
$("loadHospitals").onclick=loadHospitals;
async function searchMapPlace(){const q=($("mapSearch")?.value||"").trim();if(!q||!S.map)return;const btn=$("mapSearchBtn");if(btn)btn.disabled=true;try{const r=await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q="+encodeURIComponent(q),{headers:{"Accept":"application/json"}});if(!r.ok)throw Error("Search "+r.status);const d=await r.json();if(!d.length){$("mapHint").textContent="No matching place found";return}const lat=Number(d[0].lat),lon=Number(d[0].lon);S.map.setView([lat,lon],15);if(S.map._searchMarker)S.map.removeLayer(S.map._searchMarker);S.map._searchMarker=L.marker([lat,lon]).addTo(S.map).bindPopup("<b>"+escapeHtml(d[0].display_name||q)+"</b>").openPopup();$("mapHint").textContent="Map centered on "+(d[0].display_name||q)}catch(e){$("mapHint").textContent="Map search unavailable right now";console.warn(e)}finally{if(btn)btn.disabled=false}}
$("mapSearchBtn")?.addEventListener("click",searchMapPlace);
$("mapSearch")?.addEventListener("keydown",e=>{if(e.key==="Enter")searchMapPlace()});
$("closeReplay").onclick=closeReplay;$("replayModal").addEventListener("click",e=>{if(e.target.id==="replayModal")closeReplay()});
$("hospitalSelect")?.addEventListener("change",e=>{
const p=$("incidentAckPanel"),id=p?.dataset.incident,x=id&&S.collisions.get(id);if(!x||!e.target.value)return;
try{
if(x.hospitalResponseTimer)clearTimeout(x.hospitalResponseTimer);
x.hospital=JSON.parse(e.target.value);
x.hospitalStatus="CONTACTING HOSPITAL…";
x.hospitalResponseTimer=setTimeout(()=>{
const state=hospitalState(x.hospital.name);
x.hospitalStatus=(state==="ACCEPTING"||state==="LIMITED CAPACITY")?"PATIENT ACCEPTED":"PATIENT NOT ACCEPTED";
renderCollisionControl();
const hint=$("hospitalResponseHint");if(hint)hint.textContent="SIMULATED LIVE RESPONSE · "+x.hospital.name+" · updated "+new Date().toLocaleTimeString();
},3500);
renderCollisionControl();
}catch(err){}
});
$("callFireServices")?.addEventListener("click",()=>{window.location.href="tel:101"});
$("musicEnergy")?.addEventListener("change",renderMusic);loadMusicLibrary();
$("musicSearchBtn")?.addEventListener("click",searchYouTubeMusic);
$("musicSearch")?.addEventListener("keydown",e=>{if(e.key==="Enter")searchYouTubeMusic()});
$("musicPlayPause")?.addEventListener("click",toggleMusicPlay);
$("musicNext")?.addEventListener("click",nextMusic);
$("musicPrev")?.addEventListener("click",previousMusic);
$("musicDisable")?.addEventListener("click",()=>{
S.musicEnabled=!S.musicEnabled;
const b=$("musicDisable");
if(!S.musicEnabled){
try{S.musicPlayerApi?.stopVideo?.()}catch(e){}
S.musicPaused=true;
setMusicPlaying(false);
if(b)b.textContent="MUSIC: OFF";
if(b)b.classList.add("musicDisabled");
const n=$("musicNow");if(n)n.textContent="MUSIC DISABLED";
}else{
if(b)b.textContent="MUSIC: ON";
if(b)b.classList.remove("musicDisabled");
const n=$("musicNow");if(n)n.textContent=S.musicCurrentId?"READY TO PLAY":"SELECT A SONG TO PLAY";
}
});
$("musicMainPlayPause")?.addEventListener("click",toggleMusicPlay);
$("musicMainNext")?.addEventListener("click",nextMusic);
$("musicMainPrev")?.addEventListener("click",previousMusic);



$("soundToggle").onclick=()=>{S.soundOn=!S.soundOn;$("soundToggle").textContent=S.soundOn?"ATTENTION AUDIO: ON":"ATTENTION AUDIO: OFF";if(S.soundOn)startAttentionAudio();else stopAttentionAudio()};
$("emergencyReplay").onclick=()=>{const x=[...S.collisions.values()].find(x=>x.time===Number($("emergencyBanner").dataset.time));if(x)openAlertReplay({camera:x.camera,score:x.score,time:x.time})};

["legalDate","legalFrom","legalTo","legalPlace"].forEach(id=>$(id)?.addEventListener("input",refreshLegalStorage));$("legalClearFilters")?.addEventListener("click",()=>{["legalDate","legalFrom","legalTo","legalPlace"].forEach(id=>$(id).value="");refreshLegalStorage()});
$("cameraLogout")?.addEventListener("click",()=>location.reload());
$("leave").onclick=async()=>{try{if(S.hospitalStatusTimer){clearInterval(S.hospitalStatusTimer);S.hospitalStatusTimer=null}for(const x of S.collisions.values()){if(x.hospitalResponseTimer)clearTimeout(x.hospitalResponseTimer)}S.collisions.clear();S.removedCameras.clear();stopAI();stopAttentionAudio();if(S.watchId!=null)navigator.geolocation.clearWatch(S.watchId);for(const c of S.cameras.values()){if(c.recordTimer)clearTimeout(c.recordTimer);if(c.recorder?.state==="recording")c.recorder.stop()}if(S.room)await S.room.disconnect()}catch(e){}location.reload()};
})();