// Legacy preview tests now submit authenticated UUID jobs and await durable staging.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.WORKER_SECRET ||= 'test-worker-secret';
process.env.WORK_DIR = mkdtempSync(join(tmpdir(), 'worker-http-f01-'));
export function fixtureId(value: string) {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
export async function fixtureFetch(url: string, init?: RequestInit) {
  if (url.endsWith('/job') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)); body.step ||= 'preview';
    init = { ...init, headers: { ...init.headers, 'X-Worker-Secret': process.env.WORKER_SECRET || 'test-worker-secret' }, body: JSON.stringify(body) };
    const response = await globalThis.fetch(url, init);
    if (response.ok) {
      for (let i = 0; i < 200; i++) {
        const status = await globalThis.fetch(`${url}/${body.job_id}/status`, { headers: { 'X-Worker-Secret': process.env.WORKER_SECRET || 'test-worker-secret' } });
        if (status.ok && !['queued', 'running'].includes((await status.json()).status)) return response;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('Fixture staging did not finish');
    }
    return response;
  }
  return globalThis.fetch(url, init);
}
