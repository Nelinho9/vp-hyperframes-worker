/**
 * exec-error.test.ts — V4-3f.7: formatExecError surfaces lint findings
 *
 * Regression guard for the opaque "Command failed: npx hyperframes lint"
 * errors: execSync failures carry stdout/stderr Buffers which must be
 * included in the job error sent to the orchestrator callback.
 */
import { describe, it, expect } from "vitest";
import { formatExecError } from "./server.js";

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
});
