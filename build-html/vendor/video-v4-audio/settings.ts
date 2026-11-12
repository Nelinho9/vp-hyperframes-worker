/**
 * settings.ts — F03.4/F03.2: tri-state puro + sfx + idioma/locale/voz.
 *
 * Project metadata is authoritative; model-generated voice annotations are not.
 * `sfx` é tri-state puro (auto/on/off). `on` exige capability real (ver
 * `_shared/sfxCatalog.ts`); sem capability, o chamador deve falhar explícito.
 * Voz incompatível com locale => clarificação/fallback explícito, nunca troca
 * silenciosa (ver validateVoiceForLocale no resolution).
 */
export interface ProjectAudioSettings {
  lang: string;
  voiceLocale: string;
  voiceName?: string;
  narration: "auto" | "on" | "off";
  captions: "auto" | "on" | "off";
  music: "auto" | "on" | "off";
  sfx: "auto" | "on" | "off";
  /** C04.1: preset visual das legendas (hormozi/editorial/karaoke). */
  captionStyle: "hormozi" | "editorial" | "karaoke";
}

export type SettingsOrigin = "ui" | "dialogue" | "inference" | "default" | "capture" | "legacy";

export interface ProjectAudioSettingsWithOrigins extends ProjectAudioSettings {
  origins: Record<"lang" | "voiceLocale" | "narration" | "captions" | "music" | "sfx", SettingsOrigin>;
}

const VOICES = new Set(["Zephyr", "Fenrir", "Aoede", "Achernar", "Charon", "Puck"]);

function toggle(value: unknown): "auto" | "on" | "off" {
  return value === "on" || value === "off" ? value : "auto";
}

/**
 * C04.1: preset visual das legendas. Omisso/inválido → `editorial`
 * (aparência mais próxima do legado) — nunca um quarto estilo inventado.
 */
function captionStyle(value: unknown): "hormozi" | "editorial" | "karaoke" {
  return value === "hormozi" || value === "karaoke" ? value : "editorial";
}

export function resolveProjectAudioSettings(
  metadata: unknown,
  fallbackLang = "pt",
): ProjectAudioSettings {
  const meta = metadata as {
    language?: unknown;
    voice_locale?: unknown;
    video_config?: { voice?: unknown; voice_locale?: unknown; language?: unknown; audio?: Record<string, unknown> };
    requested_config?: { voice?: unknown; voice_locale?: unknown; language?: unknown; audio?: Record<string, unknown> };
    effective_config?: { voice?: unknown; voice_locale?: unknown; language?: unknown; audio?: Record<string, unknown> };
  } | null;
  // Effective wins over requested/video_config legacy (F03: ler effective).
  const effective = meta?.effective_config;
  const requested = meta?.requested_config;
  const config = (effective as { audio?: Record<string, unknown> } | undefined)
    ?? (requested as { audio?: Record<string, unknown> } | undefined)
    ?? meta?.video_config;
  const pick = (name: string): "auto" | "on" | "off" => toggle((config as { audio?: Record<string, unknown> } | undefined)?.audio?.[name]);
  const voice = (effective as { voice?: unknown } | undefined)?.voice
    ?? (requested as { voice?: unknown } | undefined)?.voice
    ?? (meta?.video_config as { voice?: unknown } | undefined)?.voice;
  const rawLang = (effective as { language?: unknown } | undefined)?.language
    ?? (requested as { language?: unknown } | undefined)?.language
    ?? meta?.language
    ?? (meta?.video_config as { language?: unknown } | undefined)?.language
    ?? fallbackLang;
  const rawLocale = (effective as { voice_locale?: unknown } | undefined)?.voice_locale
    ?? (requested as { voice_locale?: unknown } | undefined)?.voice_locale
    ?? meta?.voice_locale
    ?? (meta?.video_config as { voice_locale?: unknown } | undefined)?.voice_locale
    ?? "auto";
  const lang = typeof rawLang === "string" && rawLang.trim() && rawLang !== "auto" ? rawLang.trim() : fallbackLang;
  const voiceLocale = typeof rawLocale === "string" && rawLocale.trim() && rawLocale !== "auto" ? rawLocale.trim() : lang.includes("-") ? lang : `${lang.split("-")[0]}-${lang.split("-")[0].toUpperCase() === "PT" ? "PT" : lang.toLowerCase() === "pt" ? "PT" : "US"}`;
  return {
    lang,
    voiceLocale,
    ...(typeof voice === "string" && VOICES.has(voice) && voice !== "auto" ? { voiceName: voice } : {}),
    narration: pick("narration"),
    captions: pick("captions"),
    music: pick("music"),
    sfx: pick("sfx"),
    captionStyle: captionStyle(
      (config as { audio?: Record<string, unknown> } | undefined)?.audio?.caption_style,
    ),
  };
}

/**
 * Valida voz vs locale/capabilities antes de TTS.
 * Incompatível => clarificação/fallback explícito, nunca troca silenciosa.
 */
export function validateVoiceForSettings(args: {
  voiceName?: string;
  lang: string;
  voiceLocale: string;
}): { voiceName: string; clarification: string; wasFallback: boolean } {
  const catalog: Record<string, string[]> = {
    pt: ["Zephyr", "Aoede"],
    en: ["Fenrir", "Charon"],
    es: ["Aoede", "Puck"],
    fr: ["Achernar", "Puck"],
    de: ["Charon", "Zephyr"],
    it: ["Puck", "Achernar"],
  };
  const defaults: Record<string, string> = { pt: "Zephyr", en: "Fenrir", es: "Aoede", fr: "Achernar", de: "Charon", it: "Puck" };
  const base = args.lang.toLowerCase().split("-")[0];
  const fallback = defaults[base] ?? "Zephyr";
  if (!args.voiceName) return { voiceName: fallback, clarification: `Voz auto → ${fallback} (${args.lang}/${args.voiceLocale})`, wasFallback: true };
  if (!VOICES.has(args.voiceName)) {
    return { voiceName: fallback, clarification: `Voz desconhecida ${args.voiceName} → fallback explícito ${fallback}`, wasFallback: true };
  }
  const allowed = catalog[base] ?? [];
  if (allowed.length > 0 && !allowed.includes(args.voiceName)) {
    return { voiceName: args.voiceName, clarification: `Voz ${args.voiceName} mantida (fora do preferencial de ${base}, compatível, sem troca silenciosa)`, wasFallback: false };
  }
  return { voiceName: args.voiceName, clarification: `Voz ${args.voiceName} compatível com ${args.lang}/${args.voiceLocale}`, wasFallback: false };
}
