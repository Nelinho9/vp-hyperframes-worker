/** Deadline spans connection, headers, redirects and every streamed body chunk. */
export async function fetchBounded(url, { fetchImpl = fetch, timeoutMs = 60_000, maxBytes = 64 * 1024 * 1024, maxChunks = 100_000, init = {}, consumeBody = true } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('DOWNLOAD_DEADLINE')); }, timeoutMs);
  });
  let reader;
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!consumeBody) { controller.abort(); return { response, buffer: Buffer.alloc(0) }; }
      if (!response.ok) { controller.abort(); throw new Error(`HTTP_${response.status}`); }
      if (Number(response.headers.get('content-length')) > maxBytes) { controller.abort(); throw new Error('DOWNLOAD_BYTES_LIMIT'); }
      if (!response.body?.getReader) throw new Error('STREAM_REQUIRED');
      reader = response.body.getReader();
      let bytes = 0, count = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count++; bytes += value.byteLength;
        if (bytes > maxBytes || count > maxChunks) { controller.abort(); throw new Error('DOWNLOAD_BYTES_LIMIT'); }
        chunks.push(Buffer.from(value));
      }
      return { response, buffer: Buffer.concat(chunks, bytes) };
    })()]);
  } finally {
    clearTimeout(timer);
    if (controller.signal.aborted) { try { await reader?.cancel(); } catch { /* abort already stopped body */ } }
    try { reader?.releaseLock(); } catch { /* pending reader on aborted transport */ }
  }
}
