// @vitest-environment node
/**
 * job-pools.test.ts — F2/F3 (plano v2, emenda B): pools llm/render.
 * Geração (I/O-bound) não fica atrás de renders (CPU-bound); capacity por
 * pool; recover encaminha pelo mode; legacy sem pools intacto.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobQueue } from './job-queue.js';

const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const flush = () => new Promise((r) => setTimeout(r, 15));

function body(n, mode) {
  return { job_id: id(n), project_id: id(100 + n), step: mode === 'render' ? 'build' : 'build', mode, revision: 1, inputs: {} };
}

/** processJob controlável: cada job fica running até ser libertado. */
function controlled() {
  const gates = new Map();
  const started = [];
  const processJob = (payload) => {
    started.push(payload.job_id);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    gates.set(payload.job_id, resolve);
    return promise;
  };
  const release = async (n) => { gates.get(id(n))?.(); await flush(); };
  return { processJob, started, release };
}

describe('createJobQueue — pools llm/render', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vp-pools-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('llm corre em paralelo enquanto o render está bloqueado (sem head-of-line)', async () => {
    const { processJob, started, release } = controlled();
    const jobs = new Map();
    const queue = createJobQueue({
      root, jobs, processJob,
      pools: { llm: { concurrency: 2, capacity: 8 }, render: { concurrency: 1, capacity: 4 } },
    });
    expect(queue.accept(body(1, 'render'), 'h1').status).toBe(202);
    await flush();
    expect(queue.accept(body(2, 'build-html'), 'h2').status).toBe(202);
    expect(queue.accept(body(3, 'llm-step'), 'h3').status).toBe(202);
    await flush();
    // render 1 activo; llm 2 activos em paralelo (concurrency 2).
    expect(started.sort()).toEqual([id(1), id(2), id(3)].sort());
    const stats = queue.stats();
    expect(stats.pools.render.active).toBe(1);
    expect(stats.pools.llm.active).toBe(2);
    expect(stats.active).toBe(3);
    await release(1); await release(2); await release(3);
    expect(queue.stats().active).toBe(0);
  });

  it('capacity é por pool: llm cheio não bloqueia render', async () => {
    const { processJob, release } = controlled();
    const jobs = new Map();
    const queue = createJobQueue({
      root, jobs, processJob,
      pools: { llm: { concurrency: 1, capacity: 1 }, render: { concurrency: 1, capacity: 2 } },
    });
    expect(queue.accept(body(1, 'build-html'), 'h1').status).toBe(202);
    await flush();
    // llm pool cheio (1 activo, capacity 1) → 429.
    expect(queue.accept(body(2, 'build-html'), 'h2').status).toBe(429);
    // render pool independente → aceita.
    expect(queue.accept(body(3, 'render'), 'h3').status).toBe(202);
    await release(1);
    // llm libertou → já aceita outro.
    expect(queue.accept(body(4, 'build-html'), 'h4').status).toBe(202);
    await release(3); await release(4);
  });

  it('recover encaminha jobs queued pelo mode e terminaliza running', async () => {
    // Seed durável: 1 render queued, 1 build-html queued, 1 llm running.
    for (const [n, mode, status] of [[1, 'render', 'queued'], [2, 'build-html', 'queued'], [3, 'llm-step', 'running']]) {
      const dir = join(root, id(n));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'job-state-v1.json'), JSON.stringify({
        state_version: 1, id: id(n), project_id: id(100 + n), status, mode, step: 'build',
        job_dir: dir, payload: body(n, mode), created_at: new Date().toISOString(),
      }));
    }
    const { processJob, started, release } = controlled();
    const jobs = new Map();
    const queue = createJobQueue({
      root, jobs, processJob,
      pools: { llm: { concurrency: 2, capacity: 8 }, render: { concurrency: 1, capacity: 4 } },
    });
    queue.recover();
    await flush();
    expect(jobs.get(id(3)).status).toBe('failed'); // running → WORKER_RESTART_INTERRUPTED
    expect(jobs.get(id(3)).error_code).toBe('WORKER_RESTART_INTERRUPTED');
    expect(started.sort()).toEqual([id(1), id(2)].sort()); // queued arrancam nos pools certos
    expect(queue.stats().pools.render.active).toBe(1);
    expect(queue.stats().pools.llm.active).toBe(1);
    await release(1); await release(2);
  });

  it('sem pools: comportamento legacy (fila única, capacity partilhada)', async () => {
    const { processJob } = controlled();
    const jobs = new Map();
    const queue = createJobQueue({ root, jobs, processJob, concurrency: 1, capacity: 1 });
    expect(queue.accept(body(1, 'render'), 'h1').status).toBe(202);
    await flush();
    expect(queue.accept(body(2, 'build-html'), 'h2').status).toBe(429); // capacity 1 partilhada
    const stats = queue.stats();
    expect(stats.pools).toBeUndefined();
    expect(stats.active).toBe(1);
    expect(stats.concurrency).toBe(1);
  });
});