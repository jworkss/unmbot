const os = require("node:os");
const path = require("node:path");
const { asegurarCertificados } = require("./certificados");

function obtenerIPLocal() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const interfaz of interfaces || []) {
      if (interfaz.family === "IPv4" && !interfaz.internal) {
        return interfaz.address;
      }
    }
  }
  return undefined;
}

asegurarCertificados({
  directory: path.join(__dirname, "certs"),
  ipAddress: obtenerIPLocal(),
  force: process.argv.includes("--force"),
})
  .then(({ generated, certPath, keyPath }) => {
    console.log(
      generated
        ? `Certificados generados:\n${certPath}\n${keyPath}`
        : "Ya existen certs/cert.pem y certs/key.pem; no se modificaron.",
    );
  })
  .catch((error) => {
    console.error("No se pudieron generar los certificados:", error);
    process.exitCode = 1;
  });
