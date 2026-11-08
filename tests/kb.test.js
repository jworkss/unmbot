const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");
const { initKB, buscar, cargarItems } = require("../kb");
const { embeddingDePrueba } = require("./helpers");

describe("base de conocimiento", () => {
  let temporal;
  let cachePath;
  let llamadasEmbedding;

  before(async () => {
    temporal = fs.mkdtempSync(path.join(os.tmpdir(), "asistente-kb-test-"));
    cachePath = path.join(temporal, "embeddings.json");
    llamadasEmbedding = 0;
    await initKB({
      cachePath,
      embedFn: async (textos) => {
        llamadasEmbedding++;
        return embeddingDePrueba(textos);
      },
    });
  });

  after(() => {
    fs.rmSync(temporal, { recursive: true, force: true });
  });

  it("carga los archivos temáticos y conserva sus metadatos", () => {
    const items = cargarItems();
    assert.equal(items.length, 89);
    assert.ok(items.some((item) => item.archivo === "contactos.json"));
    assert.ok(items.some((item) => item.archivo === "coprun.json"));
    assert.ok(items.some((item) => item.archivo === "inscripcion-2027.json"));
    assert.ok(items.some((item) => item.archivo === "posgrado-2027.json"));
    assert.ok(items.some((item) => item.archivo === "becas.json"));
    assert.ok(items.some((item) => item.archivo === "departamento-ciencias-aplicadas-tecnologia.json"));
    assert.ok(items.some((item) => item.archivo === "departamento-ciencias-economicas-juridicas.json"));
    assert.ok(items.some((item) => item.archivo === "departamento-humanidades-ciencias-sociales.json"));
    assert.ok(items.some((item) => item.etiqueta && item.palabrasClave.length));
    assert.ok(items.every((item) => item.id && item.pregunta && item.texto));
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  });

  it("recupera primero respuestas pertinentes por tema y palabras clave", async (t) => {
    const casos = [
      ["¿Cuáles son las fechas de inscripción para 2027?", "inscripcion-2027-faq-1"],
      ["¿Cómo se aprueba el COPRUN y qué asistencia piden?", "coprun-faq-5"],
      ["¿Dónde está la biblioteca y cuál es su correo?", "contactos-faq-3"],
      ["Hablame de becas", "becas-faq-1"],
      ["¿Hay becas o ayuda económica en la UNM?", "becas-faq-1"],
      ["¿Cómo solicito una beca interna en la UNM?", "becas-faq-3"],
      ["¿Qué becas externas informa la UNM y cuándo se puede inscribir?", "becas-faq-5"],
      ["¿Qué opciones de posgrado y diplomaturas ofrece la UNM en 2027?", "posgrado-2027-oferta"],
      ["¿Cuándo puedo inscribirme a un posgrado para 2027?", "posgrado-2027-inscripcion"],
      ["Hola, quiero averiguar por las carreras disponibles.", "oferta-academica-general"],
      ["¿Qué carreras ofrece el Departamento de Ciencias Aplicadas y Tecnología?", "carreras-aplicadas-tecnologia"],
      ["¿Qué carreras ofrece el Departamento de Ciencias Económicas y Jurídicas?", "carreras-economicas-juridicas"],
      ["¿Qué carreras ofrece el Departamento de Humanidades y Ciencias Sociales?", "carreras-humanidades-sociales"],
      ["¿Qué perfil tiene Ingeniería en Electrónica y qué título intermedio ofrece?", "dcayt-ingenieria-electronica"],
      ["¿Qué perfil tiene la Licenciatura en Economía?", "dceyj-economia"],
      ["¿Qué perfil y requisitos tiene el Profesorado Universitario en Educación Secundaria y Superior?", "dhycs-profesorado-universitario"],
    ];

    for (const [pregunta, esperado] of casos) {
      await t.test(pregunta, async () => {
        const resultados = await buscar(pregunta);
        assert.equal(resultados[0]?.id, esperado);
      });
    }
  });

  it("incluye los nombres de las carreras de Diseño en la respuesta recuperada", async () => {
    const [carreras] = await buscar("Hola, quiero averiguar por las carreras disponibles.");
    assert.match(carreras.texto, /Diseño Multimedial/);
    assert.match(carreras.texto, /Comunicación Visual/);
    assert.match(carreras.texto, /Diseño de Indumentaria/);
    assert.match(carreras.texto, /Diseño Industrial/);
  });

  it("recupera perfiles y duración de Diseño desde el catálogo del departamento", async () => {
    const [industrial] = await buscar("¿Cuál es el perfil profesional de Diseño Industrial?");
    assert.equal(industrial.id, "dcayt-diseno-industrial");
    assert.match(industrial.texto, /5 años/);
    assert.match(industrial.texto, /Prototipado Rápido y Renderización/);
    assert.match(industrial.texto, /3 años/);
  });

  it("recupera la oferta por departamento sin mezclarla con otras carreras", async () => {
    const [electronica] = await buscar("¿Qué título intermedio ofrece Ingeniería en Electrónica?");
    assert.equal(electronica.id, "dcayt-ingenieria-electronica");
    assert.match(electronica.texto, /Tecnicatura Universitaria en Electrónica/);

    const [educacion] = await buscar("¿Qué requisitos tiene el Profesorado Universitario?");
    assert.equal(educacion.id, "dhycs-profesorado-universitario");
  });

  it("deriva los listados de carreras de un catálogo único por departamento", () => {
    const items = cargarItems();
    const oferta = items.find((item) => item.id === "oferta-academica-general");
    const aplicadas = items.find((item) => item.id === "carreras-aplicadas-tecnologia");
    const economia = items.find((item) => item.id === "carreras-economicas-juridicas");
    const humanidades = items.find((item) => item.id === "carreras-humanidades-sociales");

    assert.match(oferta.texto, /Ingeniería en Electrónica/);
    assert.match(oferta.texto, /Tecnicatura Universitaria en Electrónica/);
    assert.match(aplicadas.texto, /Diseño en Comunicación Visual/);
    assert.match(economia.texto, /Abogacía/);
    assert.match(humanidades.texto, /Profesorado Universitario en Educación Secundaria y Superior/);
    assert.doesNotMatch(humanidades.texto, /Gestión Universitaria/);

    for (const archivo of [
      "departamento-ciencias-aplicadas-tecnologia.json",
      "departamento-ciencias-economicas-juridicas.json",
      "departamento-humanidades-ciencias-sociales.json",
    ]) {
      const datos = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "kb", archivo), "utf8"));
      assert.ok(Array.isArray(datos.carreras));
      assert.equal(Object.hasOwn(datos, "preguntas_frecuentes"), false);
    }
  });

  it("reutiliza embeddings solo cuando la caché corresponde a la base", async () => {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.equal(cache.version, 2);
    assert.equal(cache.items.length, cargarItems().length);
    assert.match(cache.firma, /^[a-f0-9]{64}$/);

    const llamadasAntes = llamadasEmbedding;
    await initKB({
      cachePath,
      embedFn: async (textos) => {
        llamadasEmbedding++;
        return embeddingDePrueba(textos);
      },
    });
    assert.equal(llamadasEmbedding, llamadasAntes);

    fs.writeFileSync(cachePath, JSON.stringify({ ...cache, firma: "obsoleta" }));
    await initKB({
      cachePath,
      embedFn: async (textos) => {
        llamadasEmbedding++;
        return embeddingDePrueba(textos);
      },
    });
    assert.equal(llamadasEmbedding, llamadasAntes + 1);
  });
});
