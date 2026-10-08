// @vitest-environment node
/**
 * callback-retry.test.ts — V5_32 Fase C (C2 — D2)
 *
 * No incidente o worker dava o callback por enviado sem ler `res.ok`: a edge
 * respondeu 400 BAD_BODY (schema do callback) e o job ficou `dispatched` no
 * orquestrador (loading eterno). Estes testes pinam a entrega robusta:
 * leitura de `res.ok`, retry com backoff curto, corpo do erro no log e o
 * desfecho devolvido para `job.callback_status` (visível no /job/:id/status).
 */
import { describe, expect, it, vi } from 'vitest';
import { postCallback } from './server.js';

const URL = 'https://edge.example/video-v4-orchestrator/callback';
const SECRET = 'cb-secret';
const PAYLOAD = { job_id: 'j1', project_id: 'p1', step: 'build', status: 'failed', error: 'boom' };

function logger() {
  return { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
}

/** fetch falso que devolve as respostas na ordem dada (por chamada). */
function fetchSequence(responses: Array<Response | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    // Clone por chamada: um Response só pode ser lido uma vez (o retry
    // volta a ler o corpo para o log/estado).
    return next.clone();
  });
}

describe('V5_32 C2 — postCallback (res.ok + retry + estado visível)', () => {
  it('400 seguido de 200 → entrega com 2 tentativas e o secret do worker', async () => {
    const fetchImpl = fetchSequence([
      new Response(JSON.stringify({ error: 'BAD_BODY' }), { status: 400 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const log = logger();

    const result = await postCallback(URL, SECRET, PAYLOAD, { fetchImpl, sleep, log, baseDelayMs: 10 });

    expect(result).toMatchObject({ ok: true, status: 200, attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const init = fetchImpl.mock.calls[1][1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Worker-Secret']).toBe(SECRET);
    expect(init.method).toBe('POST');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1); // só a tentativa rejeitada
    expect(String(log.error.mock.calls[0][0])).toContain('400');
  });

  it('400 permanente → falha visível com status + corpo, 3 tentativas', async () => {
    const fetchImpl = fetchSequence([
      new Response(JSON.stringify({ error: 'BAD_BODY' }), { status: 400 }),
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const log = logger();

    const result = await postCallback(URL, SECRET, PAYLOAD, { fetchImpl, sleep, log });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.attempts).toBe(3);
    expect(result.error).toContain('400');
    expect(result.error).not.toContain('BAD_BODY');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // backoff entre tentativas, nunca depois da última
    expect(log.error).toHaveBeenCalledTimes(4); // 3 tentativas + o «giving up» final
    expect(log.error.mock.calls.at(-1)?.[0]).toContain('giving up');
  });

  it('erro de transporte (worker/edge inacessível) → mesma política de retry', async () => {
    const fetchImpl = fetchSequence([new Error('ECONNREFUSED')]);
    const sleep = vi.fn(() => Promise.resolve());

    const result = await postCallback(URL, SECRET, PAYLOAD, { fetchImpl, sleep, log: logger() });

    expect(result).toMatchObject({ ok: false, attempts: 3 });
    expect(result.error).toBe('CALLBACK_TRANSPORT_FAILED');
  });

  it('200 à primeira → uma tentativa, sem backoff', async () => {
    const fetchImpl = fetchSequence([new Response('{}', { status: 200 })]);
    const sleep = vi.fn(() => Promise.resolve());

    const result = await postCallback(URL, SECRET, PAYLOAD, { fetchImpl, sleep, log: logger() });

    expect(result).toMatchObject({ ok: true, status: 200, attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });
});
