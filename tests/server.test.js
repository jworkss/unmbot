const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");
const { initKB, buscar, cargarItems } = require("../kb");
const { embeddingDePrueba } = require("./helpers");

const temporal = fs.mkdtempSync(
  path.join(os.tmpdir(), "asistente-server-test-"),
);
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
        server.close((error) => (error ? reject(error) : resolve()));
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
      body: JSON.stringify({
        username: "usuario prueba",
        password: "clave-prueba-1",
      }),
    });
    assert.equal(alta.status, 200);
    assert.equal((await alta.json()).user.username, "usuario prueba");
    cookie = alta.headers.get("set-cookie").split(";")[0];

    const otroAlta = await fetch(`${baseUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "otra persona",
        password: "clave-prueba-2",
      }),
    });
    assert.equal(otroAlta.status, 200);

    const usuarioId = db
      .prepare("SELECT session_id FROM users WHERE username = ?")
      .get("usuario prueba").session_id;
    const otroId = db
      .prepare("SELECT session_id FROM users WHERE username = ?")
      .get("otra persona").session_id;
    const crearSesion = db.prepare(
      "INSERT OR IGNORE INTO sessions (id, client_name) VALUES (?, ?)",
    );
    crearSesion.run(usuarioId, "usuario prueba");
    crearSesion.run(otroId, "otra persona");
    const insertar = db.prepare(
      "INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)",
    );
    insertar.run(usuarioId, "mensaje privado propio");
    insertar.run(otroId, "mensaje de otra cuenta");

    const historial = await fetch(`${baseUrl}/api/history`, {
      headers: { Cookie: cookie },
    });
    assert.equal(historial.status, 200);
    assert.deepEqual(
      (await historial.json()).history.map((mensaje) => mensaje.content),
      ["mensaje privado propio"],
    );

    const admin = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Cookie: cookie },
    });
    assert.equal(admin.status, 403);
  });

  it("expone cuatro opciones que corresponden a preguntas de la base de conocimiento", async () => {
    const respuesta = await fetch(`${baseUrl}/api/opciones`, {
      headers: { Cookie: cookie },
    });
    assert.equal(respuesta.status, 200);
    const opciones = await respuesta.json();
    const preguntas = cargarItems();
    assert.equal(opciones.length, 4);
    assert.deepEqual(
      opciones.map((opcion) => opcion.n),
      [1, 2, 3, 4],
    );
    assert.ok(
      opciones.every((opcion) =>
        preguntas.some((pregunta) => pregunta.pregunta === opcion.pregunta),
      ),
    );
  });

  it("devuelve preguntas relacionadas con la opción seleccionada", async () => {
    const opcionesRespuesta = await fetch(`${baseUrl}/api/opciones`, {
      headers: { Cookie: cookie },
    });
    const opciones = await opcionesRespuesta.json();
    const opcion = opciones.find(
      (item) => item.etiqueta === "Inscripción 2027",
    );
    const alta = await fetch(`${baseUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "sugerencias faq",
        password: "clave-sugerencias-1",
      }),
    });
    const cookieSugerencias = alta.headers.get("set-cookie").split(";")[0];
    const originalFetch = global.fetch;
    global.fetch = async (input, options) => {
      if (new URL(input).port === "11434") {
        return new Response(
          JSON.stringify({
            message: { content: "La inscripción abre durante octubre." },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, options);
    };

    try {
      const respuesta = await fetch(`${baseUrl}/api/text-chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieSugerencias,
        },
        body: JSON.stringify({ text: opcion.pregunta, conAudio: false }),
      });
      const eventos = (await respuesta.text())
        .trim()
        .split("\n")
        .map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.equal(resultado.fromOption, true);
      assert.equal(resultado.selectedOption, opcion.etiqueta);
      assert.ok(resultado.suggestions.length > 0);
      assert.ok(
        resultado.suggestions.every(
          (sugerencia) => sugerencia.pregunta !== opcion.pregunta,
        ),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("sirve la hoja de estilos enlazada desde la página principal", async () => {
    const [pagina, estilos] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/styles.css`),
    ]);
    assert.equal(pagina.status, 200);
    assert.match(await pagina.text(), /href="\/styles\.css"/);
    assert.equal(estilos.status, 200);
    assert.match(await estilos.text(), /#chat-container\s*\{/);
  });

  it("usa una respuesta segura de respaldo y configura el límite de tokens", async () => {
    const preguntaSinResultado = "zxqvblorf qwerrtyui 99347465";
    assert.deepEqual(await buscar(preguntaSinResultado), []);

    const originalFetch = global.fetch;
    let solicitudModelo;
    global.fetch = async (input, options) => {
      const url = new URL(input);
      if (url.port === "11434") {
        solicitudModelo = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            message: { content: "No tengo información disponible." },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
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
      const eventos = (await respuesta.text())
        .trim()
        .split("\n")
        .map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.equal(
        resultado.assistantText,
        "No tengo ese dato en la información disponible.",
      );
      assert.equal(solicitudModelo.options.num_predict, 180);
      assert.match(
        solicitudModelo.messages[0].content,
        /no derives a la persona al sitio web/i,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("responde desde la base si el modelo deriva a la web para un departamento", async () => {
    const originalFetch = global.fetch;
    global.fetch = async (input, options) => {
      if (new URL(input).port === "11434") {
        return new Response(
          JSON.stringify({
            message: {
              content:
                "Puedes encontrar la información sobre las carreras disponibles en el sitio web oficial de la Universidad Nacional de Moreno, específicamente en la sección de Carreras.",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, options);
    };

    try {
      const respuesta = await fetch(`${baseUrl}/api/text-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          text: "¿Qué carreras ofrece el Departamento de Ciencias Aplicadas y Tecnología?",
          conAudio: false,
        }),
      });
      assert.equal(respuesta.status, 200);
      const eventos = (await respuesta.text())
        .trim()
        .split("\n")
        .map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.match(resultado.assistantText, /Ingeniería en Electrónica/);
      assert.match(resultado.assistantText, /Diseño Multimedial/);
      assert.match(resultado.assistantText, /Diseño Industrial/);
      assert.equal(resultado.sinInfo, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("pide elegir el departamento por texto ante una consulta amplia sobre carreras", async () => {
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
        body: JSON.stringify({
          text: "¿Qué carreras tiene la UNM?",
          conAudio: false,
        }),
      });
      assert.equal(respuesta.status, 200);
      const eventos = (await respuesta.text())
        .trim()
        .split("\n")
        .map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.match(
        resultado.assistantText,
        /se organiza en tres departamentos/,
      );
      assert.match(
        resultado.assistantText,
        /Ciencias Aplicadas y Tecnología, Ciencias Económicas y Jurídicas, y Humanidades y Ciencias Sociales/,
      );
      assert.doesNotMatch(resultado.assistantText, /\b[123]\./);
      assert.equal(resultado.selectorOptions, undefined);
      assert.equal(llamadasAlModelo, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("interpreta la respuesta textual a la pregunta sobre el departamento", async () => {
    const originalFetch = global.fetch;
    let solicitudModelo;
    global.fetch = async (input, options) => {
      if (new URL(input).port === "11434") {
        solicitudModelo = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            message: {
              content:
                "Relaciones del Trabajo, Administración, Economía, Contador Público y Abogacía.",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, options);
    };

    try {
      const respuesta = await fetch(`${baseUrl}/api/text-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ text: "la segunda opción", conAudio: false }),
      });
      assert.equal(respuesta.status, 200);
      const eventos = (await respuesta.text())
        .trim()
        .split("\n")
        .map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.match(resultado.assistantText, /Contador Público/);
      assert.match(
        solicitudModelo.messages[0].content,
        /Ciencias Económicas y Jurídicas ofrece Relaciones del Trabajo/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("resuelve una pregunta de seguimiento con la carrera mencionada previamente", async () => {
    const alta = await fetch(`${baseUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "contexto carrera",
        password: "clave-contexto-1",
      }),
    });
    const cookieContexto = alta.headers.get("set-cookie").split(";")[0];
    const usuarioId = db
      .prepare("SELECT id, session_id FROM users WHERE username = ?")
      .get("contexto carrera");
    db.prepare(
      "INSERT OR IGNORE INTO sessions (id, client_name) VALUES (?, ?)",
    ).run(usuarioId.session_id, "contexto carrera");
    db.prepare(
      "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
    ).run(usuarioId.session_id, "user", "Me interesa Diseño Industrial");
    db.prepare(
      "INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)",
    ).run(
      usuarioId.session_id,
      "assistant",
      "¿Qué querés saber sobre esta carrera?",
    );

    const originalFetch = global.fetch;
    let solicitudModelo;
    global.fetch = async (input, options) => {
      if (new URL(input).port === "11434") {
        solicitudModelo = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            message: {
              content:
                "Diseño Industrial forma profesionales para proyectar y dirigir productos y procesos industriales.",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, options);
    };

    try {
      const respuesta = await fetch(`${baseUrl}/api/text-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieContexto },
        body: JSON.stringify({
          text: "Dame detalles de esta carrera",
          conAudio: false,
        }),
      });
      assert.equal(respuesta.status, 200);
      const eventos = (await respuesta.text())
        .trim()
        .split("\n")
        .map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.match(
        solicitudModelo.messages[0].content,
        /La persona se refiere a la carrera Diseño Industrial/,
      );
      assert.match(
        solicitudModelo.messages[0].content,
        /El\/la Diseñador\/a Industrial se capacita para proyectar y dirigir procesos y productos industriales/,
      );
      assert.match(resultado.assistantText, /Diseño Industrial/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("devuelve un enlace cuando la persona pregunta por la página web", async () => {
    const respuesta = await fetch(`${baseUrl}/api/text-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        text: "¿Cuál es la página web de la UNM?",
        conAudio: false,
      }),
    });
    assert.equal(respuesta.status, 200);
    const eventos = (await respuesta.text())
      .trim()
      .split("\n")
      .map((linea) => JSON.parse(linea));
    const resultado = eventos.find((evento) => evento.type === "done");
    assert.equal(resultado.assistantText, "https://www.unm.edu.ar/");
    assert.equal(resultado.sinInfo, false);
  });

  it("limita a cinco preguntas por usuario durante 40 minutos y luego reinicia el contador", async () => {
    const alta = await fetch(`${baseUrl}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "limite pruebas",
        password: "clave-limite-1",
      }),
    });
    assert.equal(alta.status, 200);
    const cookieLimite = alta.headers.get("set-cookie").split(";")[0];
    const enviarPregunta = () =>
      fetch(`${baseUrl}/api/text-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieLimite },
        body: JSON.stringify({
          text: "¿Qué carreras tiene la UNM?",
          conAudio: false,
        }),
      });

    for (let i = 0; i < 5; i++) {
      const respuesta = await enviarPregunta();
      const eventos = (await respuesta.text())
        .trim()
        .split("\n")
        .map((linea) => JSON.parse(linea));
      const resultado = eventos.find((evento) => evento.type === "done");
      assert.ok(resultado);
      if (i === 4) assert.equal(resultado.questionLimit.remaining, 0);
    }

    const bloqueada = await enviarPregunta();
    const eventosBloqueados = (await bloqueada.text())
      .trim()
      .split("\n")
      .map((linea) => JSON.parse(linea));
    assert.match(
      eventosBloqueados.find((evento) => evento.type === "limit").message,
      /límite de 5 preguntas/,
    );

    const userId = db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get("limite pruebas").id;
    db.prepare(
      "UPDATE question_usage SET window_started_at = ? WHERE user_id = ?",
    ).run(Date.now() - 40 * 60 * 1000 - 1, userId);
    const reiniciada = await enviarPregunta();
    const eventosReiniciados = (await reiniciada.text())
      .trim()
      .split("\n")
      .map((linea) => JSON.parse(linea));
    assert.ok(eventosReiniciados.find((evento) => evento.type === "done"));
  });

  it("rechaza credenciales inválidas", async () => {
    const respuesta = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "usuario inexistente",
        password: "incorrecta",
      }),
    });
    assert.equal(respuesta.status, 401);
  });
});
