// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compositionStoragePath, persistCompositionArtifact } from './composition-persist.js';

/** Minimal fake of the supabase-js storage surface used by the module. */
function makeClient(err: { message: string } | null, calls: Array<Record<string, unknown>>) {
  return {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: unknown, opts: unknown) => {
          calls.push({ bucket, path, body, opts });
          return err ? { error: err } : { error: null };
        },
      }),
    },
  };
}

describe('compositionStoragePath', () => {
  it('devolve o caminho canónico da composição', () => {
    expect(compositionStoragePath('p1')).toBe('projects/p1/compositions/index.html');
  });
});

describe('persistCompositionArtifact', () => {
  const UUID = 'daca85b4-0724-4d71-95b1-a72f92ee791b';
  const HTML = '<html><body>composition</body></html>';

  it('sem cliente Supabase devolve false (worker sem creds)', async () => {
    await expect(persistCompositionArtifact(null, UUID, HTML)).resolves.toBe(false);
  });

  it('salta project ids não-UUID (jobs internos/testes)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(persistCompositionArtifact(makeClient(null, calls), 'preview-p1', HTML)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('salta html vazio', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(persistCompositionArtifact(makeClient(null, calls), UUID, '')).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('faz upsert em video-artifacts com contentType text/html e devolve true', async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(persistCompositionArtifact(makeClient(null, calls), UUID, HTML)).resolves.toBe(true);
    expect(calls).toEqual([
      {
        bucket: 'video-artifacts',
        path: `projects/${UUID}/compositions/index.html`,
        body: HTML,
        opts: { contentType: 'text/html', upsert: true },
      },
    ]);
  });

  it('erro do storage devolve false sem lançar (fire-and-forget)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    await expect(
      persistCompositionArtifact(
        makeClient({ message: 'new row violates row-level security policy' }, calls),
        UUID,
        HTML,
        () => {},
        (message) => failures.push(message),
      ),
    ).resolves.toBe(false);
    expect(failures).toEqual(['new row violates row-level security policy']);
  });
});
