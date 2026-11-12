// @vitest-environment node
/**
 * build-html-job.test.ts — F1 (plano Video-Engine v2), gate da emenda C:
 * o job build-html vive na fila durável SEM credenciais LLM em repouso, e o
 * secret de transporte do callback é redigido do estado persistido após
 * entrega bem-sucedida. Cobre também o contrato (parseRenderJob) e a redação
 * pública do build_result (publicJob).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobQueue } from './job-queue.js';
import { logicalInputHash, parseRenderJob, publicJob } from './job-contract.js';
import { retryTerminalCallback } from './server.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const NONCE = '44444444-4444-4444-8444-444444444444';
const CALLBACK_SECRET = 'cb-transport-secret';
const LLM_KEY = 'test-llm-key-123';
const CREDS_URL = 'https://orch.example/functions/v1/video-v4-orchestrator/build-credentials';

function buildHtmlPayload() {
  const body: Record<string, unknown> = {
    contract_version: 1,
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    request_id: REQUEST_ID,
    revision: 1,
    step: 'build',
    mode: 'build-html',
    inputs: { credentials_url: CREDS_URL, brief: 'brief', aspect_ratio: '9:16' },
    options: {},
    artifact_paths: {},
    callback: {
      url: 'https://orch.example/functions/v1/video-v4-orchestrator/callback',
      secret: CALLBACK_SECRET,
      nonce: NONCE,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
  };
  body.input_hash = logicalInputHash(body);
  return body;
}

// ─── Contrato ──────────────────────────────────────────────────────────────

describe('parseRenderJob — modo build-html', () => {
  it('aceita um job build-html válido (sem HTML, com credentials_url https)', () => {
    const { body } = parseRenderJob(buildHtmlPayload(), 'worker-secret');
    expect(body.mode).toBe('build-html');
    expect(body.inputs.credentials_url).toBe(CREDS_URL);
  });

  it('recusa credentials_url ausente/não-https, HTML inline e step errado', () => {
    const noUrl = buildHtmlPayload();
    delete (noUrl.inputs as Record<string, unknown>).credentials_url;
    noUrl.input_hash = logicalInputHash(noUrl);
    expect(() => parseRenderJob(noUrl, 'worker-secret')).toThrow('INVALID_CREDENTIALS_URL');

    const httpUrl = buildHtmlPayload();
    (httpUrl.inputs as Record<string, unknown>).credentials_url = 'http://orch.example/x';
    httpUrl.input_hash = logicalInputHash(httpUrl);
    expect(() => parseRenderJob(httpUrl, 'worker-secret')).toThrow('INVALID_CREDENTIALS_URL');

    const withHtml = buildHtmlPayload();
    (withHtml.inputs as Record<string, unknown>).index_html = '<div>x</div>';
    withHtml.input_hash = logicalInputHash(withHtml);
    expect(() => parseRenderJob(withHtml, 'worker-secret')).toThrow('INVALID_BUILD_INPUTS');

    const wrongStep = buildHtmlPayload();
    wrongStep.step = 'finalize';
    wrongStep.input_hash = logicalInputHash(wrongStep);
    expect(() => parseRenderJob(wrongStep, 'worker-secret')).toThrow('INVALID_STEP_MODE');
  });
});

// ─── Fila durável: sem credenciais em repouso (emenda C) ──────────────────

describe('fila durável build-html — gate de secrets em repouso', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vp-build-html-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('job-state nunca contém a key LLM; callback.secret redigido após entrega ok', async () => {
    // Seam DI do postCallback (fetchImpl custom → legacy path do bounded fetch).
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const transport = { fetchImpl, sleep: async () => {}, baseDelayMs: 1 };

    const jobs = new Map();
    const delivered: Array<Record<string, unknown>> = [];
    const queue = createJobQueue({
      root,
      jobs,
      concurrency: 1,
      processJob: async (payload: Record<string, unknown>) => {
        // Espelha o stageBuildHtmlJob: resultado público, sem credenciais.
        const job = jobs.get(payload.job_id);
        job.status = 'done';
        job.build_result = {
          ok: true,
          html_path: `projects/${PROJECT_ID}/compositions/build-input.html`,
          sha256: 'a'.repeat(64),
          retries: 1,
          tokens: { input: 10, output: 20 },
          duration_seconds: 15,
          fallback: false,
        };
        job.callback_payload = {
          job_id: job.id, project_id: job.project_id, step: job.step,
          request_id: job.request_id, revision: job.revision, input_hash: job.input_hash,
          callback_nonce: job.callback?.nonce, status: 'done',
          build_result: job.build_result,
        };
      },
      deliverCallback: async (job: { callback_payload?: Record<string, unknown> }) => {
        delivered.push(job.callback_payload ?? {});
        await retryTerminalCallback(job as never, transport);
      },
    });

    const payload = buildHtmlPayload();
    const accepted = queue.accept(payload, logicalInputHash(payload));
    expect(accepted.status).toBe(202);
    // Deixa a fila drenar (execute é assíncrono).
    await new Promise((r) => setTimeout(r, 50));

    const statePath = join(root, JOB_ID, 'job-state-v1.json');
    const onDisk = readFileSync(statePath, 'utf8');
    expect(onDisk).not.toContain(LLM_KEY);
    expect(onDisk).not.toContain(CALLBACK_SECRET);
    expect(onDisk).toContain('[redacted]');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].build_result).toMatchObject({ retries: 1, fallback: false });
    // O payload entregue no callback também não leva o secret.
    expect(JSON.stringify(delivered[0])).not.toContain(CALLBACK_SECRET);
  });

  it('entrega falhada mantém o secret para retry (rehydrate), sem o expor no status', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const job = {
      id: JOB_ID, project_id: PROJECT_ID, step: 'build', status: 'done',
      job_dir: join(root, JOB_ID),
      request_id: REQUEST_ID, revision: 1, input_hash: 'b'.repeat(64),
      payload: buildHtmlPayload(),
      callback: { url: 'https://orch.example/callback', secret: CALLBACK_SECRET, nonce: NONCE },
      callback_payload: { job_id: JOB_ID, status: 'done' },
    };
    await retryTerminalCallback(job as never, { fetchImpl, sleep: async () => {}, baseDelayMs: 1 });
    expect(job.callback_status?.ok).toBe(false);
    // Secret preservado para o retry — mas o estado público nunca o expõe.
    expect((job.payload as Record<string, any>).callback.secret).toBe(CALLBACK_SECRET);
    const pub = publicJob(job as never);
    expect(JSON.stringify(pub)).not.toContain(CALLBACK_SECRET);
  });
});

// ─── Redação pública do build_result ───────────────────────────────────────

describe('publicJob — build_result allowlist', () => {
  it('expõe path/sha/telemetria e NUNCA campos fora da allowlist', () => {
    const job = {
      id: JOB_ID, project_id: PROJECT_ID, step: 'build', mode: 'build-html', status: 'done',
      build_result: {
        ok: true,
        html_path: `projects/${PROJECT_ID}/compositions/build-input.html`,
        sha256: 'c'.repeat(64),
        retries: 2,
        duration_seconds: 15,
        fallback: true,
        fallback_reason: 'BUILD_LINT_FAILED',
        tokens: { input: 1, output: 2 },
        api_key: LLM_KEY,
        credentials: { url: CREDS_URL },
      },
    };
    const pub = publicJob(job as never) as Record<string, any>;
    expect(pub.build_result).toMatchObject({ retries: 2, fallback: true, tokens: { input: 1, output: 2 } });
    expect(pub.build_result.html_path).toContain('build-input.html');
    expect(JSON.stringify(pub)).not.toContain(LLM_KEY);
    expect(pub.build_result.api_key).toBeUndefined();
    expect(pub.build_result.credentials).toBeUndefined();
  });
});