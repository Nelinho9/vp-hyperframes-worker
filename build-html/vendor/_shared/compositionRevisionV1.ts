import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const storagePath = z.string().min(1).max(1024).refine(
  value => !value.startsWith('/') && !value.includes('\\') && !/[?#:]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
  'Expected a canonical relative Storage path, without credentials or traversal',
);

export const CompositionSourceRefV1Schema = z.object({
  storage_path: storagePath,
  sha256,
  kind: z.enum(['html', 'registry', 'config', 'asset', 'audio']),
}).strict();

/** Prepared C5 protocol. Publication/CAS and adoption by editing belong to F06. */
export const CompositionRevisionV1Schema = z.object({
  contract_version: z.literal('composition.v1'),
  project_id: z.string().uuid(),
  revision: z.number().int().positive(),
  parent_revision: z.number().int().positive().nullable(),
  content_hash: sha256,
  sources: z.array(CompositionSourceRefV1Schema).min(1).max(512),
}).strict().superRefine((value, context) => {
  if (value.parent_revision !== null && value.parent_revision >= value.revision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['parent_revision'], message: 'Parent must precede revision' });
  }
  const prefix = `projects/${value.project_id}/`;
  const paths = value.sources.map(source => source.storage_path);
  if (paths.some(path => !path.startsWith(prefix)) || new Set(paths).size !== paths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'Sources must be unique and project scoped' });
  }
  if (!value.sources.some(source => source.kind === 'html')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['sources'], message: 'Canonical HTML source required' });
  }
});

export const PatchOperationV1Schema = z.discriminatedUnion('op', [
  z.object({ op_id: z.string().uuid(), op: z.literal('set_text'), target_id: z.string().min(1).max(200), value: z.string().max(20000) }).strict(),
  z.object({ op_id: z.string().uuid(), op: z.literal('set_property'), target_id: z.string().min(1).max(200), property: z.string().min(1).max(100), value: z.string().max(20000) }).strict(),
  z.object({ op_id: z.string().uuid(), op: z.literal('remove'), target_id: z.string().min(1).max(200) }).strict(),
]);

export const PatchRequestV1Schema = z.object({
  contract_version: z.literal('patch.v1'),
  mutation_id: z.string().uuid(),
  project_id: z.string().uuid(),
  expected_revision: z.number().int().positive(),
  ops: z.array(PatchOperationV1Schema).min(1).max(100),
}).strict().refine(value => new Set(value.ops.map(op => op.op_id)).size === value.ops.length, 'Duplicate operation identity');

export const PatchResultV1Schema = z.object({
  contract_version: z.literal('patch-result.v1'),
  mutation_id: z.string().uuid(),
  project_id: z.string().uuid(),
  persisted: z.boolean(),
  committed_revision: z.number().int().positive().nullable(),
  content_hash: sha256.nullable(),
  registry_revision: z.number().int().positive().nullable(),
  source_refs: z.array(CompositionSourceRefV1Schema).max(512),
  results: z.array(z.object({ op_id: z.string().uuid(), status: z.enum(['applied', 'failed', 'conflict']), error_code: z.string().max(100).optional() }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.persisted && (value.committed_revision === null || value.content_hash === null
    || value.registry_revision !== value.committed_revision || !value.source_refs.some(source => source.kind === 'html'))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['persisted'], message: 'Persisted requires coherent committed source and registry identity' });
  }
  if (!value.persisted && (value.committed_revision !== null || value.content_hash !== null || value.registry_revision !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['persisted'], message: 'A draft cannot claim a committed revision' });
  }
  if (value.source_refs.some(source => !source.storage_path.startsWith(`projects/${value.project_id}/`))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['source_refs'], message: 'Source belongs to another project' });
  }
  if (new Set(value.source_refs.map(source => source.storage_path)).size !== value.source_refs.length
    || new Set(value.results.map(result => result.op_id)).size !== value.results.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate source or operation identity' });
  }
});

export type CompositionRevisionV1 = z.infer<typeof CompositionRevisionV1Schema>;
export type PatchRequestV1 = z.infer<typeof PatchRequestV1Schema>;
export type PatchResultV1 = z.infer<typeof PatchResultV1Schema>;
