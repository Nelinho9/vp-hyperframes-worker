/**
 * video-voice — pure decision logic (V2 Phase 4).
 *
 * Builds the KIE Gemini 3.1 Flash TTS job request (model + speakers +
 * dialogue_turns) from text + language, parses recordInfo results, and
 * implements the retry/fallback policy: retry exactly 1x on transient
 * failures; on final failure the caller proceeds WITHOUT voiceover — the
 * render pipeline never blocks on TTS.
 *
 * No runtime imports — unit-testable with vitest (see __tests__/voice.test.ts).
 * API contract: skill `.agents/skills/kie-gemini-3-1-flash-tts/SKILL.md`.
 */

export const TTS_MODEL = 'google/gemini-3-8-flash-tts';

export function resolveTtsModel(): string {
  try { return typeof Deno !== 'undefined' ? Deno.env.get('TTS_MODEL') || TTS_MODEL : TTS_MODEL; }
  catch { return TTS_MODEL; }
}
export const TTS_CREATE_TASK_URL = 'https://api.kie.ai/api/v1/jobs/createTask';
export const TTS_RECORD_INFO_URL = 'https://api.kie.ai/api/v1/jobs/recordInfo';
export const TTS_MAX_RETRIES = 1;
export const TTS_POLL_INTERVAL_MS = 5000;
export const TTS_POLL_MAX_ATTEMPTS = 60;

export interface VoiceProfile {
  voice_name: string;
  accent: string;
  style?: string;
  pace?: string;
  audio_profile?: string;
}

export interface VoiceText {
  id?: string;
  text: string;
}

/**
 * Phase 8a (T5): narration turns from the resolved project texts
 * (headline → subtitle order). Empty/missing texts are dropped; an empty
 * array means "nothing to narrate" (the generate action 400s).
 */
export function buildVoiceTexts(headline?: string, subtitle?: string): VoiceText[] {
  const turns: VoiceText[] = [];
  const h = headline?.trim();
  const s = subtitle?.trim();
  if (h) turns.push({ id: 'headline', text: h });
  if (s) turns.push({ id: 'subtitle', text: s });
  return turns;
}

export interface TtsInput {
  speakers: Array<Record<string, string>>;
  dialogue_turns: Array<{ speaker_id: string; text: string; style?: string }>;
  temperature?: number;
  scene?: string;
  sample_context?: string;
  // KIE spec allows extra properties (ApidogModel `[property: string]: any`).
  [property: string]: unknown;
}

export interface TtsRequestBody {
  model: string;
  input: TtsInput;
  callBackUrl?: string;
  [property: string]: unknown;
}

/** Per-language voice mapping (KIE VoiceName/Accent/Style/Pace enums exact). */
const VOICE_PROFILES: Record<string, VoiceProfile> = {
  pt: {
    voice_name: 'Zephyr',
    accent: 'Neutral',
    style: 'Empathetic',
    pace: 'Natural',
    audio_profile: 'A warm and clear advertisement narrator.',
  },
  en: {
    voice_name: 'Fenrir',
    accent: 'American (Gen)',
    style: 'Promo/Hype',
    pace: 'Rapid Fire',
    audio_profile: 'A confident and energetic ad voice.',
  },
  es: {
    voice_name: 'Aoede',
    accent: 'Neutral',
    style: 'Empathetic',
    pace: 'Natural',
    audio_profile: 'A warm and clear advertisement narrator.',
  },
  fr: {
    voice_name: 'Achernar',
    accent: 'Neutral',
    style: 'Vocal Smile',
    pace: 'Natural',
    audio_profile: 'A refined and pleasant ad voice.',
  },
  de: {
    voice_name: 'Charon',
    accent: 'Neutral',
    style: 'Newscaster',
    pace: 'Natural',
    audio_profile: 'A professional and trustworthy narrator.',
  },
  it: {
    voice_name: 'Puck',
    accent: 'Neutral',
    style: 'Vocal Smile',
    pace: 'Natural',
    audio_profile: 'A lively and friendly ad voice.',
  },
};

const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  voice_name: 'Zephyr',
  accent: 'Neutral',
  style: 'Empathetic',
  pace: 'Natural',
  audio_profile: 'A warm and clear advertisement narrator.',
};

/**
 * F2 T09 — perfis canónicos POR VOZ (não por idioma).
 *
 * Achado F0 (`evidence/f0/vozes-kie-auditoria.md`): `buildTtsRequestBody`
 * viajava com voz explícita + accent/style/pace do IDIOMA (ex.: M3 enviou
 * `Charon + American (Gen) + Promo/Hype + Rapid Fire`, aceite pelo provider
 * mas semanticamente inventado). O idioma só escolhe a voz default no `auto`;
 * voz explícita usa o seu próprio perfil.
 *
 * Valores derivados 1:1 dos perfis por idioma já auditados (cada idioma
 * ancora a sua voz default), sem inventar combinações novas.
 */
export const VOICE_STYLE_DEFAULTS: Record<string, VoiceProfile> = {
  Zephyr: {
    voice_name: 'Zephyr',
    accent: 'Neutral',
    style: 'Empathetic',
    pace: 'Natural',
    audio_profile: 'A warm and clear advertisement narrator.',
  },
  Fenrir: {
    voice_name: 'Fenrir',
    accent: 'American (Gen)',
    style: 'Promo/Hype',
    pace: 'Rapid Fire',
    audio_profile: 'A confident and energetic ad voice.',
  },
  Aoede: {
    voice_name: 'Aoede',
    accent: 'Neutral',
    style: 'Empathetic',
    pace: 'Natural',
    audio_profile: 'A warm and clear advertisement narrator.',
  },
  Achernar: {
    voice_name: 'Achernar',
    accent: 'Neutral',
    style: 'Vocal Smile',
    pace: 'Natural',
    audio_profile: 'A refined and pleasant ad voice.',
  },
  Charon: {
    voice_name: 'Charon',
    accent: 'Neutral',
    style: 'Newscaster',
    pace: 'Natural',
    audio_profile: 'A professional and trustworthy narrator.',
  },
  Puck: {
    voice_name: 'Puck',
    accent: 'Neutral',
    style: 'Vocal Smile',
    pace: 'Natural',
    audio_profile: 'A lively and friendly ad voice.',
  },
};

/**
 * Resolve o perfil de estilo de uma voz explícita (case-insensitive).
 * Devolve null quando a voz é desconhecida — o chamador cai no perfil do
 * idioma (compat histórica, nunca erro).
 */
export function mapVoiceToStyleProfile(voiceName: string | null | undefined): VoiceProfile | null {
  const key = String(voiceName ?? '').trim().toLowerCase();
  if (!key || key === 'auto') return null;
  const hit = Object.values(VOICE_STYLE_DEFAULTS).find(
    (p) => p.voice_name.toLowerCase() === key,
  );
  return hit ?? null;
}

/**
 * Map a project language to a KIE voice profile (pt/en/es/fr/de/it mapped;
 * unknown languages fall back to the default profile — never an error).
 */
export function mapLangToVoiceProfile(lang: string): VoiceProfile {
  const normalized = String(lang ?? '').toLowerCase().split('-')[0];
  return VOICE_PROFILES[normalized] ?? DEFAULT_VOICE_PROFILE;
}

/**
 * Build the complete KIE createTask body for the Gemini 3.1 Flash TTS model:
 * one Speaker 1 configured from the language profile + dialogue_turns in
 * order. Empty texts are dropped; optional fields are omitted when absent.
 */
export function buildTtsRequestBody(args: {
  texts: VoiceText[];
  lang: string;
  voiceName?: string;
  temperature?: number;
  scene?: string;
  sampleContext?: string;
  callBackUrl?: string;
  model?: string;
}): TtsRequestBody {
  const { texts, lang, voiceName, temperature, scene, sampleContext, callBackUrl } = args;
  const turns = texts
    .filter((t) => typeof t.text === 'string' && t.text.trim().length > 0)
    .map((t) => ({ speaker_id: 'Speaker 1', text: t.text }));

  const langProfile = mapLangToVoiceProfile(lang);
  // F2 T09: voz explícita conhecida → estilo da VOZ; `auto`/ausente →
  // idioma escolhe a default; voz desconhecida → perfil do idioma (compat).
  const explicit = typeof voiceName === 'string' && voiceName !== 'auto' && voiceName.trim()
    ? voiceName.trim()
    : null;
  const explicitProfile = explicit ? mapVoiceToStyleProfile(explicit) : null;
  const voiceProfile = explicitProfile ?? langProfile;
  const resolvedVoiceName = explicitProfile ? explicitProfile.voice_name : (explicit ?? langProfile.voice_name);
  const input: TtsInput = {
    speakers: [
      {
        speaker_id: 'Speaker 1',
        voice_name: resolvedVoiceName,
        accent: voiceProfile.accent,
        ...(voiceProfile.style ? { style: voiceProfile.style } : {}),
        ...(voiceProfile.pace ? { pace: voiceProfile.pace } : {}),
        ...(voiceProfile.audio_profile ? { audio_profile: voiceProfile.audio_profile } : {}),
      },
    ],
    dialogue_turns: turns,
  };
  if (temperature !== undefined) input.temperature = temperature;
  if (scene) input.scene = scene;
  if (sampleContext) input.sample_context = sampleContext;

  const model = args.model || resolveTtsModel();
  if (model === 'google/gemini-3-8-flash-tts') {
    // 3.8 accepts speaker identity + voice, and natural-language direction on
    // each turn (not the 3.1 accent/style/pace enums on the speaker).
    const speaker = input.speakers[0];
    const direction = [
      `Speak in ${lang || 'en'}.`,
      speaker.audio_profile,
      speaker.style && `Delivery: ${speaker.style}.`,
      speaker.pace && `Pace: ${speaker.pace}.`,
      scene && `Scene: ${scene}.`,
      sampleContext,
    ].filter(Boolean).join(' ');
    input.speakers = [{ speaker_id: 'Speaker 1', voice_name: speaker.voice_name }];
    input.dialogue_turns = turns.map(turn => ({ ...turn, style: direction }));
    delete input.scene;
    delete input.sample_context;
  }
  const body: TtsRequestBody = { model, input };
  if (callBackUrl) body.callBackUrl = callBackUrl;
  return body;
}

/**
 * Parse `resultJson` ({ resultUrls: [string] } for media output) into a URL
 * list. Any malformed/empty payload yields [] — never throws.
 */
export function resolveVoiceoverResult(resultJson: string | null | undefined): string[] {
  if (!resultJson) return [];
  try {
    const parsed = JSON.parse(resultJson) as { resultUrls?: unknown };
    if (Array.isArray(parsed.resultUrls)) {
      return parsed.resultUrls.filter((u): u is string => typeof u === 'string');
    }
  } catch {
    // ignore malformed payload — treated as no result
  }
  return [];
}

export interface VoiceoverRecord {
  state: 'waiting' | 'success' | 'fail' | string;
  resultUrls: string[];
  failCode: string | null;
  failMsg: string | null;
}

/**
 * Normalize a recordInfo response (accepts the full { code, msg, data }
 * envelope or the bare data object). `resultUrls` is populated ONLY on
 * success — a failed task yields no VO, and the pipeline proceeds.
 */
export function parseVoiceoverRecord(record: unknown): VoiceoverRecord {
  const data = ((record as { data?: unknown } | null)?.data ?? record) as Record<string, unknown> | null;
  const state = typeof data?.state === 'string' ? data.state : 'waiting';
  return {
    state,
    resultUrls: state === 'success' ? resolveVoiceoverResult(data?.resultJson as string | undefined) : [],
    failCode: (data?.failCode as string | null) ?? null,
    failMsg: (data?.failMsg as string | null) ?? null,
  };
}

/**
 * Retry policy: exactly 1 retry (attempt is 0-based) on transient failures
 * (429 rate limit / 5xx server errors). Permanent errors (400/401/402/404/422)
 * and terminal fails without a code are never retried.
 */
export function shouldRetry(failCode: string | null | undefined, attempt: number): boolean {
  if (attempt >= TTS_MAX_RETRIES) return false;
  if (!failCode) return false;
  const code = String(failCode);
  return code === '429' || /^5\d\d$/.test(code);
}

/**
 * F03.2: mapeamento explícito — nunca troca silenciosa.
 * `isFallback=true` quando o idioma é desconhecido; `clarification` descreve
 * a decisão para o resumo requested/effective. Reutiliza o catálogo V5.33,
 * sem expor endpoint/modelo/chave. `mapLangToVoiceProfile` legacy mantém-se
 * por compat (deprecated para resolução nova).
 */
export function mapLangToVoiceProfileExplicit(lang: string): { profile: VoiceProfile; isFallback: boolean; clarification: string } {
  const normalized = String(lang ?? "").toLowerCase().split("-")[0];
  const hit = VOICE_PROFILES[normalized];
  if (hit) return { profile: hit, isFallback: false, clarification: `Locale ${lang} → voz ${hit.voice_name} (${hit.accent})` };
  return { profile: DEFAULT_VOICE_PROFILE, isFallback: true, clarification: `Idioma desconhecido ${lang} → fallback explícito ${DEFAULT_VOICE_PROFILE.voice_name} (nunca troca silenciosa)` };
}

/** F03.2: sample/preview indisponível — UI diz não suportado, servidor rejeita. */
export function voiceSampleAvailability(): { supported: false; code: string; detail: string } {
  return {
    supported: false,
    code: "VOICE_SAMPLE_NOT_SUPPORTED",
    detail: "Preview/sample de voz indisponível nesta fase (sem provider pago, budget 0 EUR). Escolhe a voz pelo catálogo; o servidor rejeita on/sample com erro acionável.",
  };
}
