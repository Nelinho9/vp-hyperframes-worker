/**
 * render-evidence.test.ts — F04-T08 worker (V5.34).
 *
 * Mesmo projeto com cinco snapshots seguido de dois usa set novo;
 * upload zero/parcial não reutiliza antigo; job/revision/hash correspondem.
 */
import { describe, expect, it } from "vitest";
import { buildCoverageSchedule, buildEvidenceManifest, evidenceSnapshotPath, evidenceStatus } from "./render-evidence.js";
import { evidenceSnapshotStoragePath } from "./snapshots-upload.js";

describe("worker render-evidence (F04-T08)", () => {
  it("namespace job/revision: sets diferentes não colidem", () => {
    const a = evidenceSnapshotPath({ projectId: "p", jobId: "job-a", revision: 4, file: "frame-1.png" });
    const b = evidenceSnapshotPath({ projectId: "p", jobId: "job-b", revision: 4, file: "frame-1.png" });
    expect(a).not.toBe(b);
    expect(evidenceSnapshotStoragePath("11111111-1111-4111-8111-111111111111", "job-a", 4, "frame-1.png"))
      .toBe("projects/11111111-1111-4111-8111-111111111111/evidence/job-a-r4/frame-1.png");
  });

  it("cinco snapshots seguidos de dois usam set novo (sem reutilizar antigo)", () => {
    const wins5 = Array.from({ length: 5 }, (_, i) => ({ id: `scene-${i + 1}`, start: i * 3, end: i * 3 + 3 }));
    const cov5 = buildCoverageSchedule({ windows: wins5, fps: 30 });
    const m5 = buildEvidenceManifest({
      jobId: "job-5", projectId: "p", step: "finalize", revision: 5, inputHash: "a".repeat(64),
      compositionHash: "b".repeat(64), effectiveConfigRevision: 1, effectiveConfigHash: "c".repeat(64),
      sceneIds: wins5.map((w) => w.id), boundaryIds: [], outputs: [{ name: "output.mp4", path: "projects/p/renders/output.mp4", mime: "video/mp4", size_bytes: 10, sha256: "d".repeat(64) }],
      snapshots: cov5.samples.slice(0, 5).map((s, i) => ({ file: `frame-${i + 1}.png`, scene_id: s.scene_id, time_s: s.time_s, sha256: "e".repeat(64) })),
      coverage: { total_windows: 5, sampled: 5, skipped: [], missing: [] },
    });
    expect(m5.status).toBe("complete");
    const wins2 = wins5.slice(0, 2);
    const cov2 = buildCoverageSchedule({ windows: wins2, fps: 30 });
    const m2 = buildEvidenceManifest({
      jobId: "job-2", projectId: "p", step: "finalize", revision: 6, inputHash: "a".repeat(64),
      compositionHash: "f".repeat(64), effectiveConfigRevision: 1, effectiveConfigHash: "c".repeat(64),
      sceneIds: wins2.map((w) => w.id), boundaryIds: [], outputs: [],
      snapshots: [], coverage: { total_windows: 2, sampled: 0, skipped: [], missing: ["no-snapshots-captured"] },
    });
    expect(m2.status).toBe("partial");
    expect(m2.composition_hash).not.toBe(m5.composition_hash);
    expect(evidenceStatus(m2)).toBe("partial");
  });

  it("upload zero/parcial não promove set antigo", () => {
    expect(evidenceStatus({ outputs: [], coverage: { missing: [] } })).toBe("partial");
    expect(evidenceStatus({ outputs: [{ name: "o" }], coverage: { missing: ["x"] } })).toBe("partial");
    expect(evidenceStatus({ outputs: [{ name: "o" }], coverage: { missing: [] } })).toBe("complete");
  });

  it("opção A F12-voz: media_prestage no manifest, sem tokens", () => {
    const outcomes = [{ url: "https://cdn.example.com/a.wav", tag: "audio", ok: true, ms: 12, kind: "wav", duration_s: 2.5 }];
    const m = buildEvidenceManifest({ jobId: "j", projectId: "p", step: "build", revision: 1, mediaPrestage: { outcomes } });
    expect(m.media_prestage).toEqual({ outcomes });
    expect(JSON.stringify(m)).not.toContain("token=");
    const def = buildEvidenceManifest({ jobId: "j", projectId: "p", step: "build", revision: 1 });
    expect(def.media_prestage).toBeNull();
  });
});
