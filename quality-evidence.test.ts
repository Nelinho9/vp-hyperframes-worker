// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureQualityEvidence } from "./quality-evidence.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const SAMPLE_HTML = `<!doctype html><html><body>
  <div data-composition-id="root" data-width="1080" data-height="1920" data-duration="6">
    <div class="clip" data-start="0" data-duration="3"><h1>Cena 1</h1></div>
    <div class="clip" data-start="3" data-duration="3"><h1>Cena 2</h1></div>
  </div>
</body></html>`;

function makeMockSupabase(initialFiles: Record<string, Buffer | string> = {}) {
  const files = new Map<string, Buffer>(
    Object.entries(initialFiles).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, "utf8")]),
  );
  const uploads: Array<{ path: string; bytes: Buffer }> = [];
  const storageApi = {
    list: vi.fn(async (prefix: string) => {
      const clean = prefix.replace(/\/+$/, "") + "/";
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (!k.startsWith(clean)) continue;
        const rest = k.slice(clean.length);
        const seg = rest.split("/")[0];
        if (seg) names.add(seg);
      }
      return { data: [...names].map((name) => ({ name })), error: null };
    }),
    download: vi.fn(async (path: string) => {
      const buf = files.get(path);
      if (!buf) return { data: null, error: { message: "not found" } };
      return {
        data: {
          text: async () => buf.toString("utf8"),
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        },
        error: null,
      };
    }),
    upload: vi.fn(async (path: string, body: Buffer) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      files.set(path, buf);
      uploads.push({ path, bytes: buf });
      return { error: null };
    }),
  };
  return {
    supabase: { storage: { from: vi.fn(() => storageApi) } },
    files,
    uploads,
  };
}

describe("captureQualityEvidence (Opção A)", () => {
  it("captura snapshots leves e publica evidence-manifest complete com outputs=[]", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "vp-qev-work-"));
    const jobDir = join(workDir, "staged-job");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "index.html"), SAMPLE_HTML, "utf8");

    const { supabase, files, uploads } = makeMockSupabase();
    const spawnCommand = vi.fn(async (_cmd: string, args: string[]) => {
      const outIdx = args.indexOf("-o");
      expect(outIdx).toBeGreaterThan(-1);
      const outDir = args[outIdx + 1];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "frame-01-at-1.500s.png"), PNG_BYTES);
      writeFileSync(join(outDir, "frame-02-at-4.500s.png"), PNG_BYTES);
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    });

    try {
      const res = await captureQualityEvidence({
        projectId: PROJECT_ID,
        expectedRevision: 3,
        jobId: "job-recheck-1",
        supabase,
        compositionEditor: { ensurePreview: vi.fn(async () => ({ revision: 3, content_hash: "h".repeat(64) })) },
        resolveJobById: () => ({ id: "staged-job", job_dir: jobDir, revision: 3 }),
        workDir,
        spawnCommand,
      });

      expect(res.ok).toBe(true);
      expect(res.reused).toBe(false);
      expect(res.revision).toBe(3);
      expect(res.snapshots_count).toBe(2);
      expect(spawnCommand).toHaveBeenCalledTimes(1);

      const manifestBuf = files.get(res.manifest_path);
      expect(manifestBuf).toBeDefined();
      const manifest = JSON.parse(manifestBuf!.toString("utf8"));
      expect(manifest.step).toBe("quality-snapshot");
      expect(manifest.status).toBe("complete");
      expect(manifest.revision).toBe(3);
      expect(manifest.outputs).toEqual([]);
      expect(manifest.snapshots).toHaveLength(2);
      expect(uploads.some((u) => u.path.endsWith(".png"))).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("reutiliza evidence complete existente da mesma revisão sem lançar Chromium", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "vp-qev-reuse-"));
    const jobDir = join(workDir, "staged-job");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "index.html"), SAMPLE_HTML, "utf8");

    const existingPath = `projects/${PROJECT_ID}/evidence/j-old-r3/evidence-manifest.json`;
    const { supabase } = makeMockSupabase({
      [existingPath]: JSON.stringify({
        project_id: PROJECT_ID,
        job_id: "j-old",
        revision: 3,
        status: "complete",
        snapshots: [{ file: "frame-1.png", path: `projects/${PROJECT_ID}/evidence/j-old-r3/frame-1.png` }],
      }),
    });
    const spawnCommand = vi.fn();

    try {
      const res = await captureQualityEvidence({
        projectId: PROJECT_ID,
        expectedRevision: 3,
        supabase,
        compositionEditor: { ensurePreview: vi.fn(async () => ({ revision: 3 })) },
        resolveJobById: () => ({ id: "staged-job", job_dir: jobDir, revision: 3 }),
        workDir,
        spawnCommand,
      });

      expect(res.ok).toBe(true);
      expect(res.reused).toBe(true);
      expect(res.manifest_path).toBe(existingPath);
      expect(spawnCommand).not.toHaveBeenCalled();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("recusa com 409 quando revisão publicada diverge de expectedRevision", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "vp-qev-mismatch-"));
    const { supabase } = makeMockSupabase();
    try {
      await expect(
        captureQualityEvidence({
          projectId: PROJECT_ID,
          expectedRevision: 2,
          supabase,
          compositionEditor: { ensurePreview: vi.fn(async () => ({ revision: 4 })) },
          resolveJobById: () => null,
          workDir,
          spawnCommand: vi.fn(),
        }),
      ).rejects.toMatchObject({ code: "QUALITY_EVIDENCE_REVISION_MISMATCH", status: 409 });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("falha honestamente quando nenhum PNG é capturado", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "vp-qev-empty-"));
    const jobDir = join(workDir, "staged-job");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "index.html"), SAMPLE_HTML, "utf8");
    const { supabase } = makeMockSupabase();
    const spawnCommand = vi.fn(async () => ({ code: 0, timedOut: false, stdout: "", stderr: "" }));

    try {
      await expect(
        captureQualityEvidence({
          projectId: PROJECT_ID,
          expectedRevision: 3,
          supabase,
          compositionEditor: { ensurePreview: vi.fn(async () => ({ revision: 3 })) },
          resolveJobById: () => ({ id: "staged-job", job_dir: jobDir, revision: 3 }),
          workDir,
          spawnCommand,
        }),
      ).rejects.toMatchObject({ code: "QUALITY_EVIDENCE_NO_SNAPSHOTS", status: 502 });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
