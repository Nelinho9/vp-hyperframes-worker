/**
 * llmProvider.ts — perfil de capacidades do provider LLM, resolvido a partir do
 * URL. Substitui os testes dispersos `apiUrl.includes('openrouter.ai')` que
 * existiam em 4 ficheiros e misturavam três preocupações num só booleano
 * (streaming, controlo de thinking e estratégia de parsing).
 *
 * Auditoria 2026-10-06: nenhum endpoint vive no código — o URL vem sempre de
 * env (LLM_API_URL / VISION_API_URL) e um URL inválido ou em falta falha com
 * erro de configuração explícito, nunca com um default silencioso.
 *
 * Dual-runtime (padrão `readStepEnv` de _steps.ts): as leituras de env são
 * guardadas para que o módulo corra sob Deno (edge) e sob Node/vitest.
 */

export type LlmKind = 'openrouter' | 'gemini' | 'kie' | 'generic';

/** Como o provider aceita o controlo de thinking. */
export type ThinkingMode =
  | 'reasoning-object' // OpenRouter: reasoning:{effort}
  | 'reasoning-effort' // OpenAI-compat da Google: reasoning_effort (top-level)
  | 'think' // kie.ai /codex/v1/responses: think:'high'
  | 'none';

export interface LlmCapability {
  kind: LlmKind;
  /** Hostname normalizado — entra nos logs para um 401 ser diagnosticável. */
  host: string;
  /** Enviar stream:true + stream_options. */
  stream: boolean;
  thinking: ThinkingMode;
  /** provider:{sort:'throughput'} (só OpenRouter). */
  routing: boolean;
  /** HTTP-Referer / X-Title (só OpenRouter; afecta atribuição de app). */
  appHeaders: boolean;
  /** response_format:{type:'json_object'} é honrado. */
  jsonMode: boolean;
  /** O provider só aceita imagens inline (data: URL), não URLs HTTPS. */
  inlineImages: boolean;
}

/** Leitura de env dual-runtime (Deno edge devolve o valor; Node/vitest ''). */
function readEnv(name: string): string {
  try {
    if (typeof Deno !== 'undefined') return Deno.env.get(name) ?? '';
  } catch {
    // Node/vitest sem Deno.
  }
  return '';
}

/**
 * Resolve o perfil a partir do URL. Detecção por HOSTNAME parseado, não por
 * substring: `https://proxy.internal/openrouter.ai/v1` classificava-se como
 * OpenRouter no teste antigo. Um URL não-parseável lança — fail-fast que os
 * testes por substring nunca tiveram.
 */
export function llmCapability(apiUrl: string): LlmCapability {
  let host: string;
  try {
    host = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`LLM_CONFIG: invalid LLM endpoint URL: ${JSON.stringify(apiUrl)}`);
  }

  const endsWith = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

  if (endsWith('openrouter.ai')) {
    return { kind: 'openrouter', host, stream: true, thinking: 'reasoning-object', routing: true, appHeaders: true, jsonMode: true, inlineImages: false };
  }
  if (host === 'generativelanguage.googleapis.com' || endsWith('aiplatform.googleapis.com')) {
    // Matriz congelada por scripts/probe-gemini-compat.mjs contra a chave real
    // do AI Studio (2026-10-06, gemini-3.8-flash):
    //   stream:true    — P1b: stream + stream_options.include_usage + json_object
    //                    + reasoning_effort + max_tokens, tudo junto, 3 eventos e
    //                    usage no último. (O streaming NÃO é o que protege do
    //                    IDLE_TIMEOUT de 150s — é o stepKeepAlive do chamador;
    //                    está ligado porque devolve usage e progresso.)
    //   jsonMode:true  — P1: com response_format vem JSON nu; sem ele vem cercado
    //                    de ```, logo o campo é lido e não ignorado.
    //   inlineImages:false — P7a/P7b: `image_url` com URL HTTPS é aceite, incluindo
    //                    query string (a forma das URLs assinadas do Supabase). Não
    //                    é preciso inlinear bytes; o plumbing atual mantém-se.
    //   thinking:'reasoning-effort' — P3: low=1112ms/0 tok escondidos vs
    //                    high=4692ms/824, e P3b mostra que o shape nested do
    //                    OpenRouter é RECUSADO com 400 (não ignorado).
    return { kind: 'gemini', host, stream: true, thinking: 'reasoning-effort', routing: false, appHeaders: false, jsonMode: true, inlineImages: false };
  }
  if (endsWith('kie.ai')) {
    return { kind: 'kie', host, stream: false, thinking: 'reasoning-object', routing: false, appHeaders: false, jsonMode: true, inlineImages: false };
  }
  return { kind: 'generic', host, stream: false, thinking: 'none', routing: false, appHeaders: false, jsonMode: true, inlineImages: false };
}

/**
 * Mapeia o effort para o enum que o provider aceita. Necessário porque
 * `LLM_REASONING_EFFORT=xhigh` é histórico real deste tenant (§62) e o enum
 * nominal da Google é minimal|low|medium|high.
 *
 * O PISO é `low`, não `minimal`: o probe (P3c/P6) mostrou que `minimal` é
 * aceite por uns modelos e RECUSADO por outros com HTTP 400 — "Thinking level
 * MINIMAL is not supported for this model" (gemini-3.8-flash). O perfil é por
 * provider, não por modelo, e um 400 no gate de humanos é fail-closed: bloqueia
 * todas as cenas. Entre um clamp registado e uma pipeline parada, fica o clamp.
 *
 * `none` também não omite o campo: omitir dá thinking destapado, o inverso da
 * intenção (e a doc confirma que o thinking não se desliga nos Gemini 3).
 * Cada clamp avisa — substituir um valor em silêncio é o que a doutrina do repo
 * proíbe, um clamp registado é honesto.
 */
export function normalizeReasoningEffort(kind: LlmKind, raw: string): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (kind !== 'gemini') return v; // OpenRouter aceita max|xhigh|high|medium|low|minimal|none

  if (v === 'xhigh' || v === 'max') {
    console.warn(`[llmProvider] reasoning effort "${v}" não existe no Gemini — a enviar "high"`);
    return 'high';
  }
  if (v === 'none' || v === 'minimal') {
    console.warn(`[llmProvider] reasoning effort "${v}" não é utilizável no Gemini (o modelo alvo recusa MINIMAL com HTTP 400) — a enviar "low"`);
    return 'low';
  }
  if (v === 'low' || v === 'medium' || v === 'high') return v;

  console.warn(`[llmProvider] reasoning effort "${v}" desconhecido — a enviar "medium"`);
  return 'medium';
}

/**
 * Chave por provider. Gemini exige GEMINI_API_KEY; nunca recebe a credencial
 * legacy do OpenRouter. Os providers podem coexistir durante uma migração.
 */
export function resolveApiKey(kind: LlmKind): string {
  const chain: string[] =
    kind === 'gemini'
      ? ['GEMINI_API_KEY']
      : kind === 'openrouter'
        ? ['LLM_API_KEY', 'OPENROUTER_API_KEY']
        : kind === 'kie'
          ? ['KIE_API_KEY', 'KIE_AI_API_KEY', 'LLM_API_KEY']
          : ['LLM_API_KEY', 'KIE_API_KEY'];

  for (const name of chain) {
    const v = readEnv(name);
    if (v) return v;
  }
  throw new Error(`LLM_CONFIG: no API key configured for ${kind} — set one of: ${chain.join(', ')}`);
}

/** Primeiro URL não-vazio da lista; em falta, erro nomeando as variáveis. */
export function requireApiUrl(names: string[]): string {
  for (const name of names) {
    const v = readEnv(name);
    if (v) return v.replace(/\/+$/, '');
  }
  throw new Error(`LLM_CONFIG: no endpoint configured — set one of: ${names.join(', ')}`);
}

/**
 * Ids de modelo não são portáveis entre providers: o OpenRouter usa
 * `autor/slug:sufixo` e a Google usa `gemini-3.8-flash`. Apontar o URL ao Google
 * sem trocar os ids dá 404 — e no gate de humanos um 404 permanente significa
 * "bloquear a cena". Apanha-se aqui, à resolução, em vez de na fatura.
 *
 * Segunda armadilha, apanhada pelo probe (P0): o `GET /models` da Google devolve
 * os ids PREFIXADOS (`models/gemini-3.8-flash`) mas o chat quer o id nu. Copiar
 * do listing para o env dá um 400 — o erro nomeia as duas formas.
 */
export function assertModelIdForKind(kind: LlmKind, model: string): void {
  if (kind !== 'gemini') return;
  const m = (model ?? '').trim();
  if (!m.includes('/')) return;
  if (m.startsWith('models/')) {
    throw new Error(`LLM_CONFIG: "${m}" é a forma prefixada que o GET /models devolve — o chat quer o id nu: "${m.slice('models/'.length)}"`);
  }
  throw new Error(`LLM_CONFIG: "${m}" é um id de OpenRouter, não da Google — usa o id pontuado (ex.: gemini-3.8-flash)`);
}
