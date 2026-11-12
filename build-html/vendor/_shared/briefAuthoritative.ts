/**
 * briefAuthoritative.ts — F13 (V5.34): intenção autoritativa do brief no pipeline.
 *
 * Função pura única que constrói o `manifest.brief` com substância em TODOS os
 * percursos (com e sem captura, quick-mode incluído), partilhada com
 * `buildProjectBrief` (captureBridge delega para aqui — sem duplicar
 * formatadores).
 *
 * Causa raiz (auditoria 2026-10-10, projeto 5d9ecd21 sem captura):
 * - `manifest.brief` NULL em todos os steps → fallback genérico
 *   `create a promotional video` em `_steps.ts extractBrief` → LLMs de
 *   design/storyboard/visual/build alucinaram conteúdo off-brief (EN sobre
 *   hosting em vez do brief PT do Café Aroma).
 * - Duas perdas encadeadas: (1) o RPC `create_video_project_v1` reconstrói o
 *   metadata a partir da sessão mas DESCARTA o `intake_context` enviado pelo
 *   cliente (fragmenta em `intake_dialogue`/`original_request`/`resolved_brief`
 *   que o builder antigo não lia); (2) o `ManifestV4Schema` (zod, sem
 *   passthrough) DESPPIA o `brief` em cada parse → cada `updateManifest` com
 *   manifesto parseado apagava o brief do DB.
 *
 * Este módulo é dual-runtime (Deno edge + Node vitest): sem Deno.env, sem
 * I/O, só puro + `crypto.subtle` (async) para o sha256 de auditoria.
 *
 * Contratos:
 * - Quick-mode com captura e sem intake (sem substância de diálogo) produz
 *   byte-idêntico ao builder pré-F13 (sem linha nova, sem intake) — F13.06.
 * - Com intake (contexto ou campos fragmentados do RPC), o brief carrega
 *   pedido original integral + diálogo ordenado + resolved brief aprovado +
 *   config efetiva — F13.02.
 * - Com UI=`auto`, o idioma efetivo deriva do brief/diálogo (brief PT → `pt`,
 *   nunca `en` silencioso) e a linha `Video language:` reflete o efetivo —
 *   F13.04.
 * - Sem substância (sem pedido, sem resolved, sem captura), o step falha
 *   explícito `BRIEF_SUBSTANCE_MISSING` sem débito LLM — F13.03.
 */

import { formatIntakeContext, type IntakePromptContext } from './intakeContext.ts';

/** Código de falha explícita do gate de substância (sem débito LLM). */
export const BRIEF_SUBSTANCE_MISSING = 'BRIEF_SUBSTANCE_MISSING';

/** Prefixo do fallback genérico silencioso pré-F13 (nunca mais emitido). */
export const BRIEF_GENERIC_FALLBACK_PREFIX = 'Project brief: create a promotional video';

/** Formato canónico das dimensões por formato (espelho de captureBridge). */
const FORMAT_DIMENSIONS: Record<string, { width: number; height: number; ratio: string }> = {
  landscape: { width: 1920, height: 1080, ratio: '16:9' },
  portrait: { width: 1080, height: 1920, ratio: '9:16' },
  square: { width: 1080, height: 1080, ratio: '1:1' },
};

const VIDEO_TYPE_LABELS: Record<string, string> = {
  brand_reel: 'brand reel',
  product_demo: 'product demo',
  launch_teaser: 'launch teaser',
  feature_spotlight: 'feature spotlight',
};

/** Metadados mínimos lidos pelo builder (defensivo — projetos legacy). */
export interface BriefMeta {
  site_url?: unknown;
  niche?: unknown;
  style?: unknown;
  language?: unknown;
  voice_locale?: unknown;
  original_request?: unknown;
  resolved_brief?: unknown;
  video_config?: unknown;
  requested_config?: unknown;
  effective_config?: unknown;
  config_resolution?: unknown;
  intake_context?: unknown;
  intake_session_id?: unknown;
  intake_revision?: unknown;
  intake_dialogue?: unknown;
  effective_constraints?: unknown;
  [key: string]: unknown;
}

// ─── Reconstrução do contexto intake ─────────────────────────────────────────

/**
 * Valida um turno de diálogo (forma do RPC: {role, content, sequence}).
 */
function isDialogueTurn(v: unknown): v is { role: 'user' | 'assistant'; content: string; sequence: number } {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (t.role === 'user' || t.role === 'assistant')
    && typeof t.content === 'string'
    && typeof t.sequence === 'number';
}

function asDialogueArray(v: unknown): Array<{ role: 'user' | 'assistant'; content: string; sequence: number }> | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter(isDialogueTurn);
  // Aceita array vazio (diálogo sem turnos) como contexto válido sem diálogo.
  return out;
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * Reconstrói o `IntakePromptContext` a partir do metadata, aceitando as DUAS
 * formas reais:
 * - cliente (insert direto): `meta.intake_context` (objeto completo);
 * - RPC `create_video_project_v1`: campos fragmentados (`intake_session_id`,
 *   `intake_revision`, `original_request`, `intake_dialogue`, `resolved_brief`,
 *   `requested_config`, `effective_constraints`).
 *
 * Devolve null quando não há sessão intake (quick-mode / legacy sem diálogo).
 */
export function reconstructIntakeContext(meta: BriefMeta | null | undefined): IntakePromptContext | null {
  if (!meta || typeof meta !== 'object') return null;
  // Forma 1: contexto completo do cliente.
  const ctx = meta.intake_context as Record<string, unknown> | undefined;
  if (ctx && typeof ctx === 'object') {
    const sessionId = nonEmptyString(ctx.session_id);
    const original = typeof ctx.original_request === 'string' ? ctx.original_request : null;
    if (sessionId && original !== null) {
      const dialogue = Array.isArray(ctx.dialogue) ? (ctx.dialogue.filter(isDialogueTurn) as IntakePromptContext['dialogue']) : [];
      return {
        session_id: sessionId,
        revision: positiveInt(ctx.revision) ?? 1,
        original_request: original,
        dialogue,
        resolved_brief: ctx.resolved_brief ?? null,
        requested_config: ctx.requested_config ?? null,
        effective_constraints: ctx.effective_constraints ?? null,
      };
    }
  }
  // Forma 2: campos fragmentados do RPC.
  const sessionId = nonEmptyString(meta.intake_session_id);
  const original = typeof meta.original_request === 'string' ? meta.original_request : null;
  if (sessionId && original !== null) {
    const dialogue = asDialogueArray(meta.intake_dialogue) ?? [];
    return {
      session_id: sessionId,
      revision: positiveInt(meta.intake_revision) ?? 1,
      original_request: original,
      dialogue,
      resolved_brief: (meta.resolved_brief as unknown) ?? null,
      requested_config: (meta.requested_config as unknown) ?? null,
      effective_constraints: (meta.effective_constraints as unknown) ?? null,
    };
  }
  return null;
}

// ─── Deteção de idioma do texto (F13.04) ─────────────────────────────────────

/**
 * Deteção heurística determinística do idioma do brief/diálogo.
 *
 * Com UI=`auto`, o idioma efetivo deriva do texto (brief PT → `pt`, nunca
 * `en` silencioso). Heurística simples e auditável: conta marcadores PT
 * (acentos + stopwords) vs EN (stopwords). Empate com marcadores PT → `pt`
 * (o operador é PT; o bug era EN silencioso sobre brief PT).
 * Sem texto ou sem sinal → null (chamador preserva comportamento legacy,
 * sem linha nova — quick-mode byte-idêntico).
 */
export function detectBriefTextLanguage(text: string | null | undefined): 'pt' | 'en' | null {
  if (typeof text !== 'string' || text.trim().length < 8) return null;
  const lower = text.toLowerCase();
  let pt = 0;
  let en = 0;
  // Marcadores gráficos PT (fortes).
  const ptDiacritics = lower.match(/[ãõçàáâêéíóôú]/g);
  if (ptDiacritics) pt += ptDiacritics.length * 3;
  // Stopwords / léxico PT.
  const ptWords = [
    ' para ', ' com ', ' uma ', ' café', ' promo', ' vídeo', ' voce ', ' você ',
    ' seu ', ' sua ', ' nosso ', ' nossa ', ' empresa ', ' oferta ', ' hoje ',
    ' agora ', ' mais ', ' muito ', ' também', ' tambem', ' não ', ' nao ',
    ' são ', ' sao ', ' estão', ' estao', ' fazer ', ' criar ', ' sobre ',
    ' entre ', ' este ', ' esta ', ' esse ', ' essa ', ' aquele ', ' aquela ',
    ' brunch', ' aroma', ' pastel', ' bolo ', ' pão ', ' pao ', ' queijo',
    ' fresc', ' delici', ' venha ', ' conheça', ' conheca', ' experimente ',
    ' peça ', ' peca ', ' peça já', ' ligue ', ' visite ', ' rua ', ' avenida ',
    ' lisboa', ' porto ', ' portugal', ' brasileiro', ' obrigado', ' por favor',
    ' dos ', ' das ', ' nos ', ' nas ', ' pelos ', ' pelas ', ' como ',
    ' quando ', ' onde ', ' porque', ' pois ', ' então', ' entao', ' todos ',
    ' todas ',
  ];
  for (const w of ptWords) {
    let idx = lower.indexOf(w);
    while (idx >= 0) {
      pt += 2;
      idx = lower.indexOf(w, idx + 1);
    }
  }
  // Stopwords / léxico EN.
  const enWords = [
    ' the ', ' and ', ' with ', ' for ', ' create ', ' promotional ',
    ' hosting ', ' website ', ' business ', ' this ', ' that ', ' from ',
    ' have ', ' will ', ' your ', ' our ', ' about ', ' which ', ' their ',
    ' there ', ' hello ', ' welcome ', ' click ', ' discover ', ' hosting',
    ' server', ' cloud', ' tech ',
  ];
  for (const w of enWords) {
    let idx = lower.indexOf(w);
    while (idx >= 0) {
      en += 2;
      idx = lower.indexOf(w, idx + 1);
    }
  }
  if (pt === 0 && en === 0) return null;
  if (pt > en) return 'pt';
  if (en > pt) return 'en';
  // Empate com sinal PT presente → pt (anti-EN-silencioso).
  return pt > 0 ? 'pt' : null;
}

/**
 * Texto agregado para deteção: pedido original + diálogo + resolved brief
 * (campos textuais) — a mesma substância que o gate exige.
 */
export function collectBriefLanguageCorpus(meta: BriefMeta | null | undefined): string {
  if (!meta || typeof meta !== 'object') return '';
  const parts: string[] = [];
  if (typeof meta.original_request === 'string') parts.push(meta.original_request);
  const dlg = asDialogueArray(meta.intake_dialogue);
  if (dlg) {
    for (const t of dlg) parts.push(t.content);
  } else {
    const ctx = meta.intake_context as { dialogue?: unknown } | undefined;
    if (ctx && Array.isArray(ctx.dialogue)) {
      for (const t of ctx.dialogue) {
        if (isDialogueTurn(t)) parts.push(t.content);
      }
    }
  }
  const rb = meta.resolved_brief as Record<string, unknown> | string | null | undefined;
  if (typeof rb === 'string') {
    parts.push(rb);
  } else if (rb && typeof rb === 'object') {
    for (const k of ['objective', 'offer', 'cta', 'summary', 'audience', 'platform', 'style']) {
      const v = rb[k];
      if (typeof v === 'string' && v.trim()) parts.push(v);
    }
    if (Array.isArray(rb.constraints)) {
      for (const c of rb.constraints) {
        if (typeof c === 'string' && c.trim()) parts.push(c);
      }
    }
  }
  return parts.join('\n');
}

/** Língua explícita não-`auto` num campo de config (UI/diálogo). */
function explicitLang(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length < 2 || t.length > 35 || t === 'auto') return null;
  return t;
}

function readConfigLang(cfg: unknown): string | null {
  if (!cfg || typeof cfg !== 'object') return null;
  return explicitLang((cfg as Record<string, unknown>).language);
}

/**
 * Idioma efetivo para a linha `Video language:` do brief (F13.04).
 *
 * Precedência: UI explícita (requested/video/effective) > diálogo explícito
 * (intake requested_config) > resolved_brief.language > deteção do texto >
 * null (sem linha — preserva quick-mode byte-idêntico).
 * Nunca devolve `en` por omissão silenciosa: sem fonte explícita e sem sinal
 * PT/EN no texto, devolve null em vez de inventar.
 */
export function resolveBriefEffectiveLanguage(
  meta: BriefMeta | null | undefined,
): { value: string; origin: 'ui' | 'dialogue' | 'resolved' | 'inference' } | null {
  if (!meta || typeof meta !== 'object') return null;
  const uiLang = readConfigLang(meta.requested_config)
    ?? readConfigLang(meta.video_config)
    ?? readConfigLang(meta.effective_config);
  if (uiLang) return { value: uiLang, origin: 'ui' };
  const intakeReq = (meta.intake_context as { requested_config?: unknown } | undefined)?.requested_config
    ?? (meta as { requested_config?: unknown }).requested_config;
  // `requested_config` já foi consumido como UI acima; aqui distingue-se o
  // diálogo só quando a UI está em auto — na prática o mesmo objeto, por isso
  // esta camada só conta quando a UI não trouxe língua (já retornado acima).
  // Mantida por clareza de precedência C3; sem dupla contagem.
  void intakeReq;
  const rb = meta.resolved_brief as Record<string, unknown> | string | null | undefined;
  if (rb && typeof rb === 'object') {
    const rbLang = explicitLang(rb.language);
    if (rbLang) return { value: rbLang, origin: 'resolved' };
    const rbLocale = typeof rb.voice_locale === 'string' ? rb.voice_locale.trim() : '';
    if (rbLocale && rbLocale !== 'auto') {
      const base = rbLocale.toLowerCase().split('-')[0].split('_')[0];
      if (base.length >= 2) return { value: base, origin: 'resolved' };
    }
  }
  const detected = detectBriefTextLanguage(collectBriefLanguageCorpus(meta));
  if (detected) return { value: detected, origin: 'inference' };
  return null;
}

// ─── Builder autoritativo ────────────────────────────────────────────────────

/** Escolhe effective > requested > video_config (mesma semântica UI/backend). */
export function pickEffectiveVideoConfig(meta: {
  video_config?: unknown;
  requested_config?: unknown;
  effective_config?: unknown;
}): unknown {
  const eff = (meta as { effective_config?: unknown }).effective_config;
  if (eff && typeof eff === 'object') return eff;
  const req = (meta as { requested_config?: unknown }).requested_config;
  if (req && typeof req === 'object') return req;
  return (meta as { video_config?: unknown }).video_config;
}

function appendVideoConfigParts(parts: string[], videoConfig: unknown): void {
  if (!videoConfig || typeof videoConfig !== 'object') return;
  const cfg = videoConfig as Record<string, unknown>;

  const format = typeof cfg.format === 'string' ? cfg.format : 'auto';
  const dims = FORMAT_DIMENSIONS[format];
  if (dims) {
    parts.push(`Format: ${format} ${dims.ratio} — the composition canvas MUST be ${dims.width}x${dims.height} (data-width/data-height).`);
  }

  if (typeof cfg.duration_seconds === 'number' && cfg.duration_seconds > 0) {
    parts.push(`Target duration: ${cfg.duration_seconds} seconds (root data-duration and total clip time).`);
  }

  const videoType = typeof cfg.video_type === 'string' ? cfg.video_type : 'auto';
  if (VIDEO_TYPE_LABELS[videoType]) {
    parts.push(`Video type: ${VIDEO_TYPE_LABELS[videoType]}.`);
  }

  const audio = (cfg.audio && typeof cfg.audio === 'object' ? cfg.audio : {}) as Record<string, unknown>;
  const toggles = ['narration', 'captions', 'music', 'sfx']
    .map((key) => {
      const value = typeof audio[key] === 'string' ? (audio[key] as string) : 'auto';
      return `${key}=${value}`;
    })
    .join(' ');
  if (/=(on|off)/.test(toggles)) {
    parts.push(`Audio & text directives (on/off are mandatory, auto is your choice): ${toggles}.`);
  }

  const voice = typeof cfg.voice === 'string' ? cfg.voice : 'auto';
  if (voice && voice !== 'auto') {
    parts.push(`Voiceover voice: ${voice} (KIE Gemini TTS voice name).`);
  }
  const vlang = typeof cfg.language === 'string' ? cfg.language : 'auto';
  if (vlang && vlang !== 'auto') {
    parts.push(`Video language: ${vlang}.`);
  }
  const vloc = typeof cfg.voice_locale === 'string' ? cfg.voice_locale : 'auto';
  if (vloc && vloc !== 'auto') {
    parts.push(`Voice locale: ${vloc}.`);
  }

  const coreMessage = typeof cfg.core_message === 'string' ? cfg.core_message.trim().slice(0, 500) : '';
  if (coreMessage) {
    parts.push(`Core message (must anchor the narrative): ${coreMessage}. (authoritative — kit must not override message/offer/CTA).`);
  }
}

export interface BriefTokensLike {
  brand_name?: unknown;
  description?: unknown;
  colors?: unknown;
  typography?: { heading_font?: unknown; body_font?: unknown };
  colorScheme?: unknown;
  fontSizes?: unknown;
  buttonPrimary?: unknown;
}

/**
 * Constrói o brief autoritativo (puro, síncrono).
 *
 * Byte-idêntico ao `buildProjectBrief` pré-F13 quando o input não tem intake
 * (quick-mode: sem `intake_context` nem campos fragmentados, sem deteção de
 * idioma) — a única diferença intencional é: (1) campos fragmentados do RPC
 * passam a gerar o bloco intake completo; (2) com UI=`auto` e texto com sinal,
 * emite `Video language: <efetivo>.` refletindo o derivado.
 */
export function buildAuthoritativeBrief(
  meta: BriefMeta | null | undefined,
  brandingConfig: Record<string, unknown> | null | undefined,
  tokens?: BriefTokensLike | null,
): string {
  const parts: string[] = [];

  if (meta?.site_url && typeof meta.site_url === 'string' && meta.site_url.trim()) {
    parts.push(`Create a promotional video for ${meta.site_url}`);
  } else {
    parts.push('Create a promotional video');
  }

  const intakeCtx = reconstructIntakeContext(meta);
  if (intakeCtx) {
    const notes: string[] = [];
    if (typeof meta?.site_url === 'string' && meta.site_url.trim()) {
      notes.push(`Selected site URL: ${meta.site_url}`);
    }
    const rb = meta?.resolved_brief as { capture_refs?: unknown } | undefined;
    if (rb && typeof rb === 'object' && 'capture_refs' in rb) {
      notes.push(`Approved capture references: ${JSON.stringify((rb as { capture_refs?: unknown }).capture_refs ?? [])}`);
    }
    parts.push(formatIntakeContext(intakeCtx, {
      site_url: typeof meta?.site_url === 'string' ? meta.site_url : null,
      notes,
    }));
  } else {
    if (typeof meta?.original_request === 'string' && meta.original_request.trim()) {
      parts.push(`Original user request: ${JSON.stringify(meta.original_request)}.`);
    }
    if (typeof meta?.resolved_brief === 'string' && meta.resolved_brief !== meta?.original_request) {
      parts.push(`Resolved brief: ${JSON.stringify(meta.resolved_brief)}.`);
    }
  }
  if (typeof meta?.voice_locale === 'string' && meta.voice_locale.trim()) {
    parts.push(`Voice locale: ${meta.voice_locale}.`);
  }

  if (typeof meta?.niche === 'string' && meta.niche !== 'general' && meta.niche.trim()) {
    parts.push(`Niche: ${meta.niche}.`);
  }

  if (typeof meta?.style === 'string' && meta.style.trim()) {
    parts.push(`Style: ${meta.style}.`);
  }

  if (typeof meta?.language === 'string' && meta.language.trim()) {
    parts.push(`Language: ${meta.language}.`);
  }

  if (brandingConfig) {
    const ctx = brandingConfig.context as Record<string, unknown> | undefined;
    const biz = brandingConfig.business as Record<string, unknown> | undefined;
    if (ctx) {
      if (ctx.tone_of_voice) parts.push(`Tone: ${ctx.tone_of_voice}.`);
      if (ctx.visual_style) parts.push(`Visual style: ${ctx.visual_style}.`);
      if (ctx.value_proposition) parts.push(`Value proposition: ${ctx.value_proposition}.`);
      if (ctx.brand_keywords && Array.isArray(ctx.brand_keywords) && ctx.brand_keywords.length > 0) {
        parts.push(`Brand keywords: ${ctx.brand_keywords.join(', ')}.`);
      }
    }
    if (biz) {
      if (biz.headline) parts.push(`Headline: ${biz.headline}.`);
      if (biz.cta_text) parts.push(`CTA: ${biz.cta_text}.`);
    }
  }

  if (tokens) {
    if (typeof tokens.brand_name === 'string' && tokens.brand_name.trim()) {
      parts.push(`Brand: ${tokens.brand_name}.`);
    }
    if (typeof tokens.description === 'string' && tokens.description.trim() && !brandingConfig) {
      parts.push(`About: ${tokens.description}.`);
    }
  }

  if (tokens) {
    const colors = (tokens.colors ?? {}) as Record<string, string>;
    const presentRoles = ['primary', 'secondary', 'accent', 'background', 'text'].filter(
      (r) => typeof colors[r] === 'string' && (colors[r] as string).length > 0,
    );
    if (presentRoles.length > 0) {
      const scheme = typeof tokens.colorScheme === 'string' && tokens.colorScheme ? ` (scheme ${tokens.colorScheme})` : '';
      if (colors.primary && colors.background) {
        const extras = presentRoles
          .filter((r) => r !== 'primary' && r !== 'background')
          .map((r) => `${r} ${colors[r]}`);
        const extraStr = extras.length > 0 ? `, ${extras.join(', ')}` : '';
        parts.push(`Palette: primary ${colors.primary} on background ${colors.background}${extraStr}${scheme}.`);
      } else {
        parts.push(`Palette: ${presentRoles.map((r) => `${r} ${colors[r]}`).join(', ')}${scheme}.`);
      }
    }
    const fontSizes = (tokens as { fontSizes?: Record<string, string> }).fontSizes;
    if (fontSizes && (fontSizes.h1 || fontSizes.body)) {
      const h1 = fontSizes.h1 ?? '?';
      const body = fontSizes.body ?? '?';
      const headingFont = tokens.typography?.heading_font ?? 'Inter';
      const bodyFont = tokens.typography?.body_font ?? 'Inter';
      parts.push(`Type: H1 ${h1} / body ${body} (${headingFont} / ${bodyFont}).`);
    }
    const buttonPrimary = (tokens as { buttonPrimary?: { background?: string; textColor?: string } }).buttonPrimary;
    if (buttonPrimary && (buttonPrimary.background || buttonPrimary.textColor)) {
      const bg = buttonPrimary.background ? `background ${buttonPrimary.background}` : '';
      const tc = buttonPrimary.textColor ? ` with text ${buttonPrimary.textColor}` : '';
      parts.push(`CTA style: ${bg}${tc}.`);
    }
  }

  const videoConfig = pickEffectiveVideoConfig({
    video_config: meta?.video_config,
    requested_config: (meta as { requested_config?: unknown } | null | undefined)?.requested_config,
    effective_config: (meta as { effective_config?: unknown } | null | undefined)?.effective_config,
  });
  const beforeConfigLen = parts.length;
  appendVideoConfigParts(parts, videoConfig);
  // F13.04: com UI=`auto` (nenhuma linha `Video language:` emitida acima) e
  // texto com sinal, a linha reflete o idioma efetivo derivado — nunca `en`
  // silencioso. Sem sinal, nada é emitido (quick-mode byte-idêntico).
  const emittedLanguageLine = parts.slice(beforeConfigLen).some((p) => p.startsWith('Video language:'));
  if (!emittedLanguageLine) {
    const eff = resolveBriefEffectiveLanguage(meta);
    if (eff && (eff.origin === 'resolved' || eff.origin === 'inference')) {
      parts.push(`Video language: ${eff.value}.`);
    }
  }

  return parts.join(' ');
}

// ─── Gate de substância (F13.03) ─────────────────────────────────────────────

function briefHasOriginalRequestMarker(brief: string): boolean {
  if (!/original user request|immutable original user request/i.test(brief)) return false;
  // Exige conteúdo citado não-trivial após o marcador (evita cabeçalho vazio).
  const idx = brief.search(/original user request/i);
  const tail = brief.slice(idx, idx + 2500);
  const quoted = tail.match(/"([^"]{12,})"/);
  if (quoted) return true;
  // Formato JSON do formatIntakeContext: string JSON após o cabeçalho.
  const jsonLine = tail.split('\n').slice(1, 4).join(' ').trim();
  return jsonLine.replace(/["\s.,]/g, '').length >= 12;
}

function briefHasResolvedMarker(brief: string): boolean {
  if (!/resolved brief|approved resolved brief/i.test(brief)) return false;
  const idx = brief.search(/resolved brief/i);
  const tail = brief.slice(idx, idx + 4000);
  // Substantivo mínimo: objective/offer/cta/summary com valor não-nulo.
  if (/"(objective|offer|cta|summary)"\s*:\s*"[^"]{3,}"/.test(tail)) return true;
  if (/"(objective|offer|cta)"\s*:\s*"[^"]+"/.test(tail)) return true;
  const quoted = tail.match(/"([^"]{16,})"/);
  return quoted !== null;
}

function tokensHaveSubstance(tokensJson: string | null | undefined): boolean {
  if (typeof tokensJson !== 'string' || !tokensJson.trim()) return false;
  try {
    const t = JSON.parse(tokensJson) as {
      brand_name?: unknown;
      description?: unknown;
      visible_text?: unknown;
      assets?: unknown;
    };
    if (typeof t.brand_name === 'string' && t.brand_name.trim().length >= 2) return true;
    if (typeof t.description === 'string' && t.description.trim().length >= 12) return true;
    if (typeof t.visible_text === 'string' && t.visible_text.trim().length >= 40) return true;
    if (Array.isArray(t.assets) && t.assets.length > 0) {
      const hasUrl = t.assets.some((a) => typeof (a as { url?: unknown })?.url === 'string' && ((a as { url: string }).url.trim().length > 8));
      if (hasUrl) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * O brief tem substância para alimentar um LLM?
 *
 * Passa quando QUALQUER UM existe:
 * - pedido original não-vazio (marcador + conteúdo no texto), OU
 * - resolved brief com objective/offer/cta/summary não-vazio, OU
 * - artefactos de captura com substância (marcadores no texto OU tokens.json
 *   com brand/description/visible_text/assets).
 *
 * O fallback genérico pré-F13 (`Project brief: create a promotional video…`
 * sem mais nada) chumba sempre.
 */
export function hasBriefSubstance(
  brief: string | null | undefined,
  inputs?: Record<string, string>,
): boolean {
  if (typeof brief !== 'string') return false;
  const trimmed = brief.trim();
  if (trimmed.length < 20) return false;
  if (new RegExp(`^${BRIEF_GENERIC_FALLBACK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?\\s*(Capture artifacts:.*)?$`, 'i').test(trimmed)) {
    return false;
  }
  if (briefHasOriginalRequestMarker(brief)) return true;
  if (briefHasResolvedMarker(brief)) return true;
  // Captura: marcadores no texto do brief…
  if (/Create a promotional video for https?:\S+/i.test(brief)) return true;
  if (/^Brand: .{2,}/m.test(brief)) return true;
  if (/^Palette: /m.test(brief)) return true;
  if (/^About: .{12,}/m.test(brief)) return true;
  // …ou tokens.json com substância (o step recebe-os como input separado).
  if (inputs && tokensHaveSubstance(inputs['capture/extracted/tokens.json'])) return true;
  return false;
}

/**
 * Detalhe honesto para o erro `BRIEF_SUBSTANCE_MISSING` (sem segredos: só
 * comprimentos e presença de marcadores, nunca o texto do brief).
 */
export function briefSubstanceDetail(
  brief: string | null | undefined,
  inputs?: Record<string, string>,
): string {
  const len = typeof brief === 'string' ? brief.trim().length : 0;
  const hasOriginal = typeof brief === 'string' && /original user request/i.test(brief);
  const hasResolved = typeof brief === 'string' && /resolved brief/i.test(brief);
  const tokensSub = tokensHaveSubstance(inputs?.['capture/extracted/tokens.json']);
  return `brief_chars=${len} has_original_marker=${hasOriginal} has_resolved_marker=${hasResolved} capture_tokens_substance=${tokensSub}`;
}

// ─── sha256 de auditoria ─────────────────────────────────────────────────────

/** sha256 hex do texto exato do brief (que LLM recebeu o quê). */
// Governança 02.5: fonte única em `_shared/sha256.ts` (era a 3.ª cópia).
export { sha256Hex } from './sha256.ts';
