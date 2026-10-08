// Disposable, zero-provider qualification of the actual Docker worker HTTP/render path.
// Run mounted into /evidence, with /tmp/hyperframes-worker on a fresh named volume.
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logicalInputHash } from '/app/job-contract.js';

const root = '/tmp/hyperframes-worker';
const privateDir = join(root, 'fixture-private');
const runId = process.env.F01_MEDIA_RUN_ID || 'v534-f01-local-media-2026-10-08-r01';
assert.match(runId, /^[a-zA-Z0-9-]+$/);
const output = join('/evidence/media', runId);
const jobId = '10000000-0000-4000-a000-000000000061';
const projectId = '20000000-0000-4000-a000-000000000061';
const dispatchSecret = 'F01_SYNTHETIC_DISPATCH_ONLY';
const callbackSecret = 'F01_SYNTHETIC_CALLBACK_ONLY';
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
mkdirSync(output, { recursive: true });
const cert = join(privateDir, 'ca.pem'); const key = join(privateDir, 'key.pem');

if (process.argv.includes('--server')) {
  const https = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    if (req.method === 'PUT' && req.url === '/upload') writeFileSync(join(privateDir, 'uploaded.mp4'), body);
    else if (req.method === 'POST' && req.url === '/callback') {
      if (req.headers['x-worker-secret'] !== callbackSecret) { res.writeHead(401); res.end(); return; }
      const payload = JSON.parse(body);
      assert.equal(payload.job_id, jobId); assert.equal(payload.project_id, projectId);
      writeFileSync(join(privateDir, 'callback.json'), JSON.stringify(payload));
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end('{}');
  });
  await new Promise(resolve => https.listen(8443, '127.0.0.1', resolve));
  const { app } = await import('/app/server.js');
  app.listen(8787, '127.0.0.1', () => console.log('F01_FIXTURE_READY'));
} else {
  assert.equal(existsSync(join(output, 'result.json')), false, 'Use a new F01_MEDIA_RUN_ID to preserve previous evidence');
  if (!existsSync(cert)) {
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    assert.equal(generated.status, 0, 'Local test CA generation failed');
  }
  const env = { ...process.env, WORKER_SECRET: dispatchSecret, PREVIEW_SECRET: 'F01_SYNTHETIC_PREVIEW_ONLY', PIPELINE_SUPERVISOR_ENABLED: 'false', NODE_EXTRA_CA_CERTS: cert, HYPERFRAMES_RUN_ID: runId };
  delete env.SUPABASE_URL; delete env.SUPABASE_KEY; delete env.SUPABASE_SERVICE_ROLE_KEY;
  let child;
  let logs = '';
  async function start() {
    child = spawn(process.execPath, [import.meta.filename, '--server'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Worker fixture exited ${child.exitCode}`);
      try { if ((await fetch('http://127.0.0.1:8787/health')).ok) return; } catch { /* boot pending */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Fixture boot timeout');
  }
  async function stop() { if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } }
  const headers = { 'content-type': 'application/json', 'x-worker-secret': dispatchSecret };
  const base = 'http://127.0.0.1:8787';
  const html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=640,height=360"><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><style>*{box-sizing:border-box}html,body{margin:0;width:640px;height:360px;overflow:hidden}#root{position:relative;width:640px;height:360px;overflow:hidden}.clip{position:absolute;inset:0}.fill{position:absolute;inset:0;background:#101828}#box{position:absolute;left:220px;top:100px;width:200px;height:160px;background:#60a5fa;border-radius:24px}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-width="640" data-height="360" data-duration="2"><section id="scene-1" class="clip" data-start="0" data-duration="2" data-track-index="1"><div class="fill"></div><div id="box"></div></section></div><script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});tl.fromTo('#box',{x:-60,opacity:0},{x:0,opacity:1,duration:0.5,ease:'power2.out'},0);window.__timelines.main=tl;</script></body></html>`;
  const body = { contract_version: 1, job_id: jobId, project_id: projectId, request_id: jobId, revision: 1, step: 'build', mode: 'render', inputs: { index_html: html }, options: { quality: 'high', fps: 30, format: 'mp4' }, artifact_paths: { mp4: `projects/${projectId}/renders/output.mp4`, contact_sheet: null }, outputs: { mp4_upload_url: 'https://127.0.0.1:8443/upload' }, callback: { url: 'https://127.0.0.1:8443/callback', secret: callbackSecret, nonce: '30000000-0000-4000-a000-000000000061', expires_at: '2099-10-08T00:00:00.000Z' } };
  body.input_hash = logicalInputHash(body);
  const result = { run_id: runId, provider_budget_eur: 0, cli_pin: '0.7.109', outcome: 'RUNNING' };
  const readbackOnly = process.argv.includes('--readback');
  const persistedMedia = join(root, jobId, 'renders', 'output.mp4');
  const existingMediaMtime = readbackOnly ? statSync(persistedMedia).mtimeMs : null;
  try {
    result.installed_cli = JSON.parse(readFileSync('/usr/local/lib/node_modules/hyperframes/package.json', 'utf8')).version;
    result.local_package_cli = JSON.parse(readFileSync('/app/node_modules/hyperframes/package.json', 'utf8')).version;
    assert.equal(result.installed_cli, '0.7.109'); assert.equal(result.local_package_cli, '0.7.109');
    result.image_source_sha256 = Object.fromEntries(['server.js', 'job-contract.js', 'job-queue.js', 'job-environment.js', 'bounded-fetch.js', 'media-preloader.js', 'pipeline-runner.js'].map(name => [name, createHash('sha256').update(readFileSync(`/app/${name}`)).digest('hex')]));
    await start();
    result.auth_negative_status = (await fetch(`${base}/job`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
    assert.equal(result.auth_negative_status, 401);
    const post = () => fetch(`${base}/job`, { method: 'POST', headers, body: JSON.stringify(body) });
    result.admission_status = (await post()).status; assert.equal(result.admission_status, readbackOnly ? 200 : 202);
    let terminal;
    for (let i = 0; i < 900; i++) {
      const row = await (await fetch(`${base}/job/${jobId}/status`, { headers })).json();
      if (['done', 'failed'].includes(row.status) && row.callback_status) { terminal = row; break; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.ok(terminal, 'Render deadline exceeded'); result.terminal = terminal;
    assert.equal(terminal.status, 'done'); assert.equal(terminal.callback_status.ok, true);
    const callback = JSON.parse(readFileSync(join(privateDir, 'callback.json'), 'utf8'));
    result.callback_binding = { request_id: callback.request_id, revision: callback.revision, input_hash: callback.input_hash, status: callback.status };
    assert.equal(callback.input_hash, body.input_hash); assert.equal(callback.revision, 1); assert.equal(callback.request_id, body.request_id); assert.equal(callback.step, body.step); assert.equal(callback.callback_nonce, body.callback.nonce);
    const media = persistedMedia;
    if (readbackOnly) { assert.equal(statSync(media).mtimeMs, existingMediaMtime); result.container_readback_without_render = true; }
    assert.deepEqual(readFileSync(media), readFileSync(join(privateDir, 'uploaded.mp4')));
    copyFileSync(media, join(output, 'output.mp4'));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', media], { encoding: 'utf8' }); assert.equal(probe.status, 0);
    result.ffprobe = JSON.parse(probe.stdout); result.media_bytes = statSync(media).size;
    const video = result.ffprobe.streams.find(stream => stream.codec_type === 'video'); assert.equal(video.width, 640); assert.equal(video.height, 360); assert.ok(Math.abs(Number(result.ffprobe.format.duration) - 2) < 0.2);
    const frame = spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', '1', '-i', media, '-frames:v', '1', join(output, 'frame.png')], { encoding: 'utf8' }); assert.equal(frame.status, 0);
    const before = statSync(media).mtimeMs;
    await stop(); await start();
    result.restart_status = await (await fetch(`${base}/job/${jobId}/status`, { headers })).json(); assert.equal(result.restart_status.status, 'done'); assert.equal(result.restart_status.callback_status.ok, true);
    result.duplicate_status = (await post()).status; assert.equal(result.duplicate_status, 200); assert.equal(statSync(media).mtimeMs, before);
    result.state_mode = (statSync(join(root, jobId, 'job-state-v1.json')).mode & 0o777).toString(8); assert.equal(result.state_mode, '600');
    result.outcome = 'PASS_LOCAL_RENDER_RESTART';
  } catch (error) { result.outcome = 'FAIL'; result.error = error.message; process.exitCode = 1; }
  finally {
    await stop();
    // Synthetic credentials still do not belong in artifacts or console output.
    for (const secret of [dispatchSecret, callbackSecret, env.PREVIEW_SECRET]) logs = logs.split(secret).join('[redacted]');
    writeFileSync(join(output, 'worker.log'), logs);
    writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ outcome: result.outcome, error: result.error, media_bytes: result.media_bytes, duration: result.ffprobe?.format?.duration, state_mode: result.state_mode }));
  }
}
