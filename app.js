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
let declaredIfcUnitScale = 1;
let ifcApi = null;
let ifcModelID = null;
let selectedExpressID = null;
let selectionHelper = null;
let ifcInfoByExpressID = new Map();
let modelAxes = { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) };

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
  const name = Math.abs(declaredIfcUnitScale-0.01)<1e-9 ? "centímetros" :
               Math.abs(declaredIfcUnitScale-0.001)<1e-9 ? "milímetros" :
               Math.abs(declaredIfcUnitScale-1)<1e-9 ? "metros" : "unidade personalizada";
  return `IFC declarado em ${name} • medição corrigida em escala real`;
}

function computeModelAxes(){
  // Determina os eixos principais do modelo no plano horizontal (X/Z),
  // para que o corte acompanhe a orientação do IFC e não o eixo global da cena.
  const pts = [];
  for(const mesh of modelMeshes){
    const pos = mesh.geometry?.attributes?.position;
    if(!pos) continue;
    const count = pos.count;
    const step = Math.max(1, Math.floor(count / 120));
    for(let i=0; i<count; i+=step){
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      mesh.localToWorld(p);
      pts.push([p.x, p.z]);
    }
  }
  if(pts.length < 3){
    modelAxes = { x:new THREE.Vector3(1,0,0), y:new THREE.Vector3(0,1,0), z:new THREE.Vector3(0,0,1) };
    return;
  }
  let meanX=0, meanZ=0;
  for(const [x,z] of pts){ meanX += x; meanZ += z; }
  meanX /= pts.length; meanZ /= pts.length;
  let sxx=0, szz=0, sxz=0;
  for(const [x,z] of pts){
    const dx=x-meanX, dz=z-meanZ;
    sxx += dx*dx; szz += dz*dz; sxz += dx*dz;
  }
  const trace = sxx + szz;
  const det = sxx*szz - sxz*sxz;
  const disc = Math.max(0, trace*trace/4 - det);
  const lambda = trace/2 + Math.sqrt(disc);
  let dir;
  if(Math.abs(sxz) > 1e-9) dir = new THREE.Vector2(lambda - szz, sxz).normalize();
  else dir = sxx >= szz ? new THREE.Vector2(1,0) : new THREE.Vector2(0,1);
  const xAxis = new THREE.Vector3(dir.x, 0, dir.y).normalize();
  const yAxis = new THREE.Vector3(0,1,0);
  const zAxis = new THREE.Vector3().crossVectors(yAxis, xAxis).normalize();
  modelAxes = { x:xAxis, y:yAxis, z:zAxis };
}

function projectBoundsOntoAxis(axisVec){
  if(!modelBox) return { min: 0, max: 1 };
  const corners = [
    new THREE.Vector3(modelBox.min.x, modelBox.min.y, modelBox.min.z),
    new THREE.Vector3(modelBox.min.x, modelBox.min.y, modelBox.max.z),
    new THREE.Vector3(modelBox.min.x, modelBox.max.y, modelBox.min.z),
    new THREE.Vector3(modelBox.min.x, modelBox.max.y, modelBox.max.z),
    new THREE.Vector3(modelBox.max.x, modelBox.min.y, modelBox.min.z),
    new THREE.Vector3(modelBox.max.x, modelBox.min.y, modelBox.max.z),
    new THREE.Vector3(modelBox.max.x, modelBox.max.y, modelBox.min.z),
    new THREE.Vector3(modelBox.max.x, modelBox.max.y, modelBox.max.z),
  ];
  let min = Infinity, max = -Infinity;
  for(const c of corners){
    const v = axisVec.dot(c);
    if(v < min) min = v;
    if(v > max) max = v;
  }
  return { min, max };
}


// ---------- INSPEÇÃO IFC ----------

function splitIfcArgs(s){
  const out=[]; let cur="", depth=0, inStr=false;
  for(let i=0;i<s.length;i++){
    const ch=s[i];
    if(ch==="'"){
      cur+=ch;
      if(inStr && s[i+1]==="'"){ cur+="'"; i++; continue; }
      inStr=!inStr; continue;
    }
    if(!inStr){
      if(ch==='(') depth++;
      else if(ch===')') depth--;
      else if(ch===',' && depth===0){ out.push(cur.trim()); cur=""; continue; }
    }
    cur+=ch;
  }
  out.push(cur.trim());
  return out;
}

function decodeIfcText(v){
  if(!v || v==='$') return "";
  let s=String(v).trim();
  if(s.startsWith("'") && s.endsWith("'")) s=s.slice(1,-1).replace(/''/g,"'");
  // Decodificação básica de sequências IFC \X\hh (Latin-1), comum em exports brasileiros.
  s=s.replace(/\\X\\([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
  return s;
}

function parseIfcElementInfo(bytes){
  const map=new Map();
  try{
    const txt=new TextDecoder('utf-8').decode(bytes);
    const lines=txt.split(/;\s*(?:\r?\n)?/);
    for(const raw of lines){
      const m=raw.match(/^\s*#(\d+)\s*=\s*(IFC[A-Z0-9_]+)\s*\((.*)\)\s*$/is);
      if(!m) continue;
      const id=Number(m[1]), type=m[2].toUpperCase();
      // Só indexamos entidades que podem ser clicadas/renderizadas como produtos.
      // Os primeiros campos de IfcRoot/IfcObject/IfcProduct são estáveis entre IFC2x3/IFC4.
      const args=splitIfcArgs(m[3]);
      if(args.length < 3) continue;
      const globalId=decodeIfcText(args[0]);
      const name=decodeIfcText(args[2]);
      const description=decodeIfcText(args[3]);
      const objectType=decodeIfcText(args[4]);
      const tag=decodeIfcText(args[7]);
      const predefinedType=decodeIfcText(args[8]).replace(/^\.|\.$/g,'');
      map.set(id,{expressID:id,typeName:type,globalId,name,description,objectType,tag,predefinedType});
    }
  }catch(e){ console.warn('Não foi possível pré-indexar os nomes IFC',e); }
  return map;
}

const IFC_LABELS_PT = {
  IFCBEAM: "Viga",
  IFCBEAMSTANDARDCASE: "Viga",
  IFCSLAB: "Laje",
  IFCSLABSTANDARDCASE: "Laje",
  IFCCOLUMN: "Pilar",
  IFCCOLUMNSTANDARDCASE: "Pilar",
  IFCWALL: "Parede",
  IFCWALLSTANDARDCASE: "Parede",
  IFCFOOTING: "Fundação",
  IFCPILE: "Estaca",
  IFCMEMBER: "Barra / membro",
  IFCPLATE: "Placa",
  IFCSTAIR: "Escada",
  IFCSTAIRFLIGHT: "Lance de escada",
  IFCRAMP: "Rampa",
  IFCRAMPFLIGHT: "Lance de rampa",
  IFCROOF: "Cobertura",
  IFCDOOR: "Porta",
  IFCWINDOW: "Janela",
  IFCCURTAINWALL: "Fachada cortina",
  IFCBUILDINGELEMENTPROXY: "Elemento",
  IFCREINFORCINGBAR: "Armadura",
  IFCREINFORCINGMESH: "Tela de armadura",
  IFCSPACE: "Ambiente",
  IFCOPENINGELEMENT: "Abertura"
};

function rawIfcValue(v){
  if(v == null) return "";
  if(typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if(typeof v === "object"){
    if("value" in v && v.value != null) return String(v.value);
    if("Name" in v) return rawIfcValue(v.Name);
  }
  return "";
}

function getIfcTypeName(line){
  let typeName = "";
  try{
    if(ifcApi && typeof ifcApi.GetNameFromTypeCode === "function" && line?.type != null){
      typeName = ifcApi.GetNameFromTypeCode(line.type) || "";
    }
  }catch(e){ /* fallback abaixo */ }
  if(!typeName && line?.constructor?.name && !/^Object$/i.test(line.constructor.name)) typeName = line.constructor.name;
  typeName = String(typeName || "Elemento IFC").toUpperCase().replace(/^WEBIFC\./,"");
  return typeName;
}

function ensureInfoPanel(){
  let panel = document.getElementById("ifc-info-panel");
  if(panel) return panel;
  const style = document.createElement("style");
  style.textContent = `
    #ifc-info-panel{position:absolute;right:18px;top:86px;z-index:25;width:min(360px,calc(100% - 36px));background:rgba(255,255,255,.97);border:1px solid rgba(0,0,0,.08);border-radius:16px;box-shadow:0 14px 34px rgba(0,0,0,.16);padding:15px 16px;display:none;font-family:inherit;color:#282828;backdrop-filter:blur(10px)}
    #ifc-info-panel.show{display:block}
    #ifc-info-panel .ifc-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;margin-bottom:8px}
    #ifc-info-panel .ifc-kicker{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#ff6500;margin-bottom:4px}
    #ifc-info-panel .ifc-title{font-size:16px;font-weight:800;line-height:1.2;word-break:break-word}
    #ifc-info-panel .ifc-close{border:0;background:#f1f1f1;border-radius:9px;width:30px;height:30px;cursor:pointer;font-size:18px;line-height:28px;color:#555}
    #ifc-info-panel .ifc-grid{display:grid;grid-template-columns:92px 1fr;gap:7px 10px;font-size:12px;border-top:1px solid #eee;padding-top:10px}
    #ifc-info-panel .ifc-label{color:#777;font-weight:700}
    #ifc-info-panel .ifc-value{color:#222;font-weight:600;min-width:0;overflow-wrap:anywhere}
    #ifc-info-panel .ifc-hint{font-size:10px;color:#8a8a8a;margin-top:10px;line-height:1.35}
    @media(max-width:700px){#ifc-info-panel{left:12px;right:12px;top:auto;bottom:92px;width:auto;max-height:42vh;overflow:auto;border-radius:14px}}
  `;
  document.head.appendChild(style);
  panel = document.createElement("div");
  panel.id = "ifc-info-panel";
  panel.innerHTML = `
    <div class="ifc-head">
      <div><div class="ifc-kicker">Elemento IFC</div><div class="ifc-title" id="ifc-info-title">Elemento</div></div>
      <button class="ifc-close" id="ifc-info-close" aria-label="Fechar">×</button>
    </div>
    <div class="ifc-grid" id="ifc-info-grid"></div>
    <div class="ifc-hint">Clique/toque em outro elemento para consultar seus dados IFC.</div>
  `;
  viewer.appendChild(panel);
  panel.querySelector("#ifc-info-close").addEventListener("click",()=>clearIfcSelection());
  return panel;
}

function clearIfcSelection(){
  selectedExpressID = null;
  const panel = document.getElementById("ifc-info-panel");
  panel?.classList.remove("show");
  if(selectionHelper){ scene.remove(selectionHelper); selectionHelper.geometry?.dispose?.(); selectionHelper.material?.dispose?.(); selectionHelper=null; }
}

function showSelectionHelper(expressID){
  if(selectionHelper){ scene.remove(selectionHelper); selectionHelper.geometry?.dispose?.(); selectionHelper.material?.dispose?.(); selectionHelper=null; }
  const selected = modelMeshes.filter(m=>m.userData?.expressID===expressID);
  if(!selected.length) return;
  const box = new THREE.Box3();
  for(const mesh of selected) box.expandByObject(mesh);
  if(box.isEmpty()) return;
  selectionHelper = new THREE.Box3Helper(box, 0xff6a00);
  selectionHelper.renderOrder = 1000;
  scene.add(selectionHelper);
}

function addInfoRow(rows,label,value){
  const v = String(value ?? "").trim();
  if(!v || v === "$" || v.toUpperCase() === "NOTDEFINED") return;
  rows.push(`<div class="ifc-label">${label}</div><div class="ifc-value">${v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>`);
}

function inspectIfcElement(hit){
  if(!hit?.object) return;
  const expressID = hit.object.userData?.expressID;
  if(expressID == null) return;
  try{
    let info = ifcInfoByExpressID.get(Number(expressID));
    // Fallback para Web-IFC, caso o item não tenha sido encontrado no texto bruto.
    if(!info && ifcApi && ifcModelID != null){
      const line = ifcApi.GetLine(ifcModelID, expressID, true);
      if(line){
        const typeName=getIfcTypeName(line);
        info={
          expressID,
          typeName,
          name:rawIfcValue(line.Name),
          description:rawIfcValue(line.Description),
          objectType:rawIfcValue(line.ObjectType),
          tag:rawIfcValue(line.Tag),
          predefinedType:rawIfcValue(line.PredefinedType),
          globalId:rawIfcValue(line.GlobalId)
        };
      }
    }
    if(!info) info={expressID,typeName:'ELEMENTO IFC',name:`Elemento #${expressID}`};

    selectedExpressID = expressID;
    showSelectionHelper(expressID);
    const typeName = String(info.typeName || 'ELEMENTO IFC').toUpperCase();
    const ptType = IFC_LABELS_PT[typeName] || typeName.replace(/^IFC/,"");
    const name = info.name || `${ptType} #${expressID}`;
    const panel = ensureInfoPanel();
    panel.querySelector("#ifc-info-title").textContent = name;
    const rows=[];
    addInfoRow(rows,"Tipo",`${ptType}${typeName && typeName!==ptType ? ` (${typeName})` : ""}`);
    addInfoRow(rows,"Nome IFC",info.name);
    addInfoRow(rows,"Descrição",info.description);
    addInfoRow(rows,"Objeto",info.objectType);
    addInfoRow(rows,"Tag",info.tag);
    addInfoRow(rows,"Pré-definição",info.predefinedType);
    addInfoRow(rows,"GlobalId",info.globalId);
    addInfoRow(rows,"Express ID",`#${expressID}`);
    panel.querySelector("#ifc-info-grid").innerHTML = rows.join("");
    panel.classList.add("show");
  }catch(e){
    console.warn("Não foi possível ler as propriedades IFC do elemento", e);
  }
}

// ---------- CORTE ----------
function axisVector(axis){
  return modelAxes[axis]?.clone() || new THREE.Vector3(1,0,0);
}

function boundsForAxis(axis){
  return projectBoundsOntoAxis(axisVector(axis));
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
  const baseAxis = axisVector(cutAxis);
  const normal = baseAxis.clone().multiplyScalar(cutInverted ? -1 : 1).normalize();
  const planePoint = baseAxis.clone().normalize().multiplyScalar(coordinate);
  cutPlane.setFromNormalAndCoplanarPoint(normal, planePoint);
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
  if(!pointerDown) return;
  const moved=Math.hypot(e.clientX-pointerDown.x,e.clientY-pointerDown.y); pointerDown=null;
  if(moved>7) return;
  const hit=raycastAt(e.clientX,e.clientY);
  if(!hit) return;

  if(!measureEnabled){
    inspectIfcElement(hit);
    return;
  }

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
    initThree(); ensureInfoPanel();
    const bytes=await fetchIfc();
    ifcInfoByExpressID = parseIfcElementInfo(bytes);
    declaredIfcUnitScale = detectLengthUnit(bytes);
    // O Web-IFC já entrega a geometria em escala SI (metros).
    // Por isso a medição deve usar 1 unidade = 1 metro no visualizador.
    metersPerModelUnit = 1;
    unitNote.textContent = unitDescription();
    setProgress(37,"Inicializando leitor IFC…");
    ifcApi=new IfcAPI(); ifcApi.SetWasmPath(WASM_PATH,true); await ifcApi.Init();
    setProgress(43,"Lendo estrutura IFC…");
    ifcModelID=ifcApi.OpenModel(bytes,{COORDINATE_TO_ORIGIN:true,USE_FAST_BOOLS:true});
    const geometryCache=new Map(); const materialCache=new Map(); let count=0;
    ifcApi.StreamAllMeshes(ifcModelID,(flatMesh,index,total)=>{
      const geoms=flatMesh.geometries;
      for(let i=0;i<geoms.size();i++){
        const placed=geoms.get(i); const geo=geometryFromIfc(ifcApi,ifcModelID,placed.geometryExpressID,geometryCache); if(!geo)continue;
        const mat=materialFor(placed.color,materialCache); const mesh=new THREE.Mesh(geo,mat);
        const matrix=new THREE.Matrix4(); matrix.fromArray(placed.flatTransformation); mesh.applyMatrix4(matrix); mesh.userData.expressID = flatMesh.expressID; modelRoot.add(mesh); modelMeshes.push(mesh); count++;
      }
      const t=Number(total)||1; const x=Number(index)||0; setProgress(45+Math.min(1,(x+1)/t)*47,`Montando modelo 3D… ${Math.min(100,Math.round((x+1)/t*100))}%`);
    });
    // Os nomes/tipos já foram indexados do próprio arquivo IFC; podemos fechar o modelo Web-IFC.
    try{ ifcApi.CloseModel(ifcModelID); }catch(e){}
    ifcModelID = null;
    if(!count) throw new Error("O IFC foi lido, mas nenhuma geometria 3D foi encontrada.");
    setProgress(94,"Enquadrando modelo…");
    modelRoot.updateMatrixWorld(true); modelBox=new THREE.Box3().setFromObject(modelRoot); computeModelAxes(); fit("iso");
    modelMeta.textContent=`Estrutura • ${count.toLocaleString("pt-BR")} componentes 3D • clique no elemento para ver nome IFC`;
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

window.addEventListener("beforeunload",()=>{ try{ if(ifcApi && ifcModelID!=null) ifcApi.CloseModel(ifcModelID); }catch(e){} });

boot();
