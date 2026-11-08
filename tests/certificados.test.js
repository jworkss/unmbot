const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { after, describe, it } = require("node:test");
const { X509Certificate } = require("node:crypto");
const { asegurarCertificados } = require("../certificados");

const temporal = fs.mkdtempSync(
  path.join(os.tmpdir(), "asistente-certificados-test-"),
);

after(() => {
  fs.rmSync(temporal, { recursive: true, force: true });
});

describe("generación de certificados", () => {
  it("crea el directorio, genera los PEM y conserva el par existente", async () => {
    const directory = path.join(temporal, "certs");
    const resultado = await asegurarCertificados({
      directory,
      ipAddress: "192.168.1.20",
    });

    assert.equal(resultado.generated, true);
    assert.ok(fs.existsSync(resultado.keyPath));
    assert.ok(fs.existsSync(resultado.certPath));

    const key = fs.readFileSync(resultado.keyPath);
    const cert = fs.readFileSync(resultado.certPath);
    assert.doesNotThrow(() => tls.createSecureContext({ key, cert }));
    assert.match(
      new X509Certificate(cert).subjectAltName,
      /IP Address:192\.168\.1\.20/,
    );

    const segundoResultado = await asegurarCertificados({ directory });
    assert.equal(segundoResultado.generated, false);
    assert.deepEqual(fs.readFileSync(resultado.keyPath), key);
    assert.deepEqual(fs.readFileSync(resultado.certPath), cert);
  });

  it("regenera ambos archivos cuando se solicita explícitamente", async () => {
    const directory = path.join(temporal, "regenerar");
    const inicial = await asegurarCertificados({ directory });
    const keyInicial = fs.readFileSync(inicial.keyPath);

    const regenerado = await asegurarCertificados({
      directory,
      force: true,
    });

    assert.equal(regenerado.generated, true);
    assert.notDeepEqual(fs.readFileSync(regenerado.keyPath), keyInicial);
    assert.doesNotThrow(() =>
      tls.createSecureContext({
        key: fs.readFileSync(regenerado.keyPath),
        cert: fs.readFileSync(regenerado.certPath),
      }),
    );
  });
});
