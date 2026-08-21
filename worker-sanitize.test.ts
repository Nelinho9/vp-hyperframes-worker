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
import { sanitizeCompositionTweens, extractLintFindings } from "./composition-sanitizer.js";

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
