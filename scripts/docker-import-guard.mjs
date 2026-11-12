// Guard de build da imagem (Dockerfile): o grafo transitivo de imports
// locais do server.js tem de existir na imagem. Os specs resolvem RELATIVO
// ao ficheiro que importa (o grafo vendado do build-html usa ./ e ../ entre
// subdiretórios) — a resolução flat a partir da raiz dava falsos positivos
// (incidente 12-11-2026, deploy forrkp0ise6esf46xz1qxyrq). Mesma semântica
// do localImportGraph em docker-copy.test.ts.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const seen = new Set(['server.js']);
const queue = ['server.js'];
const missing = [];
while (queue.length) {
  const file = queue.shift();
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    missing.push(file);
    continue;
  }
  const dir = dirname(file);
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const dep = join(dir, m[1]).replace(/\\/g, '/');
    if (seen.has(dep)) continue;
    seen.add(dep);
    if (existsSync(dep)) queue.push(dep);
    else missing.push(`${file} -> ${dep}`);
  }
}
if (missing.length) {
  console.error('FATAL — módulos locais em falta na imagem:', missing);
  process.exit(1);
}
console.log(`IMPORT_GUARD_OK (${seen.size} módulos no grafo de server.js)`);