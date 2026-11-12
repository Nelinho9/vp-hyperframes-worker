/**
 * llmVision.ts — chamada de visão sobre um endpoint OpenAI-compat
 * (`POST <apiUrl>/chat/completions` com partes `image_url`), partilhada por
 * video-quality-gate, video-v4-quality e video-capture.
 *
 * PORQUÊ UM MÓDULO PARTILHADO: os três sítios construíam o mesmo corpo à mão e
 * cada um decidia o provider com um `includes('openrouter.ai')`. O erro aqui não
 * é cosmético — o quality-gate é fail-closed num 4xx permanente
 * (`containsHumans: true`), portanto um body que o provider recusa bloqueia
 * TODAS as cenas. O shape do controlo de thinking passa a vir do perfil
 * (`llmCapability`), escrito uma vez: a camada OpenAI-compat da Google RECUSA
 * `reasoning:{effort}` com HTTP 400 (probe P3b), não o ignora.
 *
 * O módulo NÃO faz retry nem decide política: devolve o pedido construído e
 * interpreta a resposta, para cada chamador manter a sua própria política de
 * tentativas (o gate tem 2 tentativas/5s; o capture não tem).
 *
 * Dual-runtime (padrão `readStepEnv`): sem `Deno.env` direto, sem rede em testes.
 */
import { llmCapability, normalizeReasoningEffort, type LlmCapability } from './llmProvider.ts';

export interface VisionEndpoint {
  /** URL base sem trailing slash (ex. https://generativelanguage.googleapis.com/v1beta/openai). */
  apiUrl: string;
  cap: LlmCapability;
}

/** Normaliza um URL de env e resolve-lhe o perfil. Lança se o URL for inválido. */
export function visionEndpoint(apiUrl: string): VisionEndpoint {
  const url = apiUrl.replace(/\/+$/, '');
  return { apiUrl: url, cap: llmCapability(url) };
}

export interface ChatVisionRequest {
  endpoint: VisionEndpoint;
  apiKey: string;
  model: string;
  /** Prompt de sistema opcional (o capture usa; o gate não). */
  system?: string;
  prompt: string;
  /** URLs de imagem (HTTPS ou data:). Ordem preservada — o capture depende dela. */
  imageUrls: string[];
  /**
   * `response_format:{type:'json_object'}`. Default false: os prompts pedem JSON
   * em texto e os chamadores já extraem com `extractJsonObject`, que tolera
   * fences. Ligar isto é seguro nos providers com `jsonMode` (probe P1) mas não
   * compra nada onde a extração já funciona.
   */
  jsonMode?: boolean;
  /** Effort cru (vem de env). Normalizado aqui por kind — nunca enviado à letra. */
  reasoningEffort?: string;
  /** Teto de saída opt-in; sem ele o comportamento histórico mantém-se. */
  maxTokens?: number;
  /**
   * AbortSignal do CHAMADOR. O timer vive lá (cada função tem a sua política de
   * timeout e precisa de o limpar depois de ler o corpo) — este módulo não cria
   * timers que ninguém consegue cancelar.
   */
  signal?: AbortSignal;
}

export interface ChatVisionResult {
  status: number;
  /** Conteúdo do primeiro choice; '' em não-2xx ou resposta sem choices. */
  text: string;
  /** Corpo cru em não-2xx (truncado) — para o log dizer porquê. */
  errorBody: string;
  reasoningTokens: number | null;
  /**
   * Thinking contabilizado mas não discriminado (`total - prompt - completion`).
   * É o único sinal de que o `reasoning_effort` foi honrado na Google: a camada
   * devolve `reasoning_tokens` sempre null (probe P3).
   */
  thinkingDelta: number | null;
}

interface UsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** Constrói o pedido. O corpo depende do perfil, nunca do vendor pelo nome. */
export function buildChatVisionRequest(req: ChatVisionRequest): { url: string; init: RequestInit } {
  const { cap } = req.endpoint;
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }];
  for (const url of req.imageUrls) {
    if (url) content.push({ type: 'image_url', image_url: { url } });
  }
  const messages: Array<Record<string, unknown>> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content });

  const body: Record<string, unknown> = { model: req.model, messages };
  // `max_tokens` e `max_completion_tokens` são ambos honrados pela Google
  // (probe P4); mantém-se a ortografia histórica, que o OpenRouter também aceita.
  if (typeof req.maxTokens === 'number' && req.maxTokens > 0) body.max_tokens = req.maxTokens;
  if (req.jsonMode && cap.jsonMode) body.response_format = { type: 'json_object' };

  const effort = req.reasoningEffort ? normalizeReasoningEffort(cap.kind, req.reasoningEffort) : '';
  if (effort) {
    if (cap.thinking === 'reasoning-object') body.reasoning = { effort };
    else if (cap.thinking === 'reasoning-effort') body.reasoning_effort = effort;
    else if (cap.thinking === 'think') body.think = effort;
  }
  if (cap.routing) body.provider = { sort: 'throughput' };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${req.apiKey}`,
  };
  if (cap.appHeaders) {
    headers['HTTP-Referer'] = 'https://visttapro.com';
    headers['X-Title'] = 'VisttaPro Video Engine';
  }

  const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body) };
  if (req.signal) init.signal = req.signal;
  return { url: `${req.endpoint.apiUrl}/chat/completions`, init };
}

/** Interpreta a resposta. Nunca lança por conteúdo — só o chamador decide. */
export async function readChatVisionResponse(res: Response): Promise<ChatVisionResult> {
  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    // Colapsar whitespace + trim: isto vai para uma linha de log, e um body
    // formatado em várias linhas tornava o erro ilegível no meio do resto.
    return { status: res.status, text: '', errorBody: raw.replace(/\s+/g, ' ').trim().slice(0, 400), reasoningTokens: null, thinkingDelta: null };
  }
  let data: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: UsageShape;
  };
  try {
    data = JSON.parse(raw);
  } catch {
    return { status: res.status, text: '', errorBody: `resposta não-JSON (${raw.length} bytes)`, reasoningTokens: null, thinkingDelta: null };
  }
  const u = data.usage;
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  const explicit = typeof u?.completion_tokens_details?.reasoning_tokens === 'number' ? u.completion_tokens_details.reasoning_tokens : null;
  const delta = explicit === null && typeof u?.total_tokens === 'number' ? u.total_tokens - input - output : 0;
  return {
    status: res.status,
    text: data.choices?.[0]?.message?.content ?? '',
    errorBody: '',
    reasoningTokens: explicit,
    thinkingDelta: delta > 0 ? delta : null,
  };
}
