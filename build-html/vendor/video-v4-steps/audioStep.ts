/**
 * audioStep.ts — V4-2 Step 3.1: Audio (TTS + BGM + word timings)
 *
 * Doc: docs/video-engine/V4_02_SKILLS_PIPELINE.md §4.
 * Skills: media-use (resolve.mjs, Kokoro TTS offline).
 *
 * Input:  STORYBOARD.md, SCRIPT.md (optional)
 * Output: audio_meta.json (narration timings, BGM path, word timings)
 * Gate:   zod schema — durations sync, word_timings present when narration.
 *
 * F03.4/F03.5: tri-state puro + sfx. `on` exige output real ou falha explícita;
 * `off` impede geração/injeção e remove derivados obsoletos; `auto` resolve
 * antes de materializar (ver resolveAutoToggles no _shared). `music:on` com
 * `bgm:null` exige repair ou falha explícita. SFX só com capability real —
 * sem capability, `sfx:on` rejeitado com SFX_NOT_SUPPORTED.
 */
import { z } from "zod";
import { composeSystemPrompt } from "../_shared/skills/mod.ts";
import { BGM_TRACKS, type BgmTrack } from "../_shared/bgm/bgmCatalog.ts";
import type { ProjectAudioSettings } from "../video-v4-audio/settings.ts";
import { validateSfxRequest } from "../_shared/sfxCatalog.ts";
import { resolveAutoToggles } from "../_shared/videoConfigResolution.ts";

// ─── Output schema ─────────────────────────────────────────────────────────

const WordTimingSchema = z.object({
  word: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
});

const NarrationSegmentSchema = z.object({
  frame_number: z.number().int().min(1),
  text: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  word_timings: z.array(WordTimingSchema).optional(),
});

export const AudioOutputSchema = z.object({
  narration_segments: z.array(NarrationSegmentSchema),
  bgm: z.object({
    path: z.string(),
    mood: z.string(),
    duration_sec: z.number().positive(),
    volume: z.number().min(0).max(1).default(0.3),
  }).nullable(),
  total_duration_sec: z.number().positive(),
  audio_meta_json: z.string().optional(), // Legacy annotation; server serializes canonical fields.
}).passthrough().superRefine((audio, ctx) => {
  const seen = new Set<number>();
  let previousEnd = 0;
  audio.narration_segments.forEach((segment, i) => {
    if (seen.has(segment.frame_number) || segment.end <= segment.start || segment.end > audio.total_duration_sec || segment.start < previousEnd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["narration_segments", i], message: "Narration must have unique ordered frames and positive non-overlapping windows within the project" });
    }
    seen.add(segment.frame_number);
    previousEnd = segment.end;
    let wordEnd = segment.start;
    for (const word of segment.word_timings ?? []) {
      if (word.start < wordEnd || word.end <= word.start || word.end > segment.end) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["narration_segments", i, "word_timings"], message: "Word timings must be absolute project seconds, ordered, and inside the narration window" });
      }
      wordEnd = word.end;
    }
  });
});

export type AudioOutput = z.infer<typeof AudioOutputSchema>;

// ─── System prompt ─────────────────────────────────────────────────────────

/** Base role/task prompt. V4-3f.1: composeSystemPrompt() injects the
 * vendored media-use skill digest (B1). V5-P5B: a BGM é escolhida
 * EXCLUSIVAMENTE do catálogo REAL (secção no user message) — paths
 * fictícios são reparados deterministicamente (repairBgmSelection). */
export const AUDIO_BASE_PROMPT = `You are an audio director for a HyperFrames video project.
Your task is to produce audio metadata: narration timings, BGM selection, word timings.
The server synthesizes actual speech after this planning step. Do not invent
voice files, URLs or completed TTS jobs. Word timings are planning estimates.

## Skills context (media-use)
- Narration: generate word-level timings from the SCRIPT.md text.
- BGM: choose EXACTLY one track from the "BGM catalog (REAL files)" section of
  the user message. The \`path\` field MUST be one of the listed \`file\`
  values — never invent, never modify, never use any other path.
- Duration sync: total audio duration MUST match the storyboard total duration.
- Volume: BGM volume 0.2-0.3 when narration is present (ducking), up to 0.5
  when there is no narration.
- Fades are NOT your concern (the build injects them deterministically).

## Output format (JSON)
Return a JSON object with:
- narration_segments: array of { frame_number, text, start, end, word_timings? }
- bgm: { path, mood, duration_sec, volume } or null (silent project).
  \`duration_sec\` MUST equal the chosen catalog track duration.
- total_duration_sec: total audio duration (must match storyboard)
- Do not duplicate the output as audio_meta_json; the server serializes it.

## Rules
- Word timings are required when narration exists.
- All start/end/word_timings use ABSOLUTE PROJECT SECONDS (not per-scene offsets).
- Narration length budget (non-negotiable — voice-fit gate): each segment's text
  MUST be speakable inside its own frame. PT ~9 characters per second
  (3s → max ~27 chars; 4.2s → max ~38 chars); other languages ~13 per second.
  Take the text from SCRIPT.md and SHORTEN when needed — never expand, never
  invent. Longer text fails synthesis fitting and the video ships mute.
- Each segment start/end must align with the corresponding storyboard frame.
- BGM must come from the REAL catalog section below — nothing else.
`;

/** Full system prompt = base + vendored media-use skill digest. */
export const AUDIO_SYSTEM_PROMPT = composeSystemPrompt("audio", AUDIO_BASE_PROMPT);

// ─── V5-P5B: catálogo real ─────────────────────────────────────────────────

export interface BgmMeta {
  path: string;
  mood: string;
  duration_sec: number;
  volume?: number;
}

/** Escolhe a faixa com mais keywords de mood sobrepostas; empate/sem match → null. */
export function pickBgmTrackForMood(moodText: string): BgmTrack | null {
  const words = String(moodText ?? "")
    .toLowerCase()
    .split(/[^a-zà-ÿ]+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return null;
  let best: BgmTrack | null = null;
  let bestScore = 0;
  for (const track of BGM_TRACKS) {
    const moodWords = new Set(track.mood.toLowerCase().split(/\s+/));
    const score = words.reduce((acc, w) => acc + (moodWords.has(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * V5-P5B §2.2: repair DETERMINÍSTICO da seleção BGM do LLM — path tem de ser
 * um file do catálogo (aceita também id); inválido ⇒ reescolha por mood ⇒
 * 1.ª faixa. Volume clamp [0,1] (default 0.3); duração = REAL da faixa.
 * `bgm:null` intocado. Nunca lança.
 */
export function repairBgmSelection(bgm: unknown): BgmMeta | null {
  if (!bgm || typeof bgm !== "object") return null;
  const raw = bgm as Partial<BgmMeta>;
  let track = BGM_TRACKS.find((t) => t.file === raw.path) ?? BGM_TRACKS.find((t) => t.id === raw.path);
  if (!track) track = pickBgmTrackForMood(raw.mood ?? "") ?? BGM_TRACKS[0];
  let volume = typeof raw.volume === "number" && Number.isFinite(raw.volume) ? raw.volume : 0.3;
  volume = Math.min(1, Math.max(0, Math.round(volume * 100) / 100));
  return {
    path: track.file,
    mood: typeof raw.mood === "string" && raw.mood ? raw.mood : track.mood,
    duration_sec: track.durationSec,
    volume,
  };
}

/**
 * F03.4: `music:on` com `bgm:null` exige repair ou falha explícita — nunca
 * sucesso falso. Tenta repair por mood/default; se impossível, devolve erro
 * acionável para o step falhar explícito.
 */
export function requireBgmForMusicOn(args: {
  music: string;
  bgm: unknown;
  moodHint?: string;
}): { ok: true; bgm: BgmMeta | null } | { ok: false; code: string; detail: string } {
  if (args.music !== "on") return { ok: true, bgm: repairBgmSelection(args.bgm) };
  if (args.bgm === null || args.bgm === undefined) {
    const repaired = repairBgmSelection({ path: "", mood: args.moodHint ?? "" });
    if (repaired) return { ok: true, bgm: repaired };
    return { ok: false, code: "BGM_REQUIRED_BUT_MISSING", detail: "music:on mas bgm:null e sem mood para repair — escolhe BGM do catálogo real ou usa music:off/auto." };
  }
  const repaired = repairBgmSelection(args.bgm);
  if (!repaired) {
    return { ok: false, code: "BGM_INVALID", detail: "music:on com BGM inválida e sem repair possível — verifica o catálogo real." };
  }
  return { ok: true, bgm: repaired };
}

// ─── User message builder ──────────────────────────────────────────────────

export function buildAudioUserMessage(
  brief: string,
  inputs: Record<string, string>,
): string {
  const storyboard = inputs["STORYBOARD.md"] ?? "(no storyboard)";
  const script = inputs["SCRIPT.md"] ?? "";
  const catalogLines = BGM_TRACKS
    .map((t) => `- ${t.file} — "${t.title}" [${t.mood}] bpm:${t.bpm} duration:${t.durationSec}s`)
    .join("\n");
  return `## Project brief
${brief}

## BGM catalog (REAL files — the ONLY valid values for bgm.path)
${catalogLines}

## Storyboard
\`\`\`markdown
${storyboard}
\`\`\`

${script ? `## Script\n\`\`\`markdown\n${script}\n\`\`\`` : "## No narration script (silent project or BGM only)"}

Produce the audio metadata (audio_meta.json) for this project.
Include word timings for narration segments and pick the BGM from the REAL catalog above (copy its file EXACTLY).`;
}

// ─── Artifact extractor ────────────────────────────────────────────────────

/**
 * F03.5: aplica tri-state puro. `off` impede geração/injeção e remove derivados
 * obsoletos da nova revisão; `on` exige output real (validado a jusante);
 * `auto` resolve antes de materializar via resolveAutoToggles.
 *
 * C04.2: `reuseBgm` preserva a faixa já materializada de um clone (mesma
 * música do vídeo de origem) — só aceita paths reais dentro de `projects/…`.
 */
export function extractAudioArtifacts(
  output: AudioOutput,
  settings?: ProjectAudioSettings,
  opts?: { generateMusic?: boolean; reuseBgm?: BgmMeta | null },
): Record<string, string> {
  let extras: Record<string, unknown> = {};
  try {
    const inner = JSON.parse(output.audio_meta_json ?? "{}");
    if (inner && typeof inner === "object" && !Array.isArray(inner)) extras = inner;
  } catch {
    console.warn("[audioStep] nested metadata malformed; using validated fields");
  }
  const { files: _files, audio_meta_json: _nested, ...annotations } = extras;
  // F03: SFX:on sem capability => falha explícita aqui (não sucesso falso).
  const sfxCheck = validateSfxRequest({ sfx: settings?.sfx ?? "auto" });
  if (sfxCheck.ok === false) {
    throw new Error(`${sfxCheck.code}: ${sfxCheck.detail}`);
  }
  const resolved = settings
    ? resolveAutoToggles({
      narration: settings.narration,
      captions: settings.captions,
      music: settings.music,
      sfx: settings.sfx,
      hasNarrationText: output.narration_segments.some((s) => s.text.trim().length > 0),
    })
    : null;
  // Off => remove derivados obsoletos (nova revisão sem áudio antigo).
  const narrationSegments = resolved && resolved.narration === "off" ? [] : output.narration_segments;
  const narration = narrationSegments.map((segment) => {
    const words = segment.text.trim().split(/\s+/).filter(Boolean);
    const word_timings = segment.word_timings?.length ? segment.word_timings : words.map((word, i) => ({
      word,
      start: segment.start + (segment.end - segment.start) * i / words.length,
      end: segment.start + (segment.end - segment.start) * (i + 1) / words.length,
    }));
    return { ...segment, word_timings };
  });
  // music:on com bgm:null => repair ou erro explícito (nunca sucesso falso).
  const reusable = opts?.reuseBgm && typeof opts.reuseBgm.path === "string"
    && /^projects\/[^/]+\/audio\/music\/.+\.(mp3|wav)$/.test(opts.reuseBgm.path)
    ? {
      path: opts.reuseBgm.path,
      mood: opts.reuseBgm.mood,
      duration_sec: opts.reuseBgm.duration_sec,
      volume: opts.reuseBgm.volume ?? 0.3,
    }
    : null;
  let bgm: BgmMeta | null;
  if (resolved && resolved.music === "off") {
    bgm = null;
  } else if (reusable) {
    // C04.2: clone reutiliza a faixa do pai (copiada para o próprio prefixo).
    bgm = reusable;
  } else if (opts?.generateMusic) {
    bgm = null; // No real file until the Suno task finishes and Storage upload succeeds.
  } else if (settings?.music === "on") {
    const req = requireBgmForMusicOn({ music: "on", bgm: output.bgm, moodHint: "" });
    if (req.ok === false) throw new Error(`${req.code}: ${req.detail}`);
    bgm = req.bgm;
  } else {
    bgm = settings?.music === "off" ? null : repairBgmSelection(output.bgm);
  }
  // narration:on exige segmentos reais (validado também no superRefine do index).
  if (settings?.narration === "on" && narration.length === 0) {
    throw new Error("NARRATION_REQUIRED_BUT_MISSING: narration:on exige segmentos com texto — sem fallback silencioso.");
  }
  const metaJson = JSON.stringify({
    ...annotations,
    narration_segments: narration,
    bgm,
    ...(opts?.generateMusic && resolved?.music !== 'off' ? { music_plan: { mood: output.bgm?.mood || 'warm modern uplifting minimal', status: 'pending' } } : {}),
    total_duration_sec: output.total_duration_sec,
    timing_source: "estimated", // Planning estimates; the audio edge upgrades to `acoustic` after ASR.
    ...(settings ? { caption_style: settings.captionStyle ?? "editorial" } : {}),
    narration_enabled: resolved ? resolved.narration === "on" : settings?.narration !== "off",
    captions_enabled: resolved
      ? resolved.captions === "on"
      : settings?.captions === "on" || (settings?.captions !== "off" && settings?.narration !== "off" && narration.length > 0),
    sfx_enabled: resolved ? resolved.sfx === "on" : settings?.sfx === "on",
    ...(settings ? { language: settings.lang, voice: settings.voiceName ?? "auto", voice_locale: (settings as { voiceLocale?: string }).voiceLocale ?? "auto" } : {}),
  });
  return {
    "audio_meta.json": metaJson,
  };
}
