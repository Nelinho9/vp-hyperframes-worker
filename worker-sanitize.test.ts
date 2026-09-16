/**
 * worker-sanitize.test.ts — V4-3f.17 (V4_3F_16_INCIDENT Fase 5)
 *
 * Worker-side tolerance layer:
 * 1. sanitizeCompositionTweens mechanically converts layout-prop GSAP
 *    tweens (left/top) into transform equivalents (x/y) BEFORE
 *    `hyperframes lint` runs — the exact error class that hard-failed the
 *    V4-3f.16 build on the worker.
 * 2. extractLintFindings parses the `hyperframes lint --json` output from a
 *    failed execSync so the callback carries the full structured findings
 *    instead of a truncated opaque message.
 */
import { describe, it, expect } from "vitest";
import { sanitizeCompositionTweens, sanitizeTimelineRegistry, extractLintFindings } from "./composition-sanitizer.js";

describe("sanitizeCompositionTweens", () => {
  it("rewrites left/top tween vars to x/y and reports the repairs", () => {
    const html = `<html><body>
<script>
window.__timelines["main"].fromTo("#laser-scan", { left: "100%", duration: 1.8, ease: "power1.inOut" }, 6.8);
tl.to("#hero", { top: 40, opacity: 1 }, 0);
</script>
</body></html>`;
    const { html: out, repairs } = sanitizeCompositionTweens(html);
    expect(out).toContain('x: "100%"');
    expect(out).toContain("y: 40");
    expect(out).not.toContain("left:");
    expect(out).not.toContain("top:");
    expect(repairs.length).toBe(2);
    expect(repairs.join(" ")).toContain("#laser-scan");
    expect(repairs.join(" ")).toContain("left->x");
  });

  it("leaves transform-only tweens, CSS and string literals untouched", () => {
    const html = `<html><body>
<div style="position:absolute;left:10px;top:5px;">css stays</div>
<script>tl.fromTo("#a", { x: 0 }, { x: 10, duration: 1 }, 0); var s = "text-align:left";</script>
</body></html>`;
    const { html: out, repairs } = sanitizeCompositionTweens(html);
    expect(out).toBe(html);
    expect(repairs).toEqual([]);
  });

  it("skips external script tags and returns repairs empty for clean markup", () => {
    const html = '<script src="https://cdn.example/gsap.min.js"></script><script>gsap.set("#a", { opacity: 1 });</script>';
    const { html: out, repairs } = sanitizeCompositionTweens(html);
    expect(out).toBe(html);
    expect(repairs).toEqual([]);
  });
});

// V5.27 Fase D — spec viva dos patterns do CLI 0.7.109 (cli.js:81715/81717).
// A regra `gsap_timeline_not_registered` (cli.js:82941-82945) exige o registro
// canônico DENTRO de cada bloco <script> que contém `gsap.timeline`.
const CLI_ASSIGN_RE =
  /window\.__timelines(?:\[\s*(?:["']([^"']+)["']|[A-Za-z_$][\w$.]*)\s*\]|\.\s*([A-Za-z_$][\w$]*))\s*=\s*([A-Za-z_$][\w$]*)/i;
const CLI_OBJECT_LITERAL_RE =
  /window\.__timelines\s*=\s*\{\s*(?:["'][^"']+["']|[A-Za-z_$][\w$]*)\s*:/i;

function inlineScripts(html) {
  return [...String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/i.test(m[1]))
    .map((m) => m[2]);
}

function expectCliRegistryParity(html) {
  for (const body of inlineScripts(html)) {
    if (!/gsap\.timeline/.test(body)) continue;
    expect(
      CLI_ASSIGN_RE.test(body) || CLI_OBJECT_LITERAL_RE.test(body),
      `bloco ofensor sem registro canônico: ${body.slice(0, 160)}`,
    ).toBe(true);
  }
}

describe("sanitizeTimelineRegistry (V5.27 Fase D)", () => {
  it("registra a timeline dentro do script ofensor (incidente: tl local sem registro)", () => {
    const html = `<html><head></head><body>
<div class="composition" data-composition-id="main"></div>
<script>
const tl = gsap.timeline({ paused: true });
tl.fromTo("#scene-6-text-2", { opacity: 0 }, { opacity: 1, duration: 0.5 }, 32.1);
</script>
</body></html>`;
    const { html: out, repairs } = sanitizeTimelineRegistry(html, "main");
    expect(repairs).toHaveLength(1);
    expect(out).toContain('window.__timelines["main"] = tl;');
    expectCliRegistryParity(out);
  });

  it("deixa HTML canônico inalterado (idempotência)", () => {
    const html = `<html><body><script>
window.__timelines = window.__timelines || {};
window.__timelines["main"] = gsap.timeline({ paused: true });
</script></body></html>`;
    const { html: out, repairs } = sanitizeTimelineRegistry(html, "main");
    expect(out).toBe(html);
    expect(repairs).toEqual([]);
    expectCliRegistryParity(out);
  });

  it("repara múltiplos ofensores com 1 inserção cada, logada", () => {
    const html = `<html><body>
<script>const a = gsap.timeline({ paused: true }); a.to("#x", { opacity: 1 }, 0);</script>
<script>const b = gsap.timeline({ paused: true }); b.to("#y", { opacity: 1 }, 1);</script>
</body></html>`;
    const { html: out, repairs } = sanitizeTimelineRegistry(html, "main");
    expect(repairs).toHaveLength(2);
    expect(out).toContain('window.__timelines["main"] = a;');
    expect(out).toContain('window.__timelines["main"] = b;');
    expectCliRegistryParity(out);
  });

  it("recusa mutação sem identificador extraível (vai ao lint, sem magia)", () => {
    const html = `<html><body><script>gsap.timeline({ paused: true }).to("#x", { opacity: 1 }, 0);</script></body></html>`;
    const { html: out, repairs } = sanitizeTimelineRegistry(html, "main");
    expect(out).toBe(html);
    expect(repairs).toEqual([]);
  });

  it("ignora scripts externos e blocos sem gsap.timeline", () => {
    const html = '<script src="https://cdn.example/gsap.min.js"></script><script>const x = 1;</script>';
    const { html: out, repairs } = sanitizeTimelineRegistry(html, "main");
    expect(out).toBe(html);
    expect(repairs).toEqual([]);
  });
});

describe("extractLintFindings", () => {
  it("parses the findings array from lint --json stdout", () => {
    const err = Object.assign(new Error("Command failed"), {
      stdout: Buffer.from(JSON.stringify({
        ok: false,
        findings: [
          { code: "gsap_non_transform_motion", severity: "error", selector: "#laser-scan", message: "uses left" },
          { code: "composition_file_too_large", severity: "warning", message: "337 lines" },
        ],
      })),
      stderr: Buffer.from(""),
    });
    const findings = extractLintFindings(err);
    expect(findings).toHaveLength(2);
    expect(findings[0].code).toBe("gsap_non_transform_motion");
    expect(findings[1].severity).toBe("warning");
  });

  it("accepts a bare JSON array and finds JSON embedded in chatter", () => {
    const bare = Object.assign(new Error("x"), {
      stdout: Buffer.from('[{"code":"a","severity":"error"}]'),
      stderr: Buffer.from(""),
    });
    expect(extractLintFindings(bare)).toHaveLength(1);

    const embedded = Object.assign(new Error("x"), {
      stdout: Buffer.from('linting project...\n{"ok":false,"findings":[{"code":"b","severity":"error"}]}\ndone'),
      stderr: Buffer.from(""),
    });
    expect(extractLintFindings(embedded)).toHaveLength(1);
  });

  it("returns null when no JSON findings are present", () => {
    const err = Object.assign(new Error("x"), {
      stdout: Buffer.from("plain text failure"),
      stderr: Buffer.from(""),
    });
    expect(extractLintFindings(err)).toBeNull();
    expect(extractLintFindings(new Error("no streams"))).toBeNull();
  });
});
