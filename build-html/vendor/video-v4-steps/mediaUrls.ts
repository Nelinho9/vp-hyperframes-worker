/**
 * mediaUrls.ts — V5_32 Fase A: canonicalização determinística das URLs de
 * media capturado (incidente 422 `218b1071`, 2026-09-18).
 *
 * O LLM do build transcreve URLs assinadas quase idênticas (tokens de ~300
 * chars) para o `src` dos elementos. No incidente cruzou o path de `asset-5`
 * com o token de `asset-4` → `InvalidSignature` → o worker fecha o job com
 * 422 `MEDIA_VALIDATION_FAILED` e o registo é despachado. Nada no pipeline
 * verificava a consistência `path ↔ token`.
 *
 * A decisão V5_32 (decisão #1) é que o **path** da URL assinada é a fonte de
 * verdade — o texto do LLM deixa de ser fonte de verdade de um token. Este
 * módulo é puro e dual-runtime (Deno edge + Node/vitest, sem APIs `Deno.*`):
 *
 *  - `parseStorageUrl` / `decodeSignedTokenPayload` / `auditSignedMediaUrl`
 *    inspecionam uma URL de storage (formato Supabase);
 *  - `collectMediaSrcs` / `rewriteMediaSrcs` extraem/reescrevem os `src` de
 *    `<img|video|audio|source>` que sejam URLs de storage (nunca tocam BGM,
 *    `data:`, relativos ou hosts externos);
 *  - `canonicalizeCaptureMedia` re-assina por path (TTL fresco) os assets das
 *    buckets de captura, usando `list` para confirmar existência — repara o
 *    cruzamento do incidente de forma determinística e idempotente.
 *
 * A garantia de execução vive na integração (Fase A3 builder + A4
 * orquestrador); a auditoria fail-closed é a Fase B (regra edge).
 *
 * Doc: docs/video-engine/V5_32_PLANO_CORRECAO_MEDIA_URLS_422_CALLBACK_CHECK.md §3.
 */

// ─── Contratos ─────────────────────────────────────────────────────────────

/** Localização de um objeto numa URL de storage Supabase. */
export interface StorageLocation {
  bucket: string;
  /** Path relativo à bucket (pode conter subpastas), já descodificado. */
  path: string;
  /** `token` da query (apenas no formato `sign`). */
  token?: string;
  kind: 'sign' | 'public';
}

/** Payload do JWT de leitura assinada (só os campos que nos interessam). */
export interface SignedTokenPayload {
  /** `bucket/path` do objeto que o token autoriza (claim do storage). */
  url?: string;
  scope?: unknown;
  exp?: number;
  [key: string]: unknown;
}

export type MediaUrlAuditCode = 'malformed' | 'path_token_mismatch' | 'expired';

/**
 * Resultado da auditoria de uma URL de media.
 * - `{ ok: true }` — não é storage nosso (URL externa/BGM/data:) ou é uma
 *   URL de storage consistente e não expirada.
 * - `{ ok: false, code }` — inconsistência detetável (a Fase B reprova).
 */
export type MediaUrlAudit =
  | { ok: true }
  | { ok: false; code: MediaUrlAuditCode; path: string; claimedPath?: string };

/** `src` de um elemento de media que aponta para a nossa storage. */
export interface MediaSrc {
  tag: string;
  src: string;
  /** Offsets absolutos do valor do `src` no HTML (para reescrita cirúrgica). */
  start: number;
  end: number;
}

export interface CanonicalizeMediaMissing {
  bucket: string;
  path: string;
  /**
   * `not_found` — o objeto não existe; `sign_failed` — não foi possível
   * assinar; `out_of_scope` — fora das diretorias de captura autorizadas (ou
   * host de storage não autorizado): NUNCA é assinado; `cap_exceeded` — acima
   * do teto de assets distintos processados (trabalho bounded).
   */
  reason: 'not_found' | 'sign_failed' | 'out_of_scope' | 'cap_exceeded';
}

export interface CanonicalizeMediaResult {
  html: string;
  /** Nº de `src` efetivamente substituídos por uma URL re-assinada. */
  fixed: number;
  /** Assets referenciados que não existem (ou que não puderam ser assinados). */
  missing: CanonicalizeMediaMissing[];
  /**
   * V5_32 revisão (Fase B): `src` de media de storage recolhidos do HTML, já
   * com as URLs FINAIS (re-assinadas quando houve reparo). By-product para
   * quem precisa de os auditar a jusante (gate pré-dispatch) sem voltar a
   * varrer o documento; os offsets referem-se ao HTML original e não são
   * usados por esses consumidores. `undefined` = documento não inspecionado.
   */
  srcs?: MediaSrc[];
}

export interface CanonicalizeMediaOptions {
  /** Nomes existentes sob um prefixo (pastas do capture); `null` = desconhecido. */
  listNames: (bucket: string, prefix: string) => Promise<string[] | null | undefined>;
  /** Assina a leitura de um objeto; `null` = falhou. */
  sign: (bucket: string, path: string, ttlSec: number) => Promise<string | null | undefined>;
  ttlSec: number;
  /**
   * Diretorias de captura autorizadas (ex.: `captures/<captureId>`) — a única
   * coisa que o HTML de origem controla (o `path`) tem de pertencer a uma
   * delas. **Obrigatório**: sem escopo não se assina nada (fail-closed), para
   * que um caminho arbitrário no HTML nunca vire uma credencial de serviço
   * (leitura cross-tenant).
   */
  allowedDirectories: readonly string[];
  /** Buckets elegíveis (default: as duas buckets do capture V3). */
  buckets?: readonly string[];
  /**
   * Hosts de storage autorizados (`host:port`). Defesa em profundidade contra
   * URLs com o mesmo path num host estranho; quando omitido, só o escopo de
   * diretorias decide.
   */
  allowedHosts?: readonly string[];
  /** Máximo de assets distintos processados por chamada. Default 32. */
  maxAssets?: number;
  /**
   * LEGADO (sem efeito desde 2026-10-18): o skip de "token já fresco" foi
   * removido — uma assinatura corrompida não é verificável em Edge e passava a
   * auditoria. Todo o asset em escopo é re-assinado por path. Mantido na
   * interface por compatibilidade de chamadores/testes.
   */
  minRemainingTtlSec?: number;
}

/** Buckets onde o `video-capture` guarda os assets do site (V3). */
export const CAPTURE_MEDIA_BUCKETS = ['video-assets', 'video-screenshots'] as const;

/** TTL de leitura usado pelo `video-capture` (`SIGNED_TTL_SEC`, 7 dias). */
export const CAPTURE_SIGNED_TTL_SEC = 7 * 24 * 3600;

// ─── Parsing de URL de storage ──────────────────────────────────────────────

// `/storage/v1/object/sign/<bucket>/<path>` e `…/object/public/<bucket>/<path>`.
// O path pode ter subpastas; pára em `?`/`#` (query/âncora). Match por PATH,
// nunca por host, para funcionar com qualquer projeto Supabase.
const STORAGE_URL_RE = /\/storage\/v1\/object\/(sign|public)\/([^/?#]+)\/([^?#]*)/i;
const TOKEN_QUERY_RE = /[?&]token=([^&#]*)/i;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Interpreta uma URL de storage Supabase. Devolve `null` para tudo o que não
 * seja storage nosso (externos, `data:`, relativos, blobs) — quem chama
 * decide o âmbito; este módulo nunca inventa uma bucket.
 */
export function parseStorageUrl(url: unknown): StorageLocation | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const match = STORAGE_URL_RE.exec(url);
  if (!match) return null;
  const kind: StorageLocation['kind'] = match[1].toLowerCase() === 'public' ? 'public' : 'sign';
  const bucket = safeDecode(match[2]);
  const path = safeDecode(match[3]);
  if (!bucket || !path) return null;
  const tokenMatch = TOKEN_QUERY_RE.exec(url);
  const token = tokenMatch && tokenMatch[1] ? safeDecode(tokenMatch[1]) : undefined;
  return { bucket, path, kind, ...(token ? { token } : {}) };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * V5_32 revisão de código pós-Fase C (segurança): um `path` com segmentos `.`
 * ou `..` passa o teste de prefixo `captures/<id>/` mas o storage resolve os
 * dot-segments ao assinar/servir — a service role assinaria um objeto FORA do
 * escopo autorizado (leitura cross-tenant). Rejeitado antes de qualquer
 * `list`/`sign` (fail-closed), tal como qualquer path fora das diretorias.
 */
function hasUnsafePathSegments(path: string): boolean {
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * V5_32 revisão (2026-10-18, incidente `7c19e2bc`): um token com a ASSINATURA
 * corrompida (transcrição do LLM de uma string de ~300 chars) mantém o payload
 * legível — path↔token casam e o exp é futuro — mas o Storage responde `400
 * InvalidJWT: signature verification failed`. A auditoria não consegue verificar
 * assinaturas (sem segredo JWT em Edge), por isso um token "fresco" NUNCA pode
 * ser a autoridade: ver `canonicalizeCaptureMedia`, que re-assina sempre.
 * Mantido como função exportada para os testes de contrato.
 */
function isFreshSignedMediaUrl(url: string, nowMs: number, minRemainingTtlSec: number): boolean {
  if (!auditSignedMediaUrl(url, nowMs).ok) return false;
  const location = parseStorageUrl(url);
  const payload = location?.token ? decodeSignedTokenPayload(location.token) : null;
  const exp = typeof payload?.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : undefined;
  if (exp === undefined) return false;
  return exp * 1000 - nowMs >= minRemainingTtlSec * 1000;
}
export { isFreshSignedMediaUrl };

// ─── Decode do token assinado ───────────────────────────────────────────────

function base64UrlToText(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Descodifica o payload do token de leitura assinada (base64url; JWT de 3
 * partes ou payload isolado). Nunca lança — token truncado/corrompido devolve
 * `null` (o que a auditoria classifica como `malformed`).
 */
export function decodeSignedTokenPayload(token: unknown): SignedTokenPayload | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const raw = safeDecode(token);
  const parts = raw.split('.');
  const encoded = parts.length >= 2 ? parts[1] : parts[0];
  if (!encoded) return null;
  const text = base64UrlToText(encoded);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as SignedTokenPayload;
  } catch {
    return null;
  }
}

// ─── Auditoria path ↔ token ─────────────────────────────────────────────────

/**
 * Audita uma URL de media: para URLs de storage nosso, o token tem de
 * autorizar exatamente o path da URL e não estar expirado.
 *
 * Não-storage → `{ ok: true }` (fora do âmbito; a regra 24 trata hotlinks de
 * ícones e o worker trata os restantes externos). URL pública de bucket
 * privada (sem `token`) → `malformed`.
 */
export function auditSignedMediaUrl(url: unknown, nowMs: number = Date.now()): MediaUrlAudit {
  const parsed = parseStorageUrl(url);
  if (!parsed) return { ok: true };
  if (!parsed.token) return { ok: false, code: 'malformed', path: parsed.path };
  const payload = decodeSignedTokenPayload(parsed.token);
  if (!payload) return { ok: false, code: 'malformed', path: parsed.path };

  const claimed = typeof payload.url === 'string' && payload.url ? payload.url : undefined;
  if (claimed) {
    const expected = `${parsed.bucket}/${parsed.path}`;
    // Tolerante a tokens antigos que carreguem só o path (sem bucket).
    if (claimed !== expected && claimed !== parsed.path) {
      return { ok: false, code: 'path_token_mismatch', path: parsed.path, claimedPath: claimed };
    }
  }

  const exp = typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : undefined;
  if (exp !== undefined && exp * 1000 <= nowMs) {
    return { ok: false, code: 'expired', path: parsed.path };
  }
  return { ok: true };
}

// ─── Extração / reescrita de src de media ───────────────────────────────────

const MEDIA_TAG_SOURCE = '<(img|video|audio|source)\\b[^>]*>';
// `(?:^|\s)` ancora o nome do atributo: `\b` também casaria `data-src`/`x-src`
// (o `-` é uma fronteira de palavra) e o primeiro match venceria, deixando o
// `src` real por recolher — exatamente a classe de URL que este módulo repara.
const SRC_ATTR_RE = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

/**
 * Extrai os `src` de `<img|video|audio|source>` que apontam para a nossa
 * storage, com os offsets do valor no HTML. `data:`/relativos/externos/BGM
 * nunca entram (não são storage). `srcset` não é tocado.
 */
export function collectMediaSrcs(html: unknown): MediaSrc[] {
  if (typeof html !== 'string' || html.length === 0) return [];
  const out: MediaSrc[] = [];
  const tagRe = new RegExp(MEDIA_TAG_SOURCE, 'gi');
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(html)) !== null) {
    const tagText = tagMatch[0];
    const attr = SRC_ATTR_RE.exec(tagText);
    if (!attr) continue;
    const value = attr[1] ?? attr[2] ?? attr[3] ?? '';
    if (!value || !parseStorageUrl(value)) continue;
    const valueIndex = attr[0].indexOf(value);
    if (valueIndex < 0) continue;
    const start = tagMatch.index + attr.index + valueIndex;
    out.push({ tag: tagMatch[1].toLowerCase(), src: value, start, end: start + value.length });
  }
  return out;
}

/**
 * Reescreve `src` JÁ RECOLHIDOS (evita um segundo varrimento completo do
 * documento em `canonicalizeCaptureMedia`, V5_32 revisão de CPU). O resolver
 * devolve a URL nova (ou `null` para deixar intacta); a reescrita corre de trás
 * para a frente para os offsets das entradas anteriores continuarem válidos.
 */
function rewriteMediaSrcEntries(html: string, entries: MediaSrc[], resolve: (src: string) => string | null): string {
  if (entries.length === 0) return html;
  let out = html;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const next = resolve(entry.src);
    if (!next || next === entry.src) continue;
    out = out.slice(0, entry.start) + next + out.slice(entry.end);
  }
  return out;
}

/**
 * Reescreve os `src` de storage do HTML. O resolver devolve a URL nova (ou
 * `null` para deixar intacta). Reescrita de trás para a frente para os offsets
 * das entradas anteriores continuarem válidos.
 */
export function rewriteMediaSrcs(html: string, resolve: (src: string) => string | null): string {
  return rewriteMediaSrcEntries(html, collectMediaSrcs(html), resolve);
}

// ─── Canonicalizador ───────────────────────────────────────────────────────

/**
 * Re-assina por PATH os media de captura referenciados no HTML.
 *
 * Segurança: só URLs das buckets de captura, dentro das diretorias
 * `captures/<id>` autorizadas (`allowedDirectories`) e — quando `allowedHosts`
 * é dado — do host de storage do projeto. O escopo é derivado PELO CHAMADOR no
 * servidor a partir do vínculo da captura do projeto (`video_captures.id`),
 * nunca do HTML nem de ficheiros graváveis pelo utilizador (ex.: tokens.json).
 * Tudo o resto é `out_of_scope` e **nunca** é assinado (o `path` do HTML não
 * pode virar credencial de serviço para objetos alheios).
 *
 * Por cada diretório referenciado faz UM `listNames` (cache, em paralelo) para
 * confirmar existência; os `sign` correm em paralelo, ambos limitados a
 * `maxAssets` (default 32) assets distintos. Um token já consistente e com TTL
 * confortável é deixado como está (idempotente). Assets inexistentes/fora de
 * escopo/acima do teto saem em `missing` para o gate fail-closed (Fase B).
 */
export async function canonicalizeCaptureMedia(
  html: string,
  options: CanonicalizeMediaOptions,
): Promise<CanonicalizeMediaResult> {
  const buckets = new Set(
    options.buckets && options.buckets.length > 0 ? options.buckets : CAPTURE_MEDIA_BUCKETS,
  );
  const allowedDirectories = (options.allowedDirectories ?? []).filter((dir) => dir.length > 0);
  const allowedHosts = options.allowedHosts && options.allowedHosts.length > 0
    ? new Set(options.allowedHosts.map((host) => host.toLowerCase()))
    : null;
  const maxAssets = options.maxAssets && options.maxAssets > 0 ? options.maxAssets : 32;

  const entries = collectMediaSrcs(html).filter((entry) => {
    const parsed = parseStorageUrl(entry.src);
    return parsed !== null && buckets.has(parsed.bucket);
  });
  if (entries.length === 0) return { html, fixed: 0, missing: [], srcs: [] };

  const missing = new Map<string, CanonicalizeMediaMissing>();
  const markMissing = (key: string, bucket: string, path: string, reason: CanonicalizeMediaMissing['reason']): void => {
    if (!missing.has(key)) missing.set(key, { bucket, path, reason });
  };

  // 1) Classificação por path único: escopo. NUNCA se confia num token do
  //    texto do LLM como autoridade de leitura — a assinatura não é verificável
  //    em Edge e uma assinatura corrompida passa o parse do payload (incidente
  //    2026-10-18: `InvalidJWT` no worker). Todo o asset em escopo é re-assinado
  //    por path, sempre; `isFreshSignedMediaUrl` fica só para os testes.
  const plans = new Map<string, { bucket: string; path: string; dir: string; name: string }>();
  for (const entry of entries) {
    const parsed = parseStorageUrl(entry.src);
    if (!parsed) continue;
    const key = `${parsed.bucket}/${parsed.path}`;
    if (missing.has(key) || plans.has(key)) continue;
    if (allowedHosts && !allowedHosts.has(hostOf(entry.src) ?? '')) {
      markMissing(key, parsed.bucket, parsed.path, 'out_of_scope');
      continue;
    }
    if (hasUnsafePathSegments(parsed.path)) {
      // Dot-segments resolvem para fora de `captures/<id>` no storage — nunca
      // podem virar credencial de serviço (revisão pós-Fase C).
      markMissing(key, parsed.bucket, parsed.path, 'out_of_scope');
      continue;
    }
    if (!allowedDirectories.some((dir) => parsed.path.startsWith(`${dir}/`))) {
      markMissing(key, parsed.bucket, parsed.path, 'out_of_scope');
      continue;
    }
    const slash = parsed.path.lastIndexOf('/');
    plans.set(key, {
      bucket: parsed.bucket,
      path: parsed.path,
      dir: slash >= 0 ? parsed.path.slice(0, slash) : '',
      name: slash >= 0 ? parsed.path.slice(slash + 1) : parsed.path,
    });
  }

  const planList = [...plans.values()];
  const capped = planList.slice(0, maxAssets);
  for (const plan of planList.slice(maxAssets)) {
    markMissing(`${plan.bucket}/${plan.path}`, plan.bucket, plan.path, 'cap_exceeded');
  }

  // 2) Existência: UM list por (bucket, dir), em cache e em paralelo.
  const dirKeys = [...new Set(capped.map((plan) => `${plan.bucket}\u0000${plan.dir}`))];
  const namesByDir = new Map<string, string[] | null>();
  await Promise.all(
    dirKeys.map(async (dirKey) => {
      const [bucket, dir] = dirKey.split('\u0000');
      let names: string[] | null = null;
      try {
        const listed = await options.listNames(bucket, dir);
        names = Array.isArray(listed) ? listed : null;
      } catch {
        names = null;
      }
      namesByDir.set(dirKey, names);
    }),
  );
  const dirKeyOf = (plan: { bucket: string; dir: string }) => `${plan.bucket}\u0000${plan.dir}`;
  // V5_32 revisão de código pós-Fase C (segurança): `list` falhado (null) NÃO é
  // "existe" — a existência fica por verificar e um path forjado não pode ser
  // assinado com a service role por best-effort. Falha fechado: `sign_failed`.
  const existing = capped.filter((plan) => {
    const names = namesByDir.get(dirKeyOf(plan)) ?? null;
    return names !== null && names.includes(plan.name);
  });
  for (const plan of capped) {
    const names = namesByDir.get(dirKeyOf(plan)) ?? null;
    if (names === null) {
      markMissing(`${plan.bucket}/${plan.path}`, plan.bucket, plan.path, 'sign_failed');
    } else if (!names.includes(plan.name)) {
      markMissing(`${plan.bucket}/${plan.path}`, plan.bucket, plan.path, 'not_found');
    }
  }

  // 3) Re-assinatura por path, em paralelo (bounded pelo teto). Só chegam aqui
  //    paths cujo token não era fresco; o resto fica intacto.
  const signedByPath = new Map<string, string>();
  await Promise.all(
    existing.map(async (plan) => {
      let signed: string | null = null;
      try {
        const candidate = await options.sign(plan.bucket, plan.path, options.ttlSec);
        signed = typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
      } catch {
        signed = null;
      }
      if (!signed) {
        markMissing(`${plan.bucket}/${plan.path}`, plan.bucket, plan.path, 'sign_failed');
        return;
      }
      signedByPath.set(`${plan.bucket}/${plan.path}`, signed);
    }),
  );

  // 4) Reescrita cirúrgica (só entradas com URL nova distinta). `srcs` devolve
  //    as URLs FINAIS (by-product para o gate pré-dispatch) e, quando não há
  //    nada a substituir, o documento NÃO é re-varrrido (V5_32 revisão de CPU).
  const replacement = new Map<string, string>();
  for (const entry of entries) {
    const parsed = parseStorageUrl(entry.src);
    if (!parsed) continue;
    const signed = signedByPath.get(`${parsed.bucket}/${parsed.path}`);
    if (signed && signed !== entry.src) replacement.set(entry.src, signed);
  }
  const srcs = entries.map((entry) => ({ ...entry, src: replacement.get(entry.src) ?? entry.src }));
  if (replacement.size === 0) return { html, fixed: 0, missing: [...missing.values()], srcs };

  let fixed = 0;
  const out = rewriteMediaSrcEntries(html, entries, (src) => {
    const next = replacement.get(src);
    if (next === undefined) return null;
    fixed += 1;
    return next;
  });
  return { html: out, fixed, missing: [...missing.values()], srcs };
}