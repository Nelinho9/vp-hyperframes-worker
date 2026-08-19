/**
 * exec-error.test.ts — V4-3f.7: formatExecError surfaces lint findings
 *
 * Regression guard for the opaque "Command failed: npx hyperframes lint"
 * errors: execSync failures carry stdout/stderr Buffers which must be
 * included in the job error sent to the orchestrator callback.
 */
import { describe, it, expect } from "vitest";
import { formatExecError } from "./server.js";
import { classifyCheckEnvelope, extractCheckJson } from "./runtime-vendor.js";

describe("formatExecError", () => {
  it("appends stderr findings to the exec error message", () => {
    const err = Object.assign(new Error('Command failed: npx hyperframes lint --json "/tmp/job"'), {
      stderr: Buffer.from('{"ok":false,"findings":[{"code":"missing_timeline_registry"}]}'),
      stdout: Buffer.from(""),
    });
    const out = formatExecError(err);
    expect(out).toContain("Command failed: npx hyperframes lint");
    expect(out).toContain("missing_timeline_registry");
  });

  it("falls back to stdout when stderr is empty", () => {
    const err = Object.assign(new Error("Command failed: npx hyperframes check"), {
      stderr: Buffer.from(""),
      stdout: Buffer.from("check output detail"),
    });
    expect(formatExecError(err)).toContain("check output detail");
  });

  it("returns the bare message when no streams exist", () => {
    expect(formatExecError(new Error("boom"))).toBe("boom");
  });

  it("handles non-Error throwables", () => {
    expect(formatExecError("string failure")).toBe("string failure");
  });

  it("caps the combined error at 4000 chars", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("x".repeat(9000)),
    });
    expect(formatExecError(err).length).toBe(4000);
  });

  it("keeps the TAIL when truncating (render errors sit at the end)", () => {
    // Head = progress chatter, tail = the actionable failure line. The old
    // head-keep truncation hid the real render error behind INFO logs.
    const chatter = "[INFO] [Render] progress line\n".repeat(400);
    const err = Object.assign(new Error("Command failed: npx hyperframes render"), {
      stdout: Buffer.from(chatter + "FATAL: capture worker OOM — JavaScript heap out of memory"),
      stderr: Buffer.from(""),
    });
    const out = formatExecError(err);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).toContain("FATAL: capture worker OOM");
    expect(out).toContain("…truncated…");
  });

  it("não trunca erros curtos", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("small finding"),
    });
    const out = formatExecError(err);
    expect(out).toContain("small finding");
    expect(out).not.toContain("truncated");
  });

  it("keeps a non-zero check useful when stdout contains a tolerant network finding", () => {
    const envelope = extractCheckJson('check failed\n{"ok":false,"lint":{"ok":true},"layout":{"ok":true},"runtime":{"ok":false,"findings":[{"code":"request_failed","severity":"error","url":"https://fonts.googleapis.com/css2"}]}}');
    expect(classifyCheckEnvelope(envelope).ok).toBe(true);
  });

  it("does not downgrade a page error to a warning", () => {
    const envelope = extractCheckJson('{"ok":false,"lint":{"ok":true},"layout":{"ok":true},"runtime":{"ok":false,"findings":[{"code":"page_error","severity":"error","message":"ReferenceError"}]}}');
    expect(classifyCheckEnvelope(envelope).ok).toBe(false);
  });
});
