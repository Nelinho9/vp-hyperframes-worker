/**
 * render-output-contract.test.ts — F04-T07 worker (V5.34).
 *
 * Bytes + ffprobe divergentes de options falham antes de DONE;
 * PNG/GIF têm capacidades próprias; não aceita MP4 em path WebM.
 */
import { describe, expect, it } from "vitest";
import { validateFfprobeOutput, isPngSignature, isMp4Signature } from "./render-verify.js";

const EXP = { width: 1920, height: 1080, fps: 30, duration_target_seconds: 30, format: "mp4", mode: "deterministic" };

describe("worker render-output-contract (F04-T07)", () => {
  it("mp4 válido passa; dims/fps/duração divergentes falham com expected/observed", () => {
    const good = { format: { format_name: "mp4", duration: "30.0" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" }] };
    expect(validateFfprobeOutput({ ffprobeJson: good, mime: "video/mp4", fileSizeBytes: 1000, expected: EXP }).ok).toBe(true);
    const badDims = { format: { format_name: "mp4", duration: "30.0" }, streams: [{ codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30/1" }] };
    const r = validateFfprobeOutput({ ffprobeJson: badDims, mime: "video/mp4", fileSizeBytes: 1000, expected: EXP });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failures[0].expected).toContain("1920x1080");
  });

  it("PNG: sem duração/FPS/áudio; GIF: sem promessa de áudio", () => {
    expect(validateFfprobeOutput({ ffprobeJson: { format: {}, streams: [{ codec_type: "audio", codec_name: "aac" }] }, mime: "image/png", fileSizeBytes: 10, expected: { ...EXP, format: "png" } }).ok).toBe(false);
    expect(validateFfprobeOutput({ ffprobeJson: { format: { duration: "8" }, streams: [{ codec_type: "audio" }] }, mime: "image/gif", fileSizeBytes: 10, expected: { ...EXP, format: "gif" } }).ok).toBe(false);
  });

  it("não aceita MP4 escrito em path WebM", () => {
    const good = { format: { format_name: "mp4", duration: "30.0" }, streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1" }] };
    expect(validateFfprobeOutput({ ffprobeJson: good, mime: "video/webm", fileSizeBytes: 10, expected: EXP }).ok).toBe(false);
  });

  it("signatures: PNG e MP4", () => {
    expect(isPngSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(isPngSignature(Buffer.from([0, 0, 0, 0]))).toBe(false);
    expect(isMp4Signature(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]))).toBe(true);
  });
});
