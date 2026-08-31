// @vitest-environment node
/**
 * pipeline-runner.test.ts — V5.14 Fase C (F7): worker como supervisor durável
 *
 * O worker do Coolify é o único processo neste sistema sem teto de wall-clock,
 * por isso é o lugar natural para apertar o botão do motor one-step (F1) a cada
 * 15-60s. A máquina de estados continua no orquestrador (P13): o loop só lê
 * `{ idle, action }` do `GET /status` e executa a ação indicada — não interpreta
 * o manifesto nem sabe o que é um step.
 *
 * Aqui `fetch` e `sleep` são injetados, pelo que nenhum teste espera segundos
 * reais; o script de respostas é o contrato HTTP da edge.
 * Doc: docs/video-engine/V5_14_PLANO_FLUIDEZ_PIPELINE_WORKER_DRIVER.md §3 F7
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CONSECUTIVE_ERRORS,
  TICK_MAX_MS,
  TICK_MIN_MS,
  createSupervisionRegistry,
  normalizeDriver,
  runSupervisor,
  startSupervision,
  supervisorEnabled,
} from './pipeline-runner.js';

const PROJECT = 'proj-f7';

const DRIVER = {
  status_url: `https://edge.example/video-v4-orchestrator/status?project_id=${PROJECT}`,
  step_url: 'https://edge.example/video-v4-orchestrator/step',
  resume_url: 'https://edge.example/video-v4-orchestrator/resume',
  secret: 'cb-secret',
};

/**
 * fetch falso guiado por um script: `statuses` é a fila de respostas do
 * `GET /status` e `press` a resposta dos `POST` (por omissão 202 aceite).
 * Regista tudo o que foi chamado para as asserções de comportamento.
 */
function makeFetch(
  statuses: Array<{ action?: string; idle?: boolean } | { fail: true }>,
  opts: { press?: (url: string, body: unknown) => { status: number; body?: unknown } } = {},
) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), method, body, headers: (init.headers ?? {}) as Record<string, string> });
    if (method === 'GET') {
      const next = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      if (next && 'fail' in next) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => next };
    }
    const pressed = opts.press?.(String(url), body) ?? { status: 202 };
    return { ok: pressed.status < 400, status: pressed.status, json: async () => pressed.body ?? { ok: true } };
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls, statusCalls: () => i };
}

function makeSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

async function run(statuses: Parameters<typeof makeFetch>[0], opts: Parameters<typeof makeFetch>[1] = {}) {
  const { fetchImpl, calls } = makeFetch(statuses, opts);
  const { sleep, delays } = makeSleep();
  const outcome = await runSupervisor({ fetchImpl, sleep, log: () => {} }, PROJECT, DRIVER);
  return { outcome, calls, delays };
}

describe('runSupervisor — segue a ação que o orquestrador indica', () => {
  it('pressiona /step enquanto há trabalho e sai quando o status diz idle', async () => {
    const { outcome, calls, delays } = await run([{ action: 'step' }, { action: 'step' }, { action: 'idle' }]);
    expect(outcome.status).toBe('idle');
    const steps = calls.filter((c) => c.url === DRIVER.step_url);
    expect(steps).toHaveLength(2);
    expect(steps[0].body).toEqual({ project_id: PROJECT });
    // auth de serviço em ambas as chamadas (lê e escreve sem credenciais de utilizador)
    expect(calls[0].headers['x-worker-secret']).toBe('cb-secret');
    expect(delays).toHaveLength(2);
  });

  it('action=resume usa o /resume (órfão), nunca o /step', async () => {
    const { outcome, calls } = await run([{ action: 'resume' }, { action: 'idle' }]);
    expect(outcome.status).toBe('idle');
    expect(calls.filter((c) => c.url === DRIVER.resume_url)).toHaveLength(1);
    expect(calls.filter((c) => c.url === DRIVER.step_url)).toHaveLength(0);
  });

  it('action=wait não aperta botão nenhum (trabalho vivo noutro processo)', async () => {
    const { calls } = await run([{ action: 'wait' }, { action: 'wait' }, { action: 'idle' }]);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(3);
  });

  it('usa o idle como fallback quando o status não traz action (edge antiga)', async () => {
    const { outcome, calls } = await run([{ idle: false }, { idle: true }]);
    expect(outcome.status).toBe('idle');
    expect(calls.filter((c) => c.url === DRIVER.step_url)).toHaveLength(1);
  });

  it('409 PIPELINE_CLAIMED é normal: continua sem contar como erro', async () => {
    const { fetchImpl, calls } = makeFetch([{ action: 'step' }, { action: 'step' }, { action: 'idle' }], {
      press: (url, body) =>
        body && url === DRIVER.step_url
          ? { status: 409, body: { error: 'PIPELINE_CLAIMED' } }
          : { status: 202 },
    });
    const { sleep } = makeSleep();
    const outcome = await runSupervisor({ fetchImpl, sleep, log: () => {} }, PROJECT, DRIVER);
    expect(outcome.status).toBe('idle');
    expect(calls.filter((c) => c.url === DRIVER.step_url)).toHaveLength(2);
    expect(outcome.presses[0]).toMatchObject({ action: 'step', claimed: true });
  });

  it('backoff cresce 15s→30s→60s e fica capped', async () => {
    const { delays } = await run([{ action: 'wait' }, { action: 'wait' }, { action: 'wait' }, { action: 'wait' }, { action: 'idle' }]);
    expect(delays).toEqual([TICK_MIN_MS, TICK_MIN_MS * 2, TICK_MAX_MS, TICK_MAX_MS]);
    expect(TICK_MIN_MS).toBe(15_000);
    expect(TICK_MAX_MS).toBe(60_000);
  });

  it('um passo aceite (202) repõe o ritmo rápido — o supervisor não adormece enquanto avança', async () => {
    const { delays } = await run([{ action: 'wait' }, { action: 'wait' }, { action: 'step' }, { action: 'step' }, { action: 'idle' }]);
    // 15s, 30s (waits), depois /step aceite → volta a 15s
    expect(delays).toEqual([TICK_MIN_MS, TICK_MIN_MS * 2, TICK_MIN_MS, TICK_MIN_MS]);
  });

  it('desistências do status: erros consecutivos param o loop (nunca pendura)', async () => {
    const { outcome, calls } = await run(new Array(MAX_CONSECUTIVE_ERRORS).fill({ fail: true } as never));
    expect(outcome.status).toBe('error');
    expect(outcome.ticks).toBe(MAX_CONSECUTIVE_ERRORS);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('um tick é sempre delimitado — loop termina no teto de ticks', async () => {
    const { fetchImpl, sleep } = makeFetch([{ action: 'wait' }]);
    const sleeps: number[] = [];
    const outcome = await runSupervisor(
      { fetchImpl, sleep: (ms: number) => { sleeps.push(ms); return Promise.resolve(); }, log: () => {} },
      PROJECT,
      DRIVER,
      { maxTicks: 3 },
    );
    expect(outcome.status).toBe('timeout');
    expect(outcome.ticks).toBe(3);
    expect(sleeps).toHaveLength(3);
  });
});

describe('normalizeDriver — contrato entregue pelo orquestrador, fallback de boot', () => {
  it('aceita o driver enviado pelo /supervise', () => {
    const res = normalizeDriver({ project_id: PROJECT, driver: DRIVER }, {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.driver).toEqual(DRIVER);
  });

  it('recusa sem segredo ou sem URLs (não arranca loop cego)', () => {
    expect(normalizeDriver({ project_id: PROJECT }, {}).ok).toBe(false);
    expect(normalizeDriver({ driver: { ...DRIVER, secret: '' } }, {}).ok).toBe(false);
    expect(normalizeDriver({ driver: { ...DRIVER, step_url: '' } }, {}).ok).toBe(false);
  });

  it('reconstrói a partir do env no boot (SUPABASE_URL + WORKER_SECRET já existentes)', () => {
    const res = normalizeDriver(
      null,
      {
        SUPABASE_URL: 'https://projref.supabase.co',
        WORKER_SECRET: 'cb-secret',
      },
      'rehydrated',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.driver.status_url).toBe('https://projref.supabase.co/functions/v1/video-v4-orchestrator/status?project_id=rehydrated');
    expect(res.driver.step_url).toBe('https://projref.supabase.co/functions/v1/video-v4-orchestrator/step');
    expect(res.driver.resume_url).toBe('https://projref.supabase.co/functions/v1/video-v4-orchestrator/resume');
  });

  it('sem env nem corpo → não ok (o watchdog é a última linha)', () => {
    expect(normalizeDriver(null, {}).ok).toBe(false);
    expect(normalizeDriver(null, { SUPABASE_URL: 'https://x.supabase.co' }).ok).toBe(false);
  });
});

describe('registry + flag — um supervisor por projeto, desligável sem redeploy', () => {
  it('não arranca um segundo loop para o mesmo projeto', async () => {
    const { fetchImpl } = makeFetch([{ action: 'wait' }, { action: 'idle' }]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = { fetchImpl, sleep: () => gate, log: () => {} };
    const registry = createSupervisionRegistry();

    const first = startSupervision(registry, deps, PROJECT, DRIVER);
    expect(first).toEqual({ started: true });
    const second = startSupervision(registry, deps, PROJECT, DRIVER);
    expect(second.started).toBe(false);
    expect(second.reason).toBe('already_running');
    expect(registry.list()).toEqual([PROJECT]);

    release();
    await registry.get(PROJECT);
    expect(registry.list()).toEqual([]);
    // terminal libertou o slot → um novo /supervise volta a poder arrancar
    expect(startSupervision(registry, deps, PROJECT, DRIVER).started).toBe(true);
    release();
  });

  it('stop termina o loop do projeto', async () => {
    const { fetchImpl } = makeFetch([{ action: 'wait' }]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const registry = createSupervisionRegistry();
    startSupervision(registry, { fetchImpl, sleep: () => gate, log: () => {} }, PROJECT, DRIVER);
    registry.stop(PROJECT);
    release();
    const outcome = await registry.get(PROJECT);
    expect(outcome?.status).toBe('stopped');
    expect(registry.list()).toEqual([]);
  });

  it('PIPELINE_SUPERVISOR_ENABLED: ligado por omissão, desliga com false/0/off', () => {
    expect(supervisorEnabled({})).toBe(true);
    expect(supervisorEnabled({ PIPELINE_SUPERVISOR_ENABLED: 'true' })).toBe(true);
    expect(supervisorEnabled({ PIPELINE_SUPERVISOR_ENABLED: 'false' })).toBe(false);
    expect(supervisorEnabled({ PIPELINE_SUPERVISOR_ENABLED: '0' })).toBe(false);
    expect(supervisorEnabled({ PIPELINE_SUPERVISOR_ENABLED: ' off ' })).toBe(false);
  });
});
