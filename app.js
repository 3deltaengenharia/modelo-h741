import * as THREE from "https://esm.sh/three@0.181.0";
import * as OBC from "https://esm.sh/@thatopen/components@3.4.9?deps=three@0.181.0";

const MODEL_URL = "./modelo.ifc";
const CACHE_DB = "3delta-bim-cache-v1";
const CACHE_STORE = "models";
const MODEL_ID = "H741-LEAO";

const viewer = document.getElementById("viewer");
const loader = document.getElementById("loader");
const progressBar = document.getElementById("progress-bar");
const progressText = document.getElementById("progress-text");
const errorBox = document.getElementById("error-box");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const modelMeta = document.getElementById("model-meta");
const hint = document.getElementById("hint");

let modelSphere = null;
let world = null;
let fragments = null;

function setStatus(kind, text) {
  statusDot.className = `dot ${kind}`;
  statusText.textContent = text;
}

function setProgress(value, label) {
  const pct = Math.max(4, Math.min(100, Math.round(value)));
  progressBar.style.width = `${pct}%`;
  progressText.textContent = label || `${pct}%`;
}

function extractRevision(bytes) {
  try {
    const sample = bytes.slice(0, Math.min(bytes.length, 2_000_000));
    const text = new TextDecoder("latin1").decode(sample);
    const name = text.match(/IFCBUILDING\([^;]{0,2000}?'([^']+)'/i)?.[1] || "";
    const rev = (name.match(/(?:^|[-_])(R\d{2,3})(?:[-_]|$)/i) || text.match(/(?:^|[-_])(R\d{2,3})(?:[-_]|$)/im))?.[1]?.toUpperCase();
    return { name, rev };
  } catch {
    return { name: "", rev: "" };
  }
}

function fitModel(animate = true) {
  if (!world?.camera?.controls || !modelSphere) return;
  world.camera.controls.fitToSphere(modelSphere, animate);
}

async function setView(direction) {
  if (!world?.camera?.controls || !modelSphere) return;
  const c = modelSphere.center;
  const r = Math.max(modelSphere.radius, 1);
  let p;
  if (direction === "top") p = new THREE.Vector3(c.x, c.y + r * 2.8, c.z);
  else if (direction === "front") p = new THREE.Vector3(c.x, c.y + r * 0.25, c.z + r * 2.8);
  else p = new THREE.Vector3(c.x + r * 1.7, c.y + r * 1.25, c.z + r * 1.7);
  await world.camera.controls.setLookAt(p.x, p.y, p.z, c.x, c.y, c.z, true);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readonly");
      const req = tx.objectStore(CACHE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function cachePut(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      const store = tx.objectStore(CACHE_STORE);
      // Mantém apenas a versão atual do modelo neste navegador.
      store.clear();
      store.put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("Cache local indisponível", e);
  }
}

async function getServerVersion() {
  try {
    // "no-cache" permite revalidação (304) sem forçar download do IFC toda vez.
    const r = await fetch(MODEL_URL, { method: "HEAD", cache: "no-cache" });
    if (!r.ok) return null;
    const etag = r.headers.get("etag") || "";
    const modified = r.headers.get("last-modified") || "";
    const length = r.headers.get("content-length") || "";
    return `${etag}|${modified}|${length}` || null;
  } catch {
    return null;
  }
}

async function prepareModel(model) {
  fragments.core.update(true);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const box = new THREE.Box3().setFromObject(model.object);
  if (!box.isEmpty()) {
    modelSphere = new THREE.Sphere();
    box.getBoundingSphere(modelSphere);
    if (Number.isFinite(modelSphere.radius) && modelSphere.radius > 0) {
      await setView("iso");
      fitModel(false);
    }
  }
}

async function boot() {
  try {
    setStatus("busy", "Carregando");
    setProgress(5, "Preparando visualizador…");

    const components = new OBC.Components();
    const worlds = components.get(OBC.Worlds);
    world = worlds.create();
    world.scene = new OBC.SimpleScene(components);
    world.scene.setup();
    world.scene.three.background = new THREE.Color(0xf4f3f1);
    world.renderer = new OBC.SimpleRenderer(components, viewer);
    world.camera = new OBC.OrthoPerspectiveCamera(components);
    components.init();
    components.get(OBC.Grids).create(world);

    const workerUrl = await OBC.FragmentsManager.getWorker();
    fragments = components.get(OBC.FragmentsManager);
    fragments.init(workerUrl);
    world.camera.controls.addEventListener("update", () => fragments.core.update());
    world.onCameraChanged.add((camera) => {
      for (const [, m] of fragments.list) m.useCamera(camera.three);
      fragments.core.update(true);
    });
    fragments.list.onItemSet.add(({ value: m }) => {
      m.useCamera(world.camera.three);
      world.scene.three.add(m.object);
      fragments.core.update(true);
    });

    // Primeiro tenta o modelo já convertido e salvo no próprio celular/computador.
    setProgress(10, "Verificando versão do modelo…");
    const serverVersion = await getServerVersion();
    const cacheKey = serverVersion ? `${MODEL_URL}|${serverVersion}` : null;
    const cached = cacheKey ? await cacheGet(cacheKey) : null;

    if (cached?.fragments) {
      setProgress(28, "Abrindo modelo otimizado…");
      const model = await fragments.core.load(cached.fragments, { modelId: MODEL_ID });
      modelMeta.textContent = cached.metaText || "Estrutura • IFC";
      await prepareModel(model);
      setProgress(100, "Modelo pronto");
      setStatus("ok", "Modelo atualizado");
      setTimeout(() => loader.classList.add("hidden"), 180);
      setTimeout(() => hint.classList.add("hide"), 7000);
      return;
    }

    const ifcLoader = components.get(OBC.IfcLoader);
    await ifcLoader.setup({
      autoSetWasm: false,
      wasm: { path: "https://unpkg.com/web-ifc@0.0.77/", absolute: true },
    });

    setProgress(14, "Primeiro acesso: baixando IFC…");
    // Sem timestamp na URL: o navegador pode reaproveitar/validar o arquivo.
    const response = await fetch(MODEL_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Não foi possível baixar o IFC (HTTP ${response.status}).`);
    const total = Number(response.headers.get("content-length")) || 0;
    let bytes;

    if (response.body && total) {
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const downloadPct = 14 + (received / total) * 26;
        setProgress(downloadPct, `Baixando IFC… ${Math.round((received / total) * 100)}%`);
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      bytes = merged;
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
      setProgress(40, "IFC baixado. Processando geometria…");
    }

    const meta = extractRevision(bytes);
    const metaText = meta.rev ? `Estrutura • ${meta.rev} • IFC` : "Estrutura • IFC";
    modelMeta.textContent = metaText;

    setProgress(43, "Primeiro acesso: processando BIM…");
    const model = await ifcLoader.load(bytes, false, MODEL_ID, {
      processData: {
        progressCallback: (p) => {
          const normalized = p > 1 ? p / 100 : p;
          const pct = 43 + Math.max(0, Math.min(1, normalized)) * 46;
          setProgress(pct, `Processando geometria… ${Math.round(normalized * 100)}%`);
        },
      },
    });

    await prepareModel(model);

    // Salva a conversão em Fragments no dispositivo. Próximas aberturas pulam
    // o parsing pesado do IFC, desde que a versão do arquivo não tenha mudado.
    if (cacheKey) {
      setProgress(92, "Otimizando próximos acessos…");
      try {
        const fragBytes = await model.getBuffer(false);
        const fragBuffer = fragBytes instanceof ArrayBuffer
          ? fragBytes
          : fragBytes.buffer.slice(fragBytes.byteOffset, fragBytes.byteOffset + fragBytes.byteLength);
        await cachePut(cacheKey, { fragments: fragBuffer, metaText, savedAt: Date.now() });
      } catch (e) {
        console.warn("Não foi possível salvar cache de fragments", e);
      }
    }

    setProgress(100, "Modelo pronto");
    setStatus("ok", "Modelo atualizado");
    setTimeout(() => loader.classList.add("hidden"), 220);
    setTimeout(() => hint.classList.add("hide"), 7000);
  } catch (error) {
    console.error(error);
    setStatus("error", "Erro");
    errorBox.textContent = `Erro ao abrir o modelo: ${error?.message || error}. Verifique a conexão e tente novamente.`;
    errorBox.classList.add("show");
    progressText.textContent = "Não foi possível carregar o IFC.";
  }
}

document.getElementById("btn-fit").addEventListener("click", () => fitModel(true));
document.getElementById("btn-iso").addEventListener("click", () => setView("iso"));
document.getElementById("btn-top").addEventListener("click", () => setView("top"));
document.getElementById("btn-front").addEventListener("click", () => setView("front"));

boot();
