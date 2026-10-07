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

let camera, renderer, controls, modelRoot, modelBox;

function setStatus(kind, text){statusDot.className=`dot ${kind}`;statusText.textContent=text}
function setProgress(v, text){progressBar.style.width=`${Math.max(4,Math.min(100,Math.round(v)))}%`;progressText.textContent=text}

function initThree(){
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf4f3f1);
  camera = new THREE.PerspectiveCamera(48, viewer.clientWidth/viewer.clientHeight, 0.01, 1e9);
  renderer = new THREE.WebGLRenderer({antialias:true, alpha:false, powerPreference:"high-performance"});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(viewer.clientWidth, viewer.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
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

  const animate=()=>{requestAnimationFrame(animate);controls.update();renderer.render(scene,camera)}; animate();
  const resize=()=>{const w=viewer.clientWidth,h=viewer.clientHeight;camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h)};
  window.addEventListener("resize",resize,{passive:true});
  return scene;
}

function fit(direction="iso", animate=false){
  if(!modelBox || modelBox.isEmpty()) return;
  const sphere=new THREE.Sphere(); modelBox.getBoundingSphere(sphere);
  const c=sphere.center, r=Math.max(sphere.radius,1);
  let p;
  if(direction==="top") p=new THREE.Vector3(c.x,c.y+r*2.4,c.z+0.001);
  else if(direction==="front") p=new THREE.Vector3(c.x,c.y+r*0.18,c.z+r*2.4);
  else p=new THREE.Vector3(c.x+r*1.45,c.y+r*1.1,c.z+r*1.45);
  controls.target.copy(c); camera.position.copy(p); camera.near=Math.max(r/10000,0.01); camera.far=Math.max(r*50,1000); camera.updateProjectionMatrix(); controls.update();
}

function materialFor(color, cache){
  const r=Math.max(0,Math.min(1,color?.x ?? .72)); const g=Math.max(0,Math.min(1,color?.y ?? .72)); const b=Math.max(0,Math.min(1,color?.z ?? .72)); const a=Math.max(0.03,Math.min(1,color?.w ?? 1));
  const key=`${r.toFixed(3)}_${g.toFixed(3)}_${b.toFixed(3)}_${a.toFixed(3)}`;
  if(cache.has(key)) return cache.get(key);
  const m=new THREE.MeshStandardMaterial({color:new THREE.Color(r,g,b),roughness:.72,metalness:.02,side:THREE.DoubleSide,transparent:a<.995,opacity:a,depthWrite:a>.75});
  cache.set(key,m); return m;
}

function geometryFromIfc(ifcApi, modelID, geometryExpressID, cache){
  if(cache.has(geometryExpressID)) return cache.get(geometryExpressID);
  const ifcGeom=ifcApi.GetGeometry(modelID,geometryExpressID);
  const verts=ifcApi.GetVertexArray(ifcGeom.GetVertexData(),ifcGeom.GetVertexDataSize());
  const idx=ifcApi.GetIndexArray(ifcGeom.GetIndexData(),ifcGeom.GetIndexDataSize());
  if(!verts?.length || !idx?.length){ifcGeom.delete?.();return null}
  const n=verts.length/6; const pos=new Float32Array(n*3); const nor=new Float32Array(n*3);
  for(let i=0,j=0;i<verts.length;i+=6,j+=3){pos[j]=verts[i];pos[j+1]=verts[i+1];pos[j+2]=verts[i+2];nor[j]=verts[i+3];nor[j+1]=verts[i+4];nor[j+2]=verts[i+5]}
  const geo=new THREE.BufferGeometry(); geo.setAttribute("position",new THREE.BufferAttribute(pos,3)); geo.setAttribute("normal",new THREE.BufferAttribute(nor,3)); geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx),1)); geo.computeBoundingSphere();
  cache.set(geometryExpressID,geo); ifcGeom.delete?.(); return geo;
}

async function fetchIfc(){
  const r=await fetch(MODEL_URL,{cache:"no-cache"}); if(!r.ok) throw new Error(`Falha ao baixar modelo.ifc (HTTP ${r.status}).`);
  const total=Number(r.headers.get("content-length"))||0;
  if(!r.body || !total){const a=new Uint8Array(await r.arrayBuffer());setProgress(34,"IFC baixado. Inicializando BIM…");return a}
  const reader=r.body.getReader();const chunks=[];let received=0;
  while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);received+=value.length;setProgress(8+(received/total)*27,`Baixando IFC… ${Math.round(received/total*100)}%`)}
  const bytes=new Uint8Array(received);let o=0;for(const c of chunks){bytes.set(c,o);o+=c.length}return bytes;
}

async function boot(){
  try{
    setStatus("busy","Carregando");setProgress(4,"Preparando visualizador…");
    initThree();
    const bytes=await fetchIfc();
    setProgress(37,"Inicializando leitor IFC…");
    const ifcApi=new IfcAPI();
    ifcApi.SetWasmPath(WASM_PATH,true);
    await ifcApi.Init();
    setProgress(43,"Lendo estrutura IFC…");
    const modelID=ifcApi.OpenModel(bytes,{COORDINATE_TO_ORIGIN:true,USE_FAST_BOOLS:true});
    const geometryCache=new Map();const materialCache=new Map();let count=0;
    ifcApi.StreamAllMeshes(modelID,(flatMesh,index,total)=>{
      const geoms=flatMesh.geometries;
      for(let i=0;i<geoms.size();i++){
        const placed=geoms.get(i);const geo=geometryFromIfc(ifcApi,modelID,placed.geometryExpressID,geometryCache);if(!geo)continue;
        const mat=materialFor(placed.color,materialCache);const mesh=new THREE.Mesh(geo,mat);
        const matrix=new THREE.Matrix4();matrix.fromArray(placed.flatTransformation);mesh.applyMatrix4(matrix);modelRoot.add(mesh);count++;
      }
      const t=Number(total)||1;const x=Number(index)||0;setProgress(45+Math.min(1,(x+1)/t)*47,`Montando modelo 3D… ${Math.min(100,Math.round((x+1)/t*100))}%`);
    });
    ifcApi.CloseModel(modelID);
    if(!count) throw new Error("O IFC foi lido, mas nenhuma geometria 3D foi encontrada.");
    setProgress(94,"Enquadrando modelo…");
    modelRoot.updateMatrixWorld(true); modelBox=new THREE.Box3().setFromObject(modelRoot); fit("iso");
    modelMeta.textContent=`Estrutura • ${count.toLocaleString("pt-BR")} componentes 3D`;
    setProgress(100,"Modelo pronto");setStatus("ok","Modelo pronto");
    setTimeout(()=>loader.classList.add("hidden"),250);setTimeout(()=>hint.classList.add("hide"),7000);
  }catch(e){console.error(e);setStatus("error","Erro");setProgress(40,"Não foi possível carregar o IFC.");errorBox.textContent=`Erro ao abrir o modelo: ${e?.message||e}`;errorBox.classList.add("show")}
}

document.getElementById("btn-fit").addEventListener("click",()=>fit("iso"));
document.getElementById("btn-iso").addEventListener("click",()=>fit("iso"));
document.getElementById("btn-top").addEventListener("click",()=>fit("top"));
document.getElementById("btn-front").addEventListener("click",()=>fit("front"));
boot();
