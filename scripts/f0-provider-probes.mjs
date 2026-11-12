/**
 * F0.3/F0.4 (plano Video-Engine v2) — sondas aprovadas no F0:
 *  - TTS: 1 segmento PT mínimo com o modelo deployed (google/gemini-3-8-flash-tts),
 *    poll até estado terminal; regista state/failCode/duração.
 *  - STT: replica o contrato do adapter deployed (createKieAsrTranscriber):
 *    download de 1 voz real do projeto de prova → upload CDN kie.ai →
 *    createTask nemotron timestamps:true → recordInfo → words JSON público.
 * Nunca imprime keys. Resultados em evidence/video-engine-v2-f0-2026-11-12/.
 * Custos esperados: TTS ~0.02€ + ASR ~0.06 cr kie (ledger no README).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTtsRequestBody, TTS_MODEL } from '../../visttapro/supabase/functions/video-voice/logic.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const KIE = env.KIE_API_KEY || '';
const SB_URL = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
const PROJECT = '3e7992ac-2d61-40ae-ab5d-7577fb099863'; // projeto de prova C04 (Tasca do Largo)
if (!KIE) { console.log('KIE_API_KEY_MISSING'); process.exit(1); }

const OUT = join(HERE, '..', 'evidence', 'video-engine-v2-f0-2026-11-12');
mkdirSync(OUT, { recursive: true });
const results = { started_at: new Date().toISOString(), tts: null, stt: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kieHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${KIE}` };

async function pollTask(taskId, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, { headers: kieHeaders });
    const data = await res.json().catch(() => null);
    const state = data?.data?.state;
    if (state === 'success' || state === 'fail') return { data: data.data, elapsed_ms: Date.now() - start };
    await sleep(5000);
  }
  return { data: null, elapsed_ms: Date.now() - start, timeout: true };
}

// ── F0.3: TTS health probe (1 segmento PT) ─────────────────────────────────
try {
  const body = buildTtsRequestBody({ texts: [{ id: 'probe-1', text: 'Sonda de saúde do motor de voz. Olá, isto é um teste curto.' }], lang: 'pt' });
  const createRes = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST', headers: kieHeaders, body: JSON.stringify({ model: TTS_MODEL, input: body.input ?? body }),
  });
  const created = await createRes.json().catch(() => null);
  const taskId = created?.data?.taskId;
  if (!taskId) {
    results.tts = { ok: false, stage: 'createTask', http: createRes.status, code: created?.code, msg: created?.msg };
  } else {
    const polled = await pollTask(taskId, 150_000);
    const d = polled.data;
    let resultUrls = [];
    try { resultUrls = JSON.parse(d?.resultJson || '{}').resultUrls || []; } catch { /* ignore */ }
    results.tts = {
      ok: d?.state === 'success', task_id: taskId, state: d?.state ?? 'timeout',
      fail_code: d?.failCode ?? null, fail_msg: d?.failMsg ?? null,
      elapsed_ms: polled.elapsed_ms, result_url_count: resultUrls.length,
      model: TTS_MODEL,
    };
  }
} catch (err) {
  results.tts = { ok: false, error: String(err?.message ?? err).slice(0, 200) };
}
console.log('TTS_PROBE', JSON.stringify(results.tts));

// ── F0.4: STT contract probe (adapter deployed replica) ────────────────────
try {
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_CONFIG_MISSING');
  const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
  const listRes = await fetch(`${SB_URL}/storage/v1/object/list/video-artifacts`, {
    method: 'POST', headers: sbHeaders, body: JSON.stringify({ prefix: `projects/${PROJECT}/audio`, limit: 50 }),
  });
  const files = await listRes.json().catch(() => []);
  const voice = (Array.isArray(files) ? files : []).find((f) => /^vo-.*\.(wav|mp3|m4a)$/i.test(f.name));
  if (!voice) throw new Error(`NO_VOICE_FILE (files=${JSON.stringify(files).slice(0, 150)})`);
  const audioPath = `projects/${PROJECT}/audio/${voice.name}`;
  const dlRes = await fetch(`${SB_URL}/storage/v1/object/video-artifacts/${audioPath}`, { headers: sbHeaders });
  if (!dlRes.ok) throw new Error(`AUDIO_DOWNLOAD_HTTP_${dlRes.status}`);
  const bytes = new Uint8Array(await dlRes.arrayBuffer());
  const mime = voice.name.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
  // 1) upload CDN kie.ai (data URI base64)
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const dataUri = `data:${mime};base64,${btoa(binary)}`;
  const upRes = await fetch('https://kieai.redpandaai.co/api/file-base64-upload', {
    method: 'POST', headers: kieHeaders,
    body: JSON.stringify({ base64Data: dataUri, uploadPath: 'audio/v4-asr', fileName: `probe.${voice.name.split('.').pop()}` }),
  });
  const up = await upRes.json().catch(() => null);
  const cdnUrl = up?.data?.downloadUrl;
  if (up?.code !== 200 || !cdnUrl) throw new Error(`CDN_UPLOAD_FAILED:${up?.code}:${up?.msg ?? ''}`);
  // 2) createTask nemotron timestamps:true (sem target_language)
  const createRes = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST', headers: kieHeaders,
    body: JSON.stringify({ model: 'nvidia/nemotron-3-5-transcribe', input: { audio_url: cdnUrl, timestamps: true } }),
  });
  const created = await createRes.json().catch(() => null);
  const taskId = created?.data?.taskId;
  if (!taskId) throw new Error(`ASR_CREATE_FAILED:${created?.code}:${created?.msg ?? ''}`);
  // 3) poll + 4) words JSON público SEM Authorization
  const polled = await pollTask(taskId, 120_000);
  const d = polled.data;
  if (d?.state !== 'success') throw new Error(`ASR_STATE:${d?.state ?? 'timeout'}:${d?.failMsg ?? ''}`);
  const resp = d.response ?? (typeof d.resultJson === 'string' ? JSON.parse(d.resultJson) : null);
  const wordsUrl = resp?.resultObject?.url;
  let words = null;
  if (wordsUrl) {
    const wRes = await fetch(wordsUrl); // sem Authorization (CDN público)
    words = await wRes.json().catch(() => null);
  }
  results.stt = {
    ok: Array.isArray(words?.words) && words.words.length > 0,
    task_id: taskId, audio_path: audioPath, audio_bytes: bytes.length,
    elapsed_ms: polled.elapsed_ms, word_count: words?.words?.length ?? 0,
    sample: (words?.words ?? []).slice(0, 3),
    result_shape: wordsUrl ? 'resultObject.url' : 'inline',
  };
} catch (err) {
  results.stt = { ok: false, error: String(err?.message ?? err).slice(0, 250) };
}
console.log('STT_PROBE', JSON.stringify(results.stt));

results.finished_at = new Date().toISOString();
writeFileSync(join(OUT, 'probe-results.json'), JSON.stringify(results, null, 2));
console.log('EVIDENCE_WRITTEN', join(OUT, 'probe-results.json'));