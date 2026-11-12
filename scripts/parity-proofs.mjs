/**
 * F1/F2 (plano Video-Engine v2, emenda F) — provas reais de paridade,
 * AUTORIZADAS pelo operador (2026-11-12): ≥3 vídeos completos com
 * V4_BUILD_ON_WORKER=true + V4_LLM_STEPS_ON_WORKER=design,storyboard,audio,
 * visual,quality. Conta de teste teste1@visttapro.com (créditos de teste).
 *
 * Por vídeo: cria projeto → POST /start → poll /status até terminal →
 * recolhe manifesto + jobs + artefactos (build-input.html, audio_meta.json,
 * quality_report.json, MP4) → escreve evidência + ledger.
 *
 * Custos esperados: 10 cr/vídeo (design 1 + storyboard 2 + audio 1 + visual 1
 * + build 4 + finalize 1; quality 0) + TTS/BGM kie (~0,2–0,5 €/vídeo).
 * Nunca imprime keys/tokens.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(new URL('../../visttapro/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SB = (env.VITE_SUPABASE_URL || env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '';
const ORCH = `${SB}/functions/v1/video-v4-orchestrator`;
const OUT = join(HERE, '..', 'evidence', 'video-engine-v2-parity-2026-11-12');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

const BRIEFS = [
  {
    name: 'Parity A — Tasca do Largo (9:16)',
    meta: { niche: 'restaurante', sub_topic: 'Menu de jantar tradicional', aspect_ratio: '9:16', duration_sec: 15, language: 'pt', voice_locale: 'pt-PT', category: 'location_lifestyle', audio_text: { narration: true, captions: true, music: true } },
    original_request: 'Cria um vídeo promocional de 15 segundos para a Tasca do Largo, um restaurante tradicional português. Objetivo: atrair clientes para o novo menu de jantar. Oferta: pratos de bacalhau e polvo à lagareiro com vinho da casa incluído. CTA: reserva a tua mesa este fim de semana. Tom acolhedor e apetitoso, com foco na comida e no ambiente familiar.',
  },
  {
    name: 'Parity B — FlowDesk (16:9)',
    meta: { niche: 'software', sub_topic: 'App de produtividade para equipas', aspect_ratio: '16:9', duration_sec: 15, language: 'pt', voice_locale: 'pt-PT', category: 'product_demo', audio_text: { narration: true, captions: true, music: true } },
    original_request: 'Cria um vídeo de demonstração de 15 segundos para o FlowDesk, uma aplicação de produtividade para equipas remotas. Objetivo: mostrar como organiza tarefas, reuniões e documentos num só lugar. Oferta: teste gratuito de 14 dias sem cartão de crédito. CTA: experimenta grátis hoje. Tom moderno e direto, com foco na interface e na simplicidade.',
  },
  {
    name: 'Parity C — MoveFit (1:1)',
    meta: { niche: 'fitness', sub_topic: 'Ginásio com aulas de grupo', aspect_ratio: '1:1', duration_sec: 15, language: 'pt', voice_locale: 'pt-PT', category: 'promo_sale', audio_text: { narration: true, captions: true, music: true } },
    original_request: 'Cria um vídeo promocional de 15 segundos para o MoveFit, um ginásio com aulas de grupo e acompanhamento personalizado. Objetivo: angariar novos membros para o plano de verão. Oferta: primeira semana grátis e inscrição sem taxa. CTA: inscreve-te esta semana. Tom enérgico e motivador, com foco nas aulas e na comunidade.',
  },
];

// ── Conta de prova: teste1 (existente). O pipeline é conduzido por /step com
// credencial de serviço (service role) — não requer login de utilizador. ────
const TEST_EMAIL = 'teste1@visttapro.com';
const usersRes = await fetch(`${SB}/auth/v1/admin/users?email=${encodeURIComponent(TEST_EMAIL)}`, { headers: svcHeaders });
const usersBody = await usersRes.json().catch(() => null);
const testUser = (usersBody?.users || [])[0];
if (!testUser?.id) { console.log('TEST_USER_NOT_FOUND'); process.exit(1); }
const USER = testUser.id;
console.log('PROOF_USER', USER);
// Créditos de prova: garante saldo >= 100 (3 vídeos × 10 cr + folga).
const crRes = await fetch(`${SB}/rest/v1/user_credits?user_id=eq.${USER}&select=total_credits_balance`, { headers: svcHeaders });
const crRows = await crRes.json().catch(() => []);
const balance = Array.isArray(crRows) && crRows[0] ? Number(crRows[0].total_credits_balance) : null;
if (balance === null) {
  const ins = await fetch(`${SB}/rest/v1/user_credits`, {
    method: 'POST', headers: { ...svcHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: USER, total_credits_balance: 100 }),
  });
  if (!ins.ok) { console.log('CREDITS_GRANT_FAILED', ins.status); process.exit(1); }
  console.log('CREDITS_GRANTED 100');
} else if (balance < 100) {
  const upd = await fetch(`${SB}/rest/v1/user_credits?user_id=eq.${USER}`, {
    method: 'PATCH', headers: { ...svcHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ total_credits_balance: 100 }),
  });
  if (!upd.ok) { console.log('CREDITS_TOPUP_FAILED', upd.status); process.exit(1); }
  console.log('CREDITS_TOPPED_UP 100 (was ' + balance + ')');
} else {
  console.log('CREDITS_OK', balance);
}

const results = [];
for (let i = 0; i < BRIEFS.length; i++) {
  const brief = BRIEFS[i];
  const rec = { index: i + 1, name: brief.name, started_at: new Date().toISOString() };
  console.log(`\n=== PROOF ${i + 1}/3: ${brief.name} ===`);
  try {
    // 1) Criar projeto via REST (service role) — o startPipeline cria o
    // manifesto e corre o capture (fixture mode: sem site/capture associado).
    // effective_config COMPLETO (dims incl.) — espelho do que o fluxo real
    // de criação escreve via videoConfigResolution; o gate F04 do render
    // exige effective_width/height/ratio numéricos (F04_DIMS_MISSING).
    const dims = brief.meta.aspect_ratio === '16:9' ? { w: 1920, h: 1080 }
      : brief.meta.aspect_ratio === '1:1' ? { w: 1080, h: 1080 }
      : { w: 1080, h: 1920 };
    const row = {
      user_id: USER,
      name: brief.name,
      niche: brief.meta.niche,
      category: brief.meta.category,
      sub_topic: brief.meta.sub_topic,
      aspect_ratio: brief.meta.aspect_ratio,
      duration_seconds: brief.meta.duration_sec,
      status: 'draft',
      branding_config: {},
      render_config: { resolution: '1280x720', fps: 30, format: 'mp4', quality: 'standard_1080p', codec: 'h264' },
      audio_config: {},
      metadata: {
        niche: brief.meta.niche,
        language: 'pt',
        voice_locale: 'pt-PT',
        contract_version: 'create.v1',
        engine: 'v4',
        engine_version: 'v4',
        original_request: brief.original_request,
        resolved_brief: brief.original_request,
        audio_text: brief.meta.audio_text,
        effective_config: {
          duration_seconds: brief.meta.duration_sec,
          format: brief.meta.aspect_ratio === '16:9' ? 'landscape' : brief.meta.aspect_ratio === '1:1' ? 'square' : 'portrait',
          effective_width: dims.w,
          effective_height: dims.h,
          effective_ratio: brief.meta.aspect_ratio,
          language: 'pt',
          voice_locale: 'pt-PT',
        },
      },
    };
    const createRes = await fetch(`${SB}/rest/v1/video_projects`, {
      method: 'POST',
      headers: { ...svcHeaders, Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    const created = await createRes.json().catch(() => null);
    const projectId = Array.isArray(created) ? created[0]?.id : created?.id;
    if (!createRes.ok || !projectId) {
      console.log('CREATE_FAILED', createRes.status, JSON.stringify(created).slice(0, 300));
      rec.error = 'CREATE_FAILED';
      results.push(rec);
      continue;
    }
    rec.project_id = projectId;
    console.log('PROJECT_CREATED', projectId);

    // 2) Semear manifesto com capture done (fixture mode — sem site associado)
    // e arrancar o motor one-step via /step com credencial de serviço. O
    // brief é reconciliado pelo ensureManifestBrief a partir do metadata.
    const manifestSeed = {
      version: 1,
      step: 'design',
      steps: {
        capture: { status: 'done', artifacts: ['capture/extracted/tokens.json', 'capture/bundle.json', 'capture/media_plan.json'] },
        design: { status: 'pending', artifacts: [] },
        storyboard: { status: 'pending', artifacts: [] },
        audio: { status: 'pending', artifacts: [] },
        visual: { status: 'pending', artifacts: [] },
        build: { status: 'pending', artifacts: [] },
        finalize: { status: 'pending', artifacts: [] },
        quality: { status: 'pending', artifacts: [] },
      },
      credits: { spent: 0, by_step: {} },
    };
    const seedRes = await fetch(`${SB}/rest/v1/video_projects?id=eq.${projectId}`, {
      method: 'PATCH', headers: { ...svcHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ manifest: manifestSeed }),
    });
    if (!seedRes.ok) { rec.error = `SEED_HTTP_${seedRes.status}`; results.push(rec); continue; }
    const startRes = await fetch(`${ORCH}/step`, {
      method: 'POST', headers: svcHeaders, body: JSON.stringify({ project_id: projectId }),
    });
    const started = await startRes.json().catch(() => null);
    console.log('STEP', startRes.status, JSON.stringify(started).slice(0, 200));
    if (!startRes.ok) { rec.error = `START_HTTP_${startRes.status}`; results.push(rec); continue; }

    // 3) Poll até terminal (25 min max)
    const deadline = Date.now() + 25 * 60 * 1000;
    let manifest = null;
    let terminal = false;
    while (Date.now() < deadline) {
      await sleep(20_000);
      const stRes = await fetch(`${ORCH}/status?project_id=${projectId}`, { headers: svcHeaders });
      const st = await stRes.json().catch(() => null);
      manifest = st?.manifest || st?.value?.manifest || null;
      if (!manifest?.steps) continue;
      const states = Object.entries(manifest.steps).map(([s, v]) => `${s}:${v.status}`).join(' ');
      console.log(`POLL ${new Date().toISOString().slice(11, 19)} ${states}`);
      const all = Object.values(manifest.steps);
      const anyRunning = all.some((s) => s.status === 'running');
      const anyFailed = all.some((s) => s.status === 'failed');
      const anyPending = all.some((s) => s.status === 'pending');
      // Terminal: nada a correr E (falha OU nada pendente). Uma falha pára a
      // cadeia — os pendentes a jusante nunca avançam.
      if (!anyRunning && (anyFailed || !anyPending)) { terminal = true; rec.failed_step = anyFailed ? Object.entries(manifest.steps).find(([, v]) => v.status === 'failed')?.[0] : null; break; }
    }
    rec.terminal = terminal;
    rec.manifest = manifest;

    // 4) Jobs + artefactos
    const jobsRes = await fetch(`${SB}/rest/v1/video_v4_jobs?project_id=eq.${projectId}&select=id,step,status,credits_cost,credits_refunded,created_at,dispatched_at,result&order=created_at.asc`, { headers: svcHeaders });
    rec.jobs = await jobsRes.json().catch(() => []);
    const artifacts = {};
    for (const path of [
      `projects/${projectId}/compositions/build-input.html`,
      `projects/${projectId}/audio_meta.json`,
      `projects/${projectId}/quality_report.json`,
      `projects/${projectId}/renders/output.mp4`,
    ]) {
      const infoRes = await fetch(`${SB}/storage/v1/object/info/video-artifacts/${path}`, { headers: svcHeaders });
      if (infoRes.ok) {
        const info = await infoRes.json().catch(() => null);
        artifacts[path.split('/').pop()] = { present: true, size: info?.metadata?.size ?? info?.size ?? null };
        if (path.endsWith('.json') || path.endsWith('.html')) {
          const dl = await fetch(`${SB}/storage/v1/object/video-artifacts/${path}`, { headers: svcHeaders });
          if (dl.ok) {
            const text = await dl.text();
            writeFileSync(join(OUT, `proof-${i + 1}-${path.split('/').pop()}`), text);
            if (path.endsWith('audio_meta.json')) {
              try {
                const meta = JSON.parse(text);
                artifacts['audio_meta.json'].files_ok = (meta.files || []).filter((f) => f.status === 'ok').length;
                artifacts['audio_meta.json'].files_total = (meta.files || []).length;
                artifacts['audio_meta.json'].timing_source = meta.timing_source ?? null;
              } catch { /* ignore */ }
            }
            if (path.endsWith('quality_report.json')) {
              try { const q = JSON.parse(text); artifacts['quality_report.json'].score = q.score; artifacts['quality_report.json'].status = q.status; } catch { /* ignore */ }
            }
          }
        }
      } else {
        artifacts[path.split('/').pop()] = { present: false };
      }
    }
    rec.artifacts = artifacts;
    rec.credits_spent = manifest?.credits?.spent ?? null;
    rec.worker_steps = (rec.jobs || []).filter((j) => j.result?.step_result || j.result?.build_result).map((j) => j.step);
    rec.finished_at = new Date().toISOString();
    const mp4 = artifacts['output.mp4'];
    rec.verdict = terminal && !rec.failed_step && mp4?.present ? 'PASS' : 'FAIL';
    console.log(`PROOF ${i + 1} VERDICT=${rec.verdict} credits=${rec.credits_spent} worker_steps=${JSON.stringify(rec.worker_steps)}`);
  } catch (err) {
    rec.error = String(err?.message ?? err).slice(0, 300);
    rec.verdict = 'ERROR';
    console.log('PROOF_ERROR', rec.error);
  }
  results.push(rec);
  writeFileSync(join(OUT, 'parity-results.json'), JSON.stringify({ started_at: results[0]?.started_at, results }, null, 2));
}

const passed = results.filter((r) => r.verdict === 'PASS').length;
const summary = {
  finished_at: new Date().toISOString(),
  flags: { V4_BUILD_ON_WORKER: 'true', V4_LLM_STEPS_ON_WORKER: 'design,storyboard,audio,visual,quality' },
  user: USER, videos: results.length, passed,
  credits_total: results.reduce((a, r) => a + (r.credits_spent || 0), 0),
  verdict: passed >= 3 ? 'PARITY_PROVEN' : 'PARITY_INCOMPLETE',
};
writeFileSync(join(OUT, 'parity-summary.json'), JSON.stringify(summary, null, 2));
console.log('\nSUMMARY', JSON.stringify(summary));