const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const directorioPiper = path.join(__dirname, "bin", "piper");
const ejecutablePiper = path.join(directorioPiper, "piper.exe");
const modeloVoz = path.join(directorioPiper, "es_AR-daniela-high.onnx");
const salidaPorDefecto = path.join(
  __dirname,
  "audio_out",
  `consulta_${Date.now()}.wav`,
);

async function verificarArchivo(ruta) {
  try {
    await fs.access(ruta);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`No se encontró el archivo requerido: ${ruta}`);
    throw error;
  }
}

function generarAudio(texto, archivoSalida) {
  return new Promise((resolve, reject) => {
    const piper = spawn(
      ejecutablePiper,
      ["--model", modeloVoz, "--output_file", archivoSalida, "--length_scale", "1.15"],
      { cwd: directorioPiper, windowsHide: true },
    );
    let errorProceso = "";

    piper.stderr.setEncoding("utf8");
    piper.stderr.on("data", (fragmento) => {
      errorProceso += fragmento;
    });
    piper.once("error", reject);
    piper.once("close", (codigo) => {
      if (codigo !== 0) {
        reject(
          new Error(
            errorProceso.trim() ||
              `Piper terminó con el código de salida ${codigo}.`,
          ),
        );
        return;
      }
      resolve();
    });

    piper.stdin.on("error", reject);
    piper.stdin.end(texto.replace(/[*_#`~]/g, " ").replace(/\s+/g, " ").trim());
  });
}

async function main() {
  await Promise.all([verificarArchivo(ejecutablePiper), verificarArchivo(modeloVoz)]);

  const entrada = readline.createInterface({ input: stdin, output: stdout });
  let texto;
  try {
    texto = (await entrada.question("Escribí el texto para convertir a audio:\n> "))
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    entrada.close();
  }

  if (!texto) {
    console.log("No ingresaste texto. No se generó ningún audio.");
    return;
  }

  const archivoSalida = process.argv[2]
    ? path.resolve(process.argv[2])
    : salidaPorDefecto;
  await fs.mkdir(path.dirname(archivoSalida), { recursive: true });
  await generarAudio(texto, archivoSalida);
  console.log(`Audio generado correctamente: ${archivoSalida}`);
}

main().catch((error) => {
  console.error(`No se pudo generar el audio: ${error.message}`);
  process.exitCode = 1;
});
