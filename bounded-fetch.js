import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from 'node:zlib';

const MAX_REDIRECT_HOPS = 5;
const MAX_DECODE_BYTES = 512 * 1024 * 1024;

function parseIpv4Octets(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return null;
  return octets;
}

function parseIpv6Hextets(rawHost) {
  const host = String(rawHost ?? '').trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const groups = half.split(':');
    const result = [];
    for (const group of groups) {
      if (group.includes('.')) {
        const ipv4 = parseIpv4Octets(group);
        if (!ipv4) return null;
        result.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(group)) {
        result.push(parseInt(group, 16));
      } else {
        return null;
      }
    }
    return result;
  };
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (!left || !right) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

function isNonPublicIpv4(octets, disallowLoopback) {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return disallowLoopback; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF/TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

export function isNonPublicIp(rawHost, { disallowLoopback = true } = {}) {
  const host = String(rawHost ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;

  // IPv4-mapped IPv6 in dotted form (e.g. ::ffff:127.0.0.1).
  const v4MappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (v4MappedDotted) {
    return isNonPublicIp(v4MappedDotted[1], { disallowLoopback });
  }

  const v4 = parseIpv4Octets(host);
  if (v4) return isNonPublicIpv4(v4, disallowLoopback);

  const groups = parseIpv6Hextets(host);
  if (!groups) return false;

  // IPv4-mapped ::ffff:0:0/96 and deprecated IPv4-compatible ::/96.
  const mapped = groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff;
  if (mapped) {
    return isNonPublicIp(
      `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`,
      { disallowLoopback },
    );
  }
  const compatible = groups.slice(0, 6).every((part) => part === 0);
  if (compatible) {
    if (groups[7] === 0) return true; // ::
    if (groups[7] === 1) return disallowLoopback; // ::1
    return true; // deprecated IPv4-compatible space
  }

  const first = groups[0];
  const second = groups[1];

  // Only 2000::/3 is global unicast. Everything else (fc00::/7 ULA,
  // fe80::/10 link-local, fec0::/10 deprecated site-local, ff00::/8 multicast,
  // 64:ff9b::/96 NAT64, 100::/64 discard-only, ...) is non-public.
  if ((first & 0xe000) !== 0x2000) return true;

  if (first === 0x2001 && second <= 0x01ff) return true; // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID)
  if (first === 0x2001 && second === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x2002) return true; // 2002::/16 6to4 (may embed private IPv4)
  if (first === 0x3fff && second <= 0x0fff) return true; // 3fff::/20 documentation (RFC 9637)
  return false;
}

export function isBlockedHostname(rawHost, { disallowLoopback = true } = {}) {
  const host = String(rawHost ?? '').trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return true;
  if (host === 'metadata.google.internal' || host === 'metadata' || host === 'instance-data') return true;
  if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.localhost')) return true;
  if (host === 'localhost') return disallowLoopback;
  return isNonPublicIp(host, { disallowLoopback });
}

function addressFamily(address) {
  return String(address).includes(':') ? 6 : 4;
}

/**
 * Validates a URL and resolves every A/AAAA answer to the exact address set the
 * caller must pin. `requireHttps` narrows the C03 policy; the legacy capture
 * contract keeps HTTP only outside production / in tests.
 */
export async function validateEgressUrl(rawUrl, {
  disallowLoopback = true,
  lookupImpl = null,
  requireHttps = false,
  allowPrivateAddresses = false,
} = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? ''));
  } catch {
    throw new Error('SSRF_INVALID_URL');
  }

  const protocolAllowed = requireHttps ? parsed.protocol === 'https:' : (
    parsed.protocol === 'http:' || parsed.protocol === 'https:'
  );
  if (!protocolAllowed) {
    throw new Error('SSRF_PROTOCOL_BLOCKED');
  }

  if (parsed.username || parsed.password) {
    throw new Error('SSRF_CREDENTIALS_BLOCKED');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivateAddresses && isBlockedHostname(host, { disallowLoopback })) {
    throw new Error(`SSRF_BLOCKED_HOST:${host}`);
  }

  const addresses = [];
  const isIpLiteral = Boolean(parseIpv4Octets(host)) || host.includes(':');
  if (isIpLiteral) {
    addresses.push({ address: host, family: addressFamily(host) });
  } else if (typeof lookupImpl === 'function') {
    let records;
    try {
      records = await lookupImpl(host, { all: true, verbatim: true });
    } catch {
      throw new Error(`DNS_LOOKUP_FAILED:${host}`);
    }
    const list = Array.isArray(records) ? records : records ? [records] : [];
    if (list.length === 0) {
      throw new Error(`DNS_LOOKUP_EMPTY:${host}`);
    }
    for (const entry of list) {
      const addr = typeof entry === 'string' ? entry : entry?.address;
      if (!addr || (!allowPrivateAddresses && isNonPublicIp(addr, { disallowLoopback }))) {
        throw new Error(`SSRF_DNS_PRIVATE_IP:${addr || 'unknown'}`);
      }
      addresses.push({ address: String(addr).replace(/^\[|\]$/g, ''), family: entry?.family || addressFamily(addr) });
    }
  }

  return { url: parsed.toString(), parsed, addresses };
}

function headerEntries(headers) {
  const out = [];
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => out.push([key, value]));
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out.push([key, String(value)]);
  } else {
    for (const [key, value] of Object.entries(headers)) out.push([key, String(value)]);
  }
  return out;
}

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function decodeBody(raw, headers, maxBytes) {
  const encoding = (headers.get('content-encoding') ?? '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return raw;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      return gunzipSync(raw, { maxOutputLength: Math.min(maxBytes, MAX_DECODE_BYTES) });
    }
    if (encoding === 'deflate') {
      return inflateSync(raw, { maxOutputLength: Math.min(maxBytes, MAX_DECODE_BYTES) });
    }
    if (encoding === 'br') {
      return brotliDecompressSync(raw, { maxOutputLength: Math.min(maxBytes, MAX_DECODE_BYTES) });
    }
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || error?.code === 'ERR_BUFFER_TOO_LARGE_OUTPUT') {
      throw fail('DOWNLOAD_BYTES_LIMIT');
    }
    throw fail('INVALID_RESPONSE');
  }
  throw fail('UNSUPPORTED_ENCODING');
}

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const opts = typeof options === 'object' && options ? options : { family: Number(options) || 0 };
    const family = Number(opts?.family) || 0;
    const usable = family ? addresses.filter((entry) => entry.family === family) : addresses;
    if (usable.length === 0) {
      callback(fail('DNS_LOOKUP_FAILED'));
      return;
    }
    if (opts?.all) {
      callback(null, usable.map((entry) => ({ address: entry.address, family: entry.family })));
      return;
    }
    callback(null, usable[0].address, usable[0].family);
  };
}

function collectResponse(res, { method, status, headers, maxBytes, maxChunks, consumeBody }) {
  if (method === 'HEAD' || status === 204 || status === 205 || status === 304 || !consumeBody) {
    res.destroy();
    return Promise.resolve(new Response(null, { status, headers }));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let count = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      res.destroy();
      fn(value);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      count += 1;
      bytes += chunk.length;
      if (bytes > maxBytes || count > maxChunks) {
        finish(reject, fail('DOWNLOAD_BYTES_LIMIT'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks, bytes);
        const decoded = decodeBody(raw, headers, maxBytes);
        if (decoded.length > maxBytes) throw fail('DOWNLOAD_BYTES_LIMIT');
        resolve(new Response(decoded, { status, headers }));
      } catch (error) {
        reject(error);
      }
    });
    res.on('error', (error) => finish(reject, error));
    res.on('aborted', () => finish(reject, fail('INVALID_RESPONSE')));
  });
}

function requestOnce({
  protocol,
  host,
  port,
  path,
  method,
  headers,
  body,
  addresses,
  maxBytes,
  maxChunks,
  consumeBody,
  requestImpl,
  register,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const transport = requestImpl ?? (protocol === 'https:' ? https.request : http.request);
    const options = {
      method,
      hostname: host,
      port,
      path,
      headers,
      agent: false,
      autoSelectFamily: true,
      lookup: pinnedLookup(addresses),
      ...(protocol === 'https:' && !parseIpv4Octets(host) && !host.includes(':')
        ? { servername: host }
        : {}),
    };
    let req;
    try {
      req = transport(options, (res) => {
        register?.({ res });
        const status = res.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
        }
        if (status < 200) {
          res.destroy();
          settle(reject, fail('INVALID_RESPONSE'));
          return;
        }
        collectResponse(res, { method, status, headers: responseHeaders, maxBytes, maxChunks, consumeBody })
          .then((response) => settle(resolve, response), (error) => settle(reject, error));
      });
    } catch (error) {
      reject(error);
      return;
    }
    register?.({ req });
    req.on('error', (error) => settle(reject, error));
    if (body !== undefined && body !== null) {
      if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
        req.write(body);
      } else if (typeof body.pipe === 'function') {
        body.pipe(req);
      } else {
        req.destroy();
        settle(reject, fail('INVALID_REQUEST_BODY'));
        return;
      }
    }
    req.end();
  });
}

/**
 * Bounded fetch with a pinned socket.
 *
 * - `policy: 'media'` (default) is for user-controlled URLs: every hop is
 *   HTTPS-only in production, DNS is resolved once and the socket lookup is
 *   pinned to those validated addresses (AUD-B02).
 * - `policy: 'control-plane'` is for orchestrator-constructed destinations
 *   (callbacks, signed uploads, composition refs). An origin allowlist can
 *   explicitly trust local/private targets; without one, the same public-only
 *   checks apply. This is the explicit distinction required by ADJ-01.
 *
 * `fetchImpl`/`requestImpl` are test seams. When `fetchImpl` is a custom mock,
 * the legacy fetch path runs so existing unit tests keep their transport; the
 * production path (no override or the global fetch) uses node:http(s).
 */
export async function fetchBounded(
  url,
  {
    fetchImpl,
    requestImpl,
    timeoutMs = 60_000,
    maxBytes = 64 * 1024 * 1024,
    maxChunks = 100_000,
    init = {},
    consumeBody = true,
    disallowLoopback,
    lookupImpl,
    requireHttps,
    policy = 'media',
    trustedOrigins = [],
  } = {},
) {
  const testLoopback = process.env.VP_ALLOW_TEST_LOOPBACK === '1' && process.env.NODE_ENV !== 'production';
  const isControlPlane = policy === 'control-plane';
  const normalizedTrustedOrigins = (trustedOrigins ?? [])
    .map((origin) => String(origin).replace(/\/$/, ''))
    .filter(Boolean);
  const requireHttpsEffective = requireHttps ?? process.env.NODE_ENV === 'production';
  const effectiveLookup = lookupImpl !== undefined
    ? lookupImpl
    : (fetchImpl === undefined || fetchImpl === globalThis.fetch) && !testLoopback
      ? dns.promises.lookup
      : null;

  const hopPolicy = (candidateUrl) => {
    let origin = '';
    try {
      origin = new URL(candidateUrl).origin;
    } catch {
      throw fail('SSRF_INVALID_URL');
    }
    if (isControlPlane && normalizedTrustedOrigins.length > 0 && !normalizedTrustedOrigins.includes(origin)) {
      throw fail('UNTRUSTED_CONTROL_PLANE_ORIGIN');
    }
    const trusted = isControlPlane && normalizedTrustedOrigins.includes(origin);
    const hopDisallow = disallowLoopback !== undefined
      ? disallowLoopback
      : !(testLoopback || trusted);
    return {
      disallowLoopback: hopDisallow,
      requireHttps: requireHttpsEffective,
      allowPrivateAddresses: trusted,
    };
  };

  const usePinnedTransport = requestImpl !== undefined
    || fetchImpl === undefined
    || fetchImpl === globalThis.fetch;

  if (!usePinnedTransport) {
    return legacyFetchBounded(url, {
      fetchImpl,
      timeoutMs,
      maxBytes,
      maxChunks,
      init,
      consumeBody,
      lookupImpl: effectiveLookup,
      hopPolicy,
    });
  }

  const controller = {
    expired: false,
    request: undefined,
    response: undefined,
    destroy() {
      this.expired = true;
      try { this.response?.destroy(); } catch { /* already closed */ }
      try { this.request?.destroy(); } catch { /* already closed */ }
    },
  };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.destroy();
      reject(fail('DOWNLOAD_DEADLINE'));
    }, timeoutMs);
  });

  const work = (async () => {
    let currentUrl = String(url);
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const policyForHop = hopPolicy(currentUrl);
      const validated = await validateEgressUrl(currentUrl, {
        ...policyForHop,
        lookupImpl: effectiveLookup,
      });
      if (controller.expired) throw fail('DOWNLOAD_DEADLINE');
      const parsed = validated.parsed;
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      const method = String(init.method ?? 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST' && method !== 'PUT') {
        throw fail('INVALID_METHOD');
      }
      const headers = new Headers(init.headers);
      headers.delete('host');
      headers.set('Host', parsed.host);
      headers.set('Accept-Encoding', 'identity');
      headers.set('Connection', 'close');
      const requestBody = init.body;
      if (
        requestBody !== undefined && requestBody !== null
        && (typeof requestBody === 'string' || Buffer.isBuffer(requestBody) || requestBody instanceof Uint8Array)
      ) {
        headers.set('Content-Length', String(Buffer.byteLength(requestBody)));
      }
      let response;
      try {
        response = await requestOnce({
          protocol: parsed.protocol,
          host,
          port,
          path: `${parsed.pathname || '/'}${parsed.search}`,
          method,
          headers: Object.fromEntries(headers.entries()),
          body: init.body,
          addresses: validated.addresses,
          maxBytes,
          maxChunks,
          consumeBody,
          requestImpl,
          register: ({ req: request, res: responseStream }) => {
            if (request) controller.request = request;
            if (responseStream) controller.response = responseStream;
            if (controller.expired) {
              try { request?.destroy(); } catch { /* closed */ }
              try { responseStream?.destroy(); } catch { /* closed */ }
            }
          },
        });
      } catch (error) {
        if (controller.expired) throw fail('DOWNLOAD_DEADLINE');
        throw error;
      }
      if (controller.expired) throw fail('DOWNLOAD_DEADLINE');
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get('location');
        if (!location) throw fail(`HTTP_${status}`);
        if (hop === MAX_REDIRECT_HOPS) throw fail('SSRF_TOO_MANY_REDIRECTS');
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!consumeBody) return { response, buffer: Buffer.alloc(0) };
      if (!response.ok) throw fail(`HTTP_${status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      return { response, buffer };
    }
    throw fail('SSRF_TOO_MANY_REDIRECTS');
  })();
  work.catch(() => {}); // deadline may win; the late rejection is already surfaced by the race

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function legacyFetchBounded(url, {
  fetchImpl,
  timeoutMs,
  maxBytes,
  maxChunks,
  init,
  consumeBody,
  lookupImpl,
  hopPolicy,
}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('DOWNLOAD_DEADLINE'));
    }, timeoutMs);
  });
  let reader;
  try {
    return await Promise.race([
      deadline,
      (async () => {
        let currentUrl = String(url);
        let response;
        for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
          const policyForHop = hopPolicy(currentUrl);
          await validateEgressUrl(currentUrl, {
            ...policyForHop,
            lookupImpl,
          });
          response = await fetchImpl(currentUrl, {
            ...init,
            redirect: init.redirect ?? 'manual',
            signal: controller.signal,
          });
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers?.get?.('location');
            try { await response.body?.cancel?.(); } catch { /* body already gone */ }
            if (!location) {
              controller.abort();
              throw new Error(`HTTP_${response.status}`);
            }
            if (hop === MAX_REDIRECT_HOPS) {
              controller.abort();
              throw new Error('SSRF_TOO_MANY_REDIRECTS');
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
          }
          break;
        }
        if (response?.url) {
          const finalPolicy = hopPolicy(response.url);
          await validateEgressUrl(response.url, { ...finalPolicy, lookupImpl: null });
        }
        if (!consumeBody) {
          controller.abort();
          return { response, buffer: Buffer.alloc(0) };
        }
        if (!response.ok) {
          controller.abort();
          throw new Error(`HTTP_${response.status}`);
        }
        if (Number(response.headers.get('content-length')) > maxBytes) {
          controller.abort();
          throw new Error('DOWNLOAD_BYTES_LIMIT');
        }
        if (!response.body?.getReader) throw new Error('STREAM_REQUIRED');
        reader = response.body.getReader();
        let bytes = 0;
        let count = 0;
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          count++;
          bytes += value.byteLength;
          if (bytes > maxBytes || count > maxChunks) {
            controller.abort();
            throw new Error('DOWNLOAD_BYTES_LIMIT');
          }
          chunks.push(Buffer.from(value));
        }
        return { response, buffer: Buffer.concat(chunks, bytes) };
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      try {
        await reader?.cancel();
      } catch {
        /* abort already stopped body */
      }
    }
    try {
      reader?.releaseLock();
    } catch {
      /* pending reader on aborted transport */
    }
  }
}