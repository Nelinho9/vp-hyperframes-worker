import { CompositionPublicationError, readPublishedArtifact, type PublicationStore } from '../_shared/compositionPublication.ts';

/** A report must not inspect current registry against snapshots of another revision. */
export async function readQualityCompositionRegistry(store: PublicationStore, projectId: string, evidenceRevision: number): Promise<string | null> {
  const head = await store.readHead(projectId);
  if (head && (head.project_id !== projectId || head.revision !== evidenceRevision)) {
    throw new CompositionPublicationError('QUALITY_COMPOSITION_REVISION_MISMATCH',
      'Published composition does not match the rendered evidence revision', 409);
  }
  const registry = head
    ? await readPublishedArtifact(store, head, 'registry')
    : await store.readText(`projects/${projectId}/compositions/elements.json`);
  if (registry !== null && new TextEncoder().encode(registry).byteLength > 1024 * 1024) {
    throw new CompositionPublicationError('QUALITY_TEXT_TOO_LARGE', 'Published quality context exceeds the text limit', 413);
  }
  return registry;
}
