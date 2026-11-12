/**
 * build-html-runner.js — F1 (plano Video-Engine v2): o build HTML corre no
 * worker, fora do teto de CPU (~2s/request) das Supabase Edge Functions que
 * matava o builder deterministicamente (BUILDER_STREAM_INCOMPLETE).
 *
 * Contrato:
 * - O job `step:'build', mode:'build-html'` NÃO transporta credenciais LLM.
 *   O runner pede-as JUST-IN-TIME ao orchestrator (`inputs.credentials_url`,
 *   autenticado com o worker secret) — nada de keys no payload durável da
 *   fila nem em logs (emenda C do plano v2).
 * - O loop completo (LLM → repair → lint → retries → fallback de storyboard)
 *   reutiliza os módulos PUROS vendados de visttapro (build-html/vendor,
 *   PROVENANCE.json + scripts/sync-build-modules.mjs). Posse ÚNICA do retry
 *   budget: neste modo o orchestrator NÃO encadeia a cadeia do builder edge
 *   (emenda E).
 * - O HTML validado é gravado em `projects/{id}/compositions/build-input.html`
 *   (bucket video-artifacts); o callback transporta `build_result` com o path
 *   + sha256 + telemetria. O orchestrator despacha o render a partir daí.
 *
 * Node >= 22.18 (type stripping nativo dos .ts vendados, sem build step).
 */
import { createHash } from 'node:crypto';
import { generateBuildHtmlOnly, createPerfLog } from './build-html/vendor/video-v4-steps/buildStep.ts';
import { createEdgeLintRunner } from './build-html/vendor/video-v4-steps/edgeLint.ts';
import {
  CAPTURE_MEDIA_BUCKETS,
  CAPTURE_SIGNED_TTL_SEC,
  canonicalizeCaptureMedia,
} from './build-html/vendor/video-v4-steps/mediaUrls.ts';
import { llmCapability, normalizeReasoningEffort } from './build-html/vendor/_shared/llmProvider.ts';

const ARTIFACTS_BUCKET = 'video-artifacts';
/** Mesmo orçamento do builder edge (video-v4-builder/index.ts, 2026-10-18). */
export const BUILD_LLM_TIMEOUT_MS = 360_000;
export const BUILD_CREDENTIALS_TIMEOUT_MS = 15_000;
/** TTL das assinaturas de leitura VO — espelha o builder edge (7 dias). */
export const BUILD_SIGN_READ_TTL_SEC = 604_800;

export function buildHtmlStoragePath(projectId) {
  return `projects/${projectId}/compositions/build-input.html`;
}

/**
 * Credenciais JUST-IN-TIME (emenda C): POST autenticado ao orchestrator; a
 * resposta vive só em memória durante o job. Nunca é persistida no job-state
 * nem escrita em logs. Falhas são nomeadas e curtas (sem eco do corpo).
 */
export async function fetchBuildCredentials(args) {
  const { credentialsUrl, workerSecret } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? BUILD_CREDENTIALS_TIMEOUT_MS;
  let url;
  try { url = new URL(credentialsUrl); } catch { throw new Error('BUILD_CREDENTIALS_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('BUILD_CREDENTIALS_URL_INVALID');
  if (typeof workerSecret !== 'string' || !workerSecret) throw new Error('BUILD_CREDENTIALS_SECRET_MISSING');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(credentialsUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-worker-secret': workerSecret },
      body: JSON.stringify({ purpose: 'build-html' }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error('BUILD_CREDENTIALS_TIMEOUT');
    throw new Error(`BUILD_CREDENTIALS_TRANSPORT: ${String(err?.message ?? err).slice(0, 120)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`BUILD_CREDENTIALS_HTTP_${res.status}`);
  const data = await res.json().catch(() => null);
  const llm = data?.llm;
  if (!llm || typeof llm.url !== 'string' || !llm.url
    || typeof llm.model !== 'string' || !llm.model
    || typeof llm.api_key !== 'string' || !llm.api_key) {
    throw new Error('BUILD_CREDENTIALS_MALFORMED');
  }
  return {
    url: llm.url,
    model: llm.model,
    apiKey: llm.api_key,
    wire: llm.wire === 'responses' ? 'responses' : 'chat',
    reasoningEffort: typeof llm.reasoning_effort === 'string' ? llm.reasoning_effort : '',
    // F2 (plano v2): config por step para o runner llm-step (opcional —
    // respostas antigas do endpoint continuam válidas para o build-html).
    steps: data?.steps && typeof data.steps === 'object' ? data.steps : null,
    // F2 (plano v2): env do pipeline de áudio (TTS/BGM/ASR), só em memória.
    audio: data?.audio && typeof data.audio === 'object' ? data.audio : null,
  };
}

/**
 * Cliente LLM do worker com os dois wire contracts reais do tenant:
 * - `chat` (OpenRouter/Gemini-compat/generic): POST {base}/chat/completions,
 *   {model, messages, stream:false}; choices[0].message.content + usage.
 * - `responses` (famílias kie.ai): POST {base}/responses, input com
 *   input_text + reasoning.effort; output[].message.content[].output_text.
 * NUNCA envia response_format — o build pede HTML cru (lição V5_16.1: com
 * json_object forçado o modelo gasta os tokens em reasoning e devolve vazio).
 * O effort é normalizado pelo perfil do provider (llmProvider vendado).
 */
export function createWorkerLlmClient(config, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? BUILD_LLM_TIMEOUT_MS;
  const cap = llmCapability(config.url);
  const effort = normalizeReasoningEffort(cap.kind, config.reasoningEffort || '');
  const base = config.url.replace(/\/+$/, '');
  const endpoint = config.wire === 'responses'
    ? (base.endsWith('/responses') ? base : `${base.replace(/\/chat\/completions$/, '')}/responses`)
    : (base.endsWith('/chat/completions') ? base : `${base}/chat/completions`);
  return {
    async call(messages) {
      const body = config.wire === 'responses'
        ? {
            model: config.model,
            stream: false,
            input: messages.map((m) => ({ role: m.role, content: [{ type: 'input_text', text: m.content }] })),
            ...(effort ? { reasoning: { effort } } : {}),
          }
        : {
            model: config.model,
            stream: false,
            messages,
            ...(effort
              ? (cap.thinking === 'reasoning-effort' ? { reasoning_effort: effort } : { reasoning: { effort } })
              : {}),
          };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new Error('BUILD_LLM_TIMEOUT');
        throw new Error(`BUILD_LLM_TRANSPORT: ${String(err?.message ?? err).slice(0, 120)}`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`BUILD_LLM_HTTP_${res.status}`);
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object') throw new Error('BUILD_LLM_BODY_UNPARSEABLE');
      // kie.ai devolve erros de aplicação dentro de HTTP 200 ({code, msg}).
      if (data.code !== undefined && Number(data.code) !== 200) throw new Error(`BUILD_LLM_PROVIDER_${data.code}`);
      let content = '';
      let tokens = { input: 0, output: 0 };
      if (config.wire === 'responses') {
        for (const item of Array.isArray(data.output) ? data.output : []) {
          if (item?.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part?.type === 'output_text' && typeof part.text === 'string') content += part.text;
            }
          }
        }
        tokens = {
          input: Number(data.usage?.input_tokens ?? 0) || 0,
          output: Number(data.usage?.output_tokens ?? 0) || 0,
        };
      } else {
        content = data.choices?.[0]?.message?.content ?? '';
        tokens = {
          input: Number(data.usage?.prompt_tokens ?? 0) || 0,
          output: Number(data.usage?.completion_tokens ?? 0) || 0,
        };
      }
      if (typeof content !== 'string' || !content.trim()) throw new Error('BUILD_LLM_EMPTY_CONTENT');
      return { content, tokens };
    },
  };
}

/**
 * Vínculo da captura do projeto — espelha o builder edge (V5_32 revisão de
 * segurança): o escopo da canonicalização deriva da BD, nunca do tokens.json.
 */
async function loadLinkedCaptureId(supabase, projectId) {
  const { data: direct } = await supabase
    .from('video_captures')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'captured')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (direct) return String(direct.id);
  const { data: projectRow } = await supabase
    .from('video_projects')
    .select('user_id, metadata')
    .eq('id', projectId)
    .maybeSingle();
  const siteUrl = projectRow?.metadata?.site_url;
  if (typeof siteUrl !== 'string' || !siteUrl || !projectRow?.user_id) return null;
  const { data: byUrl } = await supabase
    .from('video_captures')
    .select('id')
    .eq('user_id', projectRow.user_id)
    .eq('source_url', siteUrl)
    .eq('status', 'captured')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return byUrl ? String(byUrl.id) : null;
}

/**
 * Executa o job build-html completo. Devolve um resultado PÚBLICO (sem
 * credenciais): { ok, html_path, sha256, retries, tokens, duration_seconds,
 * fallback, fallback_reason } ou { ok:false, error }. Nunca lança — o server
 * traduz o resultado em estado do job + callback.
 */
export async function runBuildHtmlJob(args) {
  const { body, supabase, workerOrigin, workerSecret } = args;
  const log = args.log ?? (() => {});
  const fetchImpl = args.fetchImpl ?? fetch;
  const projectId = body?.project_id;
  const inputs = body?.inputs ?? {};
  if (!projectId) return { ok: false, error: 'BUILD_PROJECT_ID_MISSING' };
  if (!supabase) return { ok: false, error: 'BUILD_STORAGE_UNAVAILABLE' };
  if (typeof inputs.credentials_url !== 'string' || !inputs.credentials_url) {
    return { ok: false, error: 'BUILD_CREDENTIALS_URL_MISSING' };
  }
  const perf = createPerfLog();
  let credentials;
  try {
    credentials = await fetchBuildCredentials({ credentialsUrl: inputs.credentials_url, workerSecret, fetchImpl });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 200) };
  }
  perf.mark('credentials_jit');

  const storage = {
    async readText(path) {
      const { data } = await supabase.storage.from(ARTIFACTS_BUCKET).download(path);
      return data ? await data.text() : null;
    },
    async signRead(path) {
      const { data, error } = await supabase.storage.from(ARTIFACTS_BUCKET).createSignedUrl(path, BUILD_SIGN_READ_TTL_SEC);
      return error || !data?.signedUrl ? null : data.signedUrl;
    },
  };

  // Canonicalização dos media capturado (paridade com o builder edge, V5_32
  // Fase A): re-assina por PATH antes do lint; escopo fail-closed da captura.
  const canonicalizeMedia = async (html) => {
    const captureId = await loadLinkedCaptureId(supabase, projectId);
    return canonicalizeCaptureMedia(html, {
      buckets: CAPTURE_MEDIA_BUCKETS,
      ttlSec: CAPTURE_SIGNED_TTL_SEC,
      allowedDirectories: captureId ? [`captures/${captureId}`] : [],
      ...(args.storageHost ? { allowedHosts: [args.storageHost] } : {}),
      async listNames(bucket, prefix) {
        if (!CAPTURE_MEDIA_BUCKETS.includes(bucket)) return null;
        const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
        return error || !data ? null : data.map((row) => row.name);
      },
      async sign(bucket, path, ttlSec) {
        if (!CAPTURE_MEDIA_BUCKETS.includes(bucket)) return null;
        const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, ttlSec);
        return error || !data?.signedUrl ? null : data.signedUrl;
      },
    });
  };

  const llm = createWorkerLlmClient(credentials, { fetchImpl });
  const lint = createEdgeLintRunner();
  const brief = typeof inputs.brief === 'string' ? inputs.brief : undefined;
  const aspectRatio = typeof inputs.aspect_ratio === 'string' ? inputs.aspect_ratio : undefined;

  let result;
  try {
    result = await generateBuildHtmlOnly(
      {
        storage,
        llm,
        lint,
        signRead: storage.signRead,
        canonicalizeMedia,
        perf,
        // A BGM vive na biblioteca vendida do PRÓPRIO worker.
        resolveBgmSrc: (file) => {
          if (!workerOrigin || !/^https?:\/\//i.test(workerOrigin)) return null;
          if (!/^[\w-]+\.mp3$/i.test(file)) return null;
          return `${workerOrigin.replace(/\/+$/, '')}/bgm/${file}`;
        },
      },
      projectId,
      {
        storyboardPath: `projects/${projectId}/STORYBOARD.md`,
        frameMdPath: `projects/${projectId}/frame.md`,
        audioMetaPath: `projects/${projectId}/audio_meta.json`,
        tokensPath: `projects/${projectId}/capture/extracted/tokens.json`,
      },
      brief,
      aspectRatio,
    );
  } catch (err) {
    return { ok: false, error: `BUILD_HTML_FAILED: ${String(err?.message ?? err)}`.slice(0, 300) };
  } finally {
    log(`[build-html.perf] project=${projectId} ${perf.line()}`);
  }
  if (result.ok === false) return { ok: false, error: `BUILD_HTML_FAILED: ${result.error}`.slice(0, 300) };

  const htmlPath = buildHtmlStoragePath(projectId);
  const { error: uploadError } = await supabase.storage
    .from(ARTIFACTS_BUCKET)
    .upload(htmlPath, result.html, { contentType: 'text/html', upsert: true });
  if (uploadError) return { ok: false, error: `BUILD_STORAGE_WRITE_FAILED: ${uploadError.message}`.slice(0, 300) };
  const sha256 = createHash('sha256').update(result.html, 'utf8').digest('hex');
  return {
    ok: true,
    html_path: htmlPath,
    sha256,
    retries: result.retries,
    tokens: result.tokens,
    duration_seconds: result.durationSeconds,
    fallback: result.fallback === true,
    ...(result.fallback ? { fallback_reason: result.fallbackReason ?? 'BUILD_LINT_FAILED' } : {}),
  };
}