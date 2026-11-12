/** Respan's documented span API for native Deno HTTP clients (no gateway).
 * Observes the body as the caller reads it: no clone, prefetch, or extra retry.
 * https://www.respan.ai/docs/apis/spans/create-span
 */
type Json = Record<string, any>;
type Runtime = typeof globalThis & {
  Deno?: { env: { get(name: string): string | undefined } };
  process?: { env: Record<string, string | undefined> };
  EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
};

export interface RespanFetchOptions {
  name: string;
  /** Separate exporter transport; provider credentials never reach this client. */
  exportFetch?: typeof fetch;
}

const pending = new Set<Promise<void>>();
const MAX_CAPTURE = 1024 * 1024;
const runtime = () => globalThis as Runtime;
function env(name: string): string {
  return runtime().Deno?.env.get(name) ?? runtime().process?.env[name] ?? '';
}
function object(text: string): Json {
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
}
function warn(reason: string): void {
  // Never include exception messages, request URLs, headers, or provider bodies.
  console.warn(`[respan] trace export failed (${reason}); provider response preserved`);
}

/** Call before a short-lived Node script exits. Edge exports use waitUntil. */
export async function flushRespanTraces(): Promise<void> {
  await Promise.allSettled([...pending]);
}

function schedule(payload: Json, apiKey: string, base: string, exportFetch: typeof fetch): void {
  const task = (async () => {
    try {
      const endpoint = new URL(`${base.replace(/\/+$/, '')}/request-logs/`);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        warn('invalid endpoint');
        return;
      }
      const response = await fetchBufferedExport(exportFetch, endpoint.href, apiKey, payload);
      if (!response.ok) warn(`HTTP ${response.status}`);
      await response.body?.cancel();
    } catch { warn('transport'); }
  })();
  pending.add(task);
  void task.finally(() => pending.delete(task));
  runtime().EdgeRuntime?.waitUntil(task);
}

async function fetchBufferedExport(fetcher: typeof fetch, url: string, key: string, payload: Json): Promise<Response> {
  // A separate deadline: tracing never consumes the provider's abort signal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    return await fetcher(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally { clearTimeout(timer); }
}

/** Explicitly wrap AI clients only; never install a global fetch interceptor. */
export function createRespanFetch(fetcher: typeof fetch, options: RespanFetchOptions): typeof fetch {
  return async (input, init) => {
    const key = env('RESPAN_API_KEY');
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (!key || env('RESPAN_TRACING_ENABLED') === 'false' || method.toUpperCase() !== 'POST') {
      return fetcher(input, init);
    }
    const base = env('RESPAN_BASE_URL') || 'https://api.respan.ai/api';
    const started = Date.now();
    const traceId = crypto.randomUUID();
    const address = new URL(input instanceof Request ? input.url : String(input));
    const rawRequest = typeof init?.body === 'string' ? init.body : '';
    const request = rawRequest.length <= MAX_CAPTURE ? object(rawRequest) : {};
    const pathModel = address.pathname.match(/\/models\/(.+?)(?::(?:streamGenerateContent|generateContent)|\/predictions)$/)?.[1];
    const requestedModel = request.model || pathModel || request.version;
    const captureContent = env('RESPAN_CAPTURE_CONTENT') === 'true';
    let data: Json = {};
    let buffer = '';
    let truncated = false;
    let sseDone = false;
    let observedError = false;
    let finished = false;
    const decoder = new TextDecoder();
    const finish = (status: number, failure?: string) => {
      if (finished) return;
      finished = true;
      try {
        const model = data.model || requestedModel;
        // Never invent a model id when a client provides neither body nor path.
        if (!model) return;
        const usage = data.usage ?? data.usageMetadata ?? {};
        const failed = !!failure || observedError || status >= 400 || !!data.error ||
          (data.code != null && Number(data.code) !== 200) ||
          ['failed', 'incomplete', 'canceled', 'cancelled'].includes(data.status);
        const payload: Json = {
          model, trace_unique_id: traceId, custom_identifier: traceId,
          span_name: options.name, span_workflow_name: 'visttapro.ai',
          log_type: address.pathname.endsWith('/responses') ? 'response' : 'chat',
          status_code: status, status: failed ? 'error' : 'success',
          start_time: new Date(started).toISOString(), timestamp: new Date().toISOString(),
          latency: (Date.now() - started) / 1000, stream: request.stream === true,
          metadata: { app: 'VisttaPro', provider_host: address.hostname,
            capture_truncated: truncated, content_captured: captureContent,
            ...(sseDone ? { stream_completed: true } : {}) },
        };
        const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount;
        const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount;
        if (typeof inputTokens === 'number') payload.prompt_tokens = inputTokens;
        if (typeof outputTokens === 'number') payload.completion_tokens = outputTokens;
        if (typeof data.usage?.cost === 'number') payload.cost = data.usage.cost;
        if (failed) payload.error_message = failure || 'Provider returned an unsuccessful response (details redacted)';
        if (captureContent) {
          payload.input = request.messages ?? request.input ?? request.contents ?? request.input_data ?? [];
          payload.output = data.choices?.[0]?.message ?? data.output ?? data.candidates ?? '';
        }
        schedule(payload, key, base, options.exportFetch ?? fetch);
      } catch { warn('observation'); }
    };
    let response: Response;
    try { response = await fetcher(input, init); }
    catch (error) { finish(0, 'Provider transport failed (details redacted)'); throw error; }
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    const consume = (text: string) => {
      if (!sse) {
        if (buffer.length + text.length <= MAX_CAPTURE) buffer += text;
        else { truncated = true; buffer = ''; }
        return;
      }
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const value = line.slice(5).trim();
        if (value === '[DONE]') { sseDone = true; continue; }
        const event = object(value);
        if (event.error || ['error', 'response.failed', 'response.incomplete'].includes(event.type)) observedError = true;
        if (event.type === 'response.completed') { data = event.response ?? {}; sseDone = true; }
        else if (event.usage || event.usageMetadata || event.choices) data = { ...data, ...event };
      }
      if (buffer.length > MAX_CAPTURE) { buffer = ''; truncated = true; }
    };
    if (!response.body || !response.ok) { finish(response.status); return response; }
    const reader = response.body.getReader();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            consume(decoder.decode());
            if (sse && buffer) consume('\n');
            if (!sse && !truncated) data = object(buffer);
            if (sse && !sseDone && address.pathname.endsWith('/responses')) observedError = true;
            finish(response.status);
            reader.releaseLock();
            controller.close();
          } else {
            // Observation must never turn a valid provider response into failure.
            try { consume(decoder.decode(value, { stream: true })); } catch { truncated = true; }
            controller.enqueue(value);
          }
        } catch (error) {
          finish(response.status, 'Provider response body failed (details redacted)');
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish(response.status, 'Provider response canceled');
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      },
    }, { highWaterMark: 0 }), {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
}
