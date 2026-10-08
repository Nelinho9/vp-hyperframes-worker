import { mkdirSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UUID_RE, confinedPath } from './job-contract.js';

export function atomicWriteJob(job) {
  mkdirSync(job.job_dir, { recursive: true, mode: 0o700 });
  const target = join(job.job_dir, 'job-state-v1.json');
  const temp = target + '.' + randomUUID() + '.tmp';
  const data = JSON.stringify({ state_version: 1, ...job }, (key, value) => key.endsWith('Promise') ? undefined : value);
  writeFileSync(temp, data, { mode: 0o600 });
  const fd = openSync(temp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, target);
  if (process.platform !== 'win32') {
    const directory = openSync(job.job_dir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

export function createJobQueue({ root, jobs, processJob, deliverCallback, concurrency = 1, capacity = 16, writeJob = atomicWriteJob }) {
  concurrency = Math.max(1, Math.min(8, Math.floor(Number(concurrency) || 1)));
  capacity = Math.max(concurrency, Math.min(128, Math.floor(Number(capacity) || 16)));
  const pending = [];
  let active = 0;
  let storageAvailable = true;
  function persist(job) {
    try { writeJob(job); return true; }
    catch { storageAvailable = false; return false; }
  }
  async function callback(job) {
    try { await deliverCallback(job); }
    catch { job.callback_status = { ok: false, error: 'CALLBACK_TRANSPORT_FAILED', at: new Date().toISOString() }; }
    persist(job);
  }
  async function execute(id) {
    let job = jobs.get(id);
    try {
      job.status = 'running'; job.started_at = new Date().toISOString();
      if (!persist(job)) return; // Never execute without a durable running transition.
      await processJob(job.payload);
    }
    catch { job = jobs.get(id); job.status = 'failed'; job.error_code = 'WORKER_PROCESS_FAILED'; job.error = 'Worker processing failed'; }
    finally {
      job = jobs.get(id); job.completed_at ||= new Date().toISOString();
      const saved = persist(job);
      try { if (saved && deliverCallback && ['done', 'failed'].includes(job.status) && !job.callback_status) await callback(job); }
      finally { active--; pump(); }
    }
  }
  function pump() { while (storageAvailable && active < concurrency && pending.length) { active++; void execute(pending.shift()); } }
  function accept(body, hash) {
    const existing = jobs.get(body.job_id);
    if (existing) return { status: existing.payload_hash === hash ? 200 : 409, job: existing };
    if (!storageAvailable) return { status: 503 };
    if (active + pending.length >= capacity) return { status: 429 };
    const job = { id: body.job_id, project_id: body.project_id, request_id: body.request_id, revision: body.revision, input_hash: body.input_hash, step: body.step, mode: body.mode, status: 'queued', created_at: new Date().toISOString(), job_dir: confinedPath(root, body.job_id), payload_hash: hash, payload: body, callback: body.callback };
    if (!persist(job)) return { status: 503 };
    jobs.set(job.id, job); pending.push(job.id); queueMicrotask(pump);
    return { status: 202, job };
  }
  function recover() {
    mkdirSync(root, { recursive: true });
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
      let job;
      try { job = JSON.parse(readFileSync(join(confinedPath(root, entry.name), 'job-state-v1.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
      if (job.state_version !== 1 || job.id !== entry.name || !UUID_RE.test(job.project_id)) throw new Error('INVALID_DURABLE_JOB');
      job.job_dir = confinedPath(root, job.id); jobs.set(job.id, job);
      // An interrupted render is terminalized once. Never silently render again on restart.
      if (job.status === 'running') { job.status = 'failed'; job.error_code = 'WORKER_RESTART_INTERRUPTED'; job.error = 'Worker restarted during execution'; if (!persist(job)) throw new Error('DURABLE_STORE_UNAVAILABLE'); }
      if (job.status === 'queued') pending.push(job.id);
      if (deliverCallback && ['done', 'failed'].includes(job.status) && !job.callback_status?.ok) queueMicrotask(() => { void callback(job); });
    }
    queueMicrotask(pump);
  }
  return { accept, recover, stats: () => ({ active, queued: pending.length, concurrency, capacity, storage_available: storageAvailable }) };
}
