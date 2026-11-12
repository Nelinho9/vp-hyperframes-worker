/** C4: only the server dispatch adapter may persist/transport private wire data. */
export interface RenderJobIdentityV1 {
  contract_version: 1;
  job_id: string;
  project_id: string;
  request_id: string;
  revision: number;
  input_hash: string;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function renderInputHash(payload: Record<string, unknown>): Promise<string> {
  const logical = Object.fromEntries(['inputs', 'options', 'artifact_paths', 'project_id', 'step', 'mode', 'revision']
    .map((key) => [key, payload[key]]));
  if (payload.published_content_hash !== undefined) logical.published_content_hash = payload.published_content_hash;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(logical)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Explicit allowlists, not a recursive secret blacklist. No transport URLs or free text. */
export function publicJobPayload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!payload) return {};
  const out: Record<string, unknown> = {};
  for (const key of ['contract_version', 'job_id', 'project_id', 'request_id', 'revision', 'input_hash', 'step', 'mode', 'inputs_source']) {
    const value = payload[key];
    const numeric = ['contract_version', 'revision'].includes(key) && typeof value === 'number';
    const id = ['job_id', 'project_id', 'request_id'].includes(key) && typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
    const hash = key === 'input_hash' && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const enumValue = ['step', 'mode', 'inputs_source'].includes(key) && typeof value === 'string' &&
      ['capture', 'design', 'storyboard', 'audio', 'visual', 'build', 'finalize', 'quality', 'preview', 'render', 'fresh-storage', 'stale-build-fallback'].includes(value);
    if (numeric || id || hash || enumValue) out[key] = value;
  }
  const paths = payload.artifact_paths as Record<string, unknown> | undefined;
  if (paths) out.artifact_paths = Object.fromEntries(Object.entries(paths).filter(([key, value]) =>
    ['mp4', 'contact_sheet'].includes(key) && (value === null || (typeof value === 'string' && /^projects\/[a-f0-9-]+\/(renders|snapshots)\/[A-Za-z0-9_.-]+$/.test(value)))));
  return out;
}

/** Diagnostics can preserve public URLs but never transport query tokens/known credentials. */
export function scrubTransportText(value: string, credentials: string[]): string {
  let text = value;
  for (const credential of credentials.filter(Boolean)) text = text.split(credential).join('[redacted]');
  return text.replace(/https?:\/\/[^\s"'<>)]*/g, (raw) => {
    try { const url = new URL(raw); url.search = ''; url.hash = ''; url.username = ''; url.password = ''; return url.href; }
    catch { return '[transport-url]'; }
  });
}

export function scrubTransportData<T>(value: T, credentials: string[]): T {
  if (typeof value === 'string') return scrubTransportText(value, credentials) as T;
  if (Array.isArray(value)) return value.map(item => scrubTransportData(item, credentials)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/secret|authorization|bearer|upload_url/i.test(key))
    .map(([key, item]) => [key, scrubTransportData(item, credentials)])) as T;
  return value;
}

export function publicJobResult(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result) return null;
  const out: Record<string, unknown> = {};
  const metricNames: Record<string, readonly string[]> = {
    timings: ['lint_start', 'lint_ms', 'check_start', 'check_ms', 'snapshot_start', 'snapshot_ms', 'render_start', 'render_ms', 'preload_ms', 'upload_ms'],
    tokens: ['input', 'output', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens'],
    uploaded: ['mp4', 'contact_sheet', 'snapshots', 'composition_html', 'composition_elements'],
  };
  for (const key of ['timings', 'tokens', 'uploaded']) {
    const row = result[key];
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      out[key] = Object.fromEntries(Object.entries(row).filter(([name, value]) =>
        metricNames[key].includes(name) && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))));
    }
  }
  if (typeof result.total_ms === 'number' && Number.isFinite(result.total_ms)) out.total_ms = result.total_ms;
  // Free-form worker/provider errors may contain signed URLs or echoed credentials.
  if (result.error || result.error_code) out.error_code = 'WORKER_JOB_FAILED';
  return out;
}

export function jobPublicStatus<T extends { payload: Record<string, unknown>; result: Record<string, unknown> | null; worker_url?: string | null }>(job: T): T {
  return { ...job, worker_url: null, payload: publicJobPayload(job.payload), result: publicJobResult(job.result) };
}
