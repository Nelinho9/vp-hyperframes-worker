/**
 * sha256.ts — fonte ÚNICA do hash SHA-256 hex dual-runtime (Deno edge +
 * vitest/Node) para todo o domínio de composição/áudio.
 *
 * Existiam três implementações idênticas em semântica: `compositionSha256`
 * (publicador), `sha256Hex` de `regenerateEnvelope` (recibo do candidato) e
 * `sha256Hex` de `briefAuthoritative` (auditoria do brief). Os módulos
 * antigos reexportam daqui para não partir os importadores.
 *
 * Módulo puro e **sem imports** — consumível por `_shared`, pelas edges e
 * pelo orquestrador sem arrastar zod nem o publicador.
 */

/** SHA-256 hex de bytes ou texto (WebCrypto — Deno e Node ≥ 18). */
export async function sha256Hex(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : new Uint8Array(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
