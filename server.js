const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execFile } = require("child_process");
const util = require("util");
const express = require("express");
const multer = require("multer");
const Database = require("better-sqlite3");
const { initKB, buscar } = require("./kb");
initKB()
  .then(() => console.log("Base de la UNM cargada"))
  .catch(console.error);
const execFileAsync = util.promisify(execFile);
const app = express();
const PORT = 3000;
const os = require("os");
const qrcode = require("qrcode-terminal");

// 1. Configuración de Base de Datos SQLite para el historial de chats
const db = new Database("historial_chats.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,fBase de la UNM cargada
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
app.use("/audio_out", express.static(path.join(__dirname, "audio_out")));

const upload = multer({ dest: path.join(__dirname, "uploads/") });

// 2. Configuración de rutas a modelos locales y System Prompt Empático
const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = "llama3.2:3b";
/*const WHISPER_BIN = path.join(__dirname, "bin", "whisper-cli");
const WHISPER_MODEL = path.join(__dirname, "bin", "ggml-base.bin");
const PIPER_BIN = path.join(__dirname, "bin", "piper");
const PIPER_VOICE = path.join(__dirname, "bin", "es_MX-ald-medium.onnx");*/

const WHISPER_BIN = path.join(__dirname, "bin", "whisper", "whisper-cli.exe");
const WHISPER_MODEL = path.join(__dirname, "bin", "models", "ggml-small.bin");
const PIPER_BIN = path.join(__dirname, "bin", "piper", "piper.exe");
const PIPER_VOICE = path.join(
  __dirname,
  "bin",
  "piper",
  "es_AR-daniela-high.onnx",
);

/*const EMPATHETIC_SYSTEM_PROMPT = `Eres un asistente conversacional cercano, cálido y profundamente empático.
Reglas clave para tus respuestas:
1. Valida siempre las emociones o la situación del usuario con calidez, respeto y escucha activa antes de dar una sugerencia.
2. Como tu respuesta será leída en voz alta mediante síntesis de voz, redacta de forma natural y conversacional, en 2 a 4 oraciones breves.
3. No utilices listas con viñetas, asteriscos, emojis ni símbolos de formato Markdown, ya que entorpecen la lectura en audio.
4. Habla siempre en español neutro y amable, manteniendo el hilo de lo que el usuario te ha contado antes.`;
*/

const SYSTEM_PROMPT = `Eres un asistente de voz de la Universidad Nacional de Moreno (UNM), cercano, cálido y empático.
Reglas:
1. Responde SOLO con la información oficial que se te entrega abajo. Nunca inventes fechas, requisitos, carreras ni datos de contacto.
2. Si la información no está disponible, dilo con amabilidad y sugiere consultar los canales oficiales de la universidad.
3. Si la consulta no tiene que ver con la UNM, explica amablemente que solo puedes ayudar con temas de la universidad.
4. Valida con calidez la situación de la persona antes de informar.
5. Tu respuesta se leerá en voz alta: 2 a 4 oraciones breves, sin listas, asteriscos, emojis ni formato Markdown.
6. Habla en español neutro y amable.
7. Si la información tiene muchas comisiones o aulas y la persona no dijo cuál le interesa, pregúntale primero cuál es en vez de enumerarlas todas.
8. No leas códigos de materia a menos que te los pidan; nombra las materias de forma natural.`;

// 3. Funciones auxiliares para Audio -> Texto (Whisper) y Texto -> Audio (Piper)
async function transcribeAudio(inputPath) {
  const wavPath = `${inputPath}.wav`;
  // Convertir el audio del navegador a WAV 16kHz mono con FFmpeg
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]);

  // Ejecutar Whisper.cpp en español (-l es) sin marcas de tiempo (-nt)
  const { stdout } = await execFileAsync(WHISPER_BIN, [
    "-m",
    WHISPER_MODEL,
    "-f",
    wavPath,
    "-l",
    "es",
    "-nt",
    "--prompt",
    "Universidad Nacional de Moreno, UNM, inscripción, ingreso, carreras, cursada, becas",
  ]);

  // Limpiar archivos temporales de entrada
  fs.unlink(inputPath, () => {});
  fs.unlink(wavPath, () => {});

  return stdout.trim();
}

async function generateSpeech(text, outputWavPath) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PIPER_BIN,
      ["--model", PIPER_VOICE, "--output_file", outputWavPath],
      (error) => {
        if (error) return reject(error);
        resolve(outputWavPath);
      },
    );
    // Limpiamos saltos de línea o caracteres especiales antes de enviarlo a Piper
    const cleanText = text
      .replace(/[*_#`~]/g, "")
      .replace(/\n+/g, " ")
      .trim();
    child.stdin.write(cleanText + "\n");
    child.stdin.end();
  });
}

// 4. Endpoints de Sesiones e Historial
app.post("/api/session", (req, res) => {
  const { sessionId, clientName } = req.body;
  if (!sessionId || !clientName) {
    return res.status(400).json({ error: "Faltan datos de sesión" });
  }
  const existing = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId);
  if (!existing) {
    db.prepare("INSERT INTO sessions (id, client_name) VALUES (?, ?)").run(
      sessionId,
      clientName,
    );
  }
  const history = db
    .prepare(
      "SELECT role, content, audio_url, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
    )
    .all(sessionId);

  res.json({ sessionId, clientName, history });
});

app.get("/api/sessions", (req, res) => {
  const sessions = db
    .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
    .all();
  res.json(sessions);
});

// 5. Endpoint Principal: Recibe Audio -> Transcribe -> Consulta LLM con Historial -> Devuelve Audio
app.post("/api/voice-chat", upload.single("audio"), async (req, res) => {
  try {
    const { sessionId, clientName } = req.body;
    if (!req.file || !sessionId) {
      return res
        .status(400)
        .json({ error: "Se requiere archivo de audio y sessionId" });
    }

    db.prepare(
      "INSERT OR IGNORE INTO sessions (id, client_name) VALUES (?, ?)",
    ).run(sessionId, clientName || "Cliente");

    // A. Voz -> texto
    const userText = await transcribeAudio(req.file.path);
    if (!userText) {
      return res
        .status(400)
        .json({ error: "No se pudo detectar voz en el audio." });
    }
    db.prepare(
      "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
    ).run(sessionId, "user", userText);

    // B. Historial reciente de esta persona
    const pastMessages = db
      .prepare(
        "SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 12) ORDER BY id ASC",
      )
      .all(sessionId);

    // C. Buscar en la base de la UNM (incluye la pregunta anterior para repreguntas tipo "¿y cuánto dura?")
    const previa =
      pastMessages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content ||
      "";
    const fragmentos = await buscar(`${previa} ${userText}`.trim());
    console.log(
      "Pregunta:",
      userText,
      "| Fragmentos:",
      fragmentos.map((f) => f.id),
    );

    const contexto = fragmentos.length
      ? fragmentos.map((f) => `- ${f.tema}: ${f.texto}`).join("\n")
      : "No hay información disponible sobre esta consulta.";

    const ollamaMessages = [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\n\nINFORMACIÓN OFICIAL:\n${contexto}`,
      },
      ...pastMessages,
    ];

    // D. Consultar al LLM local
    const llmResponse = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: ollamaMessages,
        stream: false,
        keep_alive: "30m",
        options: { temperature: 0.3, num_ctx: 4096, num_predict: 150 },
      }),
    });
    const llmData = await llmResponse.json();
    const assistantText =
      llmData.message?.content?.trim() ||
      "Disculpá, no pude procesar tu consulta. ¿Podés repetirla?";

    // E. Texto -> voz
    const audioFileName = `resp_${Date.now()}.wav`;
    const audioOutPath = path.join(__dirname, "audio_out", audioFileName);
    await generateSpeech(assistantText, audioOutPath);
    const audioUrl = `/audio_out/${audioFileName}`;

    db.prepare(
      "INSERT INTO messages (session_id, role, content, audio_url) VALUES (?, ?, ?, ?)",
    ).run(sessionId, "assistant", assistantText, audioUrl);

    res.json({ userText, assistantText, audioUrl });
  } catch (error) {
    console.error("Error procesando el flujo de voz:", error.message);
    if (error.stderr) console.error("STDERR:", error.stderr);
    res.status(500).json({ error: "Falló: " + error.message.slice(0, 200) });
  }
});

function obtenerIPLocal() {
  const interfaces = os.networkInterfaces();
  for (const nombreDeInterfaz in interfaces) {
    for (const interfaz of interfaces[nombreDeInterfaz]) {
      if (interfaz.family === "IPv4" && !interfaz.internal) {
        return interfaz.address;
      }
    }
  }
  return "127.0.0.1";
}

// 6. Inicio del servidor en 0.0.0.0 para permitir conexiones de toda la red local (LAN)
const keyPath = path.join(__dirname, "certs", "key.pem");
const certPath = path.join(__dirname, "certs", "cert.pem");

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const credentials = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  https.createServer(credentials, app).listen(PORT, "0.0.0.0", () => {
    const ip = obtenerIPLocal();
    const url = `https://${ip}:${PORT}`;

    console.log(`\n✅ Servidor HTTPS listo en red local: ${url}`);
    qrcode.generate(url, { small: true }, (qr) => console.log(qr));
  });
} else {
  http.createServer(app).listen(PORT, "0.0.0.0", () => {
    const ip = obtenerIPLocal();
    // Nota: Si forzosamente necesitas que diga https:// aunque levante en HTTP, cambia la siguiente línea.
    const url = `http://${ip}:${PORT}`;

    console.log(`\n⚠️ Servidor HTTP listo en: ${url}`);
    console.log(
      `(Para red local con HTTPS, agrega certs/key.pem y certs/cert.pem)\n`,
    );
    qrcode.generate(url, { small: true }, (qr) => console.log(qr));
  });
}

/* 6. Inicio del servidor en 0.0.0.0 para permitir conexiones de toda la red local (LAN)
const keyPath = path.join(__dirname, "certs", "key.pem");
const certPath = path.join(__dirname, "certs", "cert.pem");

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  const credentials = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  https.createServer(credentials, app).listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor HTTPS listo en red local: https://0.0.0.0:${PORT}`);
  });
} else {
  http.createServer(app).listen(PORT, "0.0.0.0", () => {
    console.log(
      `Servidor HTTP listo en: http://localhost:${PORT} (Para red local, agrega certs/key.pem y certs/cert.pem)`,
    );
  });
}
*/
