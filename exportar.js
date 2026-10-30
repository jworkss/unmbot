// Uso: node exportar.js
// Crea la carpeta export/ con tres archivos CSV (se abren con Excel o Google Sheets):
//   mensajes.csv       -> todo el historial, con palabras clave y marca de "sin respuesta"
//   sin_respuesta.csv  -> solo las preguntas que el asistente no pudo responder
//   palabras_clave.csv -> ranking de palabras consultadas y cuántas veces quedaron sin respuesta
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "historial_chats.db"));
try { db.exec("ALTER TABLE messages ADD COLUMN sin_info INTEGER DEFAULT 0"); } catch (e) {}

const salida = path.join(__dirname, "export");
fs.mkdirSync(salida, { recursive: true });

const STOP = new Set(
  "ante bajo con contra del desde donde los las unos unas que como cuando cual cuales cuanto cuantos entre son soy hay para por pero sin sobre sus mis tus les hola buenas buenos dias tardes noches gracias quiero quisiera queria necesito saber puedo puede podes podria favor mas muy este esta estos estas ese esa eso nos tengo tiene tienen voy van ver dime decime opcion uno dos tres cuatro".split(" "),
);
const normalizar = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const claves = (t) => [...new Set(
  normalizar(t).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)),
)];
const csv = (filas) => "\uFEFF" + filas
  .map((f) => f.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";"))
  .join("\r\n");

const mensajes = db.prepare(`
  SELECT m.created_at, s.client_name, m.session_id, m.role, m.content, COALESCE(m.sin_info, 0) AS sin_info
  FROM messages m JOIN sessions s ON s.id = m.session_id ORDER BY m.id
`).all();

// Cada respuesta sin información marca como "sin respuesta" a la pregunta anterior de esa sesión
const ultimaPregunta = {};
for (const m of mensajes) {
  if (m.role === "user") { m.sin = false; ultimaPregunta[m.session_id] = m; }
  else if (m.sin_info && ultimaPregunta[m.session_id]) ultimaPregunta[m.session_id].sin = true;
}

const preguntas = mensajes.filter((m) => m.role === "user");
const ranking = {};
for (const p of preguntas) {
  for (const w of claves(p.content)) {
    ranking[w] = ranking[w] || { total: 0, sin: 0 };
    ranking[w].total++;
    if (p.sin) ranking[w].sin++;
  }
}

const cab = ["Fecha", "Cliente", "Rol", "Mensaje", "Palabras clave", "Sin respuesta"];
fs.writeFileSync(path.join(salida, "mensajes.csv"), csv([
  cab,
  ...mensajes.map((m) => [
    m.created_at, m.client_name, m.role === "user" ? "Persona" : "Asistente", m.content,
    m.role === "user" ? claves(m.content).join(", ") : "", m.sin ? "sí" : "",
  ]),
]));

fs.writeFileSync(path.join(salida, "sin_respuesta.csv"), csv([
  ["Fecha", "Cliente", "Pregunta", "Palabras clave"],
  ...preguntas.filter((p) => p.sin).map((p) => [p.created_at, p.client_name, p.content, claves(p.content).join(", ")]),
]));

const orden = Object.entries(ranking).sort((a, b) => b[1].sin - a[1].sin || b[1].total - a[1].total);
fs.writeFileSync(path.join(salida, "palabras_clave.csv"), csv([
  ["Palabra", "Veces consultada", "Veces sin respuesta", "% sin respuesta"],
  ...orden.map(([w, r]) => [w, r.total, r.sin, Math.round((r.sin / r.total) * 100) + "%"]),
]));

console.log(`Mensajes: ${mensajes.length} | Preguntas: ${preguntas.length} | Sin respuesta: ${preguntas.filter((p) => p.sin).length}`);
console.log("Palabras más frecuentes en preguntas sin respuesta:");
orden.filter(([, r]) => r.sin).slice(0, 10).forEach(([w, r]) => console.log(`  ${w}: ${r.sin} de ${r.total}`));
console.log(`Archivos creados en: ${salida}`);
