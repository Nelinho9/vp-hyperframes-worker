import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve, sep, isAbsolute } from 'node:path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
export function confinedPath(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || name.includes('..')) throw new Error('INVALID_PATH');
  const base = resolve(root), target = resolve(base, name);
  if (!target.startsWith(base + sep)) throw new Error('INVALID_PATH');
  return target;
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function logicalInputHash(body) {
  return createHash('sha256').update(JSON.stringify(canonical({ inputs: body.inputs, options: body.options, artifact_paths: body.artifact_paths, project_id: body.project_id, step: body.step, mode: body.mode, revision: body.revision }))).digest('hex');
}
function fail(code) { throw new Error(code); }
function https(value) { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }
export function parseRenderJob(value, workerSecret) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_JOB');
  const body = structuredClone(value);
  for (const key of ['job_id', 'project_id']) if (!UUID_RE.test(body[key] || '')) fail('INVALID_UUID');
  // UUID identity is case insensitive, including on a Windows persistence volume.
  body.job_id = body.job_id.toLowerCase(); body.project_id = body.project_id.toLowerCase();
  if (!['preview', 'build', 'render', 'finalize'].includes(body.step) || !['preview', 'render'].includes(body.mode)) fail('INVALID_STEP_MODE');
  if (body.contract_version !== undefined && body.contract_version !== 1) fail('UNSUPPORTED_CONTRACT');
  if (body.contract_version === 1) {
    if (!UUID_RE.test(body.request_id || '') || !Number.isSafeInteger(body.revision) || body.revision < 1 || !/^[a-f0-9]{64}$/.test(body.input_hash || '')) fail('INVALID_REVISION');
    if (logicalInputHash(body) !== body.input_hash) fail('INPUT_HASH_MISMATCH');
    // V1 execution bytes belong to the hashed inputs object. These aliases
    // exist only in authenticated N-1 jobs, never as unhashed V1 overrides.
    if (body.index_html !== undefined || body.assets !== undefined) fail('INVALID_V1_INPUT_ALIAS');
  }
  const html = body.index_html ?? body.inputs?.index_html;
  if (html !== undefined && (typeof html !== 'string' || Buffer.byteLength(html) > 8 * 1024 * 1024)) fail('INVALID_HTML');
  if (!html && body.step !== 'finalize') fail('HTML_REQUIRED');
  if (html) {
    for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      const ref = match[1];
      if (/^(?:https?:|data:|blob:|#)/i.test(ref)) continue;
      if (!/^assets\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(ref) || ref.includes('..')) fail('INVALID_COMPOSITION_PATH');
    }
  }
  if (body.assets !== undefined) {
    if (!body.assets || typeof body.assets !== 'object' || Array.isArray(body.assets) || Object.keys(body.assets).length > 128) fail('ASSET_LIMIT');
    let bytes = 0;
    for (const [name, data] of Object.entries(body.assets)) {
      confinedPath('/job/assets', name);
      if (name.startsWith('__vp_') || typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail('INVALID_ASSET');
      bytes += Buffer.byteLength(data, 'base64');
      if (bytes > 32 * 1024 * 1024) fail('ASSET_BYTES_LIMIT');
    }
  }
  if (body.options !== undefined) {
    if (!body.options || typeof body.options !== 'object' || Array.isArray(body.options)) fail('INVALID_OPTIONS');
    for (const [key, min, max] of [['width', 16, 7680], ['height', 16, 7680], ['fps', 1, 120], ['duration', 0.1, 600], ['duration_target_seconds', 0.1, 600]]) {
      if (body.options[key] !== undefined && (typeof body.options[key] !== 'number' || !Number.isFinite(body.options[key]) || body.options[key] < min || body.options[key] > max)) fail('INVALID_OPTIONS');
    }
    if (body.options.format !== undefined && !['mp4', 'webm', 'gif', 'png'].includes(body.options.format)) fail('INVALID_OPTIONS');
    if (body.options.quality !== undefined && !['low', 'medium', 'high'].includes(body.options.quality)) fail('INVALID_OPTIONS');
    // F04-T02: unknown/invalid nunca viram defaults silenciosos — chaves fora do contrato falham.
    const allowedOptions = new Set(['width', 'height', 'fps', 'duration', 'duration_target_seconds', 'format', 'quality', 'aspect_ratio', 'pngAtSeconds', 'gifSeconds', 'effective_config_revision', 'effective_config_hash', 'composition_revision', 'composition_hash']);
    for (const key of Object.keys(body.options)) {
      if (!allowedOptions.has(key)) fail('INVALID_OPTIONS');
    }
  }
  // F04-T03: fonte de composição imutável (union discriminada inline-vs-ref) + hashes.
  // Opcionais para N-1; quando presentes, validados. Tokens/URLs efémeros nunca são identidade.
  if (body.composition_revision !== undefined && (!Number.isSafeInteger(body.composition_revision) || body.composition_revision < 1)) fail('INVALID_REVISION');
  if (body.composition_hash !== undefined && (typeof body.composition_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(body.composition_hash))) fail('INVALID_REVISION');
  if (body.effective_config_revision !== undefined && (!Number.isSafeInteger(body.effective_config_revision) || body.effective_config_revision < 0)) fail('INVALID_REVISION');
  if (body.effective_config_hash !== undefined && (typeof body.effective_config_hash !== 'string' || (body.effective_config_hash !== '' && !/^[a-f0-9]{64}$/i.test(body.effective_config_hash)))) fail('INVALID_REVISION');
  if (body.composition_source !== undefined) {
    const src = body.composition_source;
    if (!src || typeof src !== 'object' || (src.kind !== 'inline' && src.kind !== 'ref')) fail('INVALID_COMPOSITION_SOURCE');
    if (src.kind === 'ref') {
      try { const u = new URL(src.url); if (u.protocol !== 'https:') fail('INVALID_COMPOSITION_SOURCE'); } catch { fail('INVALID_COMPOSITION_SOURCE'); }
    }
  }
  if (body.options_provenance !== undefined && body.options_provenance !== 'fresh' && body.options_provenance !== 'legacy-fallback') fail('INVALID_OPTIONS');
  if (body.artifact_paths !== undefined) {
    if (!body.artifact_paths || typeof body.artifact_paths !== 'object' || Array.isArray(body.artifact_paths)) fail('INVALID_ARTIFACT_PATH');
    for (const [key, path] of Object.entries(body.artifact_paths)) {
      if (!['mp4', 'contact_sheet'].includes(key)) fail('INVALID_ARTIFACT_PATH');
      if (path === null) continue; // Preview producer intentionally has no MP4 artifact.
      if (typeof path !== 'string' || !path.startsWith(`projects/${body.project_id}/`) || path.includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.length > 512) fail('INVALID_ARTIFACT_PATH');
    }
  }
  if (body.outputs !== undefined) for (const [key, url] of Object.entries(body.outputs)) if (!key.endsWith('_upload_url') || !https(url)) fail('INVALID_OUTPUT');
  if (body.callback !== undefined) {
    const cb = body.callback;
    if (!https(cb?.url) || typeof cb.secret !== 'string' || !cb.secret || secureEqual(cb.secret, workerSecret)) fail('INVALID_CALLBACK');
    if (body.contract_version === 1 && (!UUID_RE.test(cb.nonce || '') || !Number.isFinite(Date.parse(cb.expires_at)) || Date.parse(cb.expires_at) <= Date.now())) fail('INVALID_CALLBACK_BINDING');
  }
  // Transport credentials expire independently; dedupe compares immutable execution input.
  const hash = createHash('sha256').update(JSON.stringify(canonical({ ...body, callback: body.callback ? { url: body.callback.url, nonce: body.callback.nonce } : undefined, outputs: undefined }))).digest('hex');
  return { body, hash };
}

export function publicJob(job) {
  const keys = ['id', 'project_id', 'request_id', 'step', 'mode', 'status', 'revision', 'input_hash', 'created_at', 'started_at', 'completed_at', 'total_ms'];
  const out = Object.fromEntries(keys.filter(key => job[key] !== undefined).map(key => [key, job[key]]));
  if (job.timings) out.timings = Object.fromEntries(Object.entries(job.timings).filter(([key, value]) => /^[a-z0-9_]+$/i.test(key) && Number.isFinite(value)));
  const storageRef = value => typeof value === 'string' && value.startsWith(`projects/${job.project_id}/`) && /^[a-zA-Z0-9_./-]+$/.test(value) && !value.includes('..');
  if (job.error) { out.error_code = job.error_code || 'WORKER_JOB_FAILED'; out.error = out.error_code; }
  if (job.callback_status) out.callback_status = { ok: Boolean(job.callback_status.ok), status: job.callback_status.status, attempts: job.callback_status.attempts, at: job.callback_status.at };
  if (job.window_normalization_warning) out.window_normalization_warning = {
    code: job.window_normalization_warning.code,
    previous_id: job.window_normalization_warning.previous_id,
    next_id: job.window_normalization_warning.next_id,
  };
  if (job.uploaded) out.uploaded = Object.fromEntries(Object.entries(job.uploaded).filter(([key, value]) => ['mp4', 'contact_sheet', 'snapshots', 'composition_html', 'composition_elements'].includes(key) && (typeof value === 'boolean' || storageRef(value))));
  if (job.output) out.output = {
    ...(storageRef(job.output.mp4_url) ? { mp4_url: job.output.mp4_url } : {}),
    ...(Number.isFinite(job.output.mp4_size_bytes) ? { mp4_size_bytes: job.output.mp4_size_bytes } : {}),
  };
  return out;
}
