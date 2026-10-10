/**
 * render-coverage.test.ts — F04-T09 worker (V5.34, amplia render-snapshots).
 *
 * >5 root scenes, CTA, boundaries/transições, cenas curtas, overlaps e nested
 * têm schedule/coverage explícitos.
 */
import { describe, expect, it } from "vitest";
import { buildCoverageSchedule } from "./render-evidence.js";
import { validateTemporalAudioPlan } from "./render-temporal.js";

describe("worker render-coverage (F04-T09)", () => {
  it(">5 root scenes + CTA final com boundaries", () => {
    const windows = Array.from({ length: 7 }, (_, i) => ({ id: `scene-${i + 1}`, start: i * 4, end: i * 4 + 4, isCTA: i === 6 }));
    const cov = buildCoverageSchedule({ windows, fps: 30 });
    expect(cov.samples.length).toBeGreaterThan(5);
    expect(cov.samples.some((s) => s.kind === "final-cta" && s.scene_id === "scene-7")).toBe(true);
    expect(cov.samples.filter((s) => s.kind === "boundary").length).toBeGreaterThanOrEqual(7);
    expect(cov.missing).toEqual([]);
  });

  it("cenas curtas têm clamping frame-exato", () => {
    const cov = buildCoverageSchedule({ windows: [{ id: "scene-1", start: 0, end: 0.05 }], fps: 30 });
    expect(cov.samples.length).toBeGreaterThan(0);
    for (const s of cov.samples) {
      expect(s.time_s).toBeGreaterThanOrEqual(0);
      expect(s.time_s).toBeLessThan(0.05);
    }
  });

  it("overlaps falham com diagnóstico (sem somar durations)", () => {
    const r = validateTemporalAudioPlan({
      rootDuration: 6,
      windows: [{ id: "scene-1", start: 0, duration: 4 }, { id: "scene-2", start: 3, duration: 3 }],
    });
    expect(r.ok).toBe(false);
  });

  it("nested clips não contam como root (contrato: só root entra no schedule)", async () => {
    const { parseSceneWindows } = await import("./thumbnails.js");
    const html = `<div data-composition-id="main"><div class="clip" data-start="0" data-duration="3"></div>`
      + `<div data-composition-id="sub"><div class="clip" data-start="0" data-duration="10"></div></div></div>`;
    const wins = parseSceneWindows(html);
    // parseSceneWindows já filtra nested (owner === root).
    expect(wins.length).toBe(1);
  });
});
