import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCheckEnvelope,
  extractCheckJson,
  extractGoogleFontFamilies,
  loadVendoredRuntimeBundles,
  localFontFaceStyle,
  prepareOfflineFonts,
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
    // V4-3f.13: GSAP é embutido como data URI (o ficheiro local 404ava no
    // render porque o compile serve o compiled dir sem copiar assets/).
    expect(result).toContain('src="data:text/javascript;base64,');
    expect(result).not.toContain('src="assets/__vp_gsap.min.js"');
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
    expect(result).toContain('src="data:text/javascript;base64,');
    expect(result).not.toContain(bundles.gsap.slice(0, 80));
    // O código do bundle nunca aparece em texto claro (lint não o inspeciona).
    expect(result).not.toContain("gsap.com");
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

describe("offline font resolution (V4-3f.10)", () => {
  const FONT_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;700&family=Inter&display=swap">';
  const HTML_WITH_FONTS = `<!doctype html><html><head>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    ${FONT_LINK}
    <style>h1{font-family:'Space Grotesk',sans-serif}</style>
  </head><body></body></html>`;

  it("extrai as famílias dos links css2 (weights preservados nos specs)", () => {
    const families = extractGoogleFontFamilies(HTML_WITH_FONTS);
    expect(families).toEqual(["Space Grotesk", "Inter"]);
  });

  it("remove também os preconnect (sem trailing slash) — fix do warning google_fonts_import", () => {
    const result = sanitizeCompositionForOffline(HTML_WITH_FONTS, {});
    expect(result).not.toContain("fonts.googleapis");
    expect(result).not.toContain("fonts.gstatic");
    expect(result).not.toContain("preconnect");
  });

  it("injeta o fontFaceStyle fornecido no <head>", () => {
    const style = localFontFaceStyle(["Space Grotesk"]);
    const result = sanitizeCompositionForOffline(HTML_WITH_FONTS, { fontFaceStyle: style });
    expect(result).toContain('data-vp-fonts="local"');
    expect(result).toContain("font-family:'Space Grotesk'");
    expect(result).toContain("src:local('Space Grotesk')");
    expect(result.indexOf("data-vp-fonts")).toBeLessThan(result.search(/<\/head>/i));
  });

  it("resolve woff2 reais via fetch e escreve os assets no jobDir", async () => {
    const jobDir = mkdtempSync(join(tmpdir(), "vp-font-job-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "vp-font-cache-"));
    const WOFF2 = Buffer.from("wOF2fakefontbytes");
    const css = [
      "/* latin-ext */",
      "@font-face { font-family: 'Space Grotesk'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/spacegrotesk/ext.woff2); }",
      "/* latin */",
      "@font-face { font-family: 'Space Grotesk'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/spacegrotesk/latin400.woff2); }",
      "/* latin */",
      "@font-face { font-family: 'Space Grotesk'; font-style: normal; font-weight: 700; src: url(https://fonts.gstatic.com/s/spacegrotesk/latin700.woff2); }",
    ].join("\n");
    const fetchImpl = async (url: string) => {
      if (String(url).includes("css2")) {
        return { ok: true, status: 200, text: async () => css } as unknown as Response;
      }
      if (String(url).includes("fonts.gstatic.com")) {
        return { ok: true, status: 200, arrayBuffer: async () => WOFF2.buffer.slice(WOFF2.byteOffset, WOFF2.byteOffset + WOFF2.length) } as unknown as Response;
      }
      throw new Error(`unexpected url ${url}`);
    };

    const result = await prepareOfflineFonts(HTML_WITH_FONTS, { jobDir, cacheDir, fetchImpl });
    expect(result.families).toEqual(["Space Grotesk", "Inter"]);
    expect(result.style).toContain('data-vp-fonts="resolved"');
    expect(result.style).toContain("font-family:'Space Grotesk'");
    // Only latin subset files downloaded (latin-ext skipped).
    const assets = readdirSync(join(jobDir, "assets")).filter((f) => f.startsWith("vp-font-"));
    expect(assets).toHaveLength(2);
    for (const file of assets) {
      expect(readFileSync(join(jobDir, "assets", file))).toEqual(WOFF2);
      expect(result.style).toContain(`assets/${file}`);
    }
    // Cache populated for future jobs.
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".woff2"))).toHaveLength(2);

    // Full pipeline: sanitized HTML keeps the declarations and drops the CDN.
    const sanitized = sanitizeCompositionForOffline(HTML_WITH_FONTS, { fontFaceStyle: result.style });
    expect(sanitized).not.toContain("fonts.googleapis");
    expect(sanitized).toContain("font-family:'Space Grotesk'");
    expect(sanitized).toContain("format('woff2')");
  });

  it("falha para o fallback local() quando a rede não responde", async () => {
    const jobDir = mkdtempSync(join(tmpdir(), "vp-font-job-"));
    const fetchImpl = async () => {
      throw new Error("egress blocked");
    };
    const result = await prepareOfflineFonts(HTML_WITH_FONTS, { jobDir, fetchImpl });
    expect(result.style).toContain('data-vp-fonts="local"');
    expect(result.style).toContain("local('Space Grotesk')");
    expect(result.style).toContain("local('Inter')");
    const assets = existsSync(join(jobDir, "assets")) ? readdirSync(join(jobDir, "assets")) : [];
    expect(assets.filter((f) => f.startsWith("vp-font-"))).toHaveLength(0);
  });

  it("sem referências Google Fonts devolve style vazio", async () => {
    const jobDir = mkdtempSync(join(tmpdir(), "vp-font-job-"));
    const result = await prepareOfflineFonts("<html><head></head><body></body></html>", { jobDir });
    expect(result.style).toBe("");
    expect(result.families).toEqual([]);
  });
});
