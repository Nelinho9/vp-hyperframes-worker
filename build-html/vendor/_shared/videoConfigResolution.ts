/**
 * videoConfigResolution.ts — F03.1 Edge mirror (V5.34).
 *
 * Pure versioned resolution, identical semantics to
 * `src/video/contracts/videoConfigResolution.ts`. Deno runtime: imports `z`
 * only for documentation parity (logic is pure, no zod needed at runtime).
 * Relative imports keep the `.ts` extension per `supabase/functions/AGENTS.md`.
 *
 * Precedence: UI explicit > dialogue confirmed > brief inference > versioned
 * default. Inference never erases explicit UI; UI Auto does not erase dialogue
 * whose origin is not UI.
 */
import { z } from "zod";

export const VIDEO_CONFIG_RESOLUTION_VERSION = "v1" as const;

export type ConfigOrigin = "ui" | "dialogue" | "inference" | "default" | "capture" | "legacy";
export type AutoToggle = "auto" | "on" | "off";
export type VideoFormat = "auto" | "landscape" | "portrait" | "square";
export type VideoType = "auto" | "brand_reel" | "product_demo" | "launch_teaser" | "feature_spotlight";

export interface VideoConfigV4Like {
  format: VideoFormat;
  duration_seconds: number;
  video_type: VideoType;
  audio: { narration: AutoToggle; captions: AutoToggle; music: AutoToggle; sfx: AutoToggle };
  voice: string;
  language: string;
  voice_locale: string;
  core_message: string;
}

export interface ResolutionOrigins {
  format: ConfigOrigin;
  duration_seconds: ConfigOrigin;
  video_type: ConfigOrigin;
  language: ConfigOrigin;
  voice_locale: ConfigOrigin;
  voice: ConfigOrigin;
  narration: ConfigOrigin;
  captions: ConfigOrigin;
  music: ConfigOrigin;
  sfx: ConfigOrigin;
  core_message: ConfigOrigin;
  preset: ConfigOrigin;
  destination: ConfigOrigin;
}

export interface EffectiveVideoConfig extends VideoConfigV4Like {
  effective_width: number;
  effective_height: number;
  effective_ratio: "16:9" | "9:16" | "1:1";
}

export interface VideoConfigResolution {
  version: typeof VIDEO_CONFIG_RESOLUTION_VERSION;
  requested: VideoConfigV4Like;
  effective: EffectiveVideoConfig;
  origins: ResolutionOrigins;
  conflicts: string[];
  clarifications: string[];
  preset: string;
  destination: string;
}

export interface ResolutionInput {
  ui?: unknown;
  dialogue?: unknown;
  inference?: {
    format?: VideoFormat | string | null;
    duration_target_seconds?: number | null;
    video_type?: string | null;
    language?: string | null;
    voice_locale?: string | null;
    voice?: string | null;
    narration?: AutoToggle | null;
    captions?: AutoToggle | null;
    music?: AutoToggle | null;
    sfx?: AutoToggle | null;
    core_message?: string | null;
    platform?: string | null;
  } | null;
  capture?: { source_url?: string | null } | null;
  legacyRaw?: unknown;
  userLocale?: string | null;
  platform?: string | null;
}

// Keep zod referenced so the esm.sh→local alias stays exercised in vitest.
void z;

const FORMAT_DIMENSIONS: Record<Exclude<VideoFormat, "auto">, { width: number; height: number; ratio: string }> = {
  landscape: { width: 1920, height: 1080, ratio: "16:9" },
  portrait: { width: 1080, height: 1920, ratio: "9:16" },
  square: { width: 1080, height: 1080, ratio: "1:1" },
};

const TTS_VOICES = ["auto", "Zephyr", "Fenrir", "Aoede", "Achernar", "Charon", "Puck"];

const LANGUAGE_TO_DEFAULT_LOCALE: Record<string, string> = {
  pt: "pt-PT",
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
};

const DEFAULT_CONFIG: VideoConfigV4Like = {
  format: "auto",
  duration_seconds: 0,
  video_type: "auto",
  audio: { narration: "auto", captions: "auto", music: "auto", sfx: "auto" },
  voice: "auto",
  language: "auto",
  voice_locale: "auto",
  core_message: "",
};

function parseConfig(raw: unknown): VideoConfigV4Like {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: VideoConfigV4Like = { ...DEFAULT_CONFIG, audio: { ...DEFAULT_CONFIG.audio } };
  if (obj.format === "landscape" || obj.format === "portrait" || obj.format === "square" || obj.format === "auto") out.format = obj.format;
  if (typeof obj.duration_seconds === "number" && Number.isInteger(obj.duration_seconds) && obj.duration_seconds >= 0 && obj.duration_seconds <= 120) out.duration_seconds = obj.duration_seconds;
  if (obj.video_type === "auto" || obj.video_type === "brand_reel" || obj.video_type === "product_demo" || obj.video_type === "launch_teaser" || obj.video_type === "feature_spotlight") out.video_type = obj.video_type;
  if (typeof obj.voice === "string" && TTS_VOICES.includes(obj.voice)) out.voice = obj.voice;
  if (typeof obj.language === "string" && obj.language.trim().length >= 2 && obj.language.trim().length <= 35) out.language = obj.language.trim();
  if (typeof obj.voice_locale === "string" && obj.voice_locale.trim().length >= 2 && obj.voice_locale.trim().length <= 35) out.voice_locale = obj.voice_locale.trim();
  if (typeof obj.core_message === "string") out.core_message = obj.core_message.slice(0, 500);
  const audio = obj.audio && typeof obj.audio === "object" ? obj.audio as Record<string, unknown> : {};
  for (const k of ["narration", "captions", "music", "sfx"] as const) {
    if (audio[k] === "on" || audio[k] === "off" || audio[k] === "auto") out.audio[k] = audio[k];
  }
  return out;
}

function isExplicitFormat(v: unknown): v is Exclude<VideoFormat, "auto"> {
  return v === "landscape" || v === "portrait" || v === "square";
}

function isExplicitDuration(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && (v as number) > 0 && (v as number) <= 120;
}

function normalizeLang(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < 2 || t.length > 35) return null;
  if (t === "auto") return null;
  return t;
}

function normalizeLocale(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < 2 || t.length > 35) return null;
  if (t === "auto") return null;
  return t;
}

function normalizeVoice(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t === "auto") return null;
  if (!TTS_VOICES.includes(t)) return null;
  return t;
}

function baseLangOf(s: string): string {
  return s.toLowerCase().split("-")[0].split("_")[0];
}

export function deriveVideoLanguage(args: { ui?: unknown; dialogue?: unknown; inference?: unknown; userLocale?: string | null }): { value: string; origin: ConfigOrigin; clarification?: string } {
  const ui = normalizeLang(args.ui);
  if (ui) return { value: ui, origin: "ui" };
  const dlg = normalizeLang(args.dialogue);
  if (dlg) return { value: dlg, origin: "dialogue" };
  const inf = normalizeLang(args.inference);
  if (inf) return { value: inf, origin: "inference" };
  const user = typeof args.userLocale === "string" && args.userLocale.trim() ? baseLangOf(args.userLocale.trim()) : null;
  if (user && user.length >= 2) return { value: user, origin: "inference", clarification: `Locale do utilizador (${args.userLocale})` };
  return { value: "pt", origin: "default", clarification: "Default versionado pt (sem origem explícita)" };
}

export function deriveVoiceLocale(args: { ui?: unknown; dialogue?: unknown; inference?: unknown; language: string }): { value: string; origin: ConfigOrigin; clarification?: string } {
  const ui = normalizeLocale(args.ui);
  if (ui) return { value: ui, origin: "ui" };
  const dlg = normalizeLocale(args.dialogue);
  if (dlg) return { value: dlg, origin: "dialogue" };
  const inf = normalizeLocale(args.inference);
  if (inf) return { value: inf, origin: "inference" };
  const mapped = LANGUAGE_TO_DEFAULT_LOCALE[baseLangOf(args.language)];
  if (mapped) return { value: mapped, origin: "inference", clarification: `Mapa default de ${args.language} → ${mapped}` };
  return { value: "pt-PT", origin: "default", clarification: "Default versionado pt-PT" };
}

const VOICE_CATALOG_BY_LANG: Record<string, string[]> = {
  pt: ["Zephyr", "Aoede"],
  en: ["Fenrir", "Charon"],
  es: ["Aoede", "Puck"],
  fr: ["Achernar", "Puck"],
  de: ["Charon", "Zephyr"],
  it: ["Puck", "Achernar"],
};

const DEFAULT_VOICE_BY_LANG: Record<string, string> = {
  pt: "Zephyr",
  en: "Fenrir",
  es: "Aoede",
  fr: "Achernar",
  de: "Charon",
  it: "Puck",
};

export function validateVoiceForLocale(args: { voice: string | null; language: string; voiceLocale: string }): { voice: string; clarification?: string; conflict?: string } {
  const lang = baseLangOf(args.language || "pt");
  const allowed = VOICE_CATALOG_BY_LANG[lang] ?? Object.keys(DEFAULT_VOICE_BY_LANG).flatMap((k) => VOICE_CATALOG_BY_LANG[k]);
  const fallback = DEFAULT_VOICE_BY_LANG[lang] ?? "Zephyr";
  if (!args.voice) return { voice: fallback, clarification: `Voz auto → ${fallback} (${args.language}/${args.voiceLocale})` };
  if (!TTS_VOICES.includes(args.voice)) {
    return { voice: fallback, conflict: `Voz desconhecida ${args.voice} → fallback explícito ${fallback}`, clarification: `Fallback explícito para ${fallback}` };
  }
  if (!allowed.includes(args.voice)) {
    return { voice: args.voice, clarification: `Voz ${args.voice} fora do catálogo preferencial de ${lang}; mantida por escolha explícita (compatível, sem troca silenciosa)` };
  }
  return { voice: args.voice };
}

export function resolveDurationTarget(args: { ui?: unknown; dialogue?: unknown; inference?: number | null; forPersistence?: boolean }): { value: number; origin: ConfigOrigin; clarification?: string; conflict?: string } {
  if (isExplicitDuration(args.ui)) {
    if (typeof args.inference === "number" && args.inference > 0 && args.inference !== args.ui) {
      return { value: args.ui as number, origin: "ui", conflict: `UI ${args.ui}s vs brief ${args.inference}s — UI explícita vence` };
    }
    return { value: args.ui as number, origin: "ui" };
  }
  if (isExplicitDuration(args.dialogue)) return { value: args.dialogue as number, origin: "dialogue" };
  if (typeof args.inference === "number" && Number.isInteger(args.inference) && args.inference >= 1 && args.inference <= 120) {
    return { value: args.inference, origin: "inference" };
  }
  if (args.forPersistence === true) {
    return { value: 15, origin: "default", clarification: "Default versionado 15s (auto resolvido para persistência)" };
  }
  return { value: 0, origin: "default", clarification: "Auto — resolver antes de materializar" };
}

function resolveFormat(args: { ui?: unknown; dialogue?: unknown; inference?: unknown }): { value: VideoFormat; origin: ConfigOrigin; conflict?: string } {
  const ui = typeof args.ui === "string" ? args.ui : "auto";
  const dlg = typeof args.dialogue === "string" ? args.dialogue : "auto";
  const inf = typeof args.inference === "string" ? args.inference : "auto";
  if (isExplicitFormat(ui)) {
    if (isExplicitFormat(inf) && inf !== ui) return { value: ui, origin: "ui", conflict: `UI ${ui} vs inferência ${inf} — UI explícita vence` };
    return { value: ui, origin: "ui" };
  }
  if (isExplicitFormat(dlg)) return { value: dlg, origin: "dialogue" };
  if (isExplicitFormat(inf)) return { value: inf, origin: "inference" };
  return { value: "auto", origin: "default" };
}

function resolveToggleChain(args: { ui?: unknown; dialogue?: unknown; inference?: unknown }): { value: AutoToggle; origin: ConfigOrigin; conflict?: string } {
  const norm = (v: unknown): AutoToggle => (v === "on" || v === "off" || v === "auto" ? v : "auto");
  const ui = norm(args.ui);
  const dlg = norm(args.dialogue);
  const inf = norm(args.inference);
  if (ui !== "auto") {
    if (inf !== "auto" && inf !== ui) return { value: ui, origin: "ui", conflict: `UI ${ui} vs inferência ${inf} — UI vence` };
    return { value: ui, origin: "ui" };
  }
  if (dlg !== "auto") return { value: dlg, origin: "dialogue" };
  if (inf !== "auto") return { value: inf, origin: "inference" };
  return { value: "auto", origin: "default" };
}

export type DialogueAudioCues = {
  narration?: "on";
  captions?: "on";
  music?: "on";
  sfx?: "on";
};

/**
 * F12 (origem F01/F03): as `brief.constraints` são texto confirmado em diálogo
 * ("Incluir locução de voz", "Incluir música de fundo") mas nunca chegavam a
 * `audio.*` estruturado — a camada dialogue da resolução era o eco do painel UI,
 * por isso "com voz e música" gerava MP4 silencioso. Extrai on-cues PT/EN e
 * devolve SÓ campos com sinal (ausência = auto, nunca off: desligar continua a
 * ser escolha explícita de UI e a precedência C3 fica intacta).
 */
export function dialogueAudioFromBriefConstraints(constraints: unknown): DialogueAudioCues {
  const out: DialogueAudioCues = {};
  if (!Array.isArray(constraints)) return out;
  const text = constraints.filter((c): c is string => typeof c === "string").join("\n").toLowerCase();
  if (!text.trim()) return out;
  if (/\bvoz\b|narra|locu|voice|narration|voiceover|voice-over|\bfala\b|spoken/.test(text)) out.narration = "on";
  if (/m[úu]sica|music|trilha|soundtrack|\bbgm\b/.test(text)) out.music = "on";
  if (/legenda|caption|subtitle/.test(text)) out.captions = "on";
  if (/\bsfx\b|efeitos?\s+sonoros?|sound\s+effects?/.test(text)) out.sfx = "on";
  return out;
}

export function getEffectiveDimensions(format: VideoFormat | string): { width: number; height: number; ratio: "16:9" | "9:16" | "1:1" } {
  const f = (format ?? "auto").toLowerCase();
  if (f === "landscape" || f === "16:9" || f === "horizontal") return { width: 1920, height: 1080, ratio: "16:9" };
  if (f === "square" || f === "1:1") return { width: 1080, height: 1080, ratio: "1:1" };
  if (isExplicitFormat(format as VideoFormat)) {
    const d = FORMAT_DIMENSIONS[format as Exclude<VideoFormat, "auto">];
    const ratio = d.ratio === "16:9" ? "16:9" as const : d.ratio === "1:1" ? "1:1" as const : "9:16" as const;
    return { width: d.width, height: d.height, ratio };
  }
  return { width: 1080, height: 1920, ratio: "9:16" };
}

function resolveDestination(format: VideoFormat, platform?: string | null): { value: string; origin: ConfigOrigin } {
  if (typeof platform === "string" && platform.trim()) return { value: platform.trim(), origin: "inference" };
  if (format === "portrait") return { value: "reels", origin: "inference" };
  if (format === "square") return { value: "feed", origin: "inference" };
  if (format === "landscape") return { value: "landscape", origin: "inference" };
  return { value: "auto", origin: "default" };
}

export function resolveVideoConfigV1(input: ResolutionInput): VideoConfigResolution {
  const conflicts: string[] = [];
  const clarifications: string[] = [];
  const ui = parseConfig(input.ui ?? {});
  const dlg = parseConfig(input.dialogue ?? {});
  const hasDialogue = input.dialogue !== undefined && input.dialogue !== null;
  const inf = input.inference ?? null;
  const uiIsDefault = JSON.stringify(ui) === JSON.stringify(DEFAULT_CONFIG);
  const legacy = input.legacyRaw !== undefined ? parseConfig(input.legacyRaw) : null;
  if (legacy && JSON.stringify(legacy) !== JSON.stringify(DEFAULT_CONFIG)) {
    clarifications.push("Payload legacy tolerado por campo (origem legacy quando sem origem melhor)");
  }
  const fmt = resolveFormat({
    ui: uiIsDefault && !hasDialogue ? "auto" : ui.format,
    dialogue: hasDialogue ? dlg.format : "auto",
    inference: (inf?.format as string | undefined) ?? "auto",
  });
  if (fmt.conflict) conflicts.push(fmt.conflict);
  const dur = resolveDurationTarget({
    ui: ui.duration_seconds || undefined,
    dialogue: hasDialogue ? dlg.duration_seconds || undefined : undefined,
    inference: inf?.duration_target_seconds ?? null,
    forPersistence: false,
  });
  if (dur.conflict) conflicts.push(dur.conflict);
  if (dur.clarification) clarifications.push(dur.clarification);
  const typeVal = ((): { value: VideoType; origin: ConfigOrigin; conflict?: string } => {
    const uiT = ui.video_type;
    const dlgT = hasDialogue ? dlg.video_type : "auto";
    const infT = ((inf?.video_type as VideoType | undefined) ?? "auto");
    if (uiT !== "auto") {
      if (infT !== "auto" && infT !== uiT) return { value: uiT, origin: "ui", conflict: `UI type ${uiT} vs inferência ${infT} — UI vence` };
      return { value: uiT, origin: "ui" };
    }
    if (dlgT !== "auto") return { value: (dlgT as VideoType), origin: "dialogue" };
    if (infT !== "auto") return { value: (infT as VideoType), origin: "inference" };
    if (legacy && (legacy.video_type as string) !== "auto") return { value: legacy.video_type, origin: "legacy" };
    return { value: "auto", origin: "default" };
  })();
  if (typeVal.conflict) conflicts.push(typeVal.conflict);
  const lang = deriveVideoLanguage({
    ui: ui.language && ui.language !== "auto" ? ui.language : undefined,
    dialogue: hasDialogue && dlg.language && dlg.language !== "auto" ? dlg.language : undefined,
    inference: inf?.language ?? undefined,
    userLocale: input.userLocale ?? null,
  });
  if (lang.clarification) clarifications.push(lang.clarification);
  const locale = deriveVoiceLocale({
    ui: ui.voice_locale && ui.voice_locale !== "auto" ? ui.voice_locale : undefined,
    dialogue: hasDialogue && dlg.voice_locale && dlg.voice_locale !== "auto" ? dlg.voice_locale : undefined,
    inference: inf?.voice_locale ?? undefined,
    language: lang.value,
  });
  if (locale.clarification) clarifications.push(locale.clarification);
  const rawVoice = ui.voice !== "auto" ? ui.voice : hasDialogue && dlg.voice !== "auto" ? dlg.voice : (inf?.voice as string | undefined) ?? "auto";
  const voiceOrigin: ConfigOrigin = ui.voice !== "auto" ? "ui" : hasDialogue && dlg.voice !== "auto" ? "dialogue" : rawVoice !== "auto" ? "inference" : "default";
  const voiceCheck = validateVoiceForLocale({ voice: rawVoice === "auto" ? null : rawVoice, language: lang.value, voiceLocale: locale.value });
  if (voiceCheck.conflict) conflicts.push(voiceCheck.conflict);
  if (voiceCheck.clarification) clarifications.push(voiceCheck.clarification);
  const narr = resolveToggleChain({ ui: ui.audio.narration, dialogue: hasDialogue ? dlg.audio.narration : "auto", inference: inf?.narration ?? "auto" });
  const caps = resolveToggleChain({ ui: ui.audio.captions, dialogue: hasDialogue ? dlg.audio.captions : "auto", inference: inf?.captions ?? "auto" });
  const music = resolveToggleChain({ ui: ui.audio.music, dialogue: hasDialogue ? dlg.audio.music : "auto", inference: inf?.music ?? "auto" });
  const sfx = resolveToggleChain({ ui: ui.audio.sfx, dialogue: hasDialogue ? dlg.audio.sfx : "auto", inference: inf?.sfx ?? "auto" });
  for (const r of [narr, caps, music, sfx]) if (r.conflict) conflicts.push(r.conflict);
  const core: { value: string; origin: ConfigOrigin } = (() => {
    if (ui.core_message.trim()) return { value: ui.core_message.slice(0, 500), origin: "ui" };
    if (hasDialogue && dlg.core_message.trim()) return { value: dlg.core_message.slice(0, 500), origin: "dialogue" };
    if (typeof inf?.core_message === "string" && inf.core_message.trim()) return { value: inf.core_message.slice(0, 500), origin: "inference" };
    if (legacy && legacy.core_message.trim()) return { value: legacy.core_message.slice(0, 500), origin: "legacy" };
    return { value: "", origin: "default" };
  })();
  const dims = getEffectiveDimensions(fmt.value === "auto" ? "portrait" : fmt.value);
  const dest = resolveDestination(fmt.value, (inf?.platform as string | undefined) ?? input.platform ?? null);
  const preset = dur.value === 0 ? `auto-${dims.ratio}` : `${dur.value}s-${dims.ratio}`;
  const requested: VideoConfigV4Like = ui;
  const effective: EffectiveVideoConfig = {
    format: fmt.value,
    duration_seconds: dur.value,
    video_type: typeVal.value,
    audio: { narration: narr.value, captions: caps.value, music: music.value, sfx: sfx.value },
    voice: voiceCheck.voice === "Zephyr" && voiceOrigin === "default" ? "auto" : voiceCheck.voice,
    language: lang.value,
    voice_locale: locale.value,
    core_message: core.value,
    effective_width: dims.width,
    effective_height: dims.height,
    effective_ratio: dims.ratio,
  };
  const origins: ResolutionOrigins = {
    format: fmt.origin,
    duration_seconds: dur.origin,
    video_type: typeVal.origin,
    language: lang.origin,
    voice_locale: locale.origin,
    voice: voiceOrigin === "default" && voiceCheck.voice !== "auto" ? "inference" : voiceOrigin,
    narration: narr.origin,
    captions: caps.origin,
    music: music.origin,
    sfx: sfx.origin,
    core_message: core.origin,
    preset: dur.origin,
    destination: dest.origin,
  };
  // Reference unused helper to keep deno lint calm if trimmed in future.
  void normalizeVoice;
  return { version: VIDEO_CONFIG_RESOLUTION_VERSION, requested, effective, origins, conflicts, clarifications, preset, destination: dest.value };
}

export function resolveAutoToggles(args: { narration: AutoToggle; captions: AutoToggle; music: AutoToggle; sfx: AutoToggle; hasNarrationText: boolean }): { narration: "on" | "off"; captions: "on" | "off"; music: "on" | "off"; sfx: "on" | "off"; decisions: string[] } {
  const decisions: string[] = [];
  let narration: "on" | "off";
  if (args.narration !== "auto") narration = args.narration;
  else {
    narration = args.hasNarrationText ? "on" : "off";
    decisions.push(`narration auto → ${narration} (${args.hasNarrationText ? "texto presente" : "sem texto"})`);
  }
  let captions: "on" | "off";
  if (args.captions !== "auto") captions = args.captions;
  else {
    captions = narration === "on" ? "on" : "off";
    decisions.push(`captions auto → ${captions} (narration ${narration})`);
  }
  let music: "on" | "off";
  if (args.music !== "auto") music = args.music;
  else {
    music = "on";
    decisions.push("music auto → on (catálogo real)");
  }
  let sfx: "on" | "off";
  if (args.sfx !== "auto") sfx = args.sfx;
  else {
    sfx = "off";
    decisions.push("sfx auto → off (sem capability real)");
  }
  return { narration, captions, music, sfx, decisions };
}

/**
 * F03.4 (invalidação): mudança de configuração invalida steps afectados.
 * Sem reutilizar áudio/captions de idioma/configuração antiga.
 */
export function invalidatedStepsForConfigChange(
  prev: Partial<VideoConfigV4Like> | null | undefined,
  next: Partial<VideoConfigV4Like> | null | undefined,
): Array<"design" | "storyboard" | "audio" | "visual" | "build" | "render" | "quality"> {
  if (!prev || !next) return ["design", "storyboard", "audio", "visual", "build", "render", "quality"];
  const p = parseConfig(prev);
  const n = parseConfig(next);
  const changed = new Set<string>();
  if (p.format !== n.format) changed.add("format");
  if (p.duration_seconds !== n.duration_seconds) changed.add("duration");
  if (p.video_type !== n.video_type) changed.add("type");
  if ((p.language ?? "auto") !== (n.language ?? "auto")) changed.add("language");
  if ((p.voice_locale ?? "auto") !== (n.voice_locale ?? "auto")) changed.add("locale");
  if (p.voice !== n.voice) changed.add("voice");
  if (p.core_message !== n.core_message) changed.add("message");
  for (const k of ["narration", "captions", "music", "sfx"] as const) {
    if (p.audio[k] !== n.audio[k]) changed.add(k);
  }
  if (changed.size === 0) return [];
  return ["design", "storyboard", "audio", "visual", "build", "render", "quality"];
}
