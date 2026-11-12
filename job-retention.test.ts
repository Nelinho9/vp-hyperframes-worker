// @vitest-environment node
/**
 * job-retention.test.ts — F3 (plano v2, emenda H1): TTL dos job dirs.
 * Só terminais expirados são podados; trabalho vivo e estado ilegível ficam.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RETENTION_TTL_DAYS, directoryBytes, pruneTerminalJobs, retentionTtlMs } from './job-retention.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const DAY = 86_400_000;
const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function seedJob(root, n, { status, completedAt, writeState = true }) {
  const dir = join(root, id(n));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html>x</html>');
  if (writeState) {
    writeFileSync(join(dir, 'job-state-v1.json'), JSON.stringify({
      state_version: 1, id: id(n), project_id: id(100 + n), status,
      completed_at: completedAt, job_dir: dir,
    }));
  }
  return dir;
}

describe('retentionTtlMs', () => {
  it('default 7 dias; override por env; 0 desliga; inválido volta ao default', () => {
    expect(retentionTtlMs({})).toBe(DEFAULT_RETENTION_TTL_DAYS * DAY);
    expect(retentionTtlMs({ JOB_RETENTION_TTL_DAYS: '3' })).toBe(3 * DAY);
    expect(retentionTtlMs({ JOB_RETENTION_TTL_DAYS: '0' })).toBe(0);
    expect(retentionTtlMs({ JOB_RETENTION_TTL_DAYS: 'abc' })).toBe(DEFAULT_RETENTION_TTL_DAYS * DAY);
    expect(retentionTtlMs({ JOB_RETENTION_TTL_DAYS: '-2' })).toBe(DEFAULT_RETENTION_TTL_DAYS * DAY);
  });
});

describe('pruneTerminalJobs', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'vp-retention-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('poda apenas terminais expirados; mantém vivos, recentes e não-UUID', () => {
    const old = new Date(NOW - 8 * DAY).toISOString();
    const recent = new Date(NOW - 1 * DAY).toISOString();
    const doneOld = seedJob(root, 1, { status: 'done', completedAt: old });
    const failedOld = seedJob(root, 2, { status: 'failed', completedAt: old });
    const runningOld = seedJob(root, 3, { status: 'running', completedAt: old });
    const queuedOld = seedJob(root, 4, { status: 'queued', completedAt: old });
    const doneRecent = seedJob(root, 5, { status: 'done', completedAt: recent });
    mkdirSync(join(root, '__vp-font-cache'), { recursive: true }); // não-UUID

    const jobs = new Map();
    const projectJobs = new Map([[id(101), id(1)], [id(103), id(3)]]);
    const result = pruneTerminalJobs({ root, jobs, projectJobs, ttlMs: 7 * DAY, now: () => NOW });

    expect(result.pruned).toBe(2);
    expect(existsSync(doneOld)).toBe(false);
    expect(existsSync(failedOld)).toBe(false);
    expect(existsSync(runningOld)).toBe(true);
    expect(existsSync(queuedOld)).toBe(true);
    expect(existsSync(doneRecent)).toBe(true);
    expect(existsSync(join(root, '__vp-font-cache'))).toBe(true);
    expect(projectJobs.has(id(101))).toBe(false); // mapping do podado removido
    expect(projectJobs.has(id(103))).toBe(true);  // vivo intacto
  });

  it('decide pelo estado durável quando o job não está em memória', () => {
    const old = new Date(NOW - 30 * DAY).toISOString();
    const dir = seedJob(root, 6, { status: 'done', completedAt: old });
    const result = pruneTerminalJobs({ root, jobs: new Map(), projectJobs: new Map(), ttlMs: 7 * DAY, now: () => NOW });
    expect(result.pruned).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('estado ilegível → mantém (fail-safe); TTL 0 desliga a poda', () => {
    const old = new Date(NOW - 30 * DAY).toISOString();
    const unreadable = seedJob(root, 7, { status: 'done', completedAt: old, writeState: false });
    const jobs = new Map();
    const r1 = pruneTerminalJobs({ root, jobs, projectJobs: new Map(), ttlMs: 7 * DAY, now: () => NOW });
    expect(r1.pruned).toBe(0);
    expect(existsSync(unreadable)).toBe(true);
    const r2 = pruneTerminalJobs({ root, jobs, projectJobs: new Map(), ttlMs: 0, now: () => NOW });
    expect(r2).toEqual({ pruned: 0, kept: 0, errors: 0 });
  });

  it('jobs em memória têm precedência sobre o estado em disco', () => {
    const old = new Date(NOW - 30 * DAY).toISOString();
    const dir = seedJob(root, 8, { status: 'done', completedAt: old });
    // Em memória está running (reidratação incompleta) → NÃO podar.
    const jobs = new Map([[id(8), { status: 'running' }]]);
    const result = pruneTerminalJobs({ root, jobs, projectJobs: new Map(), ttlMs: 7 * DAY, now: () => NOW });
    expect(result.pruned).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('directoryBytes', () => {
  it('soma ficheiros recursivamente e tolera dirs inexistentes', () => {
    const root = mkdtempSync(join(tmpdir(), 'vp-bytes-'));
    try {
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'a.bin'), Buffer.alloc(100));
      writeFileSync(join(root, 'sub', 'b.bin'), Buffer.alloc(50));
      expect(directoryBytes(root)).toBe(150);
      expect(directoryBytes(join(root, 'missing'))).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});