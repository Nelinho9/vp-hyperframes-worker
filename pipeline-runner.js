/**
 * pipeline-runner — V5.14 Fase C (F7): o worker como driver durável da pipeline
 *
 * Porque: as edge functions têm teto de wall-clock (a morte no build do teste
 * E2E de 2026-08-30 foi exatamente isso, V5_14 §2.1). Este contentor Node no
 * Coolify não tem teto — é o único processo do sistema que pode esperar minutos
 * entre passos. O supervisor por projeto substitui a dependência de a cadeia
 * edge sobreviver de step a step: aperta o botão do motor one-step (F1) a cada
 * 15-60s até o orquestrador dizer que não há nada a fazer.
 *
 * Invariante P13 (worker burro): este módulo NÃO lê nem interpreta o manifesto.
 * Por tick faz `GET /status` e obedece à palavra `action` que a edge devolve
 * ('step' | 'resume' | 'wait' | 'idle'). Toda a máquina de estados, créditos e
 * claims continuam no orquestrador; aqui só há HTTP + sleep + um teto de ticks.
 *
 * Fallback por desenho: se este loop morrer (restart, 5xx prolongado, teto
 * atingido) nada se perde — o self-chain edge (F1) continua a pipeline e o
 * watchdog pg_cron de 1min (F6) é a última linha. O sistema nunca depende
 * exclusivamente do worker.
 *
 * Doc: docs/video-engine/V5_14_PLANO_FLUIDEZ_PIPELINE_WORKER_DRIVER.md §3 F7
 */

/** Ritmo inicial: suficientemente rápido para o utilizador não notar latência. */
export const TICK_MIN_MS = 15_000;
/** Teto do backoff — acima disto o watchdog (1min) já é melhor que nós. */
export const TICK_MAX_MS = 60_000;
/**
 * Teto de segurança do loop. 400 ticks a 60s ≈ 4h: muito acima do pior caso de
 * uma pipeline V4 (~25min) e suficiente para nunca ser o loop a deixar um
 * projeto pendurado para sempre sem dono.
 */
export const MAX_TICKS = 400;
/** Falhas consecutivas de HTTP antes de desistir (o watchdog toma conta). */
export const MAX_CONSECUTIVE_ERRORS = 8;

const ORCHESTRATOR_FN_PATH = '/functions/v1/video-v4-orchestrator';

/** Flag para desligar a supervisão sem redeploy (default ligado). */
export function supervisorEnabled(env = process.env) {
  const raw = env.PIPELINE_SUPERVISOR_ENABLED;
  if (raw === undefined || raw === null || raw === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

/**
 * Valida o contrato do supervisor.
 *
 * Fonte primária: o corpo do `POST /supervise` — o orquestrador entrega as
 * rotas dele próprio + o secret de serviço, porque o worker não tem (nem deve
 * ter) esses valores configurados (Dockerfile: "Worker is DUMB: no Supabase
 * secrets baked in").
 * Fonte de reserva (só no boot, para re-registrar projetos com job em curso):
 * deriva do `SUPABASE_URL` + `WORKER_SECRET` que o contentor já tem, exatamente
 * com o mesmo default que a edge usa para `VIDEO_V4_CALLBACK_URL`.
 *
 * @param {{ project_id?: string, driver?: object } | null} body
 * @param {Record<string, string|undefined>} env
 * @param {string} [projectId]
 * @returns {{ ok: true, driver: object } | { ok: false, error: string }}
 */
export function normalizeDriver(body, env = {}, projectId) {
  const pid = (body && body.project_id) || projectId || '';
  const provided = body && body.driver;
  if (
    provided &&
    isHttpUrl(provided.status_url) &&
    isHttpUrl(provided.step_url) &&
    isHttpUrl(provided.resume_url) &&
    typeof provided.secret === 'string' &&
    provided.secret
  ) {
    return {
      ok: true,
      driver: {
        status_url: provided.status_url,
        step_url: provided.step_url,
        resume_url: provided.resume_url,
        secret: provided.secret,
      },
    };
  }

  const base = env.SUPABASE_URL ? String(env.SUPABASE_URL).replace(/\/$/, '') + ORCHESTRATOR_FN_PATH : '';
  const secret = env.WORKER_SECRET || '';
  if (base && secret && pid) {
    return {
      ok: true,
      driver: {
        status_url: `${base}/status?project_id=${encodeURIComponent(pid)}`,
        step_url: `${base}/step`,
        resume_url: `${base}/resume`,
        secret,
      },
    };
  }

  return { ok: false, error: 'driver_contract_incomplete' };
}

/**
 * Um tick de supervisão: lê o estado, obedece, dorme com backoff.
 *
 * @param {{ fetchImpl: typeof fetch, sleep: (ms:number)=>Promise<void>, log?: (msg:string)=>void }} deps
 * @param {string} projectId
 * @param {{status_url:string,step_url:string,resume_url:string,secret:string}} driver
 * @param {{ maxTicks?: number, tickMs?: number, stopped?: () => boolean }} [opts]
 */
export async function runSupervisor(deps, projectId, driver, opts = {}) {
  const { fetchImpl, sleep } = deps;
  const log = deps.log ?? (() => {});
  const maxTicks = opts.maxTicks ?? MAX_TICKS;
  const stopped = opts.stopped ?? (() => false);
  const headers = { 'Content-Type': 'application/json', 'x-worker-secret': driver.secret };
  const presses = [];
  let backoff = opts.tickMs ?? TICK_MIN_MS;
  let errors = 0;

  for (let tick = 1; tick <= maxTicks; tick++) {
    if (stopped()) return { status: 'stopped', ticks: tick, presses };

    // 1. Perguntar ao orquestrador o que fazer (a única leitura de estado).
    let action = null;
    try {
      const res = await fetchImpl(driver.status_url, { method: 'GET', headers });
      if (res.ok) {
        const body = await res.json();
        action = body?.action ?? (body?.idle ? 'idle' : 'step');
        errors = 0;
      } else {
        errors += 1;
        log(`[supervisor ${projectId}] /status respondeu ${res.status}`);
      }
    } catch (err) {
      errors += 1;
      log(`[supervisor ${projectId}] /status falhou: ${err?.message ?? err}`);
    }

    if (action === 'idle') return { status: 'idle', ticks: tick, presses };

    // 2. Apertar o botão indicado. 'wait' (e leitura falhada) não aperta nada.
    if (action === 'step' || action === 'resume') {
      const url = action === 'step' ? driver.step_url : driver.resume_url;
      let press = { action, accepted: false, claimed: false };
      try {
        const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify({ project_id: projectId }) });
        if (res.ok) {
          press = { action, accepted: true, claimed: false };
          backoff = opts.tickMs ?? TICK_MIN_MS; // houve progresso → volta ao ritmo rápido
        } else if (res.status === 409) {
          // 409 = há um runner vivo (claim F4) ou step a correr — NORMAL.
          press = { action, accepted: false, claimed: true };
        } else {
          errors += 1;
          press = { action, accepted: false, claimed: false, status: res.status };
          log(`[supervisor ${projectId}] /${action} respondeu ${res.status}`);
        }
      } catch (err) {
        errors += 1;
        press = { action, accepted: false, claimed: false, error: String(err?.message ?? err) };
        log(`[supervisor ${projectId}] /${action} falhou: ${err?.message ?? err}`);
      }
      presses.push(press);
    }

    if (errors >= MAX_CONSECUTIVE_ERRORS) {
      log(`[supervisor ${projectId}] ${errors} falhas consecutivas — devolvo o projeto ao watchdog`);
      return { status: 'error', ticks: tick, presses };
    }

    // 3. Dorme (com backoff crescente até TICK_MAX_MS) e repete.
    await sleep(backoff);
    backoff = Math.min(backoff * 2, TICK_MAX_MS);
  }

  log(`[supervisor ${projectId}] teto de ${maxTicks} ticks atingido — devolvo o projeto ao watchdog`);
  return { status: 'timeout', ticks: maxTicks, presses };
}

/**
 * Registador de supervisores: no máximo um loop por projeto por contentor.
 * O slot é libertado quando o loop termina (idle / erro / teto / stop), para que
 * um novo `/supervise` possa voltar a arrancar.
 */
export function createSupervisionRegistry() {
  /** @type {Map<string, {promise: Promise<object>, stop: () => void}>} */
  const entries = new Map();

  return {
    has: (projectId) => entries.has(projectId),
    /** Promise do resultado do loop em curso (null quando não supervisionado). */
    get: (projectId) => entries.get(projectId)?.promise ?? null,
    list: () => Array.from(entries.keys()),
    stop: (projectId) => {
      const entry = entries.get(projectId);
      if (!entry) return false;
      entry.stop();
      return true;
    },
    stopAll: () => {
      for (const entry of entries.values()) entry.stop();
    },
    _set: (projectId, entry) => {
      entries.set(projectId, entry);
      entry.promise.finally(() => {
        if (entries.get(projectId) === entry) entries.delete(projectId);
      }).catch(() => {});
    },
    _getEntry: (projectId) => entries.get(projectId),
  };
}

/**
 * Arranca a supervisão de um projeto (fire-and-forget). O resultado do loop
 * fica disponível em `registry.get(projectId)`; o retorno só diz se arrancou.
 *
 * @returns {{ started: true } | { started: false, reason: string }}
 */
export function startSupervision(registry, deps, projectId, driver, opts = {}) {
  if (!projectId) return { started: false, reason: 'missing_project_id' };
  if (registry.has(projectId)) return { started: false, reason: 'already_running' };

  const log = deps.log ?? (() => {});
  let stopRequested = false;
  let settle;
  const outcome = new Promise((resolve) => {
    settle = resolve;
  });
  runSupervisor(deps, projectId, driver, { ...opts, stopped: () => stopRequested })
    .then(settle)
    .catch((err) => {
      // Um loop que explode não pode rebentar o processo do worker (o render em
      // curso é trabalho pago): devolve o projeto ao watchdog.
      log(`[supervisor ${projectId}] loop explodiu: ${err?.message ?? err}`);
      settle({ status: 'error', ticks: 0, presses: [] });
    });

  registry._set(projectId, {
    promise: outcome,
    stop: () => {
      stopRequested = true;
    },
  });
  return { started: true };
}
