/**
 * _steps.ts — V4-2 shared step runner (pure logic, DI)
 *
 * Doc: docs/video-engine/V4_02_SKILLS_PIPELINE.md §4.
 *
 * Cada step LLM (design, storyboard, audio, visual) segue o mesmo fluxo:
 *   1. mark step running no manifesto
 *   2. read previous artifacts from storage
 *   3. build messages (system prompt + skills + project context)
 *   4. call LLM (retry com feedback em falha de validação — V4-3g.1)
 *   5. validate output (zod schema)
 *   6. persist new artifacts to storage
 *   7. mark step done, update manifesto
 *
 * V4-3g.2 (B4): o débito de créditos vive APENAS no orchestrator (fonte
 * única, com refund em falha terminal). Aqui `creditCost` é apenas
 * contabilístico (manifest.credits.spent / by_step).
 *
 * Edge functions (video-v4-designer, etc.) são wrappers finos que criam
 * os adapters (Supabase storage + DB) e delegam a runStep().
 *
 * Testabilidade: todos os collaborators são injetados via StepRunDeps,
 * permitindo mocks completos sob vitest (sem rede, sem Supabase).
 */
import { fetchBuffered } from '../_shared/boundedTransport.ts';
import { scrubTransportText } from '../_shared/contracts/renderJob.ts';
import {
  BRIEF_SUBSTANCE_MISSING,
  briefSubstanceDetail,
  hasBriefSubstance,
} from '../_shared/briefAuthoritative.ts';
import { z } from 'zod';

// Perfil de capacidades do provider — streaming, controlo de thinking, json
// mode, headers de app — resolvido pelo HOSTNAME do URL em vez dos
// `apiUrl.includes('openrouter.ai')` dispersos que misturavam as três
// preocupações num só booleano. Matriz congelada por
// scripts/probe-gemini-compat.mjs (ver _shared/llmProvider.ts).
import { assertModelIdForKind, llmCapability, normalizeReasoningEffort, resolveApiKey } from '../_shared/llmProvider.ts';
import { createVideoLlmFetch } from '../_shared/videoLlmTransport.ts';

// V4-3f.1 (B1/C2): skills-driven prompt composition. Step modules build
// their systemPrompt via composeSystemPrompt — skills injected.
export { composeSystemPrompt } from '../_shared/skills/mod.ts';
// F13.03: re-export do gate para os edges/testes importarem de um só lugar.
export { BRIEF_SUBSTANCE_MISSING } from '../_shared/briefAuthoritative.ts';

// ─── V4-2 credit table (10cr/vídeo) ────────────────────────────────────────
// V4_02_SKILLS_PIPELINE.md §7: capture 0 · design 1 · storyboard 2 ·
// audio 1 · visual 1 · build 4 · finalize 1 = 10cr total.
// Supersedes V4-1 table (build 8, finalize 2, no visual).

export const V4_2_STEPS = ['capture', 'design', 'storyboard', 'audio', 'visual', 'build', 'finalize'] as const;
export type V4_2Step = (typeof V4_2_STEPS)[number];

/** Pipeline steps that run as LLM edge functions (steps 2-4). */
export const LLM_STEPS = ['design', 'storyboard', 'audio', 'visual'] as const;
export type LLMStep = (typeof LLM_STEPS)[number];

export const V4_2_CREDITS: Record<V4_2Step, number> = {
  capture: 0,
  design: 1,
  storyboard: 2,
  audio: 1,
  visual: 1,
  build: 4,
  finalize: 1,
};

// ─── LLM interface ─────────────────────────────────────────────────────────

/**
 * V5_29 Fase C (C2): multimodal user content (OpenRouter vision). Text-only
 * callers keep passing a plain string; steps that attach reference imagery
 * (design: website screenshot + top captured assets) pass a content-parts
 * array. The LLM client forwards it verbatim (OpenRouter chat-completions
 * accepts both shapes).
 */
export type LLMMessageContent =
  | string
  | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: LLMMessageContent;
}

/**
 * V5_29 Fase C (C2): cap on vision images per step call (cost/latency guard —
 * each image adds input tokens inside STEP_LLM_BUDGET_MS).
 */
export const MAX_VISION_IMAGES = 4;

export interface LLMResult {
  content: string;
  tokens: { input: number; output: number };
  /**
   * V5_31 (incidente design 2026-09-17): sinais upstream capturados do stream
   * SSE / resposta one-shot. O parser anterior só lia `delta.content` +
   * `usage` e descartava `error` / `finish_reason` / `native_finish_reason` /
   * `reasoning_tokens` — um mid-stream error (ex. `image_download_failed` do
   * vision) ou um finish `length` com reasoning a comer o budget chegava a
   * jusante como `content: ""` indistinguível, e o runStep reportava o
   * enganador `VALIDATION_FAILED: LLM output is not valid JSON` em vez da
   * causa real. Docs: OpenRouter "Errors and Debugging" (mid-stream errors
   * como SSE data com `error` top-level + `finish_reason:'error'`; chunk
   * final de usage com delta sem content a repetir o finish_reason) e
   * "When no content is generated" (`length` + reasoning_tokens≈completion).
   */
  meta?: LLMStreamMeta;
}

/**
 * V5_31: diagnóstico upstream de uma chamada LLM (stream ou one-shot).
 * Todos os campos opcionais — providers omitem vários em chunks normais.
 */
export interface LLMStreamMeta {
  /** Nº de eventos SSE `data:` JSON processados (excluindo `[DONE]`/comentários). */
  sseEvents?: number;
  /** finish_reason normalizado do OpenRouter (stop|length|content_filter|error|…). */
  finishReason?: string;
  /** finish_reason cru do provider, quando presente. */
  nativeFinishReason?: string;
  /** `error.metadata.error_type` tipado (ex. image_download_failed). */
  errorType?: string;
  /** Código HTTP dentro do corpo do erro (ex. 400/429/502). */
  errorCode?: number;
  /** Mensagem do erro upstream (truncada na origem quando longa). */
  errorMessage?: string;
  /** Tokens de reasoning (usage.completion_tokens_details.reasoning_tokens). */
  reasoningTokens?: number;
  /**
   * Thinking que o provider contabiliza mas não discrimina:
   * `total_tokens - prompt_tokens - completion_tokens`, quando positivo.
   *
   * A camada OpenAI-compat da Google devolve SEMPRE `reasoning_tokens` a null e
   * esconde o thinking dentro de `total_tokens` (probe P3, gemini-3.8-flash:
   * low → 45+89=134=total; high → 45+92=137 mas total=961, delta 824). Sem este
   * campo não há forma de provar que o `reasoning_effort` foi honrado — é o
   * sinal de validação, porque `reasoning_tokens !== 0` nunca chega a sê-lo.
   */
  thinkingTokensDelta?: number;
}

/** Prefixo dos erros lançados quando o upstream termina sem content útil. */
export const LLM_UPSTREAM_ERROR_PREFIX = 'LLM_UPSTREAM_ERROR: ';

/**
 * Thinking que o provider contabiliza mas NÃO discrimina.
 *
 * A camada OpenAI-compat da Google devolve `completion_tokens_details.
 * reasoning_tokens` sempre null e esconde o thinking dentro de `total_tokens`
 * (probe P3, gemini-3.8-flash: effort low → 45+89=134=total; effort high →
 * 45+92=137 mas total=961, delta 824 e 4× mais latência). Sem este delta não há
 * como provar que o `reasoning_effort` foi honrado — `reasoning_tokens !== 0`,
 * que era o sinal previsto, nunca chega a sê-lo neste provider.
 *
 * Devolve null quando já existe um valor explícito (não inventar um segundo
 * sinal por cima do verdadeiro) ou quando a aritmética não fecha.
 */
export function thinkingTokensDelta(
  total: number | null | undefined,
  usage: { input: number; output: number } | null | undefined,
  explicit: number | null | undefined,
): number | null {
  if (typeof explicit === 'number') return null;
  if (typeof total !== 'number' || !usage) return null;
  const delta = total - usage.input - usage.output;
  return delta > 0 ? delta : null;
}

/**
 * V5_31: detalhe honesto para output vazio a partir dos sinais capturados.
 * Usado no throw do parser (erro explícito) e no fail do runStep (vazio sem
 * erro explícito). Nunca vazio — cai em 'LLM returned empty content'.
 */
export function buildUpstreamDetail(meta: LLMStreamMeta | undefined): string {
  const parts: string[] = [];
  if (meta?.errorType) parts.push(`error_type=${meta.errorType}`);
  if (typeof meta?.errorCode === 'number') parts.push(`error_code=${meta.errorCode}`);
  if (meta?.errorMessage) parts.push(meta.errorMessage.slice(0, 200));
  if (meta?.finishReason) parts.push(`finish_reason=${meta.finishReason}`);
  if (meta?.nativeFinishReason) parts.push(`native_finish_reason=${meta.nativeFinishReason}`);
  if (typeof meta?.reasoningTokens === 'number') parts.push(`reasoning_tokens=${meta.reasoningTokens}`);
  if (typeof meta?.thinkingTokensDelta === 'number') parts.push(`thinking_delta=${meta.thinkingTokensDelta}`);
  if (
    meta?.finishReason === 'length' &&
    typeof meta?.reasoningTokens === 'number' &&
    meta.reasoningTokens > 0
  ) {
    parts.push('reasoning exhausted the output budget (OpenRouter: retrying the same request does not help — raise max_tokens or cap reasoning)');
  }
  if (
    meta?.finishReason === 'length' &&
    meta?.reasoningTokens === undefined &&
    typeof meta?.thinkingTokensDelta === 'number' &&
    meta.thinkingTokensDelta > 0
  ) {
    // Variante Gemini do mesmo diagnóstico: o thinking não vem discriminado,
    // mas o delta prova que comeu o orçamento.
    parts.push('thinking exhausted the output budget (provider does not report reasoning_tokens separately — raise max_tokens or lower reasoning_effort)');
  }
  return parts.length > 0 ? parts.join('; ') : 'LLM returned empty content';
}

/** Per-call options (budget-aware runStep passes min(LLM_TIMEOUT_MS, remaining)). */
export interface LLMCallOpts {
  timeoutMs?: number;
}

export interface LLMClient {
  call(messages: LLMMessage[], opts?: LLMCallOpts): Promise<LLMResult>;
}

// ─── Storage adapter (Supabase video-artifacts bucket) ─────────────────────

export interface StorageAdapter {
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  /**
   * C2 (E02): claim condicional — cria só se ausente. `false` = path já
   * existe; erros de transporte continuam a lançar.
   */
  writeTextIfAbsent?(path: string, content: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /**
   * V5-P5A: upload binário (voz TTS real). OPCIONAL — só os passos que
   * materializam ficheiros de áudio o implementam.
   */
  writeBinary?(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** C2 (E02): upload binário imutável — só cria; `false` = já existe. */
  writeBinaryIfAbsent?(path: string, bytes: Uint8Array, contentType: string): Promise<boolean>;
  /**
   * C04.1: leitura binária (ASR word-level sobre o áudio materializado).
   * OPCIONAL — só o passo de áudio a implementa.
   */
  readBinary?(path: string): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

// ─── DB adapter (minimal for step execution) ───────────────────────────────

export interface StepState {
  status: string;
  artifacts: string[];
  error?: string;
  /**
   * V5 bugfix (órfãos): carimbado pelo orchestrator (markRunning) e
   * PRESERVADO pelo runStep — sem isto, o rewrite running da step apagava o
   * started_at e o /retry tratava um step genuinamente a correr como órfão
   * (retry duplo com duplo débito).
   */
  started_at?: string;
  /** F13: sha256 do brief exato que este step recebeu (auditoria). */
  brief_sha256?: string;
}

export interface StepManifest {
  steps: Record<string, StepState>;
  credits: { spent: number; by_step: Record<string, number> };
  brief?: string;
  brief_sha256?: string;
  brief_revision?: number;
}

export interface StepDbAdapter {
  getProject(projectId: string): Promise<{ id: string; user_id: string; manifest: unknown; metadata?: unknown } | null>;
  updateManifest(projectId: string, manifest: StepManifest): Promise<void>;
  // V4-3g.2 (B4): deductCredits removido — o orchestrator é a única fonte
  // de débito (o step debitava em dobro).
}

// ─── Step configuration ────────────────────────────────────────────────────

export interface StepConfig {
  /** Step name (design, storyboard, audio, visual). */
  name: string;
  /** Credit cost for this step. */
  creditCost: number;
  /** Paths of artifacts from previous steps to read from storage. */
  inputPaths: string[];
  /** System prompt (compose via composeSystemPrompt — skills injected). */
  systemPrompt: string;
  /** Build user message from project brief + input artifacts. */
  buildUserMessage(brief: string, inputs: Record<string, string>, ctx?: { metadata?: unknown }): string;
  /**
   * V5_29 Fase C (C2): optional vision URLs attached to the user message as
   * `image_url` parts (OpenRouter vision). Best-effort: empty/undefined means
   * text-only (the step proceeds without vision, never failing). Only the
   * design step sets this (storyboard/visual/build stay text-only — cost).
   */
  buildVisionUrls?: (brief: string, inputs: Record<string, string>) => string[];
  /** Zod schema to validate LLM output. */
  outputSchema: z.ZodType<Record<string, unknown>>;
  /** Extract artifact files from validated output. */
  extractArtifacts(output: Record<string, unknown>): Record<string, string>;
  /**
   * V4-3g.1: retries on JSON-parse / Zod validation failure, re-calling the
   * LLM with the issues as feedback. Default 1 (one retry). LLM transport
   * errors (throws) get a separate single TRANSPORT retry (V5 bugfix) that
   * does NOT consume validation attempts.
   */
  maxValidationRetries?: number;
}

// ─── Dependencies (injected for testability) ───────────────────────────────

export interface StepRunDeps {
  db: StepDbAdapter;
  storage: StorageAdapter;
  llm: LLMClient;
  now?: () => number;
  id?: () => string;
}

// ─── Result types ──────────────────────────────────────────────────────────

export type StepResult =
  | { ok: true; artifacts: string[]; tokens: { input: number; output: number } }
  // V4-3g.2 (B5): `detail` carrega os zod issues / mensagem de erro para o
  // wrapper devolver ao orchestrator (erro fiel no manifesto).
  | { ok: false; status: number; code: string; detail?: string };

// ─── Step runner ───────────────────────────────────────────────────────────

/**
 * Execute a single LLM pipeline step.
 *
 * Flow:
 *   1. Load project + manifest
 *   2. Mark step running
 *   3. Read input artifacts from storage
 *   4. Call LLM (system + user messages), retrying with feedback on
 *      JSON-parse / Zod validation failure (maxValidationRetries)
 *   5. Write output artifacts to storage
 *   6. Mark step done, update manifest (credits accounting only — the
 *      orchestrator owns debit + terminal-failure refund, V4-3g.2/B4)
 *
 * On any failure: mark step failed in manifest and return the error code
 * plus `detail` (zod issues / LLM error message) for the orchestrator.
 */
export async function runStep(
  deps: StepRunDeps,
  projectId: string,
  config: StepConfig,
): Promise<StepResult> {
  const project = await deps.db.getProject(projectId);
  if (!project) return { ok: false, status: 404, code: 'NOT_FOUND' };

  const manifest = project.manifest as StepManifest;
  if (!manifest?.steps) return { ok: false, status: 400, code: 'INVALID_MANIFEST' };

// 1. Mark running — PRESERVA started_at carimbado pelo orchestrator
    // (V5 bugfix órfãos: apagá-lo fazia o /retry considerar este run um órfão
    // durante TODA a chamada LLM → retry duplo com duplo débito).
    const previousState = manifest.steps[config.name] as StepState | undefined;
    manifest.steps[config.name] = {
      status: 'running',
      artifacts: [],
      error: undefined,
      started_at: previousState?.started_at ?? new Date((deps.now ?? Date.now)()).toISOString(),
    };
    await deps.db.updateManifest(projectId, manifest);

  // V4-3g.2 (B4): sem débito aqui — o orchestrator debita uma única vez
  // (runLLMStep) e faz refund em falha terminal. `creditCost` só alimenta
  // a contabilidade do manifesto no mark-done.

  try {
    // 3. Read input artifacts
    // V4-3g.1: artifacts are written under projects/{id}/ (step 6 below) —
    // reads must use the same prefix. The `inputs` map keeps the RAW path as
    // key so buildUserMessage implementations stay unchanged.
    // V5.1: leituras em PARALELO — cada read de storage custa 0.5-3s; com
    // 3-5 inputs o caminho sequencial consumia 5-10s do orçamento LLM.
    const inputPaths = config.inputPaths;
    const inputValues = await Promise.all(
      inputPaths.map((path) => deps.storage.readText(`projects/${projectId}/${path}`)),
    );
    const inputs: Record<string, string> = {};
    inputPaths.forEach((path, i) => {
      const content = inputValues[i];
      if (content !== null) inputs[path] = content;
    });

    // 4. Build messages and call LLM
    // F13.03: gate de substância ANTES de qualquer chamada LLM — sem
    // `original_request` + (resolved com objective/offer/cta/summary OU
    // captura com substância), o step falha explícito
    // `BRIEF_SUBSTANCE_MISSING` (400, sem débito: o orchestrator refunda e
    // aqui nenhum LLM é chamado). O fallback genérico silencioso pré-F13 foi
    // removido: nunca renderizar conteúdo genérico sem brief.
    const briefCheck = requireBriefSubstance(manifest, inputs);
    if (briefCheck.ok === false) {
      manifest.steps[config.name] = {
        status: 'failed',
        artifacts: [],
        error: `${BRIEF_SUBSTANCE_MISSING}: ${briefCheck.detail.slice(0, 200)}`,
        started_at: previousState?.started_at,
      };
      await deps.db.updateManifest(projectId, manifest);
      return { ok: false, status: 400, code: BRIEF_SUBSTANCE_MISSING, detail: briefCheck.detail.slice(0, 500) };
    }
    const brief = briefCheck.brief;
    // F13: auditoria — o report do step referencia o brief recebido.
    manifest.steps[config.name] = {
      status: 'running',
      artifacts: [],
      error: undefined,
      started_at: previousState?.started_at ?? new Date((deps.now ?? Date.now)()).toISOString(),
      ...(manifest.brief_sha256 ? { brief_sha256: manifest.brief_sha256 } : {}),
    };
    await deps.db.updateManifest(projectId, manifest);
    // F12-voz: metadados do projeto (effective_config) para builders que
    // precisam do alvo real (ex.: storyboard honra duration_seconds).
    const userText = config.buildUserMessage(brief, inputs, { metadata: (project as { metadata?: unknown }).metadata });
    // V5_29 Fase C (C2): vision — screenshot + top assets as image_url parts
    // (best-effort: no URLs → text-only, the step proceeds unchanged).
    // V5_31: best-effort REAL — se o upstream falhar com vision anexado
    // (erro de imagem mid-stream / output vazio com finish error/length), o
    // runStep repete UMA vez text-only (textOnlyMessages) em vez de falhar
    // ou de repetir o mesmo payload vision que já falhou de forma
    // determinística (incidente design 2026-09-17: sse_events=1,
    // content_bytes=0 nas 2 tentativas, ambas com as 4 imagens).
    let userContent: LLMMessageContent = userText;
    try {
      const visionUrls = (config.buildVisionUrls?.(brief, inputs) ?? [])
        .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        .slice(0, MAX_VISION_IMAGES);
      if (visionUrls.length > 0) {
        console.log(`[runStep:${config.name}] vision: ${visionUrls.length} image(s) attached (best-effort)`);
        userContent = [
          { type: 'text', text: userText },
          ...visionUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ];
      }
    } catch (err) {
      console.warn(`[runStep:${config.name}] buildVisionUrls failed — proceeding text-only:`, String((err as Error)?.message ?? err).slice(0, 200));
    }
    let messages: LLMMessage[] = [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: userContent },
    ];
    // V5_31: fallback pré-construído (sistema + texto puro, sem image_url).
    const textOnlyMessages: LLMMessage[] | null = Array.isArray(userContent)
      ? [
        { role: 'system', content: config.systemPrompt },
        { role: 'user', content: userText },
      ]
      : null;
    let visionStripped = false;

    // 5. Call + validate, retrying with the validation issues as feedback
    //    (V4-3g.1). A single malformed LLM response must not kill the pipeline.
    //
    // V5 bugfix (504 IDLE_TIMEOUT no designer): a plataforma Supabase mata a
    // edge fn aos 150s wall-clock por REQUEST — o retry de validação V4-3g.1
    // disparava uma 2.ª chamada LLM (até LLM_TIMEOUT_MS) que, somada à 1.ª,
    // estourava esse teto → 504 IDLE_TIMEOUT e o step morria sem estado final
    // próprio. O loop corre agora contra um ORÇAMENTO partilhado
    // (STEP_LLM_BUDGET_MS < 150s) com timeout POR CHAMADA (min(LLM_TIMEOUT_MS,
    // restante)); quando o orçamento acaba, o step falha honestamente com
    // VALIDATION_FAILED (o orchestrator refunda) em vez de ser morto pela
    // plataforma.
    const maxRetries = config.maxValidationRetries ?? 1;
    const clock = deps.now ?? Date.now;
    const llmDeadline = clock() + STEP_LLM_BUDGET_MS;
    let validated: z.SafeParseSuccess<Record<string, unknown>> | null = null;
    let lastIssues = '';
    let budgetNote = '';
    let lastRaw = '';
    let tokens = { input: 0, output: 0 };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const remaining = llmDeadline - clock();
      if (remaining < MIN_LLM_CALL_SLICE_MS) {
        budgetNote = `LLM_BUDGET_EXHAUSTED: ${STEP_LLM_BUDGET_MS / 1000}s wall-clock budget reached before attempt ${attempt + 1}`;
        console.warn(`[runStep:${config.name}] ${budgetNote}`);
        break;
      }
      // V5 bugfix: 1 retry transiente de TRANSPORTE (stall/5xx/timeout do
      // fetch) — os erros de validação têm o retry V4-3g.1 abaixo; um stall
      // de rede não devia ser terminal. Bounded: cada chamada usa no máximo
      // o restante do orçamento (STEP_LLM_BUDGET_MS < teto de 150s da
      // plataforma), pelo que o pior caso cabe SEMPRE no request.
      const callTimeoutMs = Math.min(LLM_TIMEOUT_MS, remaining);
      let llmResult;
      try {
        llmResult = await deps.llm.call(messages, { timeoutMs: callTimeoutMs });
      } catch (err) {
        const remainingAfter = llmDeadline - clock();
        if (remainingAfter < MIN_LLM_CALL_SLICE_MS) {
          throw err; // sem orçamento para o retry de transporte — propaga (LLM_ERROR honesto)
        }
        const msg = err instanceof Error ? err.message : String(err);
        // V5_31: erro upstream explícito (mid-stream error, finish error)
        // com vision anexado — repetir o MESMO payload falha de forma
        // determinística (prova: incidente 2026-09-17, 2× 0 bytes). O retry
        // desta via despe as imagens (fallback text-only, 1×); erros de
        // transporte clássicos (timeout/stall) mantêm o retry idêntico.
        //
        // 2026-10-06 (migração Gemini): o mesmo raciocínio aplica-se a um 4xx
        // REAL. Antes só o prefixo LLM_UPSTREAM_ERROR (HTTP 200 + 0 bytes)
        // disparava o fallback; um `400 Unsupported url` do provider ao buscar
        // uma imagem caía no retry idêntico e falhava outra vez, com a mesma
        // certeza e gastando o orçamento. As imagens são a única diferença
        // entre os dois payloads. Só erros que identificam imagem/URL/media
        // permitem esse fallback; autenticação, billing, modelo e rate limit
        // mantêm a causa real e não são tratados como problemas de visão.
        const visionSuspect = msg.startsWith(LLM_UPSTREAM_ERROR_PREFIX)
          || (/LLM API error: (400|413|415|422)\b/.test(msg) && /image|vision|url|media/i.test(msg));
        if (visionSuspect && !visionStripped && textOnlyMessages !== null) {
          visionStripped = true;
          messages = textOnlyMessages;
          console.warn(`[runStep:${config.name}] vision upstream error, retrying text-only without images: ${msg.slice(0, 200)}`);
          llmResult = await deps.llm.call(messages, { timeoutMs: Math.min(LLM_TIMEOUT_MS, remainingAfter) });
        } else {
          console.warn(`[runStep:${config.name}] LLM transport error, retrying once: ${msg.slice(0, 200)}`);
          llmResult = await deps.llm.call(messages, { timeoutMs: Math.min(LLM_TIMEOUT_MS, remainingAfter) });
        }
      }
      tokens = llmResult.tokens;
      lastRaw = llmResult.content;

      // V5_31: output vazio NUNCA entra no caminho de validação — o feedback
      // "fix the JSON" sobre 0 bytes é inútil e produzia o VALIDATION_FAILED
      // enganador do incidente (o problema é upstream, não schema). Com
      // vision: 1 fallback text-only; sem vision (ou fallback já usado):
      // falha honesta LLM_ERROR 500 com o detalhe upstream (o orchestrator
      // refunda como em qualquer falha terminal).
      if (lastRaw.trim().length === 0) {
        if (!visionStripped && textOnlyMessages !== null) {
          const remainingForFallback = llmDeadline - clock();
          if (remainingForFallback >= MIN_LLM_CALL_SLICE_MS) {
            visionStripped = true;
            messages = textOnlyMessages;
            console.warn(`[runStep:${config.name}] empty LLM output with vision attached (${buildUpstreamDetail(llmResult.meta).slice(0, 200)}) — retrying text-only without images`);
            llmResult = await deps.llm.call(messages, { timeoutMs: Math.min(LLM_TIMEOUT_MS, remainingForFallback) });
            tokens = llmResult.tokens;
            lastRaw = llmResult.content;
          }
        }
        if (lastRaw.trim().length === 0) {
          const emptyDetail = buildUpstreamDetail(llmResult.meta).slice(0, 500);
          console.error(`[runStep:${config.name}] LLM_EMPTY_CONTENT:`, emptyDetail);
          manifest.steps[config.name] = {
            status: 'failed',
            artifacts: [],
            error: `LLM_ERROR: ${emptyDetail.slice(0, 200)}`,
            ...(manifest.brief_sha256 ? { brief_sha256: manifest.brief_sha256 } : {}),
          };
          await deps.db.updateManifest(projectId, manifest);
          return { ok: false, status: 500, code: 'LLM_ERROR', detail: emptyDetail };
        }
      }

      let output: Record<string, unknown> | null = null;
      let parseIssue: string | null = null;
      try {
        output = JSON.parse(llmResult.content) as Record<string, unknown>;
      } catch {
        // LLM returned non-JSON — try to extract JSON from markdown code block
        const jsonMatch = llmResult.content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (jsonMatch) {
          try {
            output = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
          } catch {
            parseIssue = 'LLM output is not valid JSON (markdown block also unparseable)';
          }
        } else {
          parseIssue = 'LLM output is not valid JSON';
        }
      }

      if (output !== null) {
        const parsed = config.outputSchema.safeParse(output);
        if (parsed.success) {
          validated = parsed;
          break;
        }
        lastIssues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      } else {
        lastIssues = parseIssue ?? 'LLM output is not valid JSON';
      }

      if (attempt < maxRetries) {
        console.warn(`[runStep:${config.name}] validation attempt ${attempt + 1} failed, retrying with feedback:`, lastIssues);
        messages.push(
          { role: 'assistant', content: lastRaw.slice(0, 4000) },
          {
            role: 'user',
            content: `## Previous attempt failed validation:\n${lastIssues}\n\nReturn ONLY the corrected JSON object, fixing every issue above.`,
          },
        );
      }
    }

    if (!validated) {
      // V5 bugfix: quando o orçamento wall-clock acabou, o erro carrega a
      // nota LLM_BUDGET_EXHAUSTED — diagnóstico fiel em vez de 504 da
      // plataforma. Cap 500 (padrão stepFailureDetail do orchestrator).
      const failureDetail = [lastIssues, budgetNote].filter(Boolean).join('; ') || 'LLM output is not valid JSON';
      console.error(`[runStep:${config.name}] VALIDATION_FAILED:`, failureDetail);
      console.error(`[runStep:${config.name}] Raw LLM output (first 500 chars):`, lastRaw.slice(0, 500));
      manifest.steps[config.name] = {
        status: 'failed',
        artifacts: [],
        error: `VALIDATION_FAILED: ${failureDetail.slice(0, 500)}`,
        ...(manifest.brief_sha256 ? { brief_sha256: manifest.brief_sha256 } : {}),
      };
      await deps.db.updateManifest(projectId, manifest);
      return { ok: false, status: 422, code: 'VALIDATION_FAILED', detail: failureDetail.slice(0, 500) };
    }

    // 6. Write artifacts to storage
    // V5.1: writes em PARALELO (mesma razão das leituras — I/O não pode
    // comer o orçamento nem empurrar o request para o teto wall-clock).
    const artifactMap = config.extractArtifacts(validated.data);
    const artifactEntries = Object.entries(artifactMap);
    await Promise.all(
      artifactEntries.map(([path, content]) =>
        deps.storage.writeText(`projects/${projectId}/${path}`, content)
      ),
    );
    const artifactPaths = artifactEntries.map(([path]) => path);

    // 7. Mark done (F13: preserva o brief_sha da auditoria).
    manifest.steps[config.name] = {
      status: 'done',
      artifacts: artifactPaths,
      ...(manifest.brief_sha256 ? { brief_sha256: manifest.brief_sha256 } : {}),
    };
    manifest.credits.spent += config.creditCost;
    manifest.credits.by_step[config.name] = (manifest.credits.by_step[config.name] ?? 0) + config.creditCost;
    await deps.db.updateManifest(projectId, manifest);

    return {
      ok: true,
      artifacts: artifactPaths,
      tokens,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    manifest.steps[config.name] = {
      status: 'failed',
      artifacts: [],
      error: `LLM_ERROR: ${msg.slice(0, 200)}`,
      ...(manifest.brief_sha256 ? { brief_sha256: manifest.brief_sha256 } : {}),
    };
    await deps.db.updateManifest(projectId, manifest);
    return { ok: false, status: 500, code: 'LLM_ERROR', detail: msg.slice(0, 500) };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * F13.03: exige o brief autoritativo com substância.
 *
 * O fallback genérico silencioso pré-F13 (`Project brief: create a
 * promotional video…`) foi removido: sem `manifest.brief` com substância
 * (pedido original + resolved com objective/offer/cta/summary OU captura com
 * substância), o step falha explícito `BRIEF_SUBSTANCE_MISSING` antes de
 * qualquer chamada LLM (sem débito — o orchestrator refunda o débito
 * prévio; aqui nenhum LLM é sequer chamado).
 *
 * Exportado para os testes F13-T01/T02 (congelamento da reprodução).
 */
export function requireBriefSubstance(
  manifest: StepManifest,
  inputs?: Record<string, string>,
): { ok: true; brief: string } | { ok: false; detail: string } {
  const raw = (manifest as unknown as Record<string, unknown>).brief;
  const brief = typeof raw === 'string' ? raw : null;
  if (!brief || !hasBriefSubstance(brief, inputs)) {
    return { ok: false, detail: briefSubstanceDetail(brief, inputs) };
  }
  return { ok: true, brief };
}

/**
 * Legado pré-F13: mantido como alias fino para os testes que o importavam.
 * Agora FALHA em vez de devolver fallback genérico (nunca silencioso).
 */
export function extractBrief(manifest: StepManifest): string {
  const checked = requireBriefSubstance(manifest);
  if (checked.ok === false) {
    throw new Error(`${BRIEF_SUBSTANCE_MISSING}: ${checked.detail}`);
  }
  return checked.brief;
}

// ─── Default LLM client (kie.ai / OpenRouter compatible) ───────────────────

/**
 * Hard timeout per LLM call (V5 bugfix E2E): sem isto, um provider que
 * abra a ligação e nunca responda deixa o step `running` para sempre — a
 * edge fn é morta pela plataforma (shutdownHttp) e o manifesto nunca
 * recebe `failed` (sem erro na UI, sem refund). AbortController próprio
 * (em vez de AbortSignal.timeout) para a deteção do abort ser
 * determinística em qualquer runtime — o nome/message do DOMException
 * varia entre Deno e Node ("Signal timed out" vs "This operation was
 * timed out").
 */
export const LLM_TIMEOUT_MS = 300_000;

/**
 * V5 bugfix (504 IDLE_TIMEOUT no designer): teto WALL-CLOCK do loop LLM
 * completo (1.ª chamada + retry de validação V4-3g.1 + retries de
 * transporte). Cada chamada individual usa min(LLM_TIMEOUT_MS, restante do
 * orçamento).
 *
 * V5.1 (2026-08-29): 110s → 300s. Com reasoning effort `high` o
 * glm-5.3-flash gera 5000+ tokens a ~48 tok/s (medido 109.8s ainda a
 * gerar quando o abort de 110s matou o request — OpenRouter "cancelled").
 * As functions video-v4-* são deployadas com max_duration = 390s (planos
 * pagos permitem até 400s), por isso 300s + I/O cabe com folga. Se a
 * plataforma matar aos 150s (plano Free), o manifest fica órfão em running
 * — o /retry do orchestrator recupera (não há débito duplo, V5 órfãos fix).
 */
export const STEP_LLM_BUDGET_MS = 300_000;

/**
 * Abaixo disto não vale iniciar uma nova chamada LLM (nenhuma geração útil
 * cabe) — o loop termina com o último resultado/erro honesto.
 */
export const MIN_LLM_CALL_SLICE_MS = 20_000;

/**
 * Create an LLM client that calls an OpenAI-compatible chat completions API.
 * O provider (Google Gemini, OpenRouter, kie.ai, outro compatível) decide-se pelo
 * HOSTNAME do URL — ver `_shared/llmProvider.ts`. Nada de vendor no código.
 *
 * Env: LLM_API_URL (REQUIRED — sem default hardcoded, auditoria env-only
 *                 2026-10-06; em falta, LLM_CONFIG nomeia a variável)
 *      chave      (REQUIRED — resolvida pelo perfil: Gemini → GEMINI_API_KEY
 *                 → LLM_API_KEY; OpenRouter → LLM_API_KEY → OPENROUTER_API_KEY
 *                 → KIE_API_KEY)
 *      LLM_MODEL (REQUIRED — sem default hardcoded, auditoria env-only
 *                 2026-09-25; em falta, a chamada falha com erro de config claro.
 *                 O namespace tem de bater certo com o URL: `gemini-3.8-flash`
 *                 na Google, `autor/slug:sufixo` no OpenRouter)
 *      LLM_REASONING_EFFORT (default: high — normalizado por provider; o enum da
 *                            Google é low|medium|high e `minimal`/`none`/`xhigh`
 *                            são clampados com aviso, porque um 400 no gate de
 *                            humanos bloquearia todas as cenas)
 *
 * Per-step model overrides (optional):
 *      LLM_MODEL_DESIGN    → overrides model for step 2 (designer)
 *      LLM_MODEL_STORYBOARD → overrides model for step 3 (storyboarder)
 *      LLM_MODEL_AUDIO     → overrides model for step 3.1 (audio)
 *      LLM_MODEL_VISUAL    → overrides model for step 4 (visual)
 */
/**
 * Leitura de env dual-runtime (padrão resolveChatLlmTimeoutMs do chat): Deno
 * edge devolve a secret; Node/vitest sem Deno devolve '' — permite exercitar
 * o fail-fast de config nos testes sem mock de globals.
 */
function readStepEnv(name: string): string {
  try {
    if (typeof Deno !== 'undefined') return Deno.env.get(name) ?? '';
  } catch {
    // Node/vitest sem Deno.
  }
  return '';
}

export function createLLMClient(opts?: {
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  /** Reasoning effort para OpenRouter (default 'high'; env LLM_REASONING_EFFORT). */
  reasoningEffort?: string;
  /**
   * V5_16 Fase B: teto de tokens de conclusão (body.max_tokens). OPT-IN —
   * sem teto a saída é ilimitada (comportamento histórico). Nunca definir
   * abaixo do p95 medido (telemetria `tokens` no manifesto): um teto curto
   * trunca o JSON e o step morre em VALIDATION_FAILED.
   */
  maxTokens?: number;
  /**
   * V5_16.1 (incidente build 2026-09-02): omite `response_format: json_object`.
   * O build prompt pede HTML cru — com json_object forçado o glm-5.3-flash
   * gasta TODOS os tokens em reasoning e entrega 0 bytes de content (prova
   * ao vivo: diag-openrouter-deltas.mjs). Default false (steps JSON mantêm).
   */
  omitResponseFormat?: boolean;
  /**
   * Opt-out do fallback Gemini do transporte (`createVideoLlmFetch` group=false).
   * O builder dona da sua própria política de fallback (retries encadeados pelo
   * orquestrador + fallback determinístico do storyboard): a reserva de 30s do
   * transporte para o Gemini compra uma geração de build que nunca caberia nela,
   * e rouba esse tempo à primária numa chamada medida a ~286s.
   */
  videoFallback?: boolean;
  /**
   * Timeout default do cliente (ms). Um `timeoutMs` por chamada continua a
   * vencer. O builder usa 360s — o budget-aware do runStep passa sempre o seu
   * próprio min(LLM_TIMEOUT_MS, restante).
   */
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): LLMClient {
  // Auditoria env-only 2026-10-06: nem o URL nem a chave têm default no código.
  // Um URL em falta é um erro de configuração nomeado, não uma chamada para um
  // vendor que alguém escolheu há um ano.
  const rawUrl = opts?.apiUrl ?? readStepEnv('LLM_API_URL');
  if (!rawUrl) throw new Error('LLM_CONFIG: no LLM endpoint configured — set LLM_API_URL');
  const apiUrl = rawUrl.replace(/\/+$/, '');
  const cap = llmCapability(apiUrl);
  const apiKey = opts?.apiKey ?? resolveApiKey(cap.kind);
  const model = opts?.model ?? readStepEnv('LLM_MODEL');
  const fetcher = opts?.fetcher ?? fetch;
  const maxTokens = opts?.maxTokens;
  const omitResponseFormat = opts?.omitResponseFormat === true;
  const videoFallback = opts?.videoFallback !== false;
  const clientTimeoutMs = opts?.timeoutMs;
  // V5 bugfix (LLM_TIMEOUT no design): o glm-5.3-flash TEM reasoning
  // obrigatório ("Reasoning is mandatory for this endpoint") e SEM param
  // explícito o nº de thinking tokens varia de ~700 a 5749 (totais medidos
  // 26s a 90s+, 1/3 dos requests nunca abrem em 120s — queue do provider).
  // Com reasoning.effort explícito o OpenRouter encaminha para um endpoint
  // com budget de thinking determinístico (medido 4/4 ok: primeiro byte
  // ≤4s, totais 10-50s, ~1600 completion tokens).
  const rawEffort = opts?.reasoningEffort ?? (readStepEnv('LLM_REASONING_EFFORT') || 'high');
  // O enum aceite difere por provider e o valor errado NÃO é ignorado: a Google
  // recusa `minimal`/`none` com HTTP 400 "Thinking level … is not supported"
  // (probe P3c), e o gate de humanos é fail-closed num 4xx — um esforço fora do
  // enum parado no env bloquearia todas as cenas. Normaliza por kind, com aviso.
  const reasoningEffort = normalizeReasoningEffort(cap.kind, rawEffort);
  // Com stream:true os bytes fluem DURANTE o thinking (sem buffering de
  // proxy/idle), o acumulador termina com o conteúdo e o usage vem no chunk
  // final. Quem decide é o PERFIL, não o vendor: o Gemini passou no probe P1b
  // com stream + stream_options.include_usage (o OpenRouter já o fazia); o
  // kie.ai mantém o caminho one-shot JSON.
  // Nota: o streaming NÃO é o que protege do IDLE_TIMEOUT de 150s — é o
  // stepKeepAlive do chamador. Aqui ele compra usage e progresso.
  const useStream = cap.stream;

  return {
    async call(messages: LLMMessage[], opts?: LLMCallOpts): Promise<LLMResult> {
      // Auditoria env-only 2026-09-25: sem default hardcoded — falha honesta
      // e clara quando LLM_MODEL (ou LLM_MODEL_<STEP>) não está configurado.
      if (!model) throw new Error('LLM model not configured — set LLM_MODEL (or LLM_MODEL_<STEP>)');
      // Ids não são portáveis entre providers (`autor/slug:free` vs
      // `gemini-3.8-flash`). Apontar o URL à Google sem trocar os ids dava 404
      // em cada cena; falha aqui, nomeando o ficheiro de env a corrigir.
      assertModelIdForKind(cap.kind, model);
      const body: Record<string, unknown> = { model, messages };
      // V5_16 Fase B: teto de saída opt-in (latência — cada token de conclusão
      // é tempo de geração; 10 683 tokens medidos no visual = 156.7s).
      if (typeof maxTokens === 'number' && maxTokens > 0) {
        body.max_tokens = maxTokens;
      }
      // Controlo de thinking POR PERFIL. Os três shapes são mutuamente
      // exclusivos e enviar o errado não é inócuo: a camada OpenAI-compat da
      // Google RECUSA `reasoning:{effort}` com HTTP 400 (probe P3b), portanto o
      // shape tem de vir do perfil do URL e nunca de um teste ao vendor.
      if (cap.thinking === 'think') {
        body.think = 'high'; // mandatory per kie.ai spec
      } else if (reasoningEffort) {
        if (cap.thinking === 'reasoning-object') body.reasoning = { effort: reasoningEffort };
        else if (cap.thinking === 'reasoning-effort') body.reasoning_effort = reasoningEffort;
      }
      // V5_16.1: o builder omite — json_object forçado faz o modelo gastar
      // todos os tokens em reasoning e devolver content vazio (0 bytes).
      // `cap.jsonMode` porque um provider que ignore o campo não muda nada, mas
      // um que o recuse rebenta a chamada (probe P1: a Google honra-o).
      if (!omitResponseFormat && cap.jsonMode) {
        body.response_format = { type: 'json_object' };
      }
      if (useStream) {
        body.stream = true;
        body.stream_options = { include_usage: true }; // usage no chunk final
      }
      if (cap.routing) {
        // V5.1 (2026-08-29): o routing default do OpenRouter escolheu a
        // Novita para o glm-5.3-flash — 48.8 tok/s medidos: 5360+ tokens de
        // thinking obrigatório ainda a gerar quando o orçamento matou o
        // request (110s), e gerações deste porte passam o teto wall-clock.
        // sort=throughput encaminha para o provider com MAIOR vazão → as
        // gerações longas concluem dentro do limite da plataforma.
        // Só OpenRouter: `provider` é um campo dessa API e a Google recusa
        // corpo fora do seu whitelist.
        body.provider = { sort: 'throughput' };
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      // OpenRouter recommends these headers for app identification
      if (cap.appHeaders) {
        headers['HTTP-Referer'] = 'https://visttapro.com';
        headers['X-Title'] = 'VisttaPro Video Engine V4';
      }

      // V5 bugfix: timeout por chamada — o runStep budget-aware passa
      // min(LLM_TIMEOUT_MS, restante do orçamento) para respeitar o teto
      // wall-clock de 150s da plataforma.
      //
      // V5 bugfix (504 IDLE_TIMEOUT no storyboarder): o timer cobre o CICLO
      // COMPLETO da chamada — fetch + status + leitura do body. Um stall do
      // provider depois dos headers (ligação aberta sem bytes = "idle")
      // pendurava res.json() para lá do orçamento e a plataforma matava a
      // edge fn aos 150s com o step órfão em running.
      const timeoutMs = opts?.timeoutMs ?? clientTimeoutMs ?? LLM_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchBuffered(createVideoLlmFetch(fetcher, videoFallback ? 'LLM' : false, timeoutMs), `${apiUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }, timeoutMs, 8 * 1024 * 1024);
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          throw new Error(`LLM API error: ${res.status} ${errBody}`);
        }
        if (useStream) {
          if (!res.body) throw new Error('LLM API error: streaming response has no body');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          // V5_16 follow-up (incidente CPU 2026-09-02): o teto de CPU da
          // plataforma é 2s POR REQUEST e este loop corre uma vez por evento
          // SSE — milhares por chamada, até 4 chamadas por build (retries de
          // lint). Versão otimizada: deltas em array + join único (sem risco
          // de flatten quadrático do `content +=`), sem trim() regex por
          // linha (só \r e um espaço opcionais), `pending` mínimo por chunk.
          const parts: string[] = [];
          let pending = '';
          let usage: { input: number; output: number } | null = null;
          let sseEvents = 0;
          // V5_31: sinais upstream (ver LLMStreamMeta) — sem isto, um
          // mid-stream error ou finish length/error chegava como "" mudo.
          // Só escalares por evento (caminho quente: milhares por chamada).
          let finishReason: string | null = null;
          let nativeFinishReason: string | null = null;
          let errType: string | null = null;
          let errCode: number | null = null;
          let errMsg: string | null = null;
          let reasoningTokens: number | null = null;
          let totalTokens: number | null = null;
          const streamStartedAt = Date.now();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = pending.indexOf('\n')) >= 0) {
              let line = pending.slice(0, nl);
              pending = pending.slice(nl + 1);
              if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // CRLF
              // Linhas não `data:` são comentários SSE do OpenRouter
              // (ex. ": OPENROUTER PROCESSING") ou separadores — ignorar.
              if (!line.startsWith('data:')) continue;
              let payload = line.slice(5);
              if (payload.charCodeAt(0) === 32) payload = payload.slice(1); // espaço opcional pós "data:"
              if (!payload || payload === '[DONE]') continue;
              sseEvents += 1;
              try {
                const chunk = JSON.parse(payload) as {
                  choices?: Array<{
                    delta?: { content?: string };
                    finish_reason?: string | null;
                    native_finish_reason?: string | null;
                    error?: { code?: number; message?: string; metadata?: { error_type?: string } };
                  }>;
                  error?: { code?: number; message?: string; metadata?: { error_type?: string } };
                  usage?: {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    total_tokens?: number;
                    completion_tokens_details?: { reasoning_tokens?: number };
                  };
                };
                // V5_31: erro top-level do mid-stream error (docs OpenRouter).
                const topErr = chunk.error;
                if (topErr && errMsg === null) {
                  if (typeof topErr.code === 'number') errCode = topErr.code;
                  if (typeof topErr.message === 'string' && topErr.message) errMsg = topErr.message;
                  const t = topErr.metadata?.error_type;
                  if (typeof t === 'string' && t) errType = t;
                }
                const c0 = chunk.choices?.[0];
                // V5_31: erro ao nível do choice (variante non-stream/mid-stream).
                const choiceErr = c0?.error;
                if (choiceErr && errMsg === null) {
                  if (typeof choiceErr.code === 'number') errCode = choiceErr.code;
                  if (typeof choiceErr.message === 'string' && choiceErr.message) errMsg = choiceErr.message;
                  const t = choiceErr.metadata?.error_type;
                  if (typeof t === 'string' && t) errType = t;
                }
                if (typeof c0?.finish_reason === 'string' && c0.finish_reason) finishReason = c0.finish_reason;
                if (typeof c0?.native_finish_reason === 'string' && c0.native_finish_reason) nativeFinishReason = c0.native_finish_reason;
                const delta = c0?.delta?.content;
                if (delta) parts.push(delta);
                if (chunk.usage) {
                  usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
                  const rt = chunk.usage.completion_tokens_details?.reasoning_tokens;
                  if (typeof rt === 'number') reasoningTokens = rt;
                  if (typeof chunk.usage.total_tokens === 'number') totalTokens = chunk.usage.total_tokens;
                }
              } catch {
                // payload data: malformado — chunk isolado, o resto do stream continua
              }
            }
          }
          clearTimeout(timer);
          const content = parts.join('');
          const thinkDelta = thinkingTokensDelta(totalTokens, usage, reasoningTokens);
          const meta: LLMStreamMeta = {
            sseEvents,
            ...(finishReason !== null ? { finishReason } : {}),
            ...(nativeFinishReason !== null ? { nativeFinishReason } : {}),
            ...(errType !== null ? { errorType: errType } : {}),
            ...(errCode !== null ? { errorCode: errCode } : {}),
            ...(errMsg !== null ? { errorMessage: scrubTransportText(errMsg, [apiKey]).slice(0, 300) } : {}),
            ...(reasoningTokens !== null ? { reasoningTokens } : {}),
            ...(thinkDelta !== null ? { thinkingTokensDelta: thinkDelta } : {}),
          };
          // Telemetria de CPU só no runtime edge (vitest não tem Deno) —
          // prova por chamada do custo do parse no incidente de 2026-09-02.
          // V5_31: sinais upstream no log — `sse_events=1 content_bytes=0`
          // sem finish/erro era o mistério do incidente de 2026-09-17.
          if (typeof Deno !== 'undefined') {
            const sig: string[] = [];
            sig.push(`finish_reason=${finishReason ?? '-'}`);
            if (nativeFinishReason !== null) sig.push(`native=${nativeFinishReason}`);
            if (errType !== null) sig.push(`err_type=${errType}`);
            if (errCode !== null) sig.push(`err_code=${errCode}`);
            if (reasoningTokens !== null) sig.push(`reasoning_tokens=${reasoningTokens}`);
            if (thinkDelta !== null) sig.push(`thinking_delta=${thinkDelta}`);
            console.log(`[llm-perf] model=${model} sse_events=${sseEvents} content_bytes=${content.length} stream_ms=${Date.now() - streamStartedAt} ${sig.join(' ')}`);
          }
          // V5_31: erro upstream explícito com 0 bytes — nunca devolver ""
          // mudo (virava VALIDATION_FAILED enganador no runStep). O throw
          // entra no caminho de retry de transporte do runStep, que para
          // vision faz fallback text-only (best-effort real).
          if (content.length === 0 && (errMsg !== null || errType !== null || finishReason === 'error')) {
            throw new Error(`${LLM_UPSTREAM_ERROR_PREFIX}${buildUpstreamDetail(meta)}`);
          }
          return { content, tokens: usage ?? { input: 0, output: 0 }, meta };
        }
        const data = await res.json() as {
          choices?: Array<{
            message?: { content?: string };
            finish_reason?: string | null;
            native_finish_reason?: string | null;
            error?: { code?: number; message?: string; metadata?: { error_type?: string } };
          }>;
          error?: { code?: number; message?: string; metadata?: { error_type?: string } };
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };
        clearTimeout(timer);
        // V5_31: mesmos sinais do caminho stream (docs: erro de provider em
        // non-stream chega no body com `error`, mesmo com HTTP 200).
        const nsChoice = data.choices?.[0];
        const nsErr = data.error ?? nsChoice?.error;
        const nsTokens = {
          input: data.usage?.prompt_tokens ?? 0,
          output: data.usage?.completion_tokens ?? 0,
        };
        const nsReasoning = typeof data.usage?.completion_tokens_details?.reasoning_tokens === 'number'
          ? data.usage.completion_tokens_details.reasoning_tokens
          : null;
        const nsThinkDelta = thinkingTokensDelta(data.usage?.total_tokens, nsTokens, nsReasoning);
        const nsMeta: LLMStreamMeta = {
          ...(typeof nsChoice?.finish_reason === 'string' && nsChoice.finish_reason ? { finishReason: nsChoice.finish_reason } : {}),
          ...(typeof nsChoice?.native_finish_reason === 'string' && nsChoice.native_finish_reason ? { nativeFinishReason: nsChoice.native_finish_reason } : {}),
          ...(typeof nsErr?.metadata?.error_type === 'string' && nsErr.metadata.error_type ? { errorType: nsErr.metadata.error_type } : {}),
          ...(typeof nsErr?.code === 'number' ? { errorCode: nsErr.code } : {}),
          ...(typeof nsErr?.message === 'string' && nsErr.message ? { errorMessage: scrubTransportText(nsErr.message, [apiKey]).slice(0, 300) } : {}),
          ...(nsReasoning !== null ? { reasoningTokens: nsReasoning } : {}),
          ...(nsThinkDelta !== null ? { thinkingTokensDelta: nsThinkDelta } : {}),
        };
        const content = nsChoice?.message?.content ?? '';
        if (content.length === 0 && (nsMeta.errorMessage !== undefined || nsMeta.errorType !== undefined || nsMeta.finishReason === 'error')) {
          throw new Error(`${LLM_UPSTREAM_ERROR_PREFIX}${buildUpstreamDetail(nsMeta)}`);
        }
        return {
          content,
          tokens: nsTokens,
          meta: nsMeta,
        };
      } catch (err) {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          throw new Error(`LLM_TIMEOUT: no response from LLM API in ${timeoutMs / 1000}s`);
        }
        // Provider errors can echo its Authorization credential or signed media
        // URL. Preserve diagnosis/fallback classification without those values.
        throw new Error(scrubTransportText(err instanceof Error ? err.message : String(err), [apiKey]));
      }
    },
  };
}

/**
 * Resolve the model for a specific step, checking per-step env overrides first.
 * E.g. for step 'design', checks LLM_MODEL_DESIGN before falling back to LLM_MODEL.
 */
export function resolveStepModel(step: string): string {
  const envKey = `LLM_MODEL_${step.toUpperCase()}`;
  // Auditoria env-only 2026-09-25: '' propaga — o createLLMClient falha com
  // erro de config claro (nenhum default hardcoded).
  // readStepEnv (não Deno.env.get direto): estes resolvers são chamados sob
  // vitest, onde `Deno` não existe e a leitura direta rebentava o teste.
  return readStepEnv(envKey) || readStepEnv('LLM_MODEL') || '';
}

/**
 * V5_16 Fase B: teto de tokens de conclusão por step (OPT-IN).
 * `LLM_MAX_TOKENS_<STEP>` > `LLM_MAX_TOKENS` > sem teto (undefined). Valores
 * inválidos/≤0 NUNCA viram teto — um teto abaixo do p95 real truncaria o JSON
 * (o incidente que isto quer evitar é a LATÊNCIA, não a validação).
 * Baseline para definir tetos: telemetria `tokens` no manifesto +
 * scripts/diag-step-tokens.mjs.
 */
export function resolveStepMaxTokens(step: string): number | undefined {
  const raw = readStepEnv(`LLM_MAX_TOKENS_${step.toUpperCase()}`) || readStepEnv('LLM_MAX_TOKENS') || '';
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * V5_16 Fase B: reasoning effort por step.
 * `LLM_REASONING_EFFORT_<STEP>` > `LLM_REASONING_EFFORT` > 'high'. Permite
 * baixar um step pontual para 'medium' (menos thinking tokens = menos
 * latência) via secret, sem redeploy de código.
 */
export function resolveStepReasoningEffort(step: string): string {
  return readStepEnv(`LLM_REASONING_EFFORT_${step.toUpperCase()}`) || readStepEnv('LLM_REASONING_EFFORT') || 'high';
}
