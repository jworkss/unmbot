const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EMBED_URL = "http://127.0.0.1:11434/api/embed";
const EMBED_MODEL = "bge-m3";
const KB_DIR = path.join(__dirname, "kb");
const CACHE_PATH = path.join(KB_DIR, "embeddings.json");
const CACHE_VERSION = 2;
const PALABRAS_COMUNES = new Set(
  "a al algo ante bajo cada como con contra cual cuando de del desde donde durante e el ella en entre era es esa ese esto fue ha hasta la las le les lo los mas me mi mucho muy no nos o para pero por que se sin sobre su sus te tener toda todo tu un una uno y ya".split(" "),
);
const SIGLAS = new Set(["dni", "unm", "uba"]);

let kb = [];
let embedForSearch = embed;

const limpiar = (s) =>
  s
    .replace(/\[cite:[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const normalizar = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

function cargarItems() {
  const archivos = fs.readdirSync(KB_DIR)
    .filter((nombre) => nombre.endsWith(".json") && nombre !== path.basename(CACHE_PATH))
    .sort();

  const items = archivos.flatMap((archivo) => {
    const ruta = path.join(KB_DIR, archivo);
    const raw = JSON.parse(fs.readFileSync(ruta, "utf8"));
    if (!Array.isArray(raw.preguntas_frecuentes)) {
      throw new Error(`El archivo ${archivo} no contiene preguntas_frecuentes.`);
    }

    return raw.preguntas_frecuentes.map((e, i) => ({
      id: e.id || `${path.basename(archivo, ".json")}-faq-${i + 1}`,
      archivo,
      tema: e.categoria || "Información general",
      etiqueta: e.etiqueta ? limpiar(e.etiqueta) : "",
      pregunta: limpiar(e.pregunta),
      texto: limpiar(e.respuesta),
      palabrasClave: Array.isArray(e.palabras_clave)
        ? e.palabras_clave.map(limpiar)
        : [],
      fuente: e.fuente ? limpiar(e.fuente) : "",
      actualizado: e.actualizado || "",
    }));
  });

  const unicos = new Map();
  items.forEach((item) => {
    const clave = normalizar(`${item.pregunta} ${item.texto}`)
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const existente = unicos.get(clave);
    if (!existente) {
      unicos.set(clave, item);
      return;
    }

    existente.palabrasClave = [...new Set([
      ...existente.palabrasClave,
      ...item.palabrasClave,
    ])];
    if (!existente.etiqueta) existente.etiqueta = item.etiqueta;
    if (!existente.fuente) existente.fuente = item.fuente;
    if (!existente.actualizado) existente.actualizado = item.actualizado;
  });
  return [...unicos.values()];
}

function textoParaEmbedding(item) {
  return [
    item.tema,
    item.etiqueta,
    item.pregunta,
    item.palabrasClave.join(". "),
    item.texto,
  ].filter(Boolean).join(". ");
}

function firmaFuentes(archivos) {
  const hash = crypto.createHash("sha256");
  archivos.forEach((archivo) => {
    hash.update(archivo);
    hash.update(fs.readFileSync(path.join(KB_DIR, archivo)));
  });
  return hash.digest("hex");
}

async function embed(texts) {
  const r = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: 0 }),
  });
  if (!r.ok) throw new Error(`Ollama embeddings respondió ${r.status}.`);
  const data = await r.json();
  if (
    !Array.isArray(data.embeddings) ||
    data.embeddings.length !== texts.length ||
    data.embeddings.some((vector) =>
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error("Ollama no devolvió un embedding por cada texto solicitado.");
  }
  return data.embeddings;
}

function cosine(a, b) {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

async function initKB({ cachePath = CACHE_PATH, embedFn = embed } = {}) {
  embedForSearch = embedFn;
  const archivos = fs.readdirSync(KB_DIR)
    .filter((nombre) => nombre.endsWith(".json") && nombre !== path.basename(CACHE_PATH))
    .sort();
  const firma = firmaFuentes(archivos);
  const items = cargarItems();

  if (fs.existsSync(cachePath)) {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (
      cache.version === CACHE_VERSION &&
      cache.modelo === EMBED_MODEL &&
      cache.firma === firma &&
      Array.isArray(cache.items) &&
      cache.items.length === items.length &&
      cache.items.every((item) =>
        Array.isArray(item.embedding) &&
        item.embedding.length > 0 &&
        item.embedding.every(Number.isFinite),
      )
    ) {
      const embeddings = new Map(cache.items.map((item) => [item.id, item.embedding]));
      if (items.every((item) => embeddings.has(item.id))) {
        kb = items.map((item) => ({ ...item, embedding: embeddings.get(item.id) }));
        return;
      }
    }
  }

  const embs = await embedFn(
    items.map(textoParaEmbedding),
  );
  kb = items.map((it, i) => ({ ...it, embedding: embs[i] }));
  fs.writeFileSync(cachePath, JSON.stringify({
    version: CACHE_VERSION,
    modelo: EMBED_MODEL,
    firma,
    items: kb.map(({ id, embedding }) => ({ id, embedding })),
  }));
}

async function buscar(pregunta, k = 3, minScore = 0.45) {
  const [q] = await embedForSearch([pregunta]);
  const preguntaNormalizada = normalizar(pregunta).replace(/[^a-z0-9]+/g, " ").trim();
  const palabras = new Set(
    normalizar(pregunta)
      .split(/[^a-z0-9]+/)
      .filter((w) => (w.length >= 4 || SIGLAS.has(w)) && !PALABRAS_COMUNES.has(w)),
  );
  return kb
    .map((it) => {
      const base = normalizar([
        it.tema,
        it.etiqueta,
        it.pregunta,
        it.palabrasClave.join(" "),
        it.texto,
      ].join(" "));
      let hits = 0;
      palabras.forEach((w) => {
        if (base.includes(w)) hits++;
      });
      const boost = palabras.size ? 0.15 * (hits / palabras.size) : 0;
      const fraseCoincide = it.palabrasClave.some((keyword) => {
        const frase = normalizar(keyword).replace(/[^a-z0-9]+/g, " ").trim();
        return frase.includes(" ") && preguntaNormalizada.includes(frase);
      });
      const score = cosine(q, it.embedding) + boost;
      return { it, score: fraseCoincide ? Math.max(score, 0.55) : score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((x) => x.score >= minScore)
    .map((x) => x.it);
}

module.exports = { initKB, buscar, cargarItems };
