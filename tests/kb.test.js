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
    assert.equal(items.length, 57);
    assert.ok(items.some((item) => item.archivo === "contactos.json"));
    assert.ok(items.some((item) => item.archivo === "coprun.json"));
    assert.ok(items.some((item) => item.archivo === "inscripcion-2027.json"));
    assert.ok(items.some((item) => item.etiqueta && item.palabrasClave.length));
    assert.ok(items.every((item) => item.id && item.pregunta && item.texto));
  });

  it("recupera primero respuestas pertinentes por tema y palabras clave", async (t) => {
    const casos = [
      ["¿Cuáles son las fechas de inscripción para 2027?", "inscripcion-2027-faq-1"],
      ["¿Cómo se aprueba el COPRUN y qué asistencia piden?", "coprun-faq-5"],
      ["¿Dónde está la biblioteca y cuál es su correo?", "contactos-faq-3"],
      ["¿Hay becas o ayuda económica en la UNM?", "vida-universitaria-faq-8"],
      ["Hola, quiero averiguar por las carreras disponibles.", "vida-universitaria-faq-2"],
      ["¿Qué carreras ofrece el Departamento de Ciencias Aplicadas y Tecnología?", "carreras-aplicadas-tecnologia"],
      ["¿Qué carreras ofrece el Departamento de Ciencias Económicas y Jurídicas?", "carreras-economicas-juridicas"],
      ["¿Qué carreras ofrece el Departamento de Humanidades y Ciencias Sociales?", "carreras-humanidades-sociales"],
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

  it("reutiliza embeddings solo cuando la caché corresponde a la base", async () => {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.equal(cache.version, 2);
    assert.equal(cache.items.length, 57);
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
