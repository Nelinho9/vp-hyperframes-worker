/**
 * render-temporal.test.ts — F04-T05 worker (V5.34), correção E02/N-H.
 *
 * Contrato §4: o gate do plano temporal do render usa a MESMA decisão de fit do
 * build (`decideVoiceFit`), sem a tolerância local de +0,25s, e a mesma guarda
 * de janela inválida. Antes desta correção a cópia do worker
 * (`render-temporal.js`) mantinha `measuredSec > slot + 0.25` — uma voz até
 * ~7,5 frames acima da janela passava — e era fail-open em janelas malformadas.
 *
 * Vetores discriminantes: 3,25s/3s é exatamente o caso que a tolerância antiga
 * deixava passar (3.25 > 3 + 0.25 é falso); hoje falha.
 */
import { describe, expect, it } from "vitest";
import { validateTemporalAudioPlan, secondsToFrameFloorHalfUp, measurementSourceTrusted, EFFECTIVE_FPS_DEFAULT } from "./render-temporal.js";

const WINDOWS = [{ id: "scene-1", start: 0, duration: 3 }];
const slot = (over) => ({ frameNumber: 1, measuredSec: 3, windowStart: 0, windowEnd: 3, ...over });

describe("worker validateTemporalAudioPlan (F04-T05) — fit por frames, sem tolerância local", () => {
  it("fps default é 30 (paridade com decideVoiceFit/AUDIO_FPS)", () => {
    expect(EFFECTIVE_FPS_DEFAULT).toBe(30);
  });

  it("secondsToFrameFloorHalfUp quantiza floor(s*fps+0.5) e recusa entrada inválida", () => {
    expect(secondsToFrameFloorHalfUp(3, 30)).toBe(90);
    expect(secondsToFrameFloorHalfUp(3.016, 30)).toBe(90); // 90.48+0.5 -> 90
    expect(secondsToFrameFloorHalfUp(3.017, 30)).toBe(91); // 90.51+0.5 -> 91
    expect(secondsToFrameFloorHalfUp(Number.NaN, 30)).toBeNull();
    expect(secondsToFrameFloorHalfUp(Number.POSITIVE_INFINITY, 30)).toBeNull();
    expect(secondsToFrameFloorHalfUp(-1, 30)).toBeNull();
    expect(secondsToFrameFloorHalfUp("3", 30)).toBeNull();
  });

  it("5,92s em janela de 3s excede (fixture histórica)", () => {
    const r = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: 5.92 })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0].code).toBe("F04_VO_WINDOW_OVERFLOW");
  });

  it("3,25s em janela de 3s excede — o caso que a tolerância +0,25s deixava passar", () => {
    const r = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: 3.25 })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failures[0].code).toBe("F04_VO_WINDOW_OVERFLOW");
  });

  it("3,1s em janela de 3s excede; 3,0s exato (90 frames) passa", () => {
    const over = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: 3.1 })] });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.failures[0].code).toBe("F04_VO_WINDOW_OVERFLOW");

    const exact = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: 3 })] });
    expect(exact.ok).toBe(true);
  });

  it("janelas malformadas são recusadas (guarda N-G, antes fail-open)", () => {
    const inf = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: 99, windowEnd: Number.POSITIVE_INFINITY })] });
    expect(inf.ok).toBe(false);
    if (!inf.ok) expect(inf.failures.map((f) => f.code)).toContain("F04_VO_WINDOW_INVALID");

    const nan = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ windowStart: Number.NaN })] });
    expect(nan.ok).toBe(false);

    const collapsed = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: 0, windowStart: 0, windowEnd: 0 })] });
    expect(collapsed.ok).toBe(false);
    if (!collapsed.ok) expect(collapsed.failures.map((f) => f.code)).toContain("F04_VO_WINDOW_INVALID");
  });

  it("medida ausente/estimada continua a falhar antes do fit", () => {
    const unmeasured = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: null })] });
    expect(unmeasured.ok).toBe(false);
    if (!unmeasured.ok) expect(unmeasured.failures[0].code).toBe("F04_VO_UNMEASURED");

    const estimated = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: 2.5, measurementSource: "wpm-estimate" })] });
    expect(estimated.ok).toBe(false);
    if (!estimated.ok) expect(estimated.failures[0].code).toBe("F04_VO_ESTIMATED");
  });

  it("N-J: só uma fonte medida confiável promove timing (paridade com decideVoiceFit)", () => {
    // O produtor do plano transporta `duration_source` do TTS. Antes (N-J) um
    // regex deixava passar `unknown`, que `decideVoiceFit` recusa.
    for (const source of ["unknown", "estimated-mp3", "measured-flac", ""]) {
      const r = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: 2.5, measurementSource: source })] });
      expect(r.ok, `fonte ${JSON.stringify(source)} devia recusar`).toBe(false);
      if (!r.ok) expect(r.failures[0].code).toBe("F04_VO_ESTIMATED");
    }
    for (const source of [null, undefined, "measured-wav", "measured-mp3"]) {
      const r = validateTemporalAudioPlan({ rootDuration: 3, windows: WINDOWS, audioSlots: [slot({ measuredSec: 2.5, measurementSource: source })] });
      expect(r.ok, `fonte ${JSON.stringify(source)} devia passar`).toBe(true);
    }
  });

  it("measurementSourceTrusted espelha a lista de fontes confiáveis da decisão única", () => {
    expect(measurementSourceTrusted(null)).toBe(true);
    expect(measurementSourceTrusted(undefined)).toBe(true);
    expect(measurementSourceTrusted("measured-wav")).toBe(true);
    expect(measurementSourceTrusted("measured-mp3")).toBe(true);
    expect(measurementSourceTrusted("unknown")).toBe(false);
    expect(measurementSourceTrusted("estimated-mp3")).toBe(false);
    expect(measurementSourceTrusted("wpm-estimate")).toBe(false);
  });

  it("sem windows é inválido e o total usa max(start+duration), não a soma", () => {
    expect(validateTemporalAudioPlan({ rootDuration: 3, windows: [] }).ok).toBe(false);
    const ok = validateTemporalAudioPlan({ rootDuration: 6, windows: [{ id: "a", start: 0, duration: 3 }, { id: "b", start: 3, duration: 3 }] });
    expect(ok.ok).toBe(true);
  });
});


describe('E02 review: exact decoded sample certificates', () => {
  const check = (extra: Record<string, unknown>) => validateTemporalAudioPlan({
    rootDuration: 3, windows: [{ id: 'scene-1', start: 0, duration: 3 }], fps: 30,
    audioSlots: [{ frameNumber: 1, measuredSec: 3, measurementSource: 'measured-wav',
      sampleCount: 72000, sampleRate: 24000, decodeComplete: true,
      windowStart: 0, windowEnd: 3, ...extra }],
  });
  it('exact fit passes; one extra sample fails even if seconds round to 3', () => {
    expect(check({}).ok).toBe(true);
    expect(check({ sampleCount: 72001 })).toMatchObject({ ok: false, failures: [{ code: 'F04_VO_WINDOW_OVERFLOW' }] });
  });
  it.each([
    { sampleRate: null }, { sampleCount: -1 }, { sampleCount: 1.5 },
    { decodeComplete: false }, { measuredSec: 1 },
  ])('invalid or partial certificate fails: %j', (extra) => {
    expect(check(extra)).toMatchObject({ ok: false, failures: [{ code: 'F04_VO_UNMEASURED' }] });
  });
});
