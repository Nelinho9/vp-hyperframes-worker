// Zero-provider HTTP fixture for process restart, callback and queue acceptance.
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createJobQueue } from '../job-queue.js';
import { parseRenderJob, publicJob } from '../job-contract.js';
const jobs = new Map();
const queue = createJobQueue({ root: process.env.WORK_DIR, jobs, concurrency: 1, capacity: 2,
  processJob: async body => {
    appendFileSync(join(process.env.WORK_DIR, 'executions.txt'), body.job_id + '\n');
    await new Promise(resolve => setTimeout(resolve, Number(process.env.FIXTURE_DELAY_MS || 100)));
    const job = jobs.get(body.job_id); job.status = 'done'; job.uploaded = { mp4: 'fixture/result.mp4' };
  },
  deliverCallback: async job => {
    if (!process.env.FIXTURE_CALLBACK_URL) return;
    const response = await fetch(process.env.FIXTURE_CALLBACK_URL, { method: 'POST', body: JSON.stringify({ job_id: job.id, status: job.status, revision: job.revision, input_hash: job.input_hash }) });
    job.callback_status = { ok: response.ok, status: response.status };
  },
});
queue.recover();
const server = http.createServer(async (req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'POST') {
    let text = ''; for await (const chunk of req) text += chunk;
    try {
      const { body, hash } = parseRenderJob(JSON.parse(text), 'fixture-dispatch');
      const result = queue.accept(body, hash); json(result.status, result.job ? publicJob(result.job) : { error: 'JOB_QUEUE_FULL' });
    } catch (error) { json(400, { error: error.message }); }
  } else if (req.url === '/stats') json(200, queue.stats());
  else { const job = jobs.get(req.url.slice(1)); json(job ? 200 : 404, job ? publicJob(job) : {}); }
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'));
