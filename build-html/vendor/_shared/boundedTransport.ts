/** Deadline covers headers AND body, including fetchers that ignore AbortSignal. */
export async function fetchBuffered(
  fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number, maxBytes = 2 * 1024 * 1024, maxChunks = 8192,
): Promise<Response> {
  if (![timeoutMs, maxBytes, maxChunks].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('TRANSPORT_BUDGET_INVALID');
  }
  if (init.signal?.aborted) throw init.signal.reason ?? new Error('TRANSPORT_ABORTED');
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStopped: (reason: unknown) => void = () => undefined;
  const stop = (reason: unknown) => {
    rejectStopped(reason);
    controller.abort(reason);
    void reader?.cancel(reason).catch(() => undefined);
  };
  const onAbort = () => stop(init.signal?.reason ?? new Error('TRANSPORT_ABORTED'));
  const stopped = new Promise<never>((_, reject) => {
    rejectStopped = reject;
    timer = setTimeout(() => {
      stop(new Error('TRANSPORT_DEADLINE_EXCEEDED'));
    }, timeoutMs);
  });
  init.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const pendingResponse = fetcher(url, { ...init, signal: controller.signal }).then(response => {
      // A custom fetcher may ignore abort and resolve after the deadline.
      if (controller.signal.aborted) {
        void response.body?.cancel(controller.signal.reason).catch(() => undefined);
        throw controller.signal.reason;
      }
      return response;
    });
    const response = await Promise.race([pendingResponse, stopped]);
    if (response.body) reader = response.body.getReader();
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) throw new Error('TRANSPORT_BODY_TOO_LARGE');
    if (!response.body) return response;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let count = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader!.read(), stopped]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (done) break;
      if (++count > maxChunks) throw new Error('TRANSPORT_CHUNK_LIMIT_EXCEEDED');
      total += value.byteLength;
      if (total > maxBytes) throw new Error('TRANSPORT_BODY_TOO_LARGE');
      if (value.byteLength) chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
    reader?.releaseLock();
  }
}

export async function readRequestJsonBounded(request: Request, maxBytes = 1024 * 1024): Promise<Record<string, unknown> | null> {
  const response = await fetchBuffered(() => Promise.resolve(new Response(request.body, { headers: request.headers })),
    'https://request.local.invalid', {}, 10_000, maxBytes);
  const parsed: unknown = await response.json().catch(() => null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}
