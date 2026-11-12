import { CompositionRevisionV1Schema, type CompositionRevisionV1 } from './compositionRevisionV1.ts';
export type { CompositionRevisionV1 } from './compositionRevisionV1.ts';

export interface CompositionReceipt {
  mutation_id: string;
  project_id: string;
  base_revision: number;
  committed_revision: number;
  content_hash: string;
  registry_revision: number;
  source_refs: CompositionRevisionV1['sources'];
}

/** Journal trail associated with a publication (E01-B). Service-computed. */
export interface CompositionCommandJournal {
  kind: 'edit' | 'undo' | 'redo' | 'restore';
  source: 'manual' | 'chat' | 'app';
  claim_token?: number;
  undo_of_mutation_id?: string;
  undo_cycle?: number;
  delta: Record<string, unknown>;
}

export interface PublicationStore {
  readHead(projectId: string): Promise<CompositionRevisionV1 | null>;
  lookupReceipt(projectId: string, mutationId: string): Promise<{ payload_hash: string; receipt: CompositionReceipt } | null>;
  readText(path: string): Promise<string | null>;
  /** Binary dependency verification. No UTF-8 decoding of audio/assets. */
  readBytes?(path: string): Promise<Uint8Array | null>;
  stageText(path: string, content: string): Promise<void>;
  /** Committed undo journal rows targeting `targetMutationId`, newest first. */
  readUndoCommands(projectId: string, targetMutationId: string): Promise<CompositionCommandRecord[]>;
  /** Journal row for (project, mutation): intent audit; head/receipt stay authority. */
  readCommand(projectId: string, mutationId: string): Promise<CompositionCommandRecord | null>;
  /** Idempotent intent insert before execution; keeps an existing row untouched. */
  recordCommandIntent(input: CompositionCommandIntent): Promise<CompositionCommandRecord | null>;
  /**
   * C2 (E02/R08): termina um intent que falhou de forma CONHECIDA antes do
   * commit (provider 402, fit falhado, verificação de bytes, assinatura) —
   * o lookup deixa de reportar pending. Só aceita `failed`/`conflict` e só a
   * partir de `intent`; um row committed/cancelled nunca é reescrito.
   */
  finishCommand?(input: { projectId: string; mutationId: string; state: 'failed' | 'conflict'; code: string; detail?: string }): Promise<CompositionCommandRecord | null>;
  /** Durable cancel: wins only before commit; bumps the fencing claim token. */
  cancelCommand(actorUserId: string, projectId: string, mutationId: string): Promise<'cancelled' | 'already_cancelled' | 'committed' | 'not_found'>;
  /** Receipt revision lookup for restore: unique (project, committed_revision). */
  findReceiptByRevision(projectId: string, revision: number): Promise<CompositionReceipt | null>;
  commit(input: {
    actorUserId: string; projectId: string; mutationId: string; payloadHash: string;
    expectedRevision: number; candidate: CompositionRevisionV1; command?: CompositionCommandJournal;
  }): Promise<CommitOutcome>;
}

export interface CompositionCommandRecord {
  project_id: string;
  mutation_id: string;
  kind: 'edit' | 'undo' | 'redo' | 'restore';
  source: 'manual' | 'chat' | 'app';
  state: 'intent' | 'committed' | 'conflict' | 'failed' | 'cancelled';
  claim_token: number;
  base_revision: number | null;
  committed_revision: number | null;
  payload_hash: string | null;
  undo_of_mutation_id: string | null;
  undo_cycle: number | null;
  command: Record<string, unknown>;
}

export interface CompositionCommandIntent {
  actorUserId: string; projectId: string; mutationId: string;
  kind: CompositionCommandJournal['kind']; source: CompositionCommandJournal['source'];
  payloadHash?: string; undoOfMutationId?: string; undoCycle?: number; delta?: Record<string, unknown>;
}

export type CommitOutcome =
  | { status: 'committed' | 'replay'; receipt: CompositionReceipt }
  | { status: 'conflict'; current_revision: number }
  | { status: 'identity_conflict' | 'cancelled' | 'fenced' | 'undo_cycle_conflict' };

export class CompositionPublicationError extends Error {
  // Campos explícitos (sem parameter properties) — sintaxe erasable para o
  // type stripping nativo do Node no worker vendado (F2, plano v2).
  public code: string;
  public status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = 'CompositionPublicationError';
    this.code = code;
    this.status = status;
  }
}

import { sha256Hex } from './sha256.ts';

/** Shared by publisher and readers, in Node tests and Deno production.
 *  Fonte única em `_shared/sha256.ts` (governança 02.5: `sha256Hex` ≡
 *  `compositionSha256` eram a mesma regra em dois módulos). */
export const compositionSha256 = sha256Hex;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stableValue(v)]));
  }
  return value;
}

export function compositionPayloadHash(payload: unknown): Promise<string> {
  return compositionSha256(JSON.stringify(stableValue(payload)));
}

/** Stable UUID for a batch/operation identity; callers retain the seed on retries. */
export async function compositionMutationId(seed: string): Promise<string> {
  const hash = await compositionSha256(seed);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function withCompositionRevision<T extends { metadata?: unknown; manifest?: unknown }>(project: T, revision: number): T {
  const manifest = project.manifest && typeof project.manifest === 'object' ? project.manifest as Record<string, unknown> : {};
  return { ...project, metadata: { ...project.metadata as object, composition_revision: revision },
    manifest: { ...manifest, metadata: { ...manifest.metadata as object, composition_revision: revision } } };
}

export function legacyCompositionRevision(project: { metadata?: unknown; manifest?: unknown }): number {
  const metadata = project.metadata as Record<string, unknown> | null;
  const manifest = project.manifest as { metadata?: Record<string, unknown>; composition_revision?: unknown } | null;
  for (const revision of [metadata?.composition_revision, manifest?.metadata?.composition_revision, manifest?.composition_revision]) {
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 1) return revision;
  }
  return 1;
}

export async function readPublishedArtifact(
  store: PublicationStore, head: CompositionRevisionV1, kind: 'html' | 'registry',
): Promise<string> {
  const parsed = CompositionRevisionV1Schema.safeParse(head);
  if (!parsed.success) throw new CompositionPublicationError('PUBLICATION_READ_FAILED', 'Invalid published composition identity', 502);
  const refs = parsed.data.sources.filter(source => source.kind === kind);
  if (refs.length !== 1) throw new CompositionPublicationError('PUBLICATION_READ_FAILED', `Published ${kind} reference missing or ambiguous`, 502);
  const text = await store.readText(refs[0].storage_path);
  if (text === null || await compositionSha256(text) !== refs[0].sha256
    || (kind === 'html' && refs[0].sha256 !== head.content_hash)) {
    throw new CompositionPublicationError('PUBLICATION_READ_FAILED', `Published ${kind} missing or hash mismatch`, 502);
  }
  return text;
}

export async function readPublishedComposition(store: PublicationStore, projectId: string, legacyRevision = 1) {
  const head = await store.readHead(projectId);
  if (head) {
    if (head.project_id !== projectId) throw new CompositionPublicationError('PUBLICATION_READ_FAILED', 'Published composition belongs to another project', 502);
    const [html, registry] = await Promise.all([readPublishedArtifact(store, head, 'html'), readPublishedArtifact(store, head, 'registry')]);
    return { head, revision: head.revision, html, registry };
  }
  const html = await store.readText(`projects/${projectId}/compositions/index.html`);
  if (!html) throw new CompositionPublicationError('NO_COMPOSITION', 'Composition not found', 409);
  const registry = await store.readText(`projects/${projectId}/compositions/elements.json`);
  return { head: null, revision: legacyRevision, html, registry };
}

export interface PreparedComposition {
  prepared: true;
  html: string;
  elements: { revision: number; elements: unknown[]; [key: string]: unknown };
  applied: number;
}

export interface PublishCompositionInput {
  actorUserId: string;
  projectId: string;
  mutationId: string;
  expectedRevision: number;
  legacyRevision?: number;
  payload: unknown;
  expectedApplied?: number;
  /** Restore supplies historical refs; normal edits retain current refs. */
  dependencyRefs?: CompositionRevisionV1['sources'];
  /**
   * Journal extension (E01-B): recorded atomically with head+receipt.
   * A function form is resolved after prepare() and before commit, so the
   * delta can embed the write-set read by the worker during preparation.
   */
  command?: CompositionCommandJournal | (() => CompositionCommandJournal | undefined);
  prepare(html: string, candidateRevision: number): Promise<PreparedComposition>;
  activate?(receipt: CompositionReceipt, html: string): Promise<void>;
}

/** Only the SQL store moves the head. Storage stages and preview activation cannot commit. */
export async function publishComposition(store: PublicationStore, input: PublishCompositionInput) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.mutationId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new CompositionPublicationError('PUBLICATION_CONTEXT_REQUIRED', 'A mutation UUID and expected revision are required', 428);
  }
  // Governança (raiz da revisão — família N-K): a identidade da mutação
  // normaliza-se NA FRONTEIRA. O storage de áudio já normalizava; a raiz
  // `composition-revisions/{id}` e as receipts ficavam verbatim, pelo que o
  // mesmo UUID em duas grafias (o /apply aceita regex case-insensitive) dava
  // duas identities para um só namespace. Ids minúsculos (todos os derivados
  // em produção) ficam byte-a-byte idênticos.
  input = { ...input, mutationId: input.mutationId.toLowerCase() };
  const payloadHash = await compositionPayloadHash({ project_id: input.projectId, expected_revision: input.expectedRevision, payload: input.payload });
  const replay = await store.lookupReceipt(input.projectId, input.mutationId);
  if (replay && replay.payload_hash !== payloadHash) {
    throw new CompositionPublicationError('MUTATION_ID_CONFLICT', 'Mutation identity already used for different content');
  }
  let receipt: CompositionReceipt;
  let html: string;
  let replayed = false;
  if (replay) {
    receipt = replay.receipt;
    const snapshot: CompositionRevisionV1 = {
      contract_version: 'composition.v1', project_id: input.projectId,
      revision: receipt.committed_revision, parent_revision: receipt.base_revision,
      content_hash: receipt.content_hash, sources: receipt.source_refs,
    };
    html = await readPublishedArtifact(store, snapshot, 'html');
    await readPublishedArtifact(store, snapshot, 'registry');
    replayed = true;
  } else {
    const base = await readPublishedComposition(store, input.projectId, input.legacyRevision);
    if (base.revision !== input.expectedRevision) {
      throw new CompositionPublicationError('REVISION_CONFLICT', `Composition revision changed to ${base.revision}`);
    }
    const revision = base.revision + 1;
    const prepared = await input.prepare(base.html, revision);
    if (prepared.prepared !== true || typeof prepared.html !== 'string' || !prepared.html
      || !prepared.elements || prepared.elements.version !== 2 || prepared.elements.revision !== revision || !Array.isArray(prepared.elements.elements)
      || prepared.elements.elements.some(element => !element || typeof element !== 'object' || (element as { revision?: unknown }).revision !== revision)
      || !Number.isInteger(prepared.applied)) {
      throw new CompositionPublicationError('INVALID_PREPARED_COMPOSITION', 'Worker must prepare coherent HTML and a versioned registry without side effects', 502);
    }
    // A caller that declares the expected count gets the honest 422 when the
    // engine skipped an operation (e.g. a worker without `element:insert`):
    // that is a recoverable precondition, not a corrupted preparation. Keep
    // the stricter 502 for callers that do not declare it.
    if (input.expectedApplied !== undefined && prepared.applied !== input.expectedApplied) {
      throw new CompositionPublicationError('INCOMPLETE_PREPARED_EDIT', 'Not all requested edits were prepared', 422);
    }
    if (prepared.applied < 1) {
      throw new CompositionPublicationError('INVALID_PREPARED_COMPOSITION', 'Worker must prepare coherent HTML and a versioned registry without side effects', 502);
    }
    html = prepared.html;
    const registry = JSON.stringify(prepared.elements);
    const resolvedCommand = typeof input.command === 'function' ? input.command() : input.command;
    const prefix = `projects/${input.projectId}/composition-revisions/${input.mutationId}`;
    const [contentHash, registryHash] = await Promise.all([compositionSha256(html), compositionSha256(registry)]);
    const dependencies = (input.dependencyRefs ?? base.head?.sources ?? []).filter(s => s.kind !== 'html' && s.kind !== 'registry');
    for (const source of dependencies) {
      const bytes = await store.readBytes?.(source.storage_path);
      if (!bytes || await compositionSha256(bytes) !== source.sha256) {
        throw new CompositionPublicationError('RESTORE_MEDIA_UNAVAILABLE', 'Composition dependency is missing or fails its byte hash', 409);
      }
    }
    const candidate = CompositionRevisionV1Schema.parse({
      contract_version: 'composition.v1', project_id: input.projectId, revision, parent_revision: base.revision,
      content_hash: contentHash, sources: [
        { kind: 'html', storage_path: `${prefix}/index.html`, sha256: contentHash },
        { kind: 'registry', storage_path: `${prefix}/elements.json`, sha256: registryHash },
        ...dependencies,
      ],
    });
    await store.stageText(candidate.sources[0].storage_path, html);
    await store.stageText(candidate.sources[1].storage_path, registry);
    let committed: CommitOutcome;
    try {
      committed = await store.commit({
        actorUserId: input.actorUserId, projectId: input.projectId, mutationId: input.mutationId,
        payloadHash, expectedRevision: input.expectedRevision, candidate,
        ...(resolvedCommand ? { command: resolvedCommand } : {}),
      });
    } catch (error) {
      // A network timeout is not rollback. Recover the durable result before retrying.
      const recovered = await store.lookupReceipt(input.projectId, input.mutationId);
      if (!recovered || recovered.payload_hash !== payloadHash) throw error;
      committed = { status: 'replay', receipt: recovered.receipt };
    }
    if (committed.status === 'conflict') throw new CompositionPublicationError('REVISION_CONFLICT', `Composition revision changed to ${committed.current_revision}`);
    if (committed.status === 'identity_conflict') throw new CompositionPublicationError('MUTATION_ID_CONFLICT', 'Mutation identity already used for different content');
    if (committed.status === 'cancelled') throw new CompositionPublicationError('COMMAND_CANCELLED', 'Command was durably cancelled before commit', 409);
    if (committed.status === 'fenced') throw new CompositionPublicationError('COMMAND_FENCED', 'Command claim was superseded by a newer runner', 409);
    if (committed.status === 'undo_cycle_conflict') throw new CompositionPublicationError('UNDO_CYCLE_CONFLICT', 'This action was already undone by another command', 409);
    if (committed.status !== 'committed' && committed.status !== 'replay') throw new CompositionPublicationError('PUBLICATION_COMMIT_FAILED', 'Publication returned no durable receipt', 502);
    if (!committed.receipt) throw new CompositionPublicationError('PUBLICATION_COMMIT_FAILED', 'Publication returned no durable receipt', 502);
    if (committed.receipt.content_hash !== candidate.content_hash
      || committed.receipt.committed_revision !== candidate.revision) {
      throw new CompositionPublicationError('PUBLICATION_COMMIT_FAILED', 'Commit differs from the prepared revision', 502);
    }
    receipt = committed.receipt;
    replayed = committed.status === 'replay';
  }
  let previewSync: 'synced' | 'pending' | 'not_requested' = 'not_requested';
  // An old replay must not reactivate an older preview or invalidate current projections.
  const currentHead = replayed ? await store.readHead(input.projectId) : null;
  if (input.activate && (!replayed || currentHead?.revision === receipt.committed_revision)) {
    try { await input.activate(receipt, html); previewSync = 'synced'; }
    catch { previewSync = 'pending'; }
  }
  return { ...receipt, persisted: true as const, persisted_elements: true as const, replayed, preview_sync: previewSync };
}
