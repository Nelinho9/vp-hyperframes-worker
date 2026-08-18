import { describe, expect, it } from "vitest";
import {
  classifyCheckEnvelope,
  extractCheckJson,
  loadVendoredRuntimeBundles,
  sanitizeCompositionForOffline,
} from "./runtime-vendor.js";

describe("offline runtime vendor", () => {
  it("removes CDN runtimes/fonts and injects both local bundles", () => {
    const html = `<!doctype html><html><head>
      <script src="https://cdn.jsdelivr.net/npm/@heygen/hyperframes@0.7.109/dist/hyperframes.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
      <style>@import url('https://fonts.googleapis.com/css2?family=Roboto');</style>
    </head><body></body></html>`;
    const result = sanitizeCompositionForOffline(html, {
      hyperframesRuntime: "window.__hf = {};",
      gsapRuntime: "window.gsap = {};",
    });

    expect(result).not.toContain("jsdelivr");
    expect(result).not.toContain("fonts.googleapis");
    expect(result).toContain('data-vp-vendored="gsap"');
    expect(result).toContain('src="assets/__vp_gsap.min.js"');
    expect(result).not.toContain('data-vp-vendored="hyperframes"');
    expect(result).not.toContain("window.__hf");
  });

  it("injects the actual installed bundle shape used by the server", () => {
    const bundles = loadVendoredRuntimeBundles();
    const result = sanitizeCompositionForOffline("<html><head></head><body></body></html>", {
      hyperframesRuntime: bundles.hyperframes,
      gsapRuntime: bundles.gsap,
    });

    expect(bundles.hyperframesPath).toBeTruthy();
    expect(bundles.gsapPath).toBeTruthy();
    expect(result).toContain('data-vp-vendored="gsap"');
    expect(result).toContain('src="assets/__vp_gsap.min.js"');
    expect(result).not.toContain(bundles.gsap.slice(0, 80));
  });

  it("tolerates only external request/http failures when lint and layout pass", () => {
    const envelope = {
      ok: false,
      lint: { ok: true, findings: [] },
      layout: { ok: true, findings: [] },
      runtime: {
        ok: false,
        findings: [
          { code: "request_failed", severity: "error", url: "https://fonts.googleapis.com/css2" },
          { code: "http_error", severity: "error", url: "https://example.com/image.png" },
        ],
      },
    };
    const result = classifyCheckEnvelope(envelope);
    expect(result.ok).toBe(true);
    expect(result.tolerated).toHaveLength(2);
    expect(result.fatal).toHaveLength(0);
  });

  it("keeps page and console errors fatal", () => {
    const result = classifyCheckEnvelope({
      lint: { ok: true, findings: [] },
      layout: { ok: true, findings: [] },
      runtime: { ok: false, findings: [{ code: "page_error", severity: "error", message: "boom" }] },
    });
    expect(result.ok).toBe(false);
    expect(result.fatal[0].code).toBe("page_error");
  });

  it("extracts JSON after CLI log chatter", () => {
    const value = extractCheckJson('checking...\n{"ok":false,"lint":{"ok":true},"layout":{"ok":true}}\n');
    expect(value?.ok).toBe(false);
    expect(value?.layout.ok).toBe(true);
  });
});
