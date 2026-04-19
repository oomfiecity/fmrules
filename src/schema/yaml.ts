/**
 * Zod schemas for the YAML surface.
 *
 * Rule files live in `rules/*.yaml` and have three top-level sections:
 * `defaults`, `archetypes`, `rules`. Archetypes are file-scoped only —
 * there's intentionally no shared archetype file.
 */

import { z } from 'zod';

/** A module reference: `simplelogin` or `{ name: vip, args: {...} }`. */
export const ModuleRefSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    args: z.unknown().optional(),
  }),
]);
export type ModuleRefYaml = z.infer<typeof ModuleRefSchema>;

export const HeaderMatcherSchema = z.object({
  name: z.string(),
  value: z.string(),
});

/**
 * Rule-level `match:` tree for cross-field OR / AND composition.
 *
 * `any:` → OR group; `all:` → AND group. Leaves are single-value matchers.
 * Compiles via build-search. AND-joined with any flat matchers on the rule.
 */
export const MatchTreeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ any: z.array(MatchTreeSchema) }),
    z.object({ all: z.array(MatchTreeSchema) }),
    z.object({ from: z.string() }),
    z.object({ to: z.string() }),
    z.object({ subject: z.string() }),
    z.object({ body: z.string() }),
    z.object({ with: z.string() }),
    z.object({ list: z.string() }),
    z.object({ text: z.string() }),
    z.object({ header: HeaderMatcherSchema }),
    z.object({ raw: z.string() }),
  ]),
);

/**
 * A scalar matcher value. The canonical form is `{any?: [...], all?: [...]}`
 * (any-list OR-joins; all-list AND-joins; combined → AND of the two groups).
 * A bare string or list is sugar for the same.
 *
 * Plurals (`subjects`, `bodies`) and `_all` suffixes (`subject_all`,
 * `body_all`) are legacy sugar — kept for backward compat, normalized into
 * the canonical singular form at pickMatchers time. Use `fmrules migrate`
 * to convert files in place.
 */
const NestedMatcherShape = z
  .object({
    any: z.array(z.string()).optional(),
    all: z.array(z.string()).optional(),
  })
  .strict()
  .refine(
    (v) => (v.any && v.any.length > 0) || (v.all && v.all.length > 0),
    { message: 'Nested matcher must include a non-empty `any` or `all`.' },
  );

const MatcherValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  NestedMatcherShape,
]);

export const MatchersSchema = z.object({
  from: MatcherValueSchema.optional(),
  to: MatcherValueSchema.optional(),
  subject: MatcherValueSchema.optional(),
  subjects: z.array(z.string()).optional(),
  subject_all: z.array(z.string()).optional(),
  body: MatcherValueSchema.optional(),
  bodies: z.array(z.string()).optional(),
  body_all: z.array(z.string()).optional(),
  header: z.union([HeaderMatcherSchema, z.array(HeaderMatcherSchema)]).optional(),
  match: MatchTreeSchema.optional(),
  list: MatcherValueSchema.optional(),
  with: MatcherValueSchema.optional(),
  text: MatcherValueSchema.optional(),
  domain: MatcherValueSchema.optional(),
  search_raw: z.string().optional(),
});

export const ActionsSchema = z.object({
  skip_inbox: z.boolean().optional(),
  mark_read: z.boolean().optional(),
  mark_flagged: z.boolean().optional(),
  show_notification: z.boolean().optional(),
  file_in: z.string().nullable().optional(),
  redirect_to: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  snooze_until: z.object({ date: z.string() }).nullable().optional(),
  discard: z.boolean().optional(),
  mark_spam: z.boolean().optional(),
  stop: z.boolean().optional(),
});

const RuleFieldsSchema = MatchersSchema.merge(ActionsSchema).extend({
  name: z.string().optional(),
  is_enabled: z.boolean().optional(),
  combinator: z.enum(['all', 'any']).optional(),
  sort_order: z.number().int().optional(),
  use: z.array(ModuleRefSchema).optional(),
  archetype: z.string().optional(),
  match_all: z.boolean().optional(),
});

export const RuleSchema = RuleFieldsSchema.extend({
  name: z.string(),
});
export type RuleYaml = z.infer<typeof RuleSchema>;

/** Archetype declarations are rule fields minus `name` / `archetype`. */
export const ArchetypeSchema = RuleFieldsSchema.omit({ archetype: true });
export type ArchetypeYaml = z.infer<typeof ArchetypeSchema>;

export const FileDefaultsSchema = RuleFieldsSchema.omit({
  name: true,
  archetype: true,
  sort_order: true,
});
export type FileDefaultsYaml = z.infer<typeof FileDefaultsSchema>;

export const RuleFileSchema = z.object({
  version: z.literal(1).optional(),
  defaults: FileDefaultsSchema.optional(),
  archetypes: z.record(z.string(), ArchetypeSchema).optional(),
  rules: z.array(RuleSchema),
});
export type RuleFileYaml = z.infer<typeof RuleFileSchema>;

/** meta/config.yaml */
export const ConfigSchema = z.object({
  folders: z.array(z.string()).optional(),
  file_order: z.array(z.string()).optional(),
});
export type ConfigYaml = z.infer<typeof ConfigSchema>;

/**
 * Declarative module (meta/modules/*.yaml). Compiled into a runtime
 * Module at load time by meta.ts.
 *
 * `targets` names which matcher field(s) the transform applies to.
 * `{value}` in the transform tree is interpolated with the field's
 * concrete value at compile time.
 */
export const DeclarativeTransformSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ or: z.array(DeclarativeTransformSchema) }),
    z.object({ and: z.array(DeclarativeTransformSchema) }),
    z.object({ from: z.string() }),
    z.object({ to: z.string() }),
    z.object({ subject: z.string() }),
    z.object({ body: z.string() }),
    z.object({
      header: z.object({
        name: z.string(),
        contains: z.string().optional(),
        value: z.string().optional(),
      }),
    }),
    z.object({ raw: z.string() }),
  ]),
);

export const DeclarativeModuleSchema = z.object({
  module: z.string(),
  description: z.string().optional(),
  targets: z.union([z.string(), z.array(z.string())]),
  transform: z.record(z.string(), DeclarativeTransformSchema),
});
export type DeclarativeModuleYaml = z.infer<typeof DeclarativeModuleSchema>;
