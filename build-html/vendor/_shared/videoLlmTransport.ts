/** Kie Responses wire adapter for the video engine's existing chat clients.
 * Keeps tool history, images, usage and the caller's abort/deadline intact.
 * Only provider failures trigger one explicitly logged Gemini fallback.
 */
import { llmCapability, normalizeReasoningEffort, resolveApiKey } from './llmProvider.ts';
import { fetchBuffered } from './boundedTransport.ts';
import { createRespanFetch } from './respanTracing.ts';

type Json = Record<string, any>;
type Group = 'LLM' | 'VISION' | 'DIRECTOR';
function env(name: string): string {
  try { return typeof Deno !== 'undefined' ? Deno.env.get(name) || '' : ''; } catch { return ''; }
}

export function toKieResponses(body: Json): Json {
  const input: Json[] = [];
  for (const message of body.messages ?? []) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content ?? '') });
      continue;
    }
    if (message.content != null && message.content !== '') {
      const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      input.push({ role: message.role, content: parts.map((p: Json) => {
        if (p.type === 'image_url') return { type: 'input_image', image_url: p.image_url.url };
        if (p.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: p.text };
        throw new Error('LLM_CONFIG: unsupported Responses input part');
      }) });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  const result: Json = { model: body.model, stream: false, input };
  const effort = body.reasoning?.effort || body.reasoning_effort || body.think || env('LLM_REASONING_EFFORT') || 'xhigh';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('LLM_CONFIG: unsupported Kie reasoning effort');
  result.reasoning = { effort };
  if (body.tools?.length) {
    result.tools = body.tools.map((t: Json) => t.type === 'function' ? { type: 'function', ...t.function } : t);
    result.tool_choice = 'auto';
  }
  if (body.response_format?.type === 'json_schema') {
    result.text = { format: { type: 'json_schema', ...body.response_format.json_schema } };
  } else if (body.response_format?.type === 'json_object') {
    // The Kie schema documents json_schema only. Preserve the JSON contract in
    // the prompt; each step still performs its own schema validation.
    input.unshift({ role: 'system', content: [{ type: 'input_text', text: 'Return only a valid JSON object, without Markdown fences.' }] });
  }
  // DeepSeek V4.1 Flash (o primário em /openai/v1) declara `max_output_tokens`,
  // `temperature` e `top_p` como não suportados: o campo é aceite e ignorado.
  // Mantém-se porque o contrato é partilhado com o /codex/v1 (Luna/Terra), onde
  // o teto é honrado; nenhum step define LLM_MAX_TOKENS_* hoje.
  if (body.max_tokens > 0) result.max_output_tokens = body.max_tokens;
  return result;
}

export function fromKieResponses(data: Json): Json {
  if ((data.code != null && Number(data.code) !== 200) || data.error || ['failed', 'incomplete', 'cancelled'].includes(data.status)) {
    const code = Number(data.code ?? data.error?.code);
    throw new ProviderFailure(Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502);
  }
  const output = data.output ?? [];
  const text = typeof data.output_text === 'string' ? data.output_text : output
    .filter((o: Json) => o.type === 'message')
    .flatMap((o: Json) => o.content ?? []).filter((c: Json) => c.type === 'output_text')
    .map((c: Json) => c.text ?? '').join('');
  const calls = output.filter((o: Json) => o.type === 'function_call').map((o: Json) => ({
    id: o.call_id || o.id, type: 'function', function: { name: o.name, arguments: o.arguments },
  }));
  if (!text && !calls.length) throw new ProviderFailure(502);
  return {
    choices: [{ message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: data.usage?.input_tokens ?? 0, completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: data.usage?.total_tokens,
      completion_tokens_details: data.usage?.output_tokens_details },
  };
}

class ProviderFailure extends Error {
  // Campo explícito (sem parameter property) — sintaxe erasable para o type
  // stripping nativo do Node no worker vendado (F2, plano v2).
  readonly status: number;
  constructor(status: number) {
    super(`LLM provider failed (${status}); response body redacted`);
    this.status = status;
  }
}
function jsonResponse(data: Json, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
/** Kie long reasoning requests use native Responses SSE; only a terminal
 * completed response is authoritative. Deltas alone never become success. */
export function completedKieResponse(text: string): Json {
  let completed: Json | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let event: Json;
    try { event = JSON.parse(raw); } catch { throw new ProviderFailure(502); }
    if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new ProviderFailure(502);
    if (event.type === 'response.completed') completed = event.response;
  }
  if (!completed) throw new ProviderFailure(502);
  return completed;
}
export function hasVideoLlmFallback(group: Group): boolean {
  const base = env(`${group}_FALLBACK_API_URL`);
  if (!base || !env(`${group}_FALLBACK_MODEL`)) return false;
  try { return !!resolveApiKey(llmCapability(base).kind); } catch { return false; }
}

/** Opt-out for a caller (the quality gates) that owns its own fallback policy. */
export function createVideoLlmFetch(fetcher: typeof fetch = fetch, group: Group | false = 'LLM', timeoutMs?: number): typeof fetch {
  fetcher = createRespanFetch(fetcher, { name: `video.${group || 'VISION'}` });
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const address = String(url);
    if (!address.endsWith('/chat/completions') || llmCapability(address).kind !== 'kie') return fetcher(url, init);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const wire = toKieResponses(body);
    const started = Date.now();
    // Reserve time for fallback under the original caller deadline. No new
    // deadline is granted by retry; outer fetchBuffered / signals remain active.
    const total = timeoutMs && timeoutMs > 0 ? timeoutMs : Number(env(group === 'VISION' ? 'VISION_TIMEOUT_MS' : 'CHAT_LLM_TIMEOUT_MS')) || (group === 'VISION' ? 60_000 : 100_000);
    const canFallback = group !== false && hasVideoLlmFallback(group);
    const imageInput = (body.messages ?? []).some((m: Json) => Array.isArray(m.content) && m.content.some((p: Json) => p.type === 'image_url'));
    const imageFailure = (error: unknown) => error instanceof ProviderFailure && [400, 413, 415, 422, 500, 502].includes(error.status);
    const primaryRequest = async (payload: Json, budget: number) => {
      const requestStarted = Date.now();
      const tracedFetch: typeof fetch = async (url, request) => {
        const response = await fetcher(url, request);
        console.info('[video-llm] kie headers', { model: payload.model, status: response.status, elapsed_ms: Date.now() - requestStarted });
        return response;
      };
      const res = await fetchBuffered(tracedFetch, address.replace(/\/chat\/completions$/, '/responses'),
        { ...init, body: JSON.stringify({ ...payload, stream: true }) }, Math.max(1, budget), 8 * 1024 * 1024, 65536);
      if (!res.ok) throw new ProviderFailure(res.status);
      const data = res.headers.get('content-type')?.includes('text/event-stream')
        ? completedKieResponse(await res.text())
        : await res.json().catch(() => { throw new ProviderFailure(502); });
      const adapted = fromKieResponses(data);
      console.info('[video-llm] kie completed', { model: payload.model, elapsed_ms: Date.now() - requestStarted,
        input_tokens: adapted.usage.prompt_tokens, output_tokens: adapted.usage.completion_tokens });
      return jsonResponse(adapted);
    };
    let failure: unknown;
    try {
      return await primaryRequest(wire, canFallback ? Math.max(1000, total - Math.min(30_000, total * 0.2)) : total);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      if (error instanceof ProviderFailure && ![401, 402, 403, 404, 408, 429, 500, 502, 503, 504].includes(error.status)
        && !(group === 'LLM' && imageInput && imageFailure(error))) {
        return jsonResponse({ error: { message: error.message } }, error.status);
      }
      failure = error;
    }
    let fallbackInput = body;
    // Design/visual/build images are explicitly best-effort. An unsupported
    // asset (e.g. SVG behind a .jpg URL) must not switch the whole step to a
    // different provider before trying the same Kie model with brand text.
    // Vision scoring/captioning never uses this path: its images are evidence.
    if (group === 'LLM' && imageInput && imageFailure(failure)) {
      const remaining = total - (Date.now() - started);
      if (remaining <= 0) throw new Error('TRANSPORT_DEADLINE_EXCEEDED');
      fallbackInput = { ...body, messages: body.messages.map((m: Json) => ({ ...m,
        content: Array.isArray(m.content) ? m.content.filter((p: Json) => p.type !== 'image_url') : m.content,
      })) };
      console.warn(`[video-llm] kie primary status=${(failure as ProviderFailure).status}; retrying optional vision text-only on kie`);
      try {
        return await primaryRequest(toKieResponses(fallbackInput), canFallback ? remaining - Math.min(30_000, remaining * 0.2) : remaining);
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        failure = error;
      }
    }
    if (!canFallback) {
      if (failure instanceof ProviderFailure) return jsonResponse({ error: { message: failure.message } }, failure.status);
      throw new Error('LLM provider transport failed; details redacted');
    }
    const fallbackUrl = env(`${group}_FALLBACK_API_URL`).replace(/\/+$/, '');
    const cap = llmCapability(fallbackUrl);
    if (cap.kind !== 'gemini') throw new Error('LLM_CONFIG: video fallback must use the direct Gemini API');
    const fallbackBody: Json = { ...fallbackInput, model: env(`${group}_FALLBACK_MODEL`), stream: false };
    for (const k of ['think', 'reasoning', 'reasoning_effort', 'stream_options', 'provider']) delete fallbackBody[k];
    fallbackBody.reasoning_effort = normalizeReasoningEffort(cap.kind, env(`${group}_FALLBACK_REASONING_EFFORT`) || 'high');
    if (!fallbackBody.tools?.length) { delete fallbackBody.tools; delete fallbackBody.tool_choice; }
    const primaryStatus = failure instanceof ProviderFailure ? failure.status : 'transport';
    console.warn(`[video-llm] ${group} primary kie failed status=${primaryStatus}; trying gemini model=${fallbackBody.model}`);
    const remaining = total - (Date.now() - started);
    if (remaining <= 0) throw new Error('TRANSPORT_DEADLINE_EXCEEDED');
    const response = await fetchBuffered(fetcher, `${fallbackUrl}/chat/completions`, {
      ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveApiKey(cap.kind)}` }, body: JSON.stringify(fallbackBody),
    }, remaining, 8 * 1024 * 1024);
    if (!response.ok) return jsonResponse({ error: { message: `Kie primary failed (${primaryStatus}); Gemini fallback failed (${response.status}); bodies redacted` } }, response.status);
    const data = await response.json().catch(() => null);
    if (!data?.choices?.[0]?.message || data.error) return jsonResponse({ error: { message: 'Gemini fallback returned invalid output' } }, 502);
    return jsonResponse(data);
  }) as typeof fetch;
}
