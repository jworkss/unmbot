function embeddingDePrueba(textos) {
  const dimension = 512;
  return textos.map((texto) => {
    const vector = Array(dimension).fill(0);
    const tokens = texto.toLowerCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[a-z0-9]+/g) || [];
    tokens.forEach((token) => {
      let hash = 5381;
      for (const caracter of token) hash = ((hash * 33) ^ caracter.charCodeAt(0)) >>> 0;
      vector[hash % dimension]++;
    });
    return vector;
  });
}

module.exports = { embeddingDePrueba };
