const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");
const { initKB, buscar } = require("../kb");
const { embeddingDePrueba } = require("./helpers");

const temporal = fs.mkdtempSync(path.join(os.tmpdir(), "asistente-server-test-"));
const cachePath = path.join(temporal, "embeddings.json");
const nombreBase = path.join(temporal, "historial.sqlite");
process.env.HISTORIAL_DB_PATH = nombreBase;
process.env.ADMIN_PASSWORD = "clave-admin-test";
const { app, db } = require("../server");
delete process.env.HISTORIAL_DB_PATH;
delete process.env.ADMIN_PASSWORD;

describe("API del asistente", () => {
  let server;
  let baseUrl;
  let cookie;

  before(async () => {
    await initKB({
      cachePath,
      embedFn: async (textos) => embeddingDePrueba(textos),
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    db.close();
    fs.rmSync(temporal, { recursive: true, force: true });
  });

  it("mantiene autenticación, permisos e historial aislado por usuario", async () => {
    const sinSesion = await fetch(`${baseUrl}/api/history`);
    assert.equal(sinSesion.status, 401);

    const alta = await fetch(`${baseUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "usuario prueba", password: "clave-prueba-1" }),
    });
    assert.equal(alta.status, 200);
    assert.equal((await alta.json()).user.username, "usuario prueba");
    cookie = alta.headers.get("set-cookie").split(";")[0];

    const otroAlta = await fetch(`${baseUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "otra persona", password: "clave-prueba-2" }),
    });
    assert.equal(otroAlta.status, 200);

    const usuarioId = db.prepare("SELECT session_id FROM users WHERE username = ?").get("usuario prueba").session_id;
    const otroId = db.prepare("SELECT session_id FROM users WHERE username = ?").get("otra persona").session_id;
    const crearSesion = db.prepare("INSERT OR IGNORE INTO sessions (id, client_name) VALUES (?, ?)");
    crearSesion.run(usuarioId, "usuario prueba");
    crearSesion.run(otroId, "otra persona");
    const insertar = db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)");
    insertar.run(usuarioId, "mensaje privado propio");
    insertar.run(otroId, "mensaje de otra cuenta");

    const historial = await fetch(`${baseUrl}/api/history`, { headers: { Cookie: cookie } });
    assert.equal(historial.status, 200);
    assert.deepEqual((await historial.json()).history.map((mensaje) => mensaje.content), ["mensaje privado propio"]);

    const admin = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: cookie } });
    assert.equal(admin.status, 403);
  });

  it("limita tokens, deriva con un contacto y no necesita llamar a Ollama", async () => {
    const preguntaSinResultado = "zxqvblorf qwerrtyui 99347465";
    assert.deepEqual(await buscar(preguntaSinResultado), []);

    const originalFetch = global.fetch;
    let solicitudModelo;
    global.fetch = async (input, options) => {
      const url = new URL(input);
      if (url.port === "11434") {
        solicitudModelo = JSON.parse(options.body);
        return new Response(JSON.stringify({
          message: { content: "No tengo información disponible." },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, options);
    };

    try {
      const respuesta = await fetch(`${baseUrl}/api/text-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ text: preguntaSinResultado, conAudio: false }),
      });
      assert.equal(respuesta.status, 200);
      const eventos = (await respuesta.text()).trim().split("\n").map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.equal(resultado.assistantText, "No tengo ese dato. Consultá https://www.unm.edu.ar/ o escribí a alumnos@unm.edu.ar.");
      assert.equal(solicitudModelo.options.num_predict, 180);
      assert.match(solicitudModelo.messages[0].content, /no derives a la persona al sitio web/i);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("responde desde la base si el modelo deriva a la web para un departamento", async () => {
    const originalFetch = global.fetch;
    global.fetch = async (input, options) => {
      if (new URL(input).port === "11434") {
        return new Response(JSON.stringify({
          message: { content: "Puedes encontrar la información sobre las carreras disponibles en el sitio web oficial de la Universidad Nacional de Moreno, específicamente en la sección de Carreras." },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, options);
    };

    try {
      const respuesta = await fetch(`${baseUrl}/api/text-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ text: "¿Qué carreras ofrece el Departamento de Ciencias Aplicadas y Tecnología?", conAudio: false }),
      });
      assert.equal(respuesta.status, 200);
      const eventos = (await respuesta.text()).trim().split("\n").map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.match(resultado.assistantText, /Ingeniería en Electrónica/);
      assert.match(resultado.assistantText, /Diseño Multimedial/);
      assert.match(resultado.assistantText, /Diseño Industrial/);
      assert.equal(resultado.sinInfo, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("ofrece un selector de departamentos para una consulta amplia sobre carreras", async () => {
    const originalFetch = global.fetch;
    let llamadasAlModelo = 0;
    global.fetch = async (input, options) => {
      if (new URL(input).port === "11434") llamadasAlModelo++;
      return originalFetch(input, options);
    };

    try {
      const respuesta = await fetch(`${baseUrl}/api/text-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ text: "¿Qué carreras tiene la UNM?", conAudio: false }),
      });
      assert.equal(respuesta.status, 200);
      const eventos = (await respuesta.text()).trim().split("\n").map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.match(resultado.assistantText, /se organiza en tres departamentos/);
      assert.deepEqual(resultado.selectorOptions.map((opcion) => opcion.etiqueta), [
        "Ciencias Aplicadas y Tecnología",
        "Ciencias Económicas y Jurídicas",
        "Humanidades y Ciencias Sociales",
      ]);
      assert.equal(llamadasAlModelo, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("rechaza credenciales inválidas", async () => {
    const respuesta = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "usuario inexistente", password: "incorrecta" }),
    });
    assert.equal(respuesta.status, 401);
  });
});
