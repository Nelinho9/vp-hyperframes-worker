import { CompositionRevisionV1Schema, type CompositionRevisionV1 } from './compositionRevisionV1.ts';
import {
  CompositionPublicationError,
  type CompositionCommandRecord, type CompositionReceipt, type PublicationStore,
} from './compositionPublication.ts';

type Result = { data: unknown; error: unknown };
interface StorageBucket {
  download(path: string): PromiseLike<{ data: { text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null; error: unknown }>;
  upload(path: string, content: string, options: { upsert: false; contentType: string }): PromiseLike<Result>;
}
interface InsertBuilder {
  insert(row: Record<string, unknown>, options: { ignoreDuplicates: boolean }): unknown;
}
/** PostgREST update builder, normalized like InsertBuilder (C2 finishCommand). */
interface UpdateBuilder {
  update(patch: Record<string, unknown>): unknown;
}
/** PostgREST's recursive generic builders are normalized at a checked runtime boundary. */
export interface CompositionPublicationAdmin {
  from(table: string): unknown;
  storage: { from(bucket: string): StorageBucket };
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<Result>;
}

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const uuid = new RegExp(`^${UUID}$`, 'i');
const immutablePath = new RegExp(`^projects/${UUID}/composition-revisions/${UUID}/(?:index\\.html|elements\\.json)$`, 'i');
const sha256 = /^[a-f0-9]{64}$/;

function fail(code: string, message: string): never {
  throw new CompositionPublicationError(code, message, 502);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function queryMethod(builder: unknown, method: 'select' | 'eq' | 'maybeSingle', args: unknown[]): unknown {
  const callable = object(builder)?.[method];
  if (typeof callable !== 'function') return fail('PUBLICATION_READ_FAILED', `Publication query lacks ${method}`);
  return Reflect.apply(callable, builder, args);
}

async function readRow(admin: CompositionPublicationAdmin, table: string, columns: string, filters: Array<[string, string | number]>): Promise<Result> {
  let builder = queryMethod(admin.from(table), 'select', [columns]);
  for (const [column, value] of filters) builder = queryMethod(builder, 'eq', [column, value]);
  const row = object(await queryMethod(builder, 'maybeSingle', []));
  if (!row || !Object.prototype.hasOwnProperty.call(row, 'data') || !Object.prototype.hasOwnProperty.call(row, 'error')) {
    return fail('PUBLICATION_READ_FAILED', 'Invalid publication query response');
  }
  return { data: row.data, error: row.error };
}

function positiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
}

function validateReceipt(value: unknown, projectId: string, mutationId: string): CompositionReceipt {
  const row = object(value);
  // Identidade normalizada (governança, família N-K): linhas históricas com
  // grafia não-minúscula validam contra a mesma identidade.
  const normalizedId = mutationId.toLowerCase();
  if (!row || row.project_id !== projectId || String(row.mutation_id).toLowerCase() !== normalizedId
    || !positiveRevision(row.base_revision) || !positiveRevision(row.committed_revision)
    || row.committed_revision !== row.base_revision + 1 || row.registry_revision !== row.committed_revision) {
    return fail('PUBLICATION_READ_FAILED', 'Invalid durable publication receipt');
  }
  const parsed = CompositionRevisionV1Schema.safeParse({
    contract_version: 'composition.v1', project_id: row.project_id, revision: row.committed_revision,
    parent_revision: row.base_revision, content_hash: row.content_hash, sources: row.source_refs,
  });
  if (parsed.success === false) return fail('PUBLICATION_READ_FAILED', 'Invalid receipt composition identity');
  validatePair(parsed.data, normalizedId);
  return {
    project_id: projectId, mutation_id: normalizedId, base_revision: row.base_revision,
    committed_revision: row.committed_revision, content_hash: parsed.data.content_hash,
    registry_revision: row.registry_revision as number, source_refs: parsed.data.sources,
  };
}

function validatePair(candidate: CompositionRevisionV1, mutationId?: string): void {
  const html = candidate.sources.filter(source => source.kind === 'html');
  const registry = candidate.sources.filter(source => source.kind === 'registry');
  const prefix = `projects/${candidate.project_id}/composition-revisions/`;
  // Identidade normalizada (família N-K): o staging do publisher normaliza o
  // id — o suffixo compara na mesma grafia.
  const suffix = mutationId ? `${mutationId.toLowerCase()}/` : '';
  if (html.length !== 1 || registry.length !== 1 || html[0].sha256 !== candidate.content_hash
    || !immutablePath.test(html[0].storage_path) || !immutablePath.test(registry[0].storage_path)
    || !html[0].storage_path.startsWith(prefix + suffix)
    || !html[0].storage_path.endsWith('/index.html')
    || registry[0].storage_path !== html[0].storage_path.slice(0, -'index.html'.length) + 'elements.json') {
    fail('PUBLICATION_READ_FAILED', 'Published HTML and registry must share an immutable mutation identity');
  }
}

function isMissing(error: unknown): boolean {
  const row = object(error);
  return row?.status === 404 || row?.statusCode === 404 || row?.statusCode === '404';
}

const COMMAND_KINDS = new Set(['edit', 'undo', 'redo', 'restore']);
const COMMAND_SOURCES = new Set(['manual', 'chat', 'app']);
const COMMAND_STATES = new Set(['intent', 'committed', 'conflict', 'failed', 'cancelled']);

function parseCommandRow(value: unknown, projectId: string, mutationId?: string): CompositionCommandRecord | null {
  const row = object(value);
  const command = object(row?.command);
  if (!row || !command || row.project_id !== projectId
    || typeof row.mutation_id !== 'string' || typeof row.kind !== 'string' || typeof row.source !== 'string'
    || typeof row.state !== 'string' || !COMMAND_KINDS.has(row.kind) || !COMMAND_SOURCES.has(row.source)
    || !COMMAND_STATES.has(row.state) || typeof row.claim_token !== 'number'
    || (row.committed_revision !== null && !positiveRevision(row.committed_revision))
    || (row.base_revision !== null && !positiveRevision(row.base_revision))) {
    return null;
  }
  if (mutationId !== undefined && String(row.mutation_id).toLowerCase() !== mutationId.toLowerCase()) return null;
  if (row.undo_of_mutation_id !== null && typeof row.undo_of_mutation_id !== 'string') return null;
  if (row.undo_cycle !== null && !(typeof row.undo_cycle === 'number' && Number.isSafeInteger(row.undo_cycle) && row.undo_cycle >= 1)) return null;
  if (row.payload_hash !== null && typeof row.payload_hash !== 'string') return null;
  return {
    project_id: projectId, mutation_id: String(row.mutation_id).toLowerCase(),
    kind: row.kind as CompositionCommandRecord['kind'], source: row.source as CompositionCommandRecord['source'],
    state: row.state as CompositionCommandRecord['state'], claim_token: row.claim_token,
    base_revision: row.base_revision as number | null, committed_revision: row.committed_revision as number | null,
    payload_hash: row.payload_hash as string | null, undo_of_mutation_id: row.undo_of_mutation_id as string | null,
    undo_cycle: row.undo_cycle as number | null, command,
  };
}

/** Only commit_video_composition_revision_v1 can advance the authority; uploads are immutable stages. */
export function createCompositionPublicationStore(admin: CompositionPublicationAdmin): PublicationStore {
  const store: PublicationStore = {
    async readHead(projectId) {
      let result: Result;
      try { result = await readRow(admin, 'video_composition_heads', 'revision,composition', [['project_id', projectId]]); }
      catch { return fail('PUBLICATION_READ_FAILED', 'Could not read published composition head'); }
      if (result.error) return fail('PUBLICATION_READ_FAILED', 'Could not read published composition head');
      if (result.data === null) return null;
      const row = object(result.data);
      const parsed = CompositionRevisionV1Schema.safeParse(row?.composition);
      if (!row || parsed.success === false || parsed.data.project_id !== projectId || row.revision !== parsed.data.revision) {
        return fail('PUBLICATION_READ_FAILED', 'Invalid published composition head');
      }
      validatePair(parsed.data);
      return parsed.data;
    },
    async lookupReceipt(projectId, mutationId) {
      let result: Result;
      try { result = await readRow(admin, 'video_composition_receipts', 'payload_hash,receipt', [['project_id', projectId], ['mutation_id', mutationId]]); }
      catch { return fail('PUBLICATION_READ_FAILED', 'Could not read publication receipt'); }
      if (result.error) return fail('PUBLICATION_READ_FAILED', 'Could not read publication receipt');
      if (result.data === null) return null;
      const row = object(result.data);
      if (!row || typeof row.payload_hash !== 'string' || !sha256.test(row.payload_hash)) {
        return fail('PUBLICATION_READ_FAILED', 'Invalid publication payload identity');
      }
      return { payload_hash: row.payload_hash, receipt: validateReceipt(row.receipt, projectId, mutationId) };
    },
    async findReceiptByRevision(projectId, revision) {
      if (!positiveRevision(revision) || revision < 2) return null;
      let result: Result;
      try { result = await readRow(admin, 'video_composition_receipts', 'mutation_id,receipt', [['project_id', projectId], ['committed_revision', revision]]); }
      catch { return fail('PUBLICATION_READ_FAILED', 'Could not read publication receipt by revision'); }
      if (result.error) return fail('PUBLICATION_READ_FAILED', 'Could not read publication receipt by revision');
      if (result.data === null) return null;
      const row = object(result.data);
      if (!row || typeof row.mutation_id !== 'string') return fail('PUBLICATION_READ_FAILED', 'Invalid revision receipt lookup');
      return validateReceipt(row.receipt, projectId, row.mutation_id);
    },
    async readCommand(projectId, mutationId) {
      let result: Result;
      try { result = await readRow(admin, 'video_composition_commands', '*', [['project_id', projectId], ['mutation_id', mutationId]]); }
      catch { return fail('PUBLICATION_READ_FAILED', 'Could not read composition command journal'); }
      if (result.error) return fail('PUBLICATION_READ_FAILED', 'Could not read composition command journal');
      if (result.data === null) return null;
      const parsed = parseCommandRow(result.data, projectId, mutationId);
      if (!parsed) return fail('PUBLICATION_READ_FAILED', 'Invalid composition command journal row');
      return parsed;
    },
    async readUndoCommands(projectId, targetMutationId) {
      let builder = queryMethod(admin.from('video_composition_commands'), 'select', ['*']);
      builder = queryMethod(builder, 'eq', ['project_id', projectId]);
      builder = queryMethod(builder, 'eq', ['undo_of_mutation_id', targetMutationId]);
      const reply = object(await builder);
      if (!reply || !Object.prototype.hasOwnProperty.call(reply, 'data') || !Object.prototype.hasOwnProperty.call(reply, 'error')) {
        return fail('PUBLICATION_READ_FAILED', 'Invalid undo journal query response');
      }
      if (reply.error) return fail('PUBLICATION_READ_FAILED', 'Could not read undo journal rows');
      const rows = Array.isArray(reply.data) ? reply.data : [];
      const out: CompositionCommandRecord[] = [];
      for (const row of rows) {
        const parsed = parseCommandRow(row, projectId);
        if (!parsed) return fail('PUBLICATION_READ_FAILED', 'Invalid undo journal row');
        if (parsed.state === 'committed') out.push(parsed);
      }
      out.sort((a, b) => (b.undo_cycle ?? 0) - (a.undo_cycle ?? 0));
      return out;
    },
    async recordCommandIntent(input) {
      const existing = await store.readCommand(input.projectId, input.mutationId);
      if (existing) return existing;
      const row = {
        user_id: input.actorUserId, project_id: input.projectId, mutation_id: input.mutationId,
        kind: input.kind, source: input.source, state: 'intent',
        ...(input.payloadHash ? { payload_hash: input.payloadHash } : {}),
        ...(input.undoOfMutationId ? { undo_of_mutation_id: input.undoOfMutationId, undo_cycle: input.undoCycle } : {}),
        command: { kind: input.kind, source: input.source, ...(input.delta ? { delta: input.delta } : {}) },
      };
      try {
        const builder = (admin.from('video_composition_commands') as unknown as InsertBuilder)
          .insert(row, { ignoreDuplicates: true });
        const reply = object(await builder);
        if (reply?.error) return fail('PUBLICATION_READ_FAILED', 'Could not record composition command intent');
      } catch { return fail('PUBLICATION_READ_FAILED', 'Could not record composition command intent'); }
      // Concurrent insert or ignore-duplicates: the durable row wins.
      return await store.readCommand(input.projectId, input.mutationId);
    },
    async cancelCommand(actorUserId, projectId, mutationId) {
      let result: Result;
      try {
        result = await admin.rpc('cancel_video_composition_command_v1', {
          p_actor_user_id: actorUserId, p_project_id: projectId, p_mutation_id: mutationId,
        });
      } catch { return fail('PUBLICATION_READ_FAILED', 'Could not cancel composition command'); }
      if (result.error) return fail('PUBLICATION_READ_FAILED', 'Could not cancel composition command');
      const reply = object(result.data);
      const status = reply?.status;
      if (status === 'cancelled' || status === 'already_cancelled' || status === 'committed' || status === 'not_found') return status;
      return fail('PUBLICATION_READ_FAILED', 'Invalid cancel composition command response');
    },
    /**
     * C2 (E02/R08): termina um intent conhecido-como-falho. Guard ONLY
     * `intent → failed|conflict`; committed/cancelled ficam intocados. A razão
     * viaja no command.delta.failure para auditoria do lookup.
     */
    async finishCommand(input) {
      if (input.state !== 'failed' && input.state !== 'conflict') {
        return fail('PUBLICATION_READ_FAILED', 'finishCommand only terminates intents as failed/conflict');
      }
      const existing = await store.readCommand(input.projectId, input.mutationId);
      if (!existing) return null;
      if (existing.state !== 'intent') return existing;
      const reason = {
        code: input.code,
        ...(input.detail ? { detail: String(input.detail).slice(0, 500) } : {}),
        finished_at: new Date().toISOString(),
      };
      const priorCommand = object(existing.command) ?? {};
      const priorDelta = object(priorCommand.delta) ?? {};
      try {
        const update = (admin.from('video_composition_commands') as unknown as UpdateBuilder)
          .update({
            state: input.state,
            command: { ...priorCommand, delta: { ...priorDelta, failure: reason } },
            updated_at: new Date().toISOString(),
          });
        // C2/R08 (auditoria): o predicado `state='intent'` torna o guard
        // atómico — um commit/cancel concorrente que transite o estado entre
        // o read e o update deixa este UPDATE sem linhas (intocadas).
        const reply = object(await queryMethod(queryMethod(queryMethod(update, 'eq', ['project_id', input.projectId]), 'eq', ['mutation_id', input.mutationId]), 'eq', ['state', 'intent']));
        if (reply?.error) return fail('PUBLICATION_READ_FAILED', 'Could not finish composition command');
      } catch {
        return fail('PUBLICATION_READ_FAILED', 'Could not finish composition command');
      }
      return await store.readCommand(input.projectId, input.mutationId);
    },
    async readBytes(path) {
      try {
        const { data, error } = await admin.storage.from('video-artifacts').download(path);
        if (error) {
          if (isMissing(error)) return null;
          return fail('PUBLICATION_READ_FAILED', 'Could not read composition dependency');
        }
        if (!data) return fail('PUBLICATION_READ_FAILED', 'Composition dependency response has no data');
        return new Uint8Array(await data.arrayBuffer());
      } catch (error) {
        if (error instanceof CompositionPublicationError) throw error;
        return fail('PUBLICATION_READ_FAILED', 'Could not read composition dependency');
      }
    },
    async readText(path) {
      try {
        const { data, error } = await admin.storage.from('video-artifacts').download(path);
        if (error) {
          if (isMissing(error)) return null;
          return fail('PUBLICATION_READ_FAILED', 'Could not read composition artifact');
        }
        if (!data) return fail('PUBLICATION_READ_FAILED', 'Composition artifact response has no data');
        return await data.text();
      } catch (error) {
        if (error instanceof CompositionPublicationError) throw error;
        return fail('PUBLICATION_READ_FAILED', 'Could not read composition artifact');
      }
    },
    async stageText(path, content) {
      if (!immutablePath.test(path)) return fail('PUBLICATION_STAGE_FAILED', 'Staging requires an immutable composition path');
      try {
        const { error } = await admin.storage.from('video-artifacts').upload(path, content, {
          upsert: false,
          contentType: path.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        });
        if (!error) return;
      } catch { /* A timeout may arrive after a successful upload; verify its bytes below. */ }
      let stored: string | null;
      try { stored = await store.readText(path); }
      catch { return fail('PUBLICATION_STAGE_FAILED', 'Could not verify immutable composition stage'); }
      if (stored !== content) return fail('PUBLICATION_STAGE_FAILED', 'Immutable composition stage is missing or differs');
    },
    async commit(input) {
      const candidate = CompositionRevisionV1Schema.safeParse(input.candidate);
      if (!uuid.test(input.actorUserId) || !uuid.test(input.projectId) || !uuid.test(input.mutationId)
        || !sha256.test(input.payloadHash) || !positiveRevision(input.expectedRevision)
        || candidate.success === false || candidate.data.project_id !== input.projectId
        || candidate.data.revision !== input.expectedRevision + 1 || candidate.data.parent_revision !== input.expectedRevision) {
        return fail('PUBLICATION_COMMIT_FAILED', 'Invalid publication commit context');
      }
      validatePair(candidate.data, input.mutationId);
      const commandEnvelope = input.command
        ? {
          kind: input.command.kind, source: input.command.source,
          claim_token: input.command.claim_token ?? 1,
          ...(input.command.undo_of_mutation_id ? { undo_of_mutation_id: input.command.undo_of_mutation_id } : {}),
          ...(input.command.undo_cycle !== undefined ? { undo_cycle: input.command.undo_cycle } : {}),
          delta: input.command.delta,
        }
        : null;
      let result: Result;
      try {
        result = await admin.rpc(commandEnvelope ? 'commit_video_composition_command_v1' : 'commit_video_composition_revision_v1', {
          p_actor_user_id: input.actorUserId, p_project_id: input.projectId, p_mutation_id: input.mutationId,
          p_payload_hash: input.payloadHash, p_expected_revision: input.expectedRevision, p_candidate: candidate.data,
          ...(commandEnvelope ? { p_command: commandEnvelope } : {}),
        });
      } catch { return fail('PUBLICATION_COMMIT_FAILED', 'Could not commit published composition'); }
      if (result.error) return fail('PUBLICATION_COMMIT_FAILED', 'Could not commit published composition');
      const reply = object(result.data);
      if (!reply) return fail('PUBLICATION_COMMIT_FAILED', 'Invalid publication commit response');
      if (reply.status === 'identity_conflict' || reply.status === 'cancelled'
        || reply.status === 'fenced' || reply.status === 'undo_cycle_conflict') return { status: reply.status };
      if (reply.status === 'conflict' && positiveRevision(reply.current_revision)) {
        return { status: 'conflict', current_revision: reply.current_revision };
      }
      if (reply.status === 'committed' || reply.status === 'replay') {
        const receipt = validateReceipt(reply.receipt, input.projectId, input.mutationId);
        if (receipt.base_revision !== input.expectedRevision || receipt.content_hash !== candidate.data.content_hash
          || JSON.stringify(receipt.source_refs) !== JSON.stringify(candidate.data.sources)) {
          return fail('PUBLICATION_COMMIT_FAILED', 'Commit receipt differs from staged composition');
        }
        return { status: reply.status, receipt };
      }
      return fail('PUBLICATION_COMMIT_FAILED', 'Invalid publication commit response');
    },
  };
  return store;
}
