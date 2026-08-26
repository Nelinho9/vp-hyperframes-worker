#!/usr/bin/env node
/**
 * generate-bgm.mjs — V5-P5B §2.1: catálogo BGM curated REAL vendido no
 * container do worker.
 *
 * Sintetiza as faixas com ffmpeg local (pads/harmónicos/tremolo, fades
 * cozidos, mp3 96k) e emite EM SINCRONIA:
 *   1. bgm/*.mp3 + bgm/catalog.json            (vendidos na imagem do worker)
 *   2. ../visttapro/supabase/functions/_shared/bgm/bgmCatalog.ts
 *      (fonte única importada pelo passo de áudio no Deno/vitest)
 *
 * Fonte única da TABELA é este ficheiro — editar aqui e correr de novo;
 * commit nos DOIS repos (app + worker).
 *
 * Uso: node scripts/generate-bgm.mjs [--force]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BGM_DIR = join(ROOT, "bgm");
const APP_SHARED_TS = process.env.BGM_TS_OUT
  ?? resolve(ROOT, "..", "visttapro", "supabase", "functions", "_shared", "bgm", "bgmCatalog.ts");

const FORCE = process.argv.includes("--force");
const SAMPLE_RATE = 44100;

/**
 * TABELA CURATED — 12 texturas ambiente distintas por mood. Frequências em
 * Hz (notas reais); durações ≥55s para cobrir vídeos típicos sem loop.
 */
const TRACKS = [
  {
    id: "sunrise-warmth", title: "Sunrise Warmth",
    mood: "warm uplifting hopeful bright",
    bpm: 70, dur: 62,
    voices: [220, 277.18, 329.63, 440],
    tremolo: { f: 0.25, d: 0.25 }, master: 0.5,
  },
  {
    id: "clean-focus", title: "Clean Focus",
    mood: "corporate calm focused minimal clean",
    bpm: 90, dur: 60,
    voices: [130.81, 164.81, 196, 246.94],
    lowpass: 2400, master: 0.45,
  },
  {
    id: "gentle-momentum", title: "Gentle Momentum",
    mood: "upbeat light playful friendly",
    bpm: 105, dur: 58,
    voices: [196, 246.94, 293.66, 392],
    tremolo: { f: 2.5, d: 0.55 }, master: 0.42,
  },
  {
    id: "deep-confidence", title: "Deep Confidence",
    mood: "bold powerful deep serious premium",
    bpm: 80, dur: 64,
    voices: [65.41, 98, 130.81],
    master: 0.55,
  },
  {
    id: "night-drive", title: "Night Drive",
    mood: "dark mysterious cinematic tense",
    bpm: 85, dur: 66,
    voices: [73.42, 110, 174.61, 164.81],
    lowpass: 1600, tremolo: { f: 0.18, d: 0.35 }, master: 0.52,
  },
  {
    id: "morning-clarity", title: "Morning Clarity",
    mood: "fresh bright clean airy optimistic",
    bpm: 100, dur: 56,
    voices: [164.81, 246.94, 329.63, 415.3],
    tremolo: { f: 0.4, d: 0.2 }, master: 0.4,
  },
  {
    id: "soft-arrival", title: "Soft Arrival",
    mood: "emotional elegant tender romantic soft",
    bpm: 65, dur: 68,
    voices: [87.31, 130.81, 164.81, 220],
    lowpass: 2800, master: 0.48,
  },
  {
    id: "steady-build", title: "Steady Build",
    mood: "energetic driving modern motivational growing",
    bpm: 120, dur: 62,
    voices: [110, 220, 330, 440],
    volRamp: { from: 0.45, to: 1 }, master: 0.5,
  },
  {
    id: "quiet-trust", title: "Quiet Trust",
    mood: "minimal quiet subtle sincere calm",
    bpm: 60, dur: 70,
    voices: [123.47, 185],
    lowpass: 1800, master: 0.34,
  },
  {
    id: "open-horizon", title: "Open Horizon",
    mood: "inspiring wide epic adventurous free",
    bpm: 75, dur: 72,
    voices: [130.81, 196, 293.66, 392],
    tremolo: { f: 0.22, d: 0.3 }, master: 0.46,
  },
  {
    id: "city-pulse", title: "City Pulse",
    mood: "urban rhythmic modern confident busy",
    bpm: 100, dur: 58,
    voices: [110, 130.81, 164.81, 220],
    tremolo: { f: 1.67, d: 0.8 }, master: 0.44,
  },
  {
    id: "sunset-glow", title: "Sunset Glow",
    mood: "nostalgic warm mellow reflective mellow",
    bpm: 68, dur: 64,
    voices: [146.83, 220, 293.66, 440],
    lowpass: 2600, tremolo: { f: 0.3, d: 0.22 }, master: 0.47,
  },
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`${cmd} exited ${r.status}\n${r.stderr?.slice(0, 2000)}`);
  }
}

function ffmpegArgs(t, outFile) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const f of t.voices) {
    args.push("-f", "lavfi", "-i", `aevalsrc=0.14*sin(2*PI*${f}*t):s=${SAMPLE_RATE}:d=${t.dur}`);
  }
  const chain = [
    `amix=inputs=${t.voices.length}:normalize=0`,
    "highpass=f=40",
    ...(t.lowpass ? [`lowpass=f=${t.lowpass}`] : []),
    ...(t.tremolo ? [`tremolo=f=${t.tremolo.f}:d=${t.tremolo.d}`] : []),
    ...(t.volRamp
      ? [`volume='0.35+${(t.volRamp.to - t.volRamp.from).toFixed(2)}*min(1\\,t/${t.dur})':eval=frame`]
      : []),
    `volume=${t.master}`,
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
    "afade=t=in:d=1.5",
    `afade=t=out:st=${Math.max(1, t.dur - 3)}:d=3`,
  ].join(",");
  args.push("-filter_complex", chain, "-c:a", "libmp3lame", "-b:a", "96k", outFile);
  return args;
}

function probeDuration(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8", windowsHide: true },
  );
  const d = parseFloat((r.stdout ?? "").trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe failed for ${file}`);
  return Math.round(d * 10) / 10;
}

function main() {
  if (!existsSync(BGM_DIR)) mkdirSync(BGM_DIR, { recursive: true });
  const catalogTracks = [];

  for (const t of TRACKS) {
    const file = `${t.id}.mp3`;
    const outPath = join(BGM_DIR, file);
    const needsRender =
      FORCE || !existsSync(outPath) || statSync(outPath).size === 0;

    if (needsRender) {
      console.log(`[bgm] rendering ${file} (${t.dur}s)...`);
      run("ffmpeg", ffmpegArgs(t, outPath));
    } else {
      console.log(`[bgm] exists, skipping render: ${file}`);
    }

    const durationSec = probeDuration(outPath);
    const sizeBytes = statSync(outPath).size;
    catalogTracks.push({
      id: t.id,
      file,
      title: t.title,
      mood: t.mood,
      bpm: t.bpm,
      durationSec,
      sizeBytes,
      license: "CC0 (generated in-house, no third-party content)",
    });
  }

  const catalog = { version: 1, generatedAt: new Date().toISOString(), tracks: catalogTracks };
  writeFileSync(join(BGM_DIR, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  console.log(`[bgm] wrote ${join(BGM_DIR, "catalog.json")} (${catalogTracks.length} tracks)`);

  // Módulo TS partilhado (fonte única do lado edge/app).
  const ts = `// AUTO-GENERATED by vp-hyperframes-worker/scripts/generate-bgm.mjs — DO NOT EDIT BY HAND.
// Regenerate: \`node scripts/generate-bgm.mjs\` in the worker repo, then commit BOTH repos.

export interface BgmTrack {
  id: string;
  file: string;
  title: string;
  /** keywords de mood (lowercase, espaço-separated) usadas pela escolha/repair */
  mood: string;
  bpm: number;
  durationSec: number;
  sizeBytes?: number;
  license?: string;
}

export const BGM_CATALOG_VERSION = ${catalog.version};

export const BGM_TRACKS: readonly BgmTrack[] = ${JSON.stringify(catalogTracks, null, 2)};

/** paths válidos (bgm.path do audio_meta tem de ser um destes files) */
export const BGM_FILES: readonly string[] = BGM_TRACKS.map((t) => t.file);
`;
  mkdirSync(dirname(APP_SHARED_TS), { recursive: true });
  writeFileSync(APP_SHARED_TS, ts);
  console.log(`[bgm] wrote ${APP_SHARED_TS}`);
}

try {
  main();
} catch (err) {
  console.error("[bgm] FAILED:", err?.message ?? err);
  process.exit(1);
}
