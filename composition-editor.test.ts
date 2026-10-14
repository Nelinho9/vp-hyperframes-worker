// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { compositionHash, renderCompositionHash, createCompositionEditor, prepareComposition, validateCompositionHead } from './composition-editor.js';
import { deriveElements } from './elements-registry.js';
import { logicalInputHash, parseRenderJob } from './job-contract.js';

const PROJECT = '33333333-3333-4333-8333-333333333333';
const HTML = '<html><body><div data-composition-id="main" data-width="1080" data-height="1920" data-duration="5"><div id="scene-1" class="clip" data-start="0" data-duration="5" data-track-index="0"><h1 id="title">Original</h1></div></div></body></html>';
const backing = vi.hoisted(() => ({ head: null as any, texts: new Map<string, string>(), uploads: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: backing.head, error: null }) }) }) }),
    storage: { from: () => ({
      download: async (path: string) => ({ data: backing.texts.has(path) ? new Blob([backing.texts.get(path)!]) : null, error: null }),
      upload: backing.uploads,
    }) },
  }),
}));

function publication(revision = 2, html = HTML) {
  const registry = JSON.stringify(deriveElements(html, { revision }));
  const mutationId = `44444444-4444-4444-8444-${String(revision).padStart(12, '0')}`;
  const htmlPath = `projects/${PROJECT}/composition-revisions/${mutationId}/index.html`;
  const registryPath = `projects/${PROJECT}/composition-revisions/${mutationId}/elements.json`;
  return {
    row: { project_id: PROJECT, revision, composition: { contract_version: 'composition.v1', project_id: PROJECT,
      revision, parent_revision: revision - 1, content_hash: compositionHash(html), sources: [
        { kind: 'html', storage_path: htmlPath, sha256: compositionHash(html) },
        { kind: 'registry', storage_path: registryPath, sha256: compositionHash(registry) },
      ] } }, html, registry, htmlPath, registryPath,
  };
}

function controller(p = publication()) {
  const readHead = vi.fn(async () => p.row);
  const readText = vi.fn(async (path: string) => path === p.htmlPath ? p.html : p.registry);
  let active: any = null;
  const stage = vi.fn(async () => ({ id: 'candidate' }));
  const publish = vi.fn(async (_id: string, _candidate: any, head: any) => { active = head; });
  const editor = createCompositionEditor({ readHead, readText, stage, publish, current: () => active });
  return { editor, readHead, readText, stage, publish };
}

describe('E01 canonical preparation', () => {
  it('uses caller canonical source and versions the derived registry without staging', () => {
    const source = HTML.replace('</h1>', '</h1><audio id="voice" src="https://media.example.test/voice.wav"></audio>');
    const prepared = prepareComposition('patch', { source_html: source, revision: 3,
      patches: [{ selector: '#title', property: 'textContent', value: 'Edited' }] });
    expect(prepared.html).toContain('https://media.example.test/voice.wav');
    expect(prepared.html).toContain('Edited');
    expect(prepared.content_hash).toBe(compositionHash(prepared.html));
    expect(prepared.elements.revision).toBe(3);
    expect(prepared.elements.elements.every((e: any) => e.revision === 3)).toBe(true);
    expect(source).toContain('Original');
  });
  it('reuses structural timing engine on canonical HTML', () => {
    const prepared = prepareComposition('restructure', { source_html: HTML, revision: 3, fps: 30,
      scenes: [{ id: 'scene-1', durationFrames: 90 }] });
    expect(prepared.html).toContain('data-duration="3"');
    expect(prepared.elements.revision).toBe(3);
  });
  it('rejects invalid revisions, duplicate scene IDs and rootless candidates', () => {
    expect(() => prepareComposition('patch', { source_html: HTML, revision: 0, patches: [] })).toThrow();
    expect(() => prepareComposition('restructure', { source_html: HTML, revision: 3,
      scenes: [{ id: 'scene-1', durationFrames: 90 }, { id: 'scene-1', durationFrames: 90 }] })).toThrow('INVALID_SCENES');
    expect(() => prepareComposition('patch', { source_html: '<h1>x</h1>', revision: 3, patches: [] })).toThrow('INVALID_COMPOSITION_ROOT');
  });
});

describe('E01 authoritative activation and readers', () => {
  it('rejects stale activation before any stage and never moves the head', async () => {
    const c = controller();
    await expect(c.editor.activate(PROJECT, { revision: 1, html: HTML, content_hash: compositionHash(HTML) })).rejects.toThrow('COMPOSITION_ACTIVATION_CONFLICT');
    expect(c.stage).not.toHaveBeenCalled();
    expect(c.publish).not.toHaveBeenCalled();
  });
  it('verifies both immutable source hashes and prevents preview change on corruption', async () => {
    const c = controller();
    c.readText.mockResolvedValueOnce('corrupt');
    await expect(c.editor.ensurePreview(PROJECT)).rejects.toThrow('COMPOSITION_SOURCE_HASH_MISMATCH');
    expect(c.stage).not.toHaveBeenCalled();
    expect(c.publish).not.toHaveBeenCalled();
  });
  it('does not activate a candidate when DB head advances during prestage', async () => {
    const c = controller();
    const newer = publication(3);
    c.stage.mockImplementationOnce(async () => { c.readHead.mockResolvedValue(newer.row); return { id: 'candidate' }; });
    await expect(c.editor.activate(PROJECT, { revision: 2, html: HTML, content_hash: compositionHash(HTML) })).rejects.toThrow('COMPOSITION_HEAD_MOVED');
    expect(c.publish).not.toHaveBeenCalled();
  });
  it('serializes duplicate activations and makes second delivery a local replay', async () => {
    const c = controller();
    const input = { revision: 2, html: HTML, content_hash: compositionHash(HTML) };
    await Promise.all([c.editor.activate(PROJECT, input), c.editor.activate(PROJECT, input)]);
    expect(c.stage).toHaveBeenCalledTimes(1);
    expect(c.publish).toHaveBeenCalledTimes(1);
  });
  it('concurrent newer activation wins after an older candidate loses its authoritative head', async () => {
    const c = controller();
    const newer = publication(3, HTML.replace('Original', 'New head'));
    c.readText.mockImplementation(async path => {
      if (path === newer.htmlPath) return newer.html;
      if (path === newer.registryPath) return newer.registry;
      const older = publication();
      return path === older.htmlPath ? older.html : older.registry;
    });
    let release: () => void;
    let started: () => void;
    const staged = new Promise<void>(done => { started = done; });
    const gate = new Promise<void>(done => { release = done; });
    c.stage.mockImplementationOnce(async () => { started(); await gate; return { id: 'old-candidate' }; });
    const old = c.editor.activate(PROJECT, { revision: 2, html: HTML, content_hash: compositionHash(HTML) });
    await staged;
    c.readHead.mockResolvedValue(newer.row);
    const fresh = c.editor.activate(PROJECT, { revision: 3, html: newer.html, content_hash: newer.row.composition.content_hash });
    release();
    const [first, second] = await Promise.allSettled([old, fresh]);
    expect(first.status).toBe('rejected'); expect(second.status).toBe('fulfilled');
    expect(c.publish).toHaveBeenCalledTimes(1);
    expect(c.publish.mock.calls[0][2].revision).toBe(3);
  });
  it('reader uses published source and rejects old render revisions instead of falling back', async () => {
    const c = controller();
    expect((await c.editor.readPublished(PROJECT, 2))?.html).toBe(HTML);
    await expect(c.editor.readPublished(PROJECT, 1)).rejects.toThrow('COMPOSITION_REVISION_CONFLICT');
    await expect(c.editor.readPublished(PROJECT, 2, 'a'.repeat(64))).rejects.toThrow('COMPOSITION_HASH_CONFLICT');
    c.readHead.mockResolvedValueOnce(null as any);
    expect(await c.editor.readPublished(PROJECT, 1)).toBeNull();
  });
  it('database failures do not authorize legacy fallback or preview publication', async () => {
    const c = controller();
    c.readHead.mockRejectedValue(new Error('database unavailable'));
    await expect(c.editor.readPublished(PROJECT, 2)).rejects.toThrow('database unavailable');
    await expect(c.editor.ensurePreview(PROJECT)).rejects.toThrow('database unavailable');
    expect(c.stage).not.toHaveBeenCalled(); expect(c.publish).not.toHaveBeenCalled();
  });
  it('preserves authenticated signed URL renewal while binding raw C5 and derived render hashes separately', async () => {
    const raw = HTML.replace('</h1>', '</h1><audio id="voice" src="https://media.example.test/voice.wav?token=old"></audio>');
    const p = publication(2, raw);
    const c = controller(p);
    const derived = raw.replace('token=old', 'token=renewed');
    const body = { revision: 2, composition_revision: 2, published_content_hash: p.row.composition.content_hash,
      composition_hash: renderCompositionHash(derived), inputs: { index_html: derived } };
    const source = await c.editor.readJobComposition(PROJECT, body);
    expect(source?.html).toContain('token=renewed');
    expect(source?.head.content_hash).toBe(compositionHash(raw));
    expect(body.composition_hash).not.toBe(source?.head.content_hash);
    await expect(c.editor.readJobComposition(PROJECT, { ...body, inputs: { index_html: derived + 'tamper' } })).rejects.toThrow('COMPOSITION_DERIVED_HASH_CONFLICT');
    await expect(c.editor.readJobComposition(PROJECT, { ...body, published_content_hash: 'a'.repeat(64) })).rejects.toThrow('COMPOSITION_HASH_CONFLICT');
    await expect(c.editor.readJobComposition(PROJECT, { ...body, composition_revision: 1 })).rejects.toThrow('COMPOSITION_REVISION_CONFLICT');
  });
  it('published source binding participates in the job logical hash and cannot be tampered', () => {
    const body: any = { contract_version: 1, request_id: '11111111-1111-4111-8111-111111111111',
      job_id: '22222222-2222-4222-8222-222222222222', project_id: PROJECT, revision: 2, step: 'build', mode: 'preview',
      inputs: { index_html: HTML }, options: { width: 1080, height: 1920, duration: 5, fps: 30 }, artifact_paths: {},
      published_content_hash: compositionHash(HTML) };
    body.input_hash = logicalInputHash(body);
    expect(parseRenderJob(body, 'local-test').body.published_content_hash).toBe(body.published_content_hash);
    expect(() => parseRenderJob({ ...body, published_content_hash: 'a'.repeat(64) }, 'local-test')).toThrow('INPUT_HASH_MISMATCH');
  });
  it('never regresses an activated revision when the authority later reports an older head', async () => {
    const newer = publication(3);
    const c = controller(newer);
    await c.editor.activate(PROJECT, { revision: 3, html: HTML, content_hash: compositionHash(HTML) });
    c.readHead.mockResolvedValue(publication(2).row);
    await expect(c.editor.activate(PROJECT, { revision: 2, html: HTML, content_hash: compositionHash(HTML) })).rejects.toThrow('COMPOSITION_ACTIVATION_REGRESSION');
    expect(c.publish).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign paths, traversal, incoherent revisions and omitted registry', () => {
    const p = publication();
    for (const path of ['projects/foreign/index.html', `projects/${PROJECT}/../index.html`, `projects/${PROJECT}/%2e%2e/index.html`, `projects/${PROJECT}/compositions/index.html`]) {
      const row = structuredClone(p.row); row.composition.sources[0].storage_path = path;
      expect(() => validateCompositionHead(row, PROJECT)).toThrow();
    }
    expect(() => validateCompositionHead({ ...p.row, revision: 7 }, PROJECT)).toThrow();
    expect(() => validateCompositionHead({ ...p.row, composition: { ...p.row.composition, sources: [p.row.composition.sources[0]] } }, PROJECT)).toThrow();
  });
});

describe('E01 server routes and real local preview files', () => {
  const secret = 'worker-e01-local-only-secret';
  const workDir = mkdtempSync(join(tmpdir(), 'worker-e01-'));
  const keys = ['WORKER_SECRET', 'PREVIEW_SECRET', 'WORK_DIR', 'SUPABASE_URL', 'SUPABASE_KEY'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let server: Server;
  let base: string;
  beforeAll(async () => {
    process.env.WORKER_SECRET = secret;
    delete process.env.PREVIEW_SECRET;
    process.env.WORK_DIR = workDir;
    process.env.SUPABASE_URL = 'https://supabase.example.test';
    process.env.SUPABASE_KEY = 'e01-test-only';
    vi.resetModules();
    const { app } = await import('./server.js');
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(done => server.once('listening', done));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>(done => server.close(() => done()));
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    // Only remove the absolute mkdtemp directory owned by this test.
    if (dirname(resolve(workDir)) !== resolve(tmpdir())) throw new Error('unsafe fixture cleanup');
    rmSync(workDir, { recursive: true, force: true });
  });
  const post = (route: string, body: unknown, authorized = true) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { 'X-Worker-Secret': secret } : {}) }, body: JSON.stringify(body),
  });
  it('prepare works with no staged job, preserves preview sentinel bytes and rejects missing auth', async () => {
    backing.head = null;
    const sentinel = join(workDir, 'preview-sentinel.html');
    writeFileSync(sentinel, 'old preview');
    const input = { source_html: HTML, revision: 2, patches: [{ selector: '#title', property: 'textContent', value: 'Prepared' }] };
    expect((await post(`/prepare-patch/${PROJECT}`, input, false)).status).toBe(401);
    const response = await post(`/prepare-patch/${PROJECT}`, input);
    expect(response.status).toBe(200);
    expect((await response.json()).prepared).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('old preview');
    expect(readdirSync(workDir)).toEqual(['preview-sentinel.html']);
    const restructure = await post(`/prepare-restructure/${PROJECT}`, { source_html: HTML, revision: 2, scenes: [{ id: 'scene-1', durationFrames: 120 }] });
    expect(restructure.status).toBe(200);
    expect((await restructure.json()).html).toContain('data-duration="4"');
    expect(backing.uploads).not.toHaveBeenCalled();
  });
  it('activates only DB-committed content, serves it, and blocks old mutable endpoints', async () => {
    const p = publication();
    backing.head = p.row;
    backing.texts.set(p.htmlPath, p.html); backing.texts.set(p.registryPath, p.registry);
    const response = await post(`/activate-composition/${PROJECT}`, { revision: 2, html: p.html, content_hash: p.row.composition.content_hash });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ activated: true, revision: 2, preview_sync_pending: false });
    const candidate = readdirSync(workDir, { withFileTypes: true }).find(entry => entry.isDirectory())!;
    expect(existsSync(join(workDir, candidate.name, 'job.json'))).toBe(false);
    const durable = JSON.parse(readFileSync(join(workDir, candidate.name, 'job-state-v1.json'), 'utf8'));
    expect(durable.publication_revision).toBe(2);
    expect(durable.publication_content_hash).toBe(p.row.composition.content_hash);
    const preview = await fetch(`${base}/preview/${PROJECT}`);
    expect(preview.status).toBe(200); expect(await preview.text()).toContain('Original');
    const old = await post(`/patch/${PROJECT}`, { patches: [{ selector: '#title', property: 'textContent', value: 'Forbidden' }] });
    expect(old.status).toBe(409);
    expect((await old.json()).error).toBe('COMPOSITION_PREPARE_REQUIRED');
    const stale = await post(`/activate-composition/${PROJECT}`, { revision: 1, html: p.html, content_hash: p.row.composition.content_hash });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ activated: false, preview_sync_pending: true, publication_changed: false });
    const unchanged = await fetch(`${base}/preview/${PROJECT}`);
    expect(await unchanged.text()).not.toContain('Forbidden');
    expect(backing.uploads).not.toHaveBeenCalled();
  });
  it('job staging reads the committed source and does not overwrite committed aliases or the live preview', async () => {
    const p = publication();
    backing.head = p.row;
    backing.texts.set(p.htmlPath, p.html); backing.texts.set(p.registryPath, p.registry);
    const jobId = '55555555-5555-4555-8555-555555555555';
    const response = await post('/job', { job_id: jobId, project_id: PROJECT, step: 'build', mode: 'preview',
      revision: 2, composition_revision: 2, composition_hash: renderCompositionHash(p.html),
      index_html: HTML.replace('Original', 'Unpublished'), options: { width: 1080, height: 1920, duration: 5, fps: 30 }, outputs: {}, artifact_paths: {} });
    expect(response.status).toBe(202);
    let status = 'queued';
    for (let attempt = 0; attempt < 50 && !['staged', 'failed'].includes(status); attempt++) {
      await new Promise(done => setTimeout(done, 10));
      const poll = await fetch(`${base}/job/${jobId}/status`, { headers: { 'X-Worker-Secret': secret } });
      status = (await poll.json()).status;
    }
    expect(status).toBe('staged');
    const staged = readFileSync(join(workDir, jobId, 'index.html'), 'utf8');
    expect(staged).toContain('Original'); expect(staged).not.toContain('Unpublished');
    expect(backing.uploads).not.toHaveBeenCalled();
    const preview = await fetch(`${base}/preview/${PROJECT}`);
    expect(await preview.text()).not.toContain('Unpublished');
  });
});
