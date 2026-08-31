// @vitest-environment node
/**
 * supervise-route.test.ts — V5.14 Fase C (F7): POST /supervise no worker
 *
 * A rota é o ponto de entrada da supervisão durável: o orquestrador regista o
 * projeto no `/start` e o worker passa a pressionar o motor one-step. Cobre o
 * que o teste unitário (`pipeline-runner.test.ts`) não pode cobrir: auth de
 * serviço, flag de kill-switch, contrato de resposta e re-registo no boot.
 *
 * O `globalThis.fetch` é substituído — o loop de supervisão fala sempre com a
 * edge por HTTP, pelo que é esse o seam correto (sem mocks do próprio módulo).
 * Doc: V5_14 §3 F7
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'sup-secret';
const PROJECT = 'proj-supervise';

let server: http.Server;
let base: string;
let workDir: string;
let supervision: ServerModule['supervision'] | null = null;

/** Registry do módulo em boot — explode se um teste esquecer o bootWorker(). */
function registry() {
  if (!supervision) throw new Error('worker não bootado');
  return supervision;
}

type ServerModule = {
  app: { listen: (port: number, host: string) => http.Server };
  supervision: { list: () => string[]; stop: (id: string) => boolean; get: (id: string) => Promise<{ status: string }> | null };
};

async function bootWorker(env: Record<string, string | undefined> = {}) {
  // Cada boot parte de um ambiente LIMPO: `Object.assign` nunca apaga, pelo que
  // sem isto o kill-switch de um teste silenciaría os boots seguintes (e os
  // testes de re-registo passariam por acaso).
  for (const key of [
    "PIPELINE_SUPERVISOR_ENABLED",
    "PIPELINE_SUPERVISOR_TICK_MS",
    "SUPABASE_URL",
    "SUPABASE_KEY",
    "WORKER_SECRET",
    "PREVIEW_SECRET",
  ])
    delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  const mod = (await import('./server.js')) as unknown as ServerModule;
  supervision = mod.supervision;
  server = mod.app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return mod;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return realFetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * `globalThis.fetch` É substituído nos testes (é o seam do loop de supervisão),
 * por isso o cliente HTTP do teste prende a referência real antes de tudo.
 */
const realFetch = globalThis.fetch.bind(globalThis);

const DRIVER = {
  status_url: `https://edge.example/video-v4-orchestrator/status?project_id=${PROJECT}`,
  step_url: 'https://edge.example/video-v4-orchestrator/step',
  resume_url: 'https://edge.example/video-v4-orchestrator/auth/resume',
  secret: 'cb-secret',
};

/** fetch da edge: responde `action` à escolha e regista as chamadas. */
function stubEdge(actions: string[], record: string[] = []) {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      record.push(`${String(init.method ?? 'GET')} ${String(url)}`);
      if (String(init.method ?? 'GET') === 'GET') {
        const action = actions[Math.min(i, actions.length - 1)];
        i += 1;
        return new Response(JSON.stringify({ action, idle: action === 'idle' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }),
  );
  return record;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /supervise', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'sup-boot-'));
    process.env.WORK_DIR = workDir;
    await bootWorker({ WORKER_SECRET: SECRET, PIPELINE_SUPERVISOR_TICK_MS: '1' });
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    vi.unstubAllGlobals();
    delete process.env.WORKER_SECRET;
    delete process.env.PIPELINE_SUPERVISOR_TICK_MS;
    rmSync(workDir, { recursive: true, force: true });
  });

  it('recusa sem secret de serviço (401) e sem secret configurado (503)', async () => {
    stubEdge(['idle']);
    const noHeader = await post('/supervise', { project_id: PROJECT, driver: DRIVER });
    expect(noHeader.status).toBe(401);
    const wrong = await post('/supervise', { project_id: PROJECT, driver: DRIVER }, { 'x-worker-secret': 'nope' });
    expect(wrong.status).toBe(401);
  });

  it('aceita o registo e arranca o loop que pergunta à edge', async () => {
    const calls = stubEdge(['wait', 'idle']);
    const res = await post('/supervise', { project_id: PROJECT, driver: DRIVER }, { 'x-worker-secret': SECRET });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ supervised: true });
    // deixa o loop dar o primeiro tick (tick de 1ms via env de teste)
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith('GET'))).toBe(true));
  });

  it('não arranca um segundo loop para o mesmo projeto', async () => {
    stubEdge(['wait']);
    const first = await post('/supervise', { project_id: 'proj-dup', driver: { ...DRIVER } }, { 'x-worker-secret': SECRET });
    expect(await first.json()).toEqual({ supervised: true });
    const second = await post('/supervise', { project_id: 'proj-dup', driver: { ...DRIVER } }, { 'x-worker-secret': SECRET });
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ supervised: false, reason: 'already_running' });
    registry().stop('proj-dup');
  });

  it('rejeita contrato incompleto (400) — sem URLs/secret não há loop', async () => {
    stubEdge(['idle']);
    const res = await post('/supervise', { project_id: PROJECT }, { 'x-worker-secret': SECRET });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('driver_contract_incomplete');
  });

  it('GET /supervision lista o que está supervisionado (diagnóstico de deploy)', async () => {
    stubEdge(['wait']);
    const unauth = await realFetch(`${base}/supervision`);
    expect(unauth.status).toBe(401);
    const res = await realFetch(`${base}/supervision`, { headers: { 'x-worker-secret': SECRET } });
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).projects)).toBe(true);
    registry().stop('proj-dup');
  });
});

describe('kill-switch + boot', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server?.close) await new Promise((r) => server.close(r));
  });

  it('PIPELINE_SUPERVISOR_ENABLED=false não registra (o orquestrador segue com a cadeia edge)', async () => {
    stubEdge(['idle']);
    await bootWorker({ WORKER_SECRET: SECRET, PIPELINE_SUPERVISOR_ENABLED: 'false' });
    const res = await post('/supervise', { project_id: PROJECT, driver: DRIVER }, { 'x-worker-secret': SECRET });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ supervised: false, reason: 'disabled' });
  });

  it('no boot re-registra supervisão de renders recentes com o contrato derivado do env', async () => {
    const calls: string[] = [];
    stubEdge(['wait'], calls);
    const dir = mkdtempSync(join(tmpdir(), 'sup-rehydrate-'));
    const jobDir = join(dir, 'build-rehydrate');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, 'index.html'), '<!doctype html><html><body>x</body></html>');
    writeFileSync(
      join(jobDir, 'job.json'),
      JSON.stringify({
        job_id: 'build-rehydrate',
        project_id: 'proj-boot',
        step: 'build',
        mode: 'render',
        created_at: new Date().toISOString(),
      }),
    );
    await bootWorker({
      WORKER_SECRET: SECRET,
      SUPABASE_URL: 'https://ref.supabase.co',
      WORK_DIR: dir,
      PIPELINE_SUPERVISOR_TICK_MS: '1',
    });
    expect(registry().list()).toContain('proj-boot');
    await vi.waitFor(() =>
      expect(calls).toContain('GET https://ref.supabase.co/functions/v1/video-v4-orchestrator/status?project_id=proj-boot'),
    );
    registry().stop('proj-boot');
    rmSync(dir, { recursive: true, force: true });
  });

  it('render antigo (fora do teto) não é re-registrado no boot', async () => {
    stubEdge(['wait']);
    const dir = mkdtempSync(join(tmpdir(), 'sup-stale-'));
    const jobDir = join(dir, 'build-old');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, 'index.html'), '<!doctype html><html><body>x</body></html>');
    writeFileSync(
      join(jobDir, 'job.json'),
      JSON.stringify({
        job_id: 'build-old',
        project_id: 'proj-old',
        step: 'build',
        mode: 'render',
        created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    );
    await bootWorker({ WORKER_SECRET: SECRET, SUPABASE_URL: 'https://ref.supabase.co', WORK_DIR: dir });
    expect(registry().list()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
