// @vitest-environment node
// Regressão do incidente 22-08-2026 (deploy cyyqzuj0k5xl6i8hk2ih8trr):
// o COPY explícito do Dockerfile omitia patch-engine.js e
// composition-sanitizer.js → ERR_MODULE_NOT_FOUND no boot do container →
// healthcheck unhealthy → rollback do Coolify. O V4_04C chegou a prod?
// Nunca. Este teste garante que o grafo de imports local do server.js
// está sempre coberto pelo COPY da runtime stage.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(fileURLToPath(import.meta.url));

const read = (p: string): string => readFileSync(join(root, p), 'utf8');

/** Grafo transitivo de imports locais (`./x.js`) a partir de um módulo raiz. */
function localImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const src = read(file);
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.\/[^'"]+)['"]/g)) {
      const dep = m[1].replace(/^\.\//, '');
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

interface CopyDirective {
  raw: string;
  expanded: Set<string>;
  hasWildcardJs: boolean;
}

/** Diretivas COPY da runtime stage (último FROM) com tokens expandidos. */
function runtimeCopyDirectives(): CopyDirective[] {
  const dockerfile = read('Dockerfile');
  const stages = dockerfile.split(/^FROM\s/m);
  const runtimeStage = stages[stages.length - 1];
  const directives: CopyDirective[] = [];
  for (const m of runtimeStage.matchAll(/^COPY\s+(.+)$/gm)) {
    const parts = m[1].trim().split(/\s+/);
    const tokens = parts.slice(0, -1); // último token é o destino
    const expanded = new Set<string>();
    let hasWildcardJs = false;
    for (const token of tokens) {
      if (token === '*.js') {
        hasWildcardJs = true;
        for (const f of readdirSync(root)) {
          if (f.endsWith('.js')) expanded.add(f);
        }
      } else {
        expanded.add(token);
      }
    }
    directives.push({ raw: m[1], expanded, hasWildcardJs });
  }
  return directives;
}

describe('Dockerfile cobre o grafo de imports do worker', () => {
  it('todo módulo local importado existe no repo', () => {
    const graph = localImportGraph('server.js');
    expect(graph.size).toBeGreaterThan(0);
    for (const dep of graph) {
      expect(() => read(dep), `módulo em falta: ${dep}`).not.toThrow();
    }
  });

  it('o COPY da runtime stage inclui todo o grafo de imports', () => {
    const graph = [...localImportGraph('server.js')];
    const directives = runtimeCopyDirectives();
    const copied = new Set<string>();
    for (const d of directives) for (const f of d.expanded) copied.add(f);

    // O wildcard *.js é a defesa primária; se alguém reverte para lista
    // explícita, este assertion continua a validar cada módulo.
    expect(directives.some((d) => d.hasWildcardJs)).toBe(true);

    for (const dep of graph) {
      expect(
        copied.has(dep),
        `deploy vai crashar: '${dep}' importado por server.js mas ausente do COPY do Dockerfile`
      ).toBe(true);
    }
  });

  it('a imagem tem guard de build para imports não resolvidos', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/RUN node -e [^\n]*FATAL/);
  });

  it('fixtures são copiadas para a imagem', () => {
    const directives = runtimeCopyDirectives();
    expect(directives.some((d) => d.raw.includes('fixtures'))).toBe(true);
  });
});
