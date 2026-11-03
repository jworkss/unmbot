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

  const items = [];
  const departamentos = [];
  archivos.forEach((archivo) => {
    const ruta = path.join(KB_DIR, archivo);
    const raw = JSON.parse(fs.readFileSync(ruta, "utf8"));
    if (Array.isArray(raw.preguntas_frecuentes)) {
      items.push(...raw.preguntas_frecuentes.map((e, i) => ({
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
      })));
      return;
    }

    if (
      Array.isArray(raw.carreras) &&
      raw.departamento &&
      raw.oferta_id &&
      raw.fuente &&
      raw.actualizado
    ) {
      departamentos.push({ archivo, ...raw });
      return;
    }

    throw new Error(`El archivo ${archivo} no contiene preguntas_frecuentes ni un catálogo de carreras válido.`);
  });

  if (!departamentos.length) {
    throw new Error("No hay catálogos de carreras por departamento.");
  }

  const ofertas = departamentos.flatMap(({
    archivo,
    carreras,
    departamento,
    oferta_id,
    fuente,
    actualizado,
  }) => {
    const disponibles = carreras.filter((carrera) => carrera.estado !== "proximamente");
    const nombres = disponibles.map((carrera) => {
      const nombre = carrera.nombre.replace(/^Licenciatura en /, "");
      const ciclo = carrera.tipo === "ciclo" ? " (Ciclo de Licenciatura)" : "";
      const titulo = carrera.titulo_intermedio
        ? ` (título intermedio: ${carrera.titulo_intermedio.nombre})`
        : "";
      const orientaciones = carrera.orientaciones?.length
        ? ` (orientaciones: ${carrera.orientaciones.join(" y ")})`
        : "";
      return `${nombre}${ciclo}${titulo}${orientaciones}`;
    });
    const area = departamento.replace(/^Departamento de /, "");
    const preguntas = [{
      id: `carreras-${oferta_id}`,
      categoria: "Estudiar en la UNM",
      etiqueta: area,
      pregunta: `¿Qué carreras ofrece el ${departamento}?`,
      respuesta: `${area} ofrece ${nombres.join("; ")}.`,
      palabras_clave: [
        `carreras de ${area}`,
        `carreras del ${departamento}`,
        `oferta académica de ${area}`,
      ],
      fuente,
      actualizado,
    }, ...disponibles.flatMap((carrera) => {
      const duracion = carrera.duracion_anos
        ? ` La carrera tiene una duración de ${carrera.duracion_anos} años.`
        : "";
      const orientaciones = carrera.orientaciones?.length
        ? ` La carrera tiene las orientaciones ${carrera.orientaciones.join(" y ")}.`
        : "";
      const titulo = carrera.titulo_intermedio
        ? ` Ofrece el título intermedio de ${carrera.titulo_intermedio.nombre}${carrera.titulo_intermedio.duracion_anos ? `, con una duración de ${carrera.titulo_intermedio.duracion_anos} años` : ""}.`
        : "";
      const requisitos = carrera.requisitos
        ? ` Requisitos de ingreso: ${carrera.requisitos}`
        : "";
      const itemsCarrera = [];
      if (carrera.perfil) {
        itemsCarrera.push({
          id: carrera.id,
          categoria: `Carreras - ${area}`,
          etiqueta: carrera.nombre,
          pregunta: carrera.titulo_intermedio
            ? `¿Qué perfil tiene ${carrera.nombre} y qué título intermedio ofrece?`
            : carrera.orientaciones?.length
              ? `¿Qué perfil y orientaciones tiene ${carrera.nombre}?`
              : ["ciclo", "profesorado"].includes(carrera.tipo)
                ? `¿Qué perfil y requisitos tiene ${carrera.nombre}?`
                : `¿Qué perfil tiene ${carrera.nombre}?`,
          respuesta: `${carrera.perfil}${duracion}${orientaciones}${titulo}${requisitos}`,
          palabras_clave: [carrera.nombre, ...carrera.palabras_clave],
          fuente: carrera.fuente || fuente,
          actualizado,
        });
      }
      if (carrera.titulo_intermedio) {
        itemsCarrera.push({
          id: carrera.titulo_intermedio.id,
          categoria: `Carreras - ${area}`,
          etiqueta: carrera.titulo_intermedio.nombre,
          pregunta: `¿Qué tareas puede realizar quien egresa de ${carrera.titulo_intermedio.nombre}?`,
          respuesta: `${carrera.titulo_intermedio.perfil}${carrera.titulo_intermedio.duracion_anos ? ` Tiene una duración de ${carrera.titulo_intermedio.duracion_anos} años.` : ""}`,
          palabras_clave: [
            carrera.titulo_intermedio.nombre,
            ...carrera.titulo_intermedio.palabras_clave,
          ],
          fuente: carrera.titulo_intermedio.fuente || carrera.fuente || fuente,
          actualizado,
        });
      }
      return itemsCarrera;
    })];

    return preguntas.map((e) => ({
      ...e,
      archivo,
      tema: e.categoria,
      etiqueta: limpiar(e.etiqueta),
      pregunta: limpiar(e.pregunta),
      texto: limpiar(e.respuesta),
      palabrasClave: e.palabras_clave.map(limpiar),
    }));
  });

  const ofertaGeneral = {
    id: "oferta-academica-general",
    archivo: departamentos[0].archivo,
    tema: "Estudiar en la UNM",
    etiqueta: "Carreras que ofrece la UNM",
    pregunta: "¿Qué carreras ofrece la UNM?",
    texto: `La UNM ofrece carreras y ciclos de formación en sus departamentos. ${departamentos.map(({ departamento, carreras }) => {
      const ofertas = carreras
        .filter((carrera) => carrera.estado !== "proximamente")
        .map((carrera) => {
          const titulo = carrera.titulo_intermedio
            ? ` (título intermedio: ${carrera.titulo_intermedio.nombre})`
            : "";
          const orientaciones = carrera.orientaciones?.length
            ? ` (orientaciones: ${carrera.orientaciones.join(" y ")})`
            : "";
          return `${carrera.nombre}${titulo}${orientaciones}`;
        });
      return `${departamento.replace(/^Departamento de /, "")}: ${ofertas.join(", ")}`;
    }).join(". ")}.`,
    palabrasClave: [
      "oferta académica",
      "carreras",
      "carreras disponibles",
      "carreras que existen",
      "qué carreras hay",
      "quiero averiguar por las carreras disponibles",
      "información sobre las carreras",
      "qué se puede estudiar",
      "tecnicaturas",
      "departamentos",
    ],
    fuente: departamentos[0].fuente,
    actualizado: departamentos[0].actualizado,
  };
  items.push(...ofertas, ofertaGeneral);

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
      const preguntaExacta =
        normalizar(it.pregunta).replace(/[^a-z0-9]+/g, " ").trim() ===
        preguntaNormalizada;
      const score = cosine(q, it.embedding) + boost;
      return {
        it,
        score: preguntaExacta
          ? score + 1
          : fraseCoincide
            ? Math.max(score, 0.55)
            : score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((x) => x.score >= minScore)
    .map((x) => x.it);
}

module.exports = { initKB, buscar, cargarItems };
