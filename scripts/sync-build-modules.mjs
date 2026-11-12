/**
 * sync-build-modules.mjs — F1 (plano Video-Engine v2): vendoring dos módulos
 * PUROS do build HTML a partir do monorepo visttapro.
 *
 * O worker corre o loop completo de build (LLM → repair → lint → fallback)
 * sem o teto de CPU das edges, reutilizando EXATAMENTE os módulos dual-runtime
 * do orchestrator/builder — nada de ports manuais que divergem. Este script
 * copia o grafo de imports (estruturas de diretórios preservadas para que os
 * imports relativos `.ts` resolvam sem reescritas) e grava PROVENANCE.json
 * com o commit de origem + sha256 de cada ficheiro (gate de paridade).
 *
 * Uso (a partir da raiz do repo do worker):
 *   node scripts/sync-build-modules.mjs [caminho/para/visttapro/supabase/functions]
 *
 * Por omissão assume ../visttapro/supabase/functions (layout do workspace).
 * Node >= 22.18 (type stripping nativo) corre os .ts vendados sem build step.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const VENDOR_ROOT = join(REPO_ROOT, 'build-html', 'vendor');

/** Entrypoints do grafo; o resto é descoberto por transitividade dos imports. */
export const ENTRY_MODULES = [
  'video-v4-steps/buildStep.ts',
  '_shared/llmProvider.ts',
  // F2 (plano v2): motor partilhado dos steps LLM + configs (llm-step runner).
  'video-v4-steps/_steps.ts',
  'video-v4-steps/designStep.ts',
  'video-v4-steps/storyboardStep.ts',
  'video-v4-steps/visualStep.ts',
  // F2 (plano v2): pipeline completo do step de áudio (TTS/BGM/ASR) — o MESMO
  // módulo que a edge video-v4-audio executa (extração behavior-preserving).
  'video-v4-audio/audioPipeline.ts',
];

/**
 * F2: o Node não resolve imports https (esm.sh). A ÚNICA reescrita é o zod
 * pinned → pacote local `zod` na MESMA versão (3.25.76, package.json do
 * worker). Determinística e registada no PROVENANCE; os bytes originais
 * continuam auditáveis pelo sha256 da fonte.
 */
export const VENDOR_REWRITES = [
  { from: 'https://esm.sh/zod@3.25.76', to: 'zod' },
];

function applyRewrites(text) {
  let out = text;
  for (const { from, to } of VENDOR_REWRITES) {
    out = out.split(`'${from}'`).join(`'${to}'`).split(`"${from}"`).join(`"${to}"`);
  }
  return out;
}

/**
 * Fecho transitivo dos imports relativos `.ts` — o grafo é descoberto, não
 * mantido à mão (um import novo no upstream entra automaticamente no vendor).
 */
export function discoverModuleGraph(functionsDir, entries = ENTRY_MODULES) {
  const seen = new Set();
  const queue = [...entries];
  const importRe = /(?:from|import)\s*\(?\s*['"](\.[^'"]+\.ts)['"]/g;
  while (queue.length) {
    const rel = queue.shift().replace(/\\/g, '/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = join(functionsDir, rel);
    if (!existsSync(src)) throw new Error(`SOURCE_MODULE_MISSING: ${rel}`);
    const text = readFileSync(src, 'utf8');
    for (const m of text.matchAll(importRe)) {
      const spec = m[1];
      const resolved = join(dirname(rel), spec).replace(/\\/g, '/');
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceCommit(functionsDir) {
  try {
    // O repo git é visttapro/ (pai de supabase/functions).
    return execFileSync('git', ['-C', resolve(functionsDir, '..', '..'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function syncBuildModules(functionsDir) {
  const graph = discoverModuleGraph(functionsDir);
  const files = {};
  for (const rel of graph) {
    const src = join(functionsDir, rel);
    const bytes = readFileSync(src);
    const dst = join(VENDOR_ROOT, rel);
    mkdirSync(dirname(dst), { recursive: true });
    // sha256 da FONTE original; o ficheiro vendado pode levar a reescrita
    // determinística do zod (VENDOR_REWRITES) para resolver sob Node.
    writeFileSync(dst, applyRewrites(bytes.toString('utf8')));
    files[rel] = sha256(bytes);
  }
  const provenance = {
    contract: 'build-html-vendor.v1',
    source_repo: 'visttapro (supabase/functions)',
    source_commit: sourceCommit(functionsDir),
    synced_at: new Date().toISOString(),
    node_requirement: '>=22.18 (native TypeScript type stripping)',
    rewrites: VENDOR_REWRITES,
    files,
  };
  writeFileSync(join(VENDOR_ROOT, 'PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');
  return provenance;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const functionsDir = resolve(process.argv[2] ?? join(REPO_ROOT, '..', 'visttapro', 'supabase', 'functions'));
  const provenance = syncBuildModules(functionsDir);
  console.log(`[sync-build-modules] ${Object.keys(provenance.files).length} módulos vendados de ${functionsDir}`);
  console.log(`[sync-build-modules] source_commit=${provenance.source_commit}`);
}