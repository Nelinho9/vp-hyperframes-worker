import dns from 'node:dns';

const MAX_REDIRECT_HOPS = 5;

function parseIpv4Octets(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return null;
  return octets;
}

export function isNonPublicIp(rawHost, { disallowLoopback = true } = {}) {
  const host = String(rawHost ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;

  // IPv4-mapped IPv6 in dotted form (e.g. ::ffff:127.0.0.1 or ::ffff:169.254.169.254)
  const v4MappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (v4MappedDotted) {
    return isNonPublicIp(v4MappedDotted[1], { disallowLoopback });
  }

  // IPv4-mapped IPv6 in hex form (e.g. ::ffff:7f00:1 or ::ffff:a9fe:a9fe)
  const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isNonPublicIp(dotted, { disallowLoopback });
  }

  const v4 = parseIpv4Octets(host);
  if (v4) {
    const [a, b, c] = v4;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return disallowLoopback; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
    if (a >= 224) return true; // multicast & reserved (224.0.0.0/3)
    return false;
  }

  if (host.includes(':')) {
    if (host === '::' || host === '0:0:0:0:0:0:0:0') return true;
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return disallowLoopback;
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]:/i.test(host) || /^fe[89ab][0-9a-f]$/i.test(host.split(':')[0])) return true; // fe80::/10 link-local
    if (host.startsWith('ff')) return true; // multicast
    if (host.startsWith('2001:db8:')) return true; // documentation
  }

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

export async function validateEgressUrl(rawUrl, { disallowLoopback = true, lookupImpl = null } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? ''));
  } catch {
    throw new Error('SSRF_INVALID_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('SSRF_PROTOCOL_BLOCKED');
  }

  if (parsed.username || parsed.password) {
    throw new Error('SSRF_CREDENTIALS_BLOCKED');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isBlockedHostname(host, { disallowLoopback })) {
    throw new Error(`SSRF_BLOCKED_HOST:${host}`);
  }

  const isIpLiteral = Boolean(parseIpv4Octets(host)) || host.includes(':');
  if (!isIpLiteral && typeof lookupImpl === 'function') {
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
      if (!addr || isNonPublicIp(addr, { disallowLoopback })) {
        throw new Error(`SSRF_DNS_PRIVATE_IP:${addr || 'unknown'}`);
      }
    }
  }

  return parsed;
}

/** Deadline spans connection, headers, redirects and every streamed body chunk. */
export async function fetchBounded(
  url,
  {
    fetchImpl = fetch,
    timeoutMs = 60_000,
    maxBytes = 64 * 1024 * 1024,
    maxChunks = 100_000,
    init = {},
    consumeBody = true,
    disallowLoopback = false,
    lookupImpl,
  } = {},
) {
  const effectiveLookup =
    lookupImpl !== undefined
      ? lookupImpl
      : fetchImpl === globalThis.fetch && disallowLoopback
        ? dns.promises.lookup
        : null;

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
          await validateEgressUrl(currentUrl, {
            disallowLoopback,
            lookupImpl: effectiveLookup,
          });
          response = await fetchImpl(currentUrl, {
            ...init,
            redirect: init.redirect ?? 'manual',
            signal: controller.signal,
          });
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers?.get?.('location');
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
          await validateEgressUrl(response.url, {
            disallowLoopback,
            lookupImpl: null,
          });
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
        let bytes = 0,
          count = 0;
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
