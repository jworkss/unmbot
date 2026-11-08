const fs = require("node:fs");
const path = require("node:path");
const selfsigned = require("selfsigned");

async function asegurarCertificados({
  directory,
  ipAddress,
  force = false,
}) {
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");

  if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { generated: false, keyPath, certPath };
  }

  fs.mkdirSync(directory, { recursive: true });

  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    { type: 7, ip: "::1" },
  ];
  if (ipAddress && !altNames.some((name) => name.ip === ipAddress)) {
    altNames.push({ type: 7, ip: ipAddress });
  }

  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      keySize: 2048,
      algorithm: "sha256",
      notBeforeDate: new Date(),
      notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames },
      ],
    },
  );

  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });

  return { generated: true, keyPath, certPath };
}

module.exports = { asegurarCertificados };
