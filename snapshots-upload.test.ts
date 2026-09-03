/**
 * snapshots-upload.test.ts — V5-P6A (S24): persistRenderSnapshots
 *
 * Contrato: renomeia os PNGs de {jobDir}/snapshots/ para o path determinístico
 * projects/{id}/snapshots/frame-N.png (upsert), ordenação numérica, máx 5,
 * skip honesto (sem supabase / project id não-UUID / dir ausente) e upload
 * parcial quando um dos uploads falha (nunca fatal).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { persistRenderSnapshots, snapshotStoragePath, MAX_RENDER_SNAPSHOTS } from "./snapshots-upload.js";

const UUID = "11111111-2222-4333-8444-555555555555";

function makeFakeSupabase(failOnceAtAttempt = -1) {
  const uploads: Array<{ path: string; contentType?: string; upsert?: boolean; size: number }> = [];
  let attempt = 0;
  const supabase = {
    storage: {
      from: (_bucket: string) => ({
        upload: async (path: string, body: Uint8Array, opts: { contentType?: string; upsert?: boolean }) => {
          const thisAttempt = attempt++;
          if (thisAttempt === failOnceAtAttempt) {
            return { error: { message: "bucket unavailable" } };
          }
          uploads.push({ path, contentType: opts?.contentType, upsert: opts?.upsert, size: body.byteLength });
          return { error: null };
        },
      }),
    },
  };
  return { supabase, uploads };
}

function makeJobDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vp-snapshots-"));
  mkdirSync(join(dir, "snapshots"), { recursive: true });
  // PNG mínimo (assinatura) — só interessa o byte count para o teste.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  for (const f of files) writeFileSync(join(dir, "snapshots", f), png);
  return dir;
}

describe("persistRenderSnapshots — V5-P6A", () => {
  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  it("publica até 5 snapshots com paths frame-N.png, upsert + image/png, ordem numérica", async () => {
    const jobDir = makeJobDir(["frame_at_10.png", "frame_at_2.png", "frame_at_1.png", "notes.txt"]);
    const { supabase, uploads } = makeFakeSupabase();
    const published = await persistRenderSnapshots(supabase as never, UUID, jobDir, log);

    expect(published).toBe(3);
    expect(uploads.map((u) => u.path)).toEqual([
      snapshotStoragePath(UUID, 1),
      snapshotStoragePath(UUID, 2),
      snapshotStoragePath(UUID, 3),
    ]);
    expect(uploads.every((u) => u.contentType === "image/png" && u.upsert === true && u.size === 4)).toBe(true);
    rmSync(jobDir, { recursive: true, force: true });
  });

  it("limita a MAX_RENDER_SNAPSHOTS (=5)", async () => {
    const files = Array.from({ length: 9 }, (_, i) => `shot_${i + 1}.png`);
    const jobDir = makeJobDir(files);
    const { supabase, uploads } = makeFakeSupabase();
    const published = await persistRenderSnapshots(supabase as never, UUID, jobDir, log);
    expect(MAX_RENDER_SNAPSHOTS).toBe(5);
    expect(published).toBe(5);
    expect(uploads).toHaveLength(5);
    rmSync(jobDir, { recursive: true, force: true });
  });

  it("skip sem supabase / id não-UUID / dir ausente (honesto, sem throw)", async () => {
    await expect(persistRenderSnapshots(null, UUID, "/tmp/x", log)).resolves.toBe(0);
    const { supabase } = makeFakeSupabase();
    await expect(persistRenderSnapshots(supabase as never, "preview-proj", "/tmp/x", log)).resolves.toBe(0);
    const failures: string[] = [];
    await expect(
      persistRenderSnapshots(
        supabase as never,
        UUID,
        join(tmpdir(), "nao-existe"),
        log,
        (message) => failures.push(message),
      ),
    ).resolves.toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeTruthy();
  });

  it("falha num upload não é fatal: publica o resto (parcial)", async () => {
    const jobDir = makeJobDir(["a.png", "b.png", "c.png"]);
    const { supabase, uploads } = makeFakeSupabase(1); // 2.ª tentativa falha (uma vez)
    const failures: string[] = [];
    const published = await persistRenderSnapshots(
      supabase as never,
      UUID,
      jobDir,
      log,
      (message) => failures.push(message),
    );
    expect(published).toBe(2);
    // O que falhou era frame-2; o 3.º ficheiro ocupa o próximo slot livre.
    expect(uploads.map((u) => u.path)).toEqual([snapshotStoragePath(UUID, 1), snapshotStoragePath(UUID, 2)]);
    expect(logs.some((l) => l.includes("upload failed"))).toBe(true);
    expect(failures).toEqual(["bucket unavailable"]);
    rmSync(jobDir, { recursive: true, force: true });
  });

  it("dir vazio → 0 com log", async () => {
    const jobDir = makeJobDir([]);
    const { supabase } = makeFakeSupabase();
    const published = await persistRenderSnapshots(supabase as never, UUID, jobDir, log);
    expect(published).toBe(0);
    expect(logs.some((l) => l.includes("no snapshot pngs"))).toBe(true);
    rmSync(jobDir, { recursive: true, force: true });
  });
});
