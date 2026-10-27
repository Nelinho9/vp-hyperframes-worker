import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import {
  applyPatchesLinkedom, applyTimelineRestructure, readPatchTargetValues, readSceneStructure,
  patchValueMatches, assertInsertPreconditions, NODE_OP_PROPERTY, NODE_INSERT_POSITIONS,
} from './patch-engine.js';
import { deriveElements } from './elements-registry.js';
import { replaceAudioTargets } from './audio-prepare.js';
import { buildCoherentPublication } from './composition-publication.js';
import { lintClipWindows } from './window-lint.js';
import { canonical } from './job-contract.js';

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_HTML_BYTES = 8 * 1024 * 1024;

function reject(code, status = 400) {
  throw Object.assign(new Error(code), { code, status });
}

export function compositionHash(html) {
  return createHash('sha256').update(html, 'utf8').digest('hex');
}

/** F04 render identity hashes canonical JSON, unlike the C5 raw source hash. */
export function renderCompositionHash(html) {
  return compositionHash(JSON.stringify(canonical({ html })));
}

function validateHtml(html) {
  if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) reject('INVALID_COMPOSITION_HTML');
  if (!parseHTML(html).document.querySelector('[data-composition-id]')) reject('INVALID_COMPOSITION_ROOT');
}

export function validateCompositionHead(row, projectId) {
  if (!PROJECT_ID.test(projectId)) reject('INVALID_PROJECT_ID');
  if (row === null) return null;
  const c = row?.composition;
  if (row?.project_id !== projectId || !Number.isSafeInteger(row?.revision) || row.revision < 1
    || c?.contract_version !== 'composition.v1' || c.project_id !== projectId || c.revision !== row.revision
    || !SHA256.test(c.content_hash) || !Array.isArray(c.sources) || c.sources.length < 2 || c.sources.length > 512
    || (c.parent_revision !== null && (!Number.isSafeInteger(c.parent_revision) || c.parent_revision < 1 || c.parent_revision >= c.revision))) {
    reject('INVALID_COMPOSITION_HEAD', 503);
  }
  const paths = new Set();
  for (const source of c.sources) {
    const path = source?.storage_path;
    if (!['html', 'registry', 'config', 'asset', 'audio'].includes(source?.kind) || !SHA256.test(source?.sha256)
      || typeof path !== 'string' || path.length > 1024 || !path.startsWith(`projects/${projectId}/`) || /[\\?#:%]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(path)) reject('INVALID_COMPOSITION_SOURCE', 503);
    paths.add(path);
  }
  const html = c.sources.filter(source => source.kind === 'html');
  const registry = c.sources.filter(source => source.kind === 'registry');
  if (html.length !== 1 || registry.length !== 1 || html[0].sha256 !== c.content_hash) reject('INVALID_COMPOSITION_SOURCES', 503);
  const mutation = html[0].storage_path.slice(`projects/${projectId}/composition-revisions/`.length).split('/')[0];
  const immutablePrefix = `projects/${projectId}/composition-revisions/${mutation}/`;
  if (!PROJECT_ID.test(mutation) || html[0].storage_path !== immutablePrefix + 'index.html'
    || registry[0].storage_path !== immutablePrefix + 'elements.json') reject('INVALID_COMPOSITION_NAMESPACE', 503);
  return { ...c, htmlSource: html[0], registrySource: registry[0] };
}

/** Authenticated Edge prepares from committed canonical HTML, never job_dir. */
export function prepareComposition(kind, input, context = {}) {
  validateHtml(input?.source_html);
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) reject('INVALID_COMPOSITION_REVISION');
  let result;
  let before = null;
  let beforeScenes = null;
  let beforeTransitions = null;
  let beforeAudio = null;
  let structureUndoable = true;
  if (kind === 'patch') {
    if (!Array.isArray(input.patches) || input.patches.length < 1 || input.patches.length > 100
      || input.patches.some(p => !p || typeof p.selector !== 'string' || typeof p.property !== 'string' || typeof p.value !== 'string'
        || (p.fragment !== undefined && typeof p.fragment !== 'string')
        || (p.position !== undefined && !NODE_INSERT_POSITIONS.includes(p.position))
        || (String(p.value) === 'insert' && (String(p.property) !== NODE_OP_PROPERTY || typeof p.fragment !== 'string')))) reject('INVALID_PATCHES');
    // E01-B read-set: authored values BEFORE the edit feed the journal delta;
    // the optional `expected` array is the precondition the CURRENT base must
    // satisfy (undo of an action whose write-set was touched later must 409).
    // E04: the insert op carries a SERIALIZED fragment and its own precondition
    // (anchor present, fragment id absent) — checked before any mutation.
    assertInsertPreconditions(input.source_html, input.patches);
    before = readPatchTargetValues(input.source_html, input.patches);
    if (Array.isArray(input.expected) && input.expected.length > 0) {
      if (input.expected.some(p => !p || typeof p.selector !== 'string' || typeof p.property !== 'string' || typeof p.value !== 'string')) reject('INVALID_EXPECTED_VALUES');
      const current = readPatchTargetValues(input.source_html, input.expected);
      const conflicts = [];
      for (let i = 0; i < input.expected.length; i++) {
        const target = input.expected[i];
        if (!patchValueMatches(current[i]?.value ?? null, target.value)) {
          conflicts.push({ selector: target.selector, property: target.property, observed: current[i]?.value ?? null, expected: target.value });
        }
      }
      if (conflicts.length) {
        throw Object.assign(new Error('UNDO_PRECONDITION_CONFLICT'), {
          code: 'UNDO_PRECONDITION_CONFLICT', status: 409, conflicts,
        });
      }
    }
    result = applyPatchesLinkedom(input.source_html, input.patches);
  } else if (kind === 'restructure') {
    if (!Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > 100
      || input.scenes.some(s => !s || typeof s.id !== 'string' || !Number.isFinite(s.durationFrames) || s.durationFrames < 1)
      || new Set(input.scenes.map(s => s.id)).size !== input.scenes.length || (input.fps !== undefined && input.fps !== 30)) reject('INVALID_SCENES');
    if (input.transitions !== undefined && (!Array.isArray(input.transitions) || input.transitions.some(t => !t || typeof t.id !== 'string' || typeof t.kind !== 'string' || !Number.isFinite(t.durationMs)))) reject('INVALID_TRANSITIONS');
    const replacement = input.replace_scene_html ?? null;
    if (replacement !== null && (typeof replacement.id !== 'string' || typeof replacement.html !== 'string')) reject('INVALID_SCENE_REPLACEMENT');
    // E01-B read-set: structure before the edit + optional scene precondition.
    const beforeStructure = readSceneStructure(input.source_html);
    beforeScenes = beforeStructure.scenes;
    beforeTransitions = beforeStructure.transitions;
    // This engine cannot reinsert removed fragments or invert replacements.
    // Never advertise an ID-only delta as an exact inverse.
    structureUndoable = replacement === null && beforeScenes.length === input.scenes.length
      && beforeScenes.every(s => input.scenes.some(next => next.id === s.id));
    if (Array.isArray(input.expected_scenes) && input.expected_scenes.length > 0) {
      if (input.expected_scenes.some(s => !s || typeof s.id !== 'string' || !Number.isFinite(s.durationFrames))) reject('INVALID_EXPECTED_SCENES');
      const current = beforeStructure.scenes.map(s => ({ id: s.id, durationFrames: s.durationFrames }));
      const expected = input.expected_scenes.map(s => ({ id: String(s.id), durationFrames: s.durationFrames }));
      const conflicts = [];
      const max = Math.max(current.length, expected.length);
      for (let i = 0; i < max; i++) {
        if (!current[i] || !expected[i] || current[i].id !== expected[i].id || current[i].durationFrames !== expected[i].durationFrames) {
          conflicts.push({
            position: i,
            observed: current[i] ? { id: current[i].id, durationFrames: current[i].durationFrames } : null,
            expected: expected[i] ? { id: expected[i].id, durationFrames: expected[i].durationFrames } : null,
          });
        }
      }
      if (conflicts.length) {
        throw Object.assign(new Error('UNDO_PRECONDITION_CONFLICT'), {
          code: 'UNDO_PRECONDITION_CONFLICT', status: 409, conflicts,
        });
      }
    }
    if (input.expected_transitions !== undefined) {
      if (!Array.isArray(input.expected_transitions)) reject('INVALID_EXPECTED_TRANSITIONS');
      if (JSON.stringify(beforeTransitions) !== JSON.stringify(input.expected_transitions)) {
        throw Object.assign(new Error('UNDO_PRECONDITION_CONFLICT'), {
          code: 'UNDO_PRECONDITION_CONFLICT', status: 409,
          conflicts: [{ property: 'transitions', observed: beforeTransitions, expected: input.expected_transitions }],
        });
      }
    }
    if (input.scenes.some(s => !beforeScenes.some(current => current.id === s.id))) reject('SCENE_FRAGMENT_UNAVAILABLE', 409);
    result = applyTimelineRestructure(input.source_html, input.scenes, input.fps ?? 30, input.transitions ?? [], replacement);
  } else if (kind === 'audio') {
    // E02/I3 §7.4: só o alvo muda. O read-set (`before`) é o `src` publicado
    // que a revisão nova substitui — o inverso E01 é uma revisão nova com
    // esse mesmo valor, não um blob apagado. O `expected_src` é a precondição
    // do undo/redo (409 antes de qualquer mutação quando diverge).
    const replaced = replaceAudioTargets(input.source_html, input.replacements, input.expected_src, context);
    beforeAudio = replaced.before;
    result = { html: replaced.html, applied: replaced.applied };
  } else reject('INVALID_COMPOSITION_OPERATION');
  const elements = deriveElements(result.html, { revision: input.revision });
  if (elements.conflicts.length) reject('COMPOSITION_ELEMENT_ID_CONFLICT', 409);
  const coherent = buildCoherentPublication({ html: result.html, registry: elements, revision: input.revision });
  // Node ops and missing before-values have no patch-applicable inverse: the
  // journal marks such commands undo_unavailable instead of guessing.
  const undoable = beforeAudio !== null
    ? true
    : before !== null
      ? before.every(entry => entry.value !== null && entry.property !== NODE_OP_PROPERTY)
      : structureUndoable;
  return {
    ok: true, prepared: true, html: coherent.html, elements: coherent.registry,
    applied: result.applied, revision: input.revision, content_hash: compositionHash(coherent.html),
    ...(before !== null ? { before } : {}),
    ...(beforeAudio !== null ? { before_audio: beforeAudio } : {}),
    ...(beforeScenes !== null ? { before_scenes: beforeScenes, before_transitions: beforeTransitions } : {}),
    undoable,
    ...(result.created ? { created: result.created } : {}),
    ...(result.removed ? { removed: result.removed, replaced: result.replaced ?? null, findings: lintClipWindows(result.html, { fps: input.fps ?? 30 }) } : {}),
  };
}

export function compositionPreviewOptions(html, head) {
  const root = parseHTML(html).document.querySelector('[data-composition-id]');
  const width = Number(root?.getAttribute('data-width'));
  const height = Number(root?.getAttribute('data-height'));
  const duration = Number(root?.getAttribute('data-duration'));
  if (!(width > 0 && height > 0 && duration > 0)) reject('COMPOSITION_PREVIEW_DIMENSIONS_REQUIRED', 409);
  return { width, height, duration, fps: 30, format: 'mp4', composition_revision: head.revision, composition_hash: renderCompositionHash(html) };
}

/** One process-local activation at a time. PostgreSQL remains commit authority. */
export function createCompositionEditor({ readHead, readText, stage, publish, current, storageUrl }) {
  const tails = new Map();
  async function serial(projectId, operation) {
    const previous = tails.get(projectId) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    tails.set(projectId, next);
    await previous;
    try { return await operation(); }
    finally { release(); if (tails.get(projectId) === next) tails.delete(projectId); }
  }
  async function headFor(projectId) {
    return validateCompositionHead(await readHead(projectId), projectId);
  }
  async function sourceFor(projectId, head) {
    const [html, rawRegistry] = await Promise.all([readText(head.htmlSource.storage_path), readText(head.registrySource.storage_path)]);
    if (typeof html !== 'string' || compositionHash(html) !== head.content_hash
      || typeof rawRegistry !== 'string' || compositionHash(rawRegistry) !== head.registrySource.sha256) reject('COMPOSITION_SOURCE_HASH_MISMATCH', 503);
    validateHtml(html);
    let registry;
    try { registry = JSON.parse(rawRegistry); } catch { reject('COMPOSITION_REGISTRY_INVALID', 503); }
    if (registry?.version !== 2 || registry.revision !== head.revision || !Array.isArray(registry.elements)
      || registry.elements.some(e => e.revision !== head.revision)) reject('COMPOSITION_REGISTRY_REVISION_MISMATCH', 503);
    return { html, registry, head, projectId };
  }
  async function activateLocked(projectId, requested, knownHead = null) {
    const head = knownHead ?? await headFor(projectId);
    if (!head) reject('COMPOSITION_HEAD_REQUIRED', 409);
    if (requested && (requested.revision !== head.revision || requested.content_hash !== head.content_hash
      || typeof requested.html !== 'string' || compositionHash(requested.html) !== head.content_hash)) reject('COMPOSITION_ACTIVATION_CONFLICT', 409);
    const active = current(projectId);
    if (active && active.revision > head.revision) reject('COMPOSITION_ACTIVATION_REGRESSION', 409);
    if (active?.revision === head.revision && active.content_hash !== head.content_hash) reject('COMPOSITION_ACTIVATION_HASH_CONFLICT', 409);
    if (active?.revision === head.revision && active.content_hash === head.content_hash) return head;
    const source = await sourceFor(projectId, head);
    const candidate = await stage(projectId, source.html, head);
    const latest = await headFor(projectId);
    if (!latest || latest.revision !== head.revision || latest.content_hash !== head.content_hash) reject('COMPOSITION_HEAD_MOVED', 409);
    const activeNow = current(projectId);
    if (activeNow && activeNow.revision > head.revision) reject('COMPOSITION_ACTIVATION_REGRESSION', 409);
    await publish(projectId, candidate, head);
    return head;
  }
  async function readPublished(projectId, expectedRevision, expectedHash) {
    const head = await headFor(projectId);
    if (!head) return null;
    if (expectedRevision !== undefined && expectedRevision !== head.revision) reject('COMPOSITION_REVISION_CONFLICT', 409);
    if (expectedHash !== undefined && expectedHash !== head.content_hash) reject('COMPOSITION_HASH_CONFLICT', 409);
    return sourceFor(projectId, head);
  }
  return {
    prepare: (kind, input) => prepareComposition(kind, input, { storageUrl }),
    activate: (projectId, input) => serial(projectId, () => activateLocked(projectId, input)),
    ensurePreview: projectId => serial(projectId, async () => {
      const head = await headFor(projectId);
      return head ? activateLocked(projectId, null, head) : null;
    }),
    readPublished,
    readJobComposition: async (projectId, body) => {
      const source = await readPublished(projectId, body.composition_revision ?? body.revision, body.published_content_hash);
      if (!source) {
        if (body.published_content_hash !== undefined) reject('COMPOSITION_HEAD_REQUIRED', 409);
        return null;
      }
      // An authenticated producer may renew expiring media URLs. The immutable
      // raw C5 source and the derived F04 render bytes have separate identities.
      const html = body.published_content_hash !== undefined
        ? (body.inputs?.index_html ?? body.index_html)
        : source.html;
      if (typeof html !== 'string' || !html) reject('COMPOSITION_DERIVED_INLINE_REQUIRED', 409);
      if (body.composition_hash !== renderCompositionHash(html)) reject('COMPOSITION_DERIVED_HASH_CONFLICT', 409);
      validateHtml(html);
      return { ...source, html };
    },
  };
}

export function registerCompositionRoutes(app, editor, authorizeService) {
  const handle = (kind) => async (req, res) => {
    const auth = authorizeService(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    if (!PROJECT_ID.test(req.params.id)) return res.status(400).json({ error: 'INVALID_PROJECT_ID' });
    try {
      if (kind !== 'activate') return res.json(editor.prepare(kind, req.body));
      const head = await editor.activate(req.params.id, req.body);
      return res.json({ ok: true, activated: true, revision: head.revision, content_hash: head.content_hash, preview_sync_pending: false });
    } catch (error) {
      // E01-B: the structured precondition conflicts ride the 409 body so the
      // gateway can show which write-set targets diverged.
      if (Array.isArray(error?.conflicts)) {
        return res.status(error.status ?? 409).json({
          error: error.code ?? 'UNDO_PRECONDITION_CONFLICT', conflicts: error.conflicts,
        });
      }
      return res.status(error.status ?? 503).json({ error: error.code ?? 'COMPOSITION_PREPARATION_FAILED',
        ...(kind === 'activate' ? { activated: false, preview_sync_pending: true, publication_changed: false } : {}) });
    }
  };
  app.post('/prepare-patch/:id', handle('patch'));
  app.post('/prepare-restructure/:id', handle('restructure'));
  app.post('/prepare-audio/:id', handle('audio'));
  app.post('/activate-composition/:id', handle('activate'));
}
