import * as THREE from "three";
import { OrbitControls } from "https://unpkg.com/three@0.181.0/examples/jsm/controls/OrbitControls.js";
import { IfcAPI } from "web-ifc";

const MODEL_URL = "./modelo.ifc";
const WASM_PATH = "https://unpkg.com/web-ifc@0.0.77/";

const viewer = document.getElementById("viewer");
const loader = document.getElementById("loader");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const errorBox = document.getElementById("error-box");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const modelMeta = document.getElementById("model-meta");
const hint = document.getElementById("hint");
const cutPanel = document.getElementById("cut-panel");
const cutSlider = document.getElementById("cut-slider");
const cutNote = document.getElementById("cut-note");
const measurePanel = document.getElementById("measure-panel");
const measureState = document.getElementById("measure-state");
const unitNote = document.getElementById("unit-note");
const crosshair = document.getElementById("crosshair");
const btnCut = document.getElementById("btn-cut");
const btnMeasure = document.getElementById("btn-measure");

let scene, camera, renderer, controls, modelRoot, modelBox;
let modelMeshes = [];
let allMaterials = new Set();
let metersPerModelUnit = 1;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// Corte
let cutEnabled = false;
let cutAxis = "x";
let cutInverted = false;
let cutPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);

// Medição
let measureEnabled = false;
let firstMeasurePoint = null;
let temporaryMarker = null;
let measurements = [];
let pointerDown = null;

function setStatus(kind, text){ statusDot.className = `dot ${kind}`; statusText.textContent = text; }
function setProgress(v, text){ progressBar.style.width = `${Math.max(4,Math.min(100,Math.round(v)))}%`; progressText.textContent = text; }

function initThree(){
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf4f3f1);
  camera = new THREE.PerspectiveCamera(48, viewer.clientWidth/viewer.clientHeight, 0.01, 1e9);
  renderer = new THREE.WebGLRenderer({antialias:true, alpha:false, powerPreference:"high-performance"});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(viewer.clientWidth, viewer.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;
  viewer.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;

  scene.add(new THREE.HemisphereLight(0xffffff,0x777777,2.0));
  const sun = new THREE.DirectionalLight(0xffffff,2.6); sun.position.set(1,2,1); scene.add(sun);
  const sun2 = new THREE.DirectionalLight(0xffffff,1.2); sun2.position.set(-1,0.6,-1); scene.add(sun2);
  modelRoot = new THREE.Group(); scene.add(modelRoot);

  const animate = () => {
    requestAnimationFrame(animate);
    controls.update();
    updateMeasurementLabels();
    renderer.render(scene,camera);
  };
  animate();

  const resize = () => {
    const w = viewer.clientWidth, h = viewer.clientHeight;
    camera.aspect = w/h; camera.updateProjectionMatrix(); renderer.setSize(w,h);
  };
  window.addEventListener("resize", resize, {passive:true});

  renderer.domElement.addEventListener("pointerdown", e => { pointerDown = {x:e.clientX,y:e.clientY}; }, {passive:true});
  renderer.domElement.addEventListener("pointerup", onPointerUp, {passive:true});
}

function fit(direction="iso"){
  if(!modelBox || modelBox.isEmpty()) return;
  const sphere = new THREE.Sphere(); modelBox.getBoundingSphere(sphere);
  const c = sphere.center, r = Math.max(sphere.radius,1);
  let p;
  if(direction === "top") p = new THREE.Vector3(c.x,c.y+r*2.4,c.z+0.001);
  else if(direction === "front") p = new THREE.Vector3(c.x,c.y+r*0.18,c.z+r*2.4);
  else p = new THREE.Vector3(c.x+r*1.45,c.y+r*1.1,c.z+r*1.45);
  controls.target.copy(c); camera.position.copy(p);
  camera.near = Math.max(r/10000,0.01); camera.far = Math.max(r*50,1000); camera.updateProjectionMatrix(); controls.update();
}

function materialFor(color, cache){
  const r=Math.max(0,Math.min(1,color?.x ?? .72)); const g=Math.max(0,Math.min(1,color?.y ?? .72)); const b=Math.max(0,Math.min(1,color?.z ?? .72)); const a=Math.max(0.03,Math.min(1,color?.w ?? 1));
  const key=`${r.toFixed(3)}_${g.toFixed(3)}_${b.toFixed(3)}_${a.toFixed(3)}`;
  if(cache.has(key)) return cache.get(key);
  const m = new THREE.MeshStandardMaterial({color:new THREE.Color(r,g,b),roughness:.72,metalness:.02,side:THREE.DoubleSide,transparent:a<.995,opacity:a,depthWrite:a>.75});
  cache.set(key,m); allMaterials.add(m); return m;
}

function geometryFromIfc(ifcApi, modelID, geometryExpressID, cache){
  if(cache.has(geometryExpressID)) return cache.get(geometryExpressID);
  const ifcGeom = ifcApi.GetGeometry(modelID,geometryExpressID);
  const verts = ifcApi.GetVertexArray(ifcGeom.GetVertexData(),ifcGeom.GetVertexDataSize());
  const idx = ifcApi.GetIndexArray(ifcGeom.GetIndexData(),ifcGeom.GetIndexDataSize());
  if(!verts?.length || !idx?.length){ ifcGeom.delete?.(); return null; }
  const n=verts.length/6; const pos=new Float32Array(n*3); const nor=new Float32Array(n*3);
  for(let i=0,j=0;i<verts.length;i+=6,j+=3){ pos[j]=verts[i];pos[j+1]=verts[i+1];pos[j+2]=verts[i+2];nor[j]=verts[i+3];nor[j+1]=verts[i+4];nor[j+2]=verts[i+5]; }
  const geo=new THREE.BufferGeometry(); geo.setAttribute("position",new THREE.BufferAttribute(pos,3)); geo.setAttribute("normal",new THREE.BufferAttribute(nor,3)); geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx),1)); geo.computeBoundingSphere();
  cache.set(geometryExpressID,geo); ifcGeom.delete?.(); return geo;
}

async function fetchIfc(){
  const r=await fetch(MODEL_URL,{cache:"no-cache"}); if(!r.ok) throw new Error(`Falha ao baixar modelo.ifc (HTTP ${r.status}).`);
  const total=Number(r.headers.get("content-length"))||0;
  if(!r.body || !total){ const a=new Uint8Array(await r.arrayBuffer()); setProgress(34,"IFC baixado. Inicializando BIM…"); return a; }
  const reader=r.body.getReader(); const chunks=[]; let received=0;
  while(true){ const {done,value}=await reader.read(); if(done)break; chunks.push(value); received+=value.length; setProgress(8+(received/total)*27,`Baixando IFC… ${Math.round(received/total*100)}%`); }
  const bytes=new Uint8Array(received); let o=0; for(const c of chunks){bytes.set(c,o);o+=c.length;} return bytes;
}

function detectLengthUnit(bytes){
  try{
    const head = new TextDecoder("utf-8").decode(bytes.slice(0, Math.min(bytes.length, 400000))).toUpperCase();
    const assignment = head.match(/IFCUNITASSIGNMENT\(\(([^)]*)\)\)/);
    const assigned = assignment ? new Set((assignment[1].match(/#\d+/g) || []).map(s=>s.slice(1))) : null;
    const re = /#(\d+)=IFCSIUNIT\(\*,\.LENGTHUNIT\.,(\.[A-Z]+\.|\$),\.METRE\.\);/g;
    let m;
    const factors = {".MILLI.":0.001,".CENTI.":0.01,".DECI.":0.1,"$":1,".DECA.":10,".HECTO.":100,".KILO.":1000};
    while((m = re.exec(head))){
      if(!assigned || assigned.has(m[1])) return factors[m[2]] ?? 1;
    }
  }catch(e){ console.warn("Não foi possível detectar a unidade IFC", e); }
  return 1;
}

function formatDistance(modelDistance){
  const meters = modelDistance * metersPerModelUnit;
  if(meters >= 1) return `${meters.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:3})} m`;
  if(meters >= 0.01) return `${(meters*100).toLocaleString("pt-BR",{minimumFractionDigits:1,maximumFractionDigits:1})} cm`;
  return `${(meters*1000).toLocaleString("pt-BR",{minimumFractionDigits:0,maximumFractionDigits:1})} mm`;
}

function unitDescription(){
  if(Math.abs(metersPerModelUnit-0.01)<1e-9) return "IFC em centímetros";
  if(Math.abs(metersPerModelUnit-0.001)<1e-9) return "IFC em milímetros";
  if(Math.abs(metersPerModelUnit-1)<1e-9) return "IFC em metros";
  return "Unidade IFC detectada";
}

// ---------- CORTE ----------
function axisVector(axis){
  if(axis === "y") return new THREE.Vector3(0,1,0);
  if(axis === "z") return new THREE.Vector3(0,0,1);
  return new THREE.Vector3(1,0,0);
}

function boundsForAxis(axis){
  if(!modelBox) return {min:0,max:1};
  return {min:modelBox.min[axis], max:modelBox.max[axis]};
}

function updateCut(){
  if(!cutEnabled || !modelBox){
    for(const m of allMaterials){ m.clippingPlanes = null; m.needsUpdate = true; }
    cutNote.textContent = "Corte desativado";
    return;
  }
  const t = Number(cutSlider.value)/100;
  const {min,max} = boundsForAxis(cutAxis);
  const coordinate = min + (max-min)*t;
  const normal = axisVector(cutAxis).multiplyScalar(cutInverted ? -1 : 1);
  cutPlane.set(normal, -normal.dot(axisVector(cutAxis).multiplyScalar(coordinate)));
  for(const m of allMaterials){ m.clippingPlanes = [cutPlane]; m.clipIntersection = false; m.needsUpdate = true; }
  cutNote.textContent = `${cutAxis.toUpperCase()} • ${Math.round(t*100)}%${cutInverted ? " • invertido" : ""}`;
}

function setCutAxis(axis){
  cutAxis = axis;
  document.querySelectorAll(".axis-btn").forEach(b=>b.classList.toggle("active",b.dataset.axis===axis));
  cutEnabled = true; btnCut.classList.add("active"); updateCut();
}

function clearCut(){
  cutEnabled = false; cutInverted = false; cutSlider.value = 50; btnCut.classList.remove("active"); updateCut();
}

// ---------- MEDIÇÃO ----------
function createMarker(point, temporary=false){
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(markerRadius(),12,8), new THREE.MeshBasicMaterial({color:0xff6a00,depthTest:false}));
  sphere.position.copy(point); sphere.renderOrder = 999; scene.add(sphere);
  if(temporary) temporaryMarker = sphere;
  return sphere;
}

function markerRadius(){
  if(!modelBox) return .05;
  const s = new THREE.Sphere(); modelBox.getBoundingSphere(s); return Math.max(s.radius*0.004, 0.01);
}

function clearTemporaryMarker(){
  if(temporaryMarker){ scene.remove(temporaryMarker); temporaryMarker.geometry?.dispose(); temporaryMarker.material?.dispose(); temporaryMarker = null; }
}

function createMeasurement(a,b){
  const geometry = new THREE.BufferGeometry().setFromPoints([a,b]);
  const material = new THREE.LineBasicMaterial({color:0xff6a00,depthTest:false,linewidth:2});
  const line = new THREE.Line(geometry,material); line.renderOrder=998; scene.add(line);
  const m1=createMarker(a), m2=createMarker(b);
  const label=document.createElement("div"); label.className="measure-label"; label.textContent=formatDistance(a.distanceTo(b)); viewer.appendChild(label);
  measurements.push({a:a.clone(),b:b.clone(),line,m1,m2,label});
}

function updateMeasurementLabels(){
  const rect = viewer.getBoundingClientRect();
  for(const m of measurements){
    const mid = m.a.clone().add(m.b).multiplyScalar(.5).project(camera);
    const visible = mid.z > -1 && mid.z < 1;
    if(!visible){m.label.style.display="none";continue;}
    m.label.style.display="block";
    m.label.style.left = `${(mid.x*.5+.5)*rect.width}px`;
    m.label.style.top = `${(-mid.y*.5+.5)*rect.height}px`;
  }
}

function clearMeasurements(){
  clearTemporaryMarker(); firstMeasurePoint=null;
  for(const m of measurements){ scene.remove(m.line,m.m1,m.m2); m.line.geometry?.dispose(); m.line.material?.dispose(); m.m1.geometry?.dispose(); m.m1.material?.dispose(); m.m2.geometry?.dispose(); m.m2.material?.dispose(); m.label.remove(); }
  measurements=[];
  measureState.innerHTML = `Toque/clique no <b>primeiro ponto</b> do modelo.`;
}

function newMeasurement(){
  clearTemporaryMarker(); firstMeasurePoint=null;
  measureState.innerHTML = `Toque/clique no <b>primeiro ponto</b> do modelo.`;
}

function pointIsVisibleByCut(p){ return !cutEnabled || cutPlane.distanceToPoint(p) >= -1e-7; }

function raycastAt(clientX,clientY){
  const rect=renderer.domElement.getBoundingClientRect();
  pointer.x=((clientX-rect.left)/rect.width)*2-1; pointer.y=-((clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer,camera);
  const hits=raycaster.intersectObjects(modelMeshes,false);
  for(const h of hits){ if(pointIsVisibleByCut(h.point)) return h; }
  return null;
}

function snapToVertex(hit,clientX,clientY){
  const geo=hit.object.geometry; const pos=geo.attributes.position; const face=hit.face;
  if(!pos || !face) return hit.point.clone();
  const indices=[face.a,face.b,face.c];
  const rect=renderer.domElement.getBoundingClientRect();
  let best=null, bestPx=Infinity;
  for(const i of indices){
    const p=new THREE.Vector3().fromBufferAttribute(pos,i); hit.object.localToWorld(p);
    if(!pointIsVisibleByCut(p)) continue;
    const s=p.clone().project(camera);
    const sx=rect.left+(s.x*.5+.5)*rect.width; const sy=rect.top+(-s.y*.5+.5)*rect.height;
    const d=Math.hypot(sx-clientX,sy-clientY);
    if(d<bestPx){bestPx=d;best=p;}
  }
  return best && bestPx<=16 ? best : hit.point.clone();
}

function onPointerUp(e){
  if(!measureEnabled || !pointerDown) return;
  const moved=Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y); pointerDown=null;
  if(moved>7) return;
  const hit=raycastAt(e.clientX,e.clientY); if(!hit) return;
  const point=snapToVertex(hit,e.clientX,e.clientY);
  if(!firstMeasurePoint){
    firstMeasurePoint=point; clearTemporaryMarker(); createMarker(point,true);
    measureState.innerHTML = `Primeiro ponto definido. Agora selecione o <b>segundo ponto</b>.`;
  }else{
    const a=firstMeasurePoint.clone(), b=point.clone(); clearTemporaryMarker(); createMeasurement(a,b); firstMeasurePoint=null;
    measureState.innerHTML = `Distância: <b>${formatDistance(a.distanceTo(b))}</b>. Toque em dois novos pontos para medir novamente.`;
  }
}

function setMeasureEnabled(value){
  measureEnabled=value;
  btnMeasure.classList.toggle("active",value);
  measurePanel.classList.toggle("show",value);
  crosshair.classList.toggle("show",value);
  if(value){ cutPanel.classList.remove("show"); btnCut.classList.toggle("active",cutEnabled); controls.enableRotate=true; newMeasurement(); }
  else{ clearTemporaryMarker(); firstMeasurePoint=null; }
}

async function boot(){
  try{
    setStatus("busy","Carregando"); setProgress(4,"Preparando visualizador…");
    initThree();
    const bytes=await fetchIfc();
    metersPerModelUnit=detectLengthUnit(bytes); unitNote.textContent=unitDescription();
    setProgress(37,"Inicializando leitor IFC…");
    const ifcApi=new IfcAPI(); ifcApi.SetWasmPath(WASM_PATH,true); await ifcApi.Init();
    setProgress(43,"Lendo estrutura IFC…");
    const modelID=ifcApi.OpenModel(bytes,{COORDINATE_TO_ORIGIN:true,USE_FAST_BOOLS:true});
    const geometryCache=new Map(); const materialCache=new Map(); let count=0;
    ifcApi.StreamAllMeshes(modelID,(flatMesh,index,total)=>{
      const geoms=flatMesh.geometries;
      for(let i=0;i<geoms.size();i++){
        const placed=geoms.get(i); const geo=geometryFromIfc(ifcApi,modelID,placed.geometryExpressID,geometryCache); if(!geo)continue;
        const mat=materialFor(placed.color,materialCache); const mesh=new THREE.Mesh(geo,mat);
        const matrix=new THREE.Matrix4(); matrix.fromArray(placed.flatTransformation); mesh.applyMatrix4(matrix); modelRoot.add(mesh); modelMeshes.push(mesh); count++;
      }
      const t=Number(total)||1; const x=Number(index)||0; setProgress(45+Math.min(1,(x+1)/t)*47,`Montando modelo 3D… ${Math.min(100,Math.round((x+1)/t*100))}%`);
    });
    ifcApi.CloseModel(modelID);
    if(!count) throw new Error("O IFC foi lido, mas nenhuma geometria 3D foi encontrada.");
    setProgress(94,"Enquadrando modelo…");
    modelRoot.updateMatrixWorld(true); modelBox=new THREE.Box3().setFromObject(modelRoot); fit("iso");
    modelMeta.textContent=`Estrutura • ${count.toLocaleString("pt-BR")} componentes 3D • corte + medição`;
    setProgress(100,"Modelo pronto"); setStatus("ok","Modelo pronto");
    setTimeout(()=>loader.classList.add("hidden"),250); setTimeout(()=>hint.classList.add("hide"),7000);
  }catch(e){
    console.error(e); setStatus("error","Erro"); setProgress(40,"Não foi possível carregar o IFC."); errorBox.textContent=`Erro ao abrir o modelo: ${e?.message||e}`; errorBox.classList.add("show");
  }
}

// Navegação
document.getElementById("btn-fit").addEventListener("click",()=>fit("iso"));
document.getElementById("btn-iso").addEventListener("click",()=>fit("iso"));
document.getElementById("btn-top").addEventListener("click",()=>fit("top"));
document.getElementById("btn-front").addEventListener("click",()=>fit("front"));

// Corte
btnCut.addEventListener("click",()=>{
  const opening=!cutPanel.classList.contains("show");
  cutPanel.classList.toggle("show",opening); measurePanel.classList.remove("show"); setMeasureEnabled(false);
  if(opening){ cutEnabled=true; btnCut.classList.add("active"); updateCut(); }
});
document.querySelectorAll(".axis-btn").forEach(b=>b.addEventListener("click",()=>setCutAxis(b.dataset.axis)));
cutSlider.addEventListener("input",()=>{cutEnabled=true;btnCut.classList.add("active");updateCut();});
document.getElementById("btn-cut-invert").addEventListener("click",()=>{cutEnabled=true;cutInverted=!cutInverted;btnCut.classList.add("active");updateCut();});
document.getElementById("btn-cut-clear").addEventListener("click",clearCut);

// Medição
btnMeasure.addEventListener("click",()=>setMeasureEnabled(!measureEnabled));
document.getElementById("btn-measure-new").addEventListener("click",newMeasurement);
document.getElementById("btn-measure-clear").addEventListener("click",clearMeasurements);

boot();
