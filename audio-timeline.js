/**
 * audio-timeline — F07 (V5.34 timeline multitrack, voz/música/SFX).
 *
 * Espelho worker de `src/video/v4/audioTimeline.ts` + `audioTimelineOps.ts`
 * (repos separados não partilham import; paridade SEMÂNTICA garantida por
 * testes nos dois lados com as mesmas fixtures).
 *
 * Unidade canónica: SEGUNDOS. Clips derivados do registry v2 (ou v1
 * adaptado); sceneId opcional; `bgm-main`/voice NUNCA excluídos por filtro
 * de cena; settings none/off → tracks ausentes com explicação.
 */

export const AUDIO_DERIVATION_VERSION = 1;

const ROLE_TOKENS = [
  { re: /^(voice|vo|narration)$/i, role: "voice" },
  { re: /^(music|mus|bgm)$/i, role: "music" },
  { re: /^(sfx|sfxs|effect|fx)$/i, role: "sfx" },
];

export function inferAudioRole(input = {}) {
  const explicit = String(input.role ?? "").trim().toLowerCase();
  for (const { re, role } of ROLE_TOKENS) {
    if (explicit && re.test(explicit)) return role;
  }
  if (explicit !== "" && explicit !== "audio") return null;
  const id = input.id ?? "";
  const stable = /^scene-\d+-([a-z]+)-\d+(?:-copy-\d+)*$/i.exec(id);
  const token = stable ? stable[1].toLowerCase() : String(id.split("-")[0] || "").toLowerCase();
  if (/^(voice|vo|narration)$/.test(token)) return "voice";
  if (/^(music|mus|bgm)$/.test(token)) return "music";
  if (/^(sfx|fx|effect)$/.test(token)) return "sfx";
  if (/^audio$/.test(token)) {
    if (/voice/i.test(id)) return "voice";
    if (/bgm|music/i.test(id)) return "music";
    if (/sfx/i.test(id)) return "sfx";
    return null;
  }
  return null;
}

export function trackIdForRole(role) {
  return `track-${role}`;
}

function clampVolume(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0.8;
  return Math.min(1, Math.max(0, n));
}

function clampFade(ms) {
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : 0;
  return Math.min(2000, Math.max(0, Math.round(n)));
}

function humanizeClipLabel(elementId, role) {
  const scene = /^scene-(\d+)-/i.exec(elementId)?.[1];
  const base = role === "voice" ? "Voice" : role === "music" ? "Music" : "SFX";
  if (elementId === "bgm-main") return "Music · global (bgm-main)";
  return scene ? `${base} · scene ${scene} (${elementId})` : `${base} · ${elementId}`;
}

/**
 * Deriva clips áudio (mesma semântica do espelho app). Nunca exclui por
 * filtro de cena; o filtro vive no consumidor.
 */
export function deriveAudioClips(elements = [], opts = {}) {
  const authored = opts.authoredById ?? {};
  const hashes = opts.sourceHashById ?? {};
  const out = [];
  for (const el of elements) {
    if ((el.type ?? "audio") !== "audio") continue;
    const role = inferAudioRole({ id: el.id, role: el.role, type: el.type });
    if (!role) continue;
    const scope = el.scope === "composition" || el.sceneId == null ? "composition" : "scene";
    const a = authored[el.id] ?? {};
    const start = typeof el.start === "number" && Number.isFinite(el.start) && el.start >= 0 ? el.start : 0;
    const duration = typeof el.duration === "number" && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    const source = el.assetRef ?? el.srcAssetUrl ?? null;
    out.push({
      clipId: el.id,
      trackId: trackIdForRole(role),
      role,
      scope: el.id === "bgm-main" ? "composition" : scope,
      sceneId: el.sceneId ?? null,
      elementId: el.id,
      label: typeof el.label === "string" && el.label.trim() ? el.label : humanizeClipLabel(el.id, role),
      source,
      sourceRevision: Number.isInteger(el.revision) ? el.revision : (opts.sourceRevision ?? null),
      sourceHash: hashes[el.id] ?? null,
      start,
      duration,
      mediaOffset: typeof el.mediaOffset === "number" && Number.isFinite(el.mediaOffset) ? el.mediaOffset : null,
      sourceDuration: duration > 0 ? duration : null,
      volume: clampVolume(a.volume),
      muted: a.muted === true,
      fadeInMs: clampFade(a.fadeIn),
      fadeOutMs: clampFade(a.fadeOut),
      wave: source ? "pending" : "unavailable",
      derivationVersion: AUDIO_DERIVATION_VERSION,
    });
  }
  const order = { voice: 0, music: 1, sfx: 2 };
  return out.sort((x, y) => order[x.role] - order[y.role] || x.start - y.start || (x.clipId < y.clipId ? -1 : 1));
}

export function secondsToFrames(seconds, fps) {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0) return 0;
  return Math.round(seconds * fps);
}

/** Replan de voice windows (nunca corte silencioso). */
export function replanVoiceWindows(windows = []) {
  const needsReplan = [];
  for (const w of windows) {
    if (w.measuredDuration === null || w.measuredDuration === undefined) continue;
    const windowDur = w.windowEnd - w.windowStart;
    if (w.measuredDuration > windowDur) {
      needsReplan.push({
        clipId: w.clipId,
        overflowSec: Math.round((w.measuredDuration - windowDur) * 100) / 100,
        action: "rewrite-regenerate",
      });
    }
  }
  return needsReplan.length > 0 ? { ok: false, needsReplan } : { ok: true };
}
