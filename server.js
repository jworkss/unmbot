const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const util = require("util");
const express = require("express");
const multer = require("multer");
const Database = require("better-sqlite3");
const qrcode = require("qrcode-terminal");
const { initKB, buscar } = require("./kb");

initKB()
  .then(() => console.log("Base de la UNM cargada"))
  .catch(console.error);

const execFileAsync = util.promisify(execFile);
const app = express();
const PORT = 3000;

// 1. Base de datos SQLite para el historial de chats
const db = new Database("historial_chats.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    audio_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// /audio_out se sirve más abajo, solo a su dueño

const upload = multer({ dest: path.join(__dirname, "uploads/") });

// 2. Rutas a modelos locales y System Prompt
const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = "llama3.2:3b";
const WHISPER_BIN = path.join(__dirname, "bin", "whisper", "whisper-cli.exe");
const WHISPER_MODEL = path.join(__dirname, "bin", "models", "ggml-small.bin");
const PIPER_BIN = path.join(__dirname, "bin", "piper", "piper.exe");
const PIPER_VOICE = path.join(__dirname, "bin", "piper", "es_AR-daniela-high.onnx");

const SYSTEM_PROMPT = `Eres un asistente de voz de la Universidad Nacional de Moreno (UNM), cercano, cálido y empático.
Reglas:
1. Responde SOLO con la información oficial que se te entrega abajo. Nunca inventes fechas, requisitos, carreras ni datos de contacto.
2. Si la información no está disponible, dilo con amabilidad y sugiere consultar los canales oficiales de la universidad.
3. Si la consulta no tiene que ver con la UNM, explica amablemente que solo puedes ayudar con temas de la universidad.
4. Valida con calidez la situación de la persona antes de informar.
5. Tu respuesta se leerá en voz alta: 2 a 4 oraciones breves, sin listas, asteriscos, emojis ni formato Markdown.
6. Habla en español neutro y amable.
7. Si la información tiene muchas comisiones o aulas y la persona no dijo cuál le interesa, pregúntale primero cuál es en vez de enumerarlas todas.
8. No leas códigos de materia a menos que te los pidan; nombra las materias de forma natural.
9. Nunca ofrezcas buscar en internet, enviar correos ni hacer acciones que no puedas hacer. Si falta información, sugiere contactar al Departamento de Alumnos (alumnos@unm.edu.ar).`;

// Migración: marca las respuestas en las que el bot no pudo ayudar
try { db.exec("ALTER TABLE messages ADD COLUMN sin_info INTEGER DEFAULT 0"); } catch (e) {}

// Menú de opciones (también se elige por voz o texto: "uno", "opción 2")
const OPCIONES = [
  { n: 1, etiqueta: "Inscripción e ingreso", pregunta: "¿Cómo y cuándo me inscribo para ingresar a la universidad?" },
  { n: 2, etiqueta: "Carreras", pregunta: "¿Qué carreras de diseño hay y cuánto duran?" },
  { n: 3, etiqueta: "Cursada y horarios", pregunta: "¿En qué turnos y horarios se cursa?" },
  { n: 4, etiqueta: "Contactar a Alumnos", pregunta: "¿Cuál es el horario y el correo del Departamento de Alumnos?" },
];
const NUMEROS = { 1: 1, uno: 1, 2: 2, dos: 2, 3: 3, tres: 3, 4: 4, cuatro: 4 };
const MENU_HABLADO = "Si querés, elegí un tema diciendo o escribiendo el número: uno, inscripción; dos, carreras; tres, cursada y horarios; cuatro, contactar a Alumnos.";
const SIN_INFO = /no (tengo|puedo|cuento|dispongo)[^.]*(informaci[oó]n|brindar)|canales oficiales/i;
const CHARLA = /^(hola|buen[oa]s?|gracias|chau|adi[oó]s|ok|dale)\b/i;

function resolverOpcion(texto) {
  const limpio = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").trim();
  const m = limpio.match(/^(?:opcion )?(1|2|3|4|uno|dos|tres|cuatro)$/);
  const op = m && OPCIONES.find((o) => o.n === NUMEROS[m[1]]);
  return op ? op.pregunta : texto;
}

app.get("/api/opciones", requireAuth, (req, res) => res.json(OPCIONES));

// 3. Audio -> texto (Whisper) y texto -> audio (Piper)
async function transcribeAudio(inputPath) {
  const wavPath = `${inputPath}.wav`;
  await execFileAsync("ffmpeg", [
    "-y", "-i", inputPath,
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    wavPath,
  ]);

  const { stdout } = await execFileAsync(WHISPER_BIN, [
    "-m", WHISPER_MODEL,
    "-f", wavPath,
    "-l", "es",
    "-nt", "-np",
    "--prompt",
    "Universidad Nacional de Moreno, UNM, inscripción, ingreso, carreras, cursada, becas",
  ]);

  fs.unlink(inputPath, () => {});
  fs.unlink(wavPath, () => {});

  // Quita marcas como [BLANK_AUDIO] que Whisper devuelve cuando no hay voz
  return stdout.replace(/\[[^\]]*\]/g, "").trim();
}

async function generateSpeech(text, outputWavPath) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PIPER_BIN,
      ["--model", PIPER_VOICE, "--output_file", outputWavPath, "--length_scale", "1.15"], // 1.15 = voz algo más lenta
      (error) => (error ? reject(error) : resolve(outputWavPath)),
    );
    const cleanText = text.replace(/[*_#`~]/g, "").replace(/\n+/g, " ").trim();
    child.stdin.write(cleanText + "\n");
    child.stdin.end();
  });
}

// 4. Usuarios, contraseñas y sesiones seguras
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    must_change INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
`);

const MIN_CLAVE = 6; // largo mínimo cuando la persona elige su contraseña
const NOMBRE_OK = /^[\p{L}\p{N}_.\- ]{3,30}$/u;
const DURACION = 7 * 24 * 3600 * 1000; // la sesión dura 7 días
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hashPass = (p) => {
  const salt = crypto.randomBytes(16);
  return salt.toString("hex") + ":" + crypto.scryptSync(p, salt, 64).toString("hex");
};
function checkPass(p, stored) {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(p, Buffer.from(salt, "hex"), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}

// Administrador: se crea una sola vez. Contraseña = variable ADMIN_PASSWORD o una aleatoria.
{
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  const envClave = process.env.ADMIN_PASSWORD;
  if (!admin) {
    const clave = envClave || crypto.randomBytes(6).toString("base64url");
    db.prepare("INSERT INTO users (username, pass_hash, role, session_id) VALUES ('admin', ?, 'admin', 'sess_admin')").run(hashPass(clave));
    console.log(`\n🔑 Administrador creado. Usuario: admin | Contraseña: ${clave}\n   (cambiala desde "Mi cuenta"; este mensaje no se repite)\n`);
  } else if (envClave) {
    db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?").run(hashPass(envClave), admin.id);
    console.log("🔑 Contraseña del administrador restablecida con ADMIN_PASSWORD.");
  }
}

// Usuarios que ya existían (de sesiones anteriores): contraseña inicial 1234
for (const s of db.prepare("SELECT id, client_name FROM sessions").all()) {
  if (!db.prepare("SELECT 1 FROM users WHERE session_id = ?").get(s.id)) {
    db.prepare("INSERT OR IGNORE INTO users (username, pass_hash, must_change, session_id) VALUES (?, ?, 1, ?)")
      .run(s.client_name, hashPass("1234"), s.id);
  }
}

function iniciarSesion(req, res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("DELETE FROM tokens WHERE expires < ?").run(Date.now());
  db.prepare("INSERT INTO tokens (token_hash, user_id, expires) VALUES (?, ?, ?)").run(sha(token), userId, Date.now() + DURACION);
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DURACION / 1000}${req.secure ? "; Secure" : ""}`);
}
function leerToken(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)sid=([a-f0-9]{64})/);
  return m ? m[1] : null;
}
function requireAuth(req, res, next) {
  const t = leerToken(req);
  const u = t && db.prepare("SELECT u.* FROM tokens k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ? AND k.expires > ?").get(sha(t), Date.now());
  if (!u) return res.status(401).json({ error: "No iniciaste sesión." });
  req.user = u;
  next();
}
function soloAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Solo el administrador puede hacer esto." });
  next();
}
const perfil = (u) => ({ username: u.username, role: u.role, mustChange: !!u.must_change });

// Límite de intentos: 5 fallos seguidos bloquean 5 minutos (por dispositivo y usuario)
const intentos = new Map();
const bloqueado = (k) => (intentos.get(k)?.hasta || 0) > Date.now();
function registrarFallo(k) {
  const i = intentos.get(k) || { n: 0, hasta: 0 };
  if (++i.n >= 5) { i.n = 0; i.hasta = Date.now() + 5 * 60 * 1000; }
  intentos.set(k, i);
}

// Cambia usuario y/o contraseña. Devuelve un mensaje de error o null si salió bien.
// Si lo hace el administrador, la persona queda con "contraseña a cambiar" y se le cierran las sesiones.
function actualizarUsuario(u, { username, password }, esAdmin) {
  const nuevoNombre = (username || "").trim();
  const cambiaNombre = nuevoNombre && nuevoNombre !== u.username;
  const min = esAdmin ? 4 : MIN_CLAVE;
  if (cambiaNombre && !NOMBRE_OK.test(nuevoNombre)) return "Usuario inválido: 3 a 30 caracteres (letras, números, espacios, punto, guion o guion bajo).";
  if (cambiaNombre && db.prepare("SELECT 1 FROM users WHERE username = ? AND id != ?").get(nuevoNombre, u.id)) return "Ese usuario ya existe. Elegí otro.";
  if (password && password.length < min) return `La contraseña debe tener al menos ${min} caracteres.`;
  if (cambiaNombre) {
    db.prepare("UPDATE users SET username = ? WHERE id = ?").run(nuevoNombre, u.id);
    db.prepare("UPDATE sessions SET client_name = ? WHERE id = ?").run(nuevoNombre, u.session_id);
  }
  if (password) {
    db.prepare("UPDATE users SET pass_hash = ?, must_change = ? WHERE id = ?").run(hashPass(password), esAdmin ? 1 : 0, u.id);
    db.prepare("DELETE FROM tokens WHERE user_id = ?").run(u.id);
  }
  return null;
}

app.post("/api/register", (req, res) => {
  const username = (req.body.username || "").trim();
  const password = req.body.password || "";
  if (!NOMBRE_OK.test(username)) return res.status(400).json({ error: "Usuario inválido: 3 a 30 caracteres (letras, números, espacios, punto, guion o guion bajo)." });
  if (password.length < MIN_CLAVE) return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_CLAVE} caracteres.` });
  try {
    const sid = "sess_" + crypto.randomBytes(6).toString("hex");
    const r = db.prepare("INSERT INTO users (username, pass_hash, session_id) VALUES (?, ?, ?)").run(username, hashPass(password), sid);
    iniciarSesion(req, res, r.lastInsertRowid);
    res.json({ user: perfil({ username, role: "user", must_change: 0 }) });
  } catch (e) {
    res.status(409).json({ error: "Ese usuario ya existe. Elegí otro." });
  }
});

app.post("/api/login", (req, res) => {
  const username = (req.body.username || "").trim();
  const clave = `${req.ip}|${username.toLowerCase()}`;
  if (bloqueado(clave)) return res.status(429).json({ error: "Demasiados intentos. Esperá 5 minutos." });
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!u || !checkPass(req.body.password || "", u.pass_hash)) {
    registrarFallo(clave);
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  }
  intentos.delete(clave);
  iniciarSesion(req, res, u.id);
  res.json({ user: perfil(u) });
});

app.post("/api/logout", (req, res) => {
  const t = leerToken(req);
  if (t) db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(sha(t));
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ user: perfil(req.user) }));

app.post("/api/account", requireAuth, (req, res) => {
  const { currentPassword, username, password } = req.body;
  if (!checkPass(currentPassword || "", req.user.pass_hash)) return res.status(403).json({ error: "La contraseña actual no es correcta." });
  const err = actualizarUsuario(req.user, { username, password }, false);
  if (err) return res.status(400).json({ error: err });
  iniciarSesion(req, res, req.user.id); // renueva la sesión (el cambio de contraseña cerró las demás)
  res.json({ user: perfil(db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id)) });
});

// Administrador: ver usuarios y cambiar usuario/contraseña de cualquiera (las contraseñas no se pueden ver, solo restablecer)
app.get("/api/admin/users", requireAuth, soloAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.role, u.must_change AS mustChange,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id = u.session_id AND m.role = 'user') AS preguntas
    FROM users u ORDER BY u.id`).all());
});
app.post("/api/admin/users/:id", requireAuth, soloAdmin, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: "Usuario inexistente." });
  const err = actualizarUsuario(u, req.body, true);
  if (err) return res.status(400).json({ error: err });
  res.json({ ok: true });
});

// Historial y audios: cada persona solo accede a lo suyo
app.get("/api/history", requireAuth, (req, res) => {
  res.json({ history: db.prepare("SELECT role, content, audio_url, created_at FROM messages WHERE session_id = ? ORDER BY id ASC").all(req.user.session_id) });
});
app.get("/audio_out/:file", requireAuth, (req, res) => {
  const archivo = path.basename(req.params.file);
  const suyo = req.user.role === "admin" ||
    db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND audio_url = ?").get(req.user.session_id, "/audio_out/" + archivo);
  if (!suyo) return res.status(404).end();
  res.sendFile(path.join(__dirname, "audio_out", archivo));
});

// 5. Cola: hay una sola GPU, las consultas se atienden de a una
let cola = Promise.resolve();
let pendientes = 0;
function encolar(tarea, emit) {
  if (pendientes > 0) emit({ type: "stage", stage: "cola" });
  pendientes++;
  const p = cola.then(tarea);
  cola = p.catch(() => {}).then(() => { pendientes--; });
  return p;
}

// Respuesta en streaming: una línea JSON por evento de progreso
function abrirStream(res) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  return (obj) => res.write(JSON.stringify(obj) + "\n");
}

function errorEsperado(msg) {
  const e = new Error(msg);
  e.expected = true;
  return e;
}

function responderError(emit, error, etiqueta) {
  console.error(`Error en ${etiqueta}:`, error.message);
  if (error.stderr) console.error("STDERR:", error.stderr);
  emit({
    type: "error",
    message: error.expected
      ? error.message
      : "Hubo un problema procesando tu consulta. Intentá de nuevo.",
  });
}

// 6. Lógica común para voz y texto
async function procesarConsulta({ userText, sessionId, clientName, conAudio, emit }) {
  userText = resolverOpcion(userText);
  db.prepare("INSERT OR IGNORE INTO sessions (id, client_name) VALUES (?, ?)").run(
    sessionId, clientName || "Cliente",
  );
  db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
    sessionId, "user", userText,
  );

  // Etapa: buscar en la base de la UNM
  emit({ type: "stage", stage: "buscando" });
  const pastMessages = db
    .prepare("SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 12) ORDER BY id ASC")
    .all(sessionId);

  const previa = pastMessages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content || "";
  const corta = userText.split(/\s+/).length < 6; // repreguntas tipo "¿y cuánto dura?"
  const fragmentos = await buscar(corta ? `${previa} ${userText}`.trim() : userText);
  console.log("Pregunta:", userText, "| Fragmentos:", fragmentos.map((f) => f.id));

  const contexto = fragmentos.length
    ? fragmentos.map((f) => `- ${f.tema} (${f.pregunta}): ${f.texto}`).join("\n")
    : "No hay información disponible sobre esta consulta.";

  // Etapa: armar la respuesta con el LLM
  emit({ type: "stage", stage: "pensando" });
  const llmResponse = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\nINFORMACIÓN OFICIAL:\n${contexto}` },
        ...pastMessages,
      ],
      stream: false,
      keep_alive: "30m",
      options: { temperature: 0.3, num_ctx: 4096, num_predict: 150 },
    }),
  });
  if (!llmResponse.ok) throw new Error("Ollama respondió " + llmResponse.status);
  const llmData = await llmResponse.json();
  let assistantText =
    llmData.message?.content?.trim() ||
    "Disculpá, no pude procesar tu consulta. ¿Podés repetirla?";

  const sinInfo = !CHARLA.test(userText) && (fragmentos.length === 0 || SIN_INFO.test(assistantText));
  if (sinInfo) assistantText += " " + MENU_HABLADO;

  // Etapa: preparar el audio (solo si la persona lo quiere)
  let audioUrl = null;
  if (conAudio) {
    emit({ type: "stage", stage: "audio" });
    const audioFileName = `resp_${Date.now()}.wav`;
    await generateSpeech(assistantText, path.join(__dirname, "audio_out", audioFileName));
    audioUrl = `/audio_out/${audioFileName}`;
  }

  db.prepare("INSERT INTO messages (session_id, role, content, audio_url, sin_info) VALUES (?, ?, ?, ?, ?)").run(
    sessionId, "assistant", assistantText, audioUrl, sinInfo ? 1 : 0,
  );
  emit({ type: "done", assistantText, audioUrl, sinInfo });
}

// 7. Endpoint de VOZ
app.post("/api/voice-chat", requireAuth, upload.single("audio"), async (req, res) => {
  const emit = abrirStream(res);
  try {
    const sessionId = req.user.session_id, clientName = req.user.username;
    if (!req.file) throw errorEsperado("Falta el audio o la sesión.");
    const conAudio = req.body.conAudio !== "false";

    await encolar(async () => {
      emit({ type: "stage", stage: "escuchando" });
      const userText = await transcribeAudio(req.file.path);
      if (!userText) throw errorEsperado("No se detectó voz. Probá hablar más cerca del micrófono.");
      emit({ type: "transcript", text: userText });
      await procesarConsulta({ userText, sessionId, clientName, conAudio, emit });
    }, emit);
  } catch (error) {
    responderError(emit, error, "voice-chat");
  } finally {
    res.end();
  }
});

// 8. Endpoint de TEXTO
app.post("/api/text-chat", requireAuth, async (req, res) => {
  const emit = abrirStream(res);
  try {
    const { text } = req.body;
    const sessionId = req.user.session_id, clientName = req.user.username;
    const userText = (text || "").trim().slice(0, 500);
    if (!sessionId || !userText) throw errorEsperado("Escribí un mensaje para enviar.");
    const conAudio = req.body.conAudio !== false;

    await encolar(
      () => procesarConsulta({ userText, sessionId, clientName, conAudio, emit }),
      emit,
    );
  } catch (error) {
    responderError(emit, error, "text-chat");
  } finally {
    res.end();
  }
});

// 9. Inicio del servidor (0.0.0.0 para toda la red local)
function obtenerIPLocal() {
  const interfaces = os.networkInterfaces();
  for (const nombre in interfaces) {
    for (const i of interfaces[nombre]) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}

const keyPath = path.join(__dirname, "certs", "key.pem");
const certPath = path.join(__dirname, "certs", "cert.pem");

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const credentials = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  https.createServer(credentials, app).listen(PORT, "0.0.0.0", () => {
    const url = `https://${obtenerIPLocal()}:${PORT}`;
    console.log(`\n✅ Servidor HTTPS listo en red local: ${url}`);
    qrcode.generate(url, { small: true }, (qr) => console.log(qr));
  });
} else {
  http.createServer(app).listen(PORT, "0.0.0.0", () => {
    const url = `http://${obtenerIPLocal()}:${PORT}`;
    console.log(`\n⚠️ Servidor HTTP listo en: ${url}`);
    console.log("(Para usar el micrófono desde otros dispositivos, agrega certs/key.pem y certs/cert.pem)\n");
    qrcode.generate(url, { small: true }, (qr) => console.log(qr));
  });
}
