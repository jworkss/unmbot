const fs = require("fs");
const path = require("path");

const EMBED_URL = "http://127.0.0.1:11434/api/embed";
const EMBED_MODEL = "bge-m3";
const KB_PATH = path.join(__dirname, "kb", "conocimiento.json");
const CACHE_PATH = path.join(__dirname, "kb", "embeddings.json");

let kb = [];

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
  const raw = JSON.parse(fs.readFileSync(KB_PATH, "utf8"));
  return raw.preguntas_frecuentes.map((e, i) => ({
    id: `faq-${i + 1}`,
    tema: e.categoria,
    pregunta: limpiar(e.pregunta),
    texto: limpiar(e.respuesta),
  }));
}

async function embed(texts) {
  const r = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, keep_alive: 0 }),
  });
  const data = await r.json();
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

async function initKB() {
  const cacheOk =
    fs.existsSync(CACHE_PATH) &&
    fs.statSync(CACHE_PATH).mtimeMs > fs.statSync(KB_PATH).mtimeMs;
  if (cacheOk) {
    kb = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return;
  }
  const items = cargarItems();
  const embs = await embed(
    items.map((i) => `${i.tema}. ${i.pregunta} ${i.texto}`),
  );
  kb = items.map((it, i) => ({ ...it, embedding: embs[i] }));
  fs.writeFileSync(CACHE_PATH, JSON.stringify(kb));
}

async function buscar(pregunta, k = 3, minScore = 0.45) {
  const [q] = await embed([pregunta]);
  const palabras = new Set(
    normalizar(pregunta)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 5),
  );
  return kb
    .map((it) => {
      const base = normalizar(`${it.pregunta} ${it.texto}`);
      let hits = 0;
      palabras.forEach((w) => {
        if (base.includes(w)) hits++;
      });
      const boost = palabras.size ? 0.15 * (hits / palabras.size) : 0;
      return { it, score: cosine(q, it.embedding) + boost };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((x) => x.score >= minScore)
    .map((x) => x.it);
}

module.exports = { initKB, buscar };
