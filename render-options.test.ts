/**
 * render-options.test.ts — F04-T02 worker (V5.34).
 *
 * Envelope da edge guarda/reidrata options; mp4/webm/gif/png geram argv/output/MIME certos;
 * invalid format/fps não é ignorado.
 */
import { describe, expect, it } from "vitest";
import { resolveWorkerRenderOptions, adaptLegacySpecOptions, persistEffectiveOptions } from "./render-options.js";
import { buildExportArgv, mimeForFormat, outputNameForFormat } from "./render-argv.js";

describe("worker render-options (F04-T02)", () => {
  it("options tipadas do producer resolvem e persistem para restart", () => {
    const body = { options: { width: 1920, height: 1080, fps: 30, duration: 30, format: "mp4", quality: "high" }, revision: 2 };
    const r = resolveWorkerRenderOptions(body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.options.width).toBe(1920);
    expect(r.options.fps).toBe(30);
    const job = persistEffectiveOptions({}, r);
    expect(job.effective_options.width).toBe(1920);
    // Restart: o objeto persistido recupera as mesmas options.
    const re = structuredClone(job);
    expect(re.effective_options.format).toBe("mp4");
  });

  it("body.fps solto divergente falha (staging usa effective)", () => {
    const r = resolveWorkerRenderOptions({ options: { width: 1920, height: 1080, fps: 30, duration: 15, format: "mp4" }, fps: 60, revision: 1 });
    expect(r.ok).toBe(false);
  });

  it("alias N-1 só pelo adapter; unknown nunca vira default silencioso", () => {
    expect(resolveWorkerRenderOptions({ options: { width: 1920, height: 1080, duration: 15, bogus: 1 }, revision: 1 }).ok).toBe(false);
    const legacy = adaptLegacySpecOptions({ aspect_ratio: "16:9" });
    expect(legacy.options.width).toBe(1920);
    expect(legacy.warnings.join(" ")).toMatch(/LEGACY_ADAPTER/);
  });

  it("mp4/webm/gif/png geram argv/output/MIME certos; inválidos falham", () => {
    for (const fmt of ["mp4", "webm", "gif", "png"]) {
      const b = buildExportArgv({ format: fmt, jobDir: "/tmp/j", durationTargetSeconds: 30 });
      expect(b.ok).toBe(true);
      if (!b.ok) continue;
      expect(b.mime).toBe(mimeForFormat(fmt));
      expect(b.outputName).toBe(outputNameForFormat(fmt));
      expect(b.args.join(" ")).not.toMatch(/--describe true/);
    }
    expect(buildExportArgv({ format: "avi", jobDir: "/tmp/j" }).ok).toBe(false);
    expect(resolveWorkerRenderOptions({ options: { width: 1920, height: 1080, fps: 60, duration: 15, format: "mp4" }, revision: 1 }).ok).toBe(false);
  });
});
