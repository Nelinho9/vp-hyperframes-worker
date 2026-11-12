// @vitest-environment node
/**
 * llm-step-job.test.ts — F2 (plano Video-Engine v2): contrato do job
 * llm-step (allowlist de steps/inputs), routing para a pool `llm` (emenda B),
 * gate de secrets em repouso (emenda C) e redação pública do step_result.
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

function llmStepPayload(step = 'design') {
  const body: Record<string, unknown> = {
    contract_version: 1,
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    request_id: REQUEST_ID,
    revision: 1,
    step,
    mode: 'llm-step',
    inputs: { credentials_url: CREDS_URL, step },
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

describe('parseRenderJob — modo llm-step', () => {
  it('aceita design/storyboard/visual sem HTML, com credentials_url https', () => {
    for (const step of ['design', 'storyboard', 'visual']) {
      const { body } = parseRenderJob(llmStepPayload(step), 'worker-secret');
      expect(body.mode).toBe('llm-step');
      expect(body.step).toBe(step);
    }
  });

  it('recusa steps não portados (audio/quality/build) no modo llm-step', () => {
    for (const step of ['audio', 'quality', 'build']) {
      expect(() => parseRenderJob(llmStepPayload(step), 'worker-secret')).toThrow('INVALID_STEP_MODE');
    }
  });

  it('recusa inputs fora da allowlist (smuggle de keys/HTML), step divergente e URL não-https', () => {
    const smuggle = llmStepPayload();
    (smuggle.inputs as Record<string, unknown>).api_key = LLM_KEY;
    smuggle.input_hash = logicalInputHash(smuggle);
    expect(() => parseRenderJob(smuggle, 'worker-secret')).toThrow('INVALID_LLM_STEP_INPUTS');

    const withHtml = llmStepPayload();
    (withHtml.inputs as Record<string, unknown>).index_html = '<div>x</div>';
    withHtml.input_hash = logicalInputHash(withHtml);
    expect(() => parseRenderJob(withHtml, 'worker-secret')).toThrow('INVALID_LLM_STEP_INPUTS');

    const divergent = llmStepPayload();
    (divergent.inputs as Record<string, unknown>).step = 'visual';
    divergent.input_hash = logicalInputHash(divergent);
    expect(() => parseRenderJob(divergent, 'worker-secret')).toThrow('INVALID_LLM_STEP_INPUTS');

    const httpUrl = llmStepPayload();
    (httpUrl.inputs as Record<string, unknown>).credentials_url = 'http://orch.example/x';
    httpUrl.input_hash = logicalInputHash(httpUrl);
    expect(() => parseRenderJob(httpUrl, 'worker-secret')).toThrow('INVALID_CREDENTIALS_URL');
  });
});

describe('fila durável llm-step — pool llm + secrets em repouso', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vp-llm-step-test-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('routing para a pool llm; job-state sem key LLM; callback.secret redigido após entrega ok', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const transport = { fetchImpl, sleep: async () => {}, baseDelayMs: 1 };
    const jobs = new Map();
    const delivered: Array<Record<string, unknown>> = [];
    const queue = createJobQueue({
      root,
      jobs,
      pools: {
        llm: { concurrency: 2, capacity: 8 },
        render: { concurrency: 1, capacity: 4 },
      },
      processJob: async (payload: Record<string, unknown>) => {
        const job = jobs.get(payload.job_id);
        job.status = 'done';
        job.step_result = {
          artifacts: [`projects/${PROJECT_ID}/frame.md`],
          tokens: { input: 10, output: 20 },
          duration_seconds: 12,
        };
        job.callback_payload = {
          job_id: job.id, project_id: job.project_id, step: job.step,
          request_id: job.request_id, revision: job.revision, input_hash: job.input_hash,
          callback_nonce: job.callback?.nonce, status: 'done',
          step_result: job.step_result,
        };
      },
      deliverCallback: async (job: { callback_payload?: Record<string, unknown> }) => {
        delivered.push(job.callback_payload ?? {});
        await retryTerminalCallback(job as never, transport);
      },
    });

    const payload = llmStepPayload();
    const accepted = queue.accept(payload, logicalInputHash(payload));
    expect(accepted.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));

    // Pool llm processou o job (render ficou intacta).
    const stats = queue.stats() as { pools: Record<string, { processed?: number; completed?: number }> };
    expect(JSON.stringify(stats.pools.llm)).not.toBe('{}');

    const onDisk = readFileSync(join(root, JOB_ID, 'job-state-v1.json'), 'utf8');
    expect(onDisk).not.toContain(LLM_KEY);
    expect(onDisk).not.toContain(CALLBACK_SECRET);
    expect(onDisk).toContain('[redacted]');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].step_result).toMatchObject({ tokens: { input: 10, output: 20 } });
    expect(JSON.stringify(delivered[0])).not.toContain(CALLBACK_SECRET);
  });
});

describe('publicJob — step_result allowlist', () => {
  it('expõe artifacts/tokens/duração e NUNCA campos fora da allowlist', () => {
    const job = {
      id: JOB_ID, project_id: PROJECT_ID, step: 'design', mode: 'llm-step', status: 'done',
      step_result: {
        artifacts: [`projects/${PROJECT_ID}/frame.md`, '../../etc/passwd'],
        tokens: { input: 1, output: 2 },
        duration_seconds: 12,
        api_key: LLM_KEY,
        raw_llm_output: 'conteúdo cru',
      },
    };
    const pub = publicJob(job as never) as Record<string, any>;
    expect(pub.step_result.artifacts).toEqual([`projects/${PROJECT_ID}/frame.md`]);
    expect(pub.step_result.tokens).toEqual({ input: 1, output: 2 });
    expect(pub.step_result.duration_seconds).toBe(12);
    expect(JSON.stringify(pub)).not.toContain(LLM_KEY);
    expect(pub.step_result.api_key).toBeUndefined();
    expect(pub.step_result.raw_llm_output).toBeUndefined();
  });
});