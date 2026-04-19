/**
 * Zod schemas for the YAML surface.
 *
 * Rule files live in `rules/*.yaml` and have three top-level sections:
 * `defaults`, `archetypes`, `rules`. Archetypes are file-scoped only —
 * there's intentionally no shared archetype file.
 */

import { z } from 'zod';

import {
  FIELDS,
  type ActionField,
  type FieldKind,
  type FieldShape,
  type FieldSpec,
  type MatcherField,
} from './fields.ts';

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
 * A scalar matcher value. Canonical form is `{any?: [...], all?: [...]}`
 * (`any` OR-joins, `all` AND-joins; combined → AND of the two groups).
 * A bare string or bare list is sugar for `{any: [v]}` / `{any: [...]}`.
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

/**
 * Shared search-expression grammar used by rule `match:` trees and
 * declarative module `transform:` trees.
 *
 * `any:` → OR group; `all:` → AND group. Leaves are field matchers whose
 * values accept the same string / list / `{any, all}` shapes as flat
 * matchers. Compiles to SearchNode IR via `compileSearchExpr`.
 */
export const SearchExprSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ any: z.array(SearchExprSchema) }),
    z.object({ all: z.array(SearchExprSchema) }),
    z.object({ from: MatcherValueSchema }),
    z.object({ to: MatcherValueSchema }),
    z.object({ subject: MatcherValueSchema }),
    z.object({ body: MatcherValueSchema }),
    z.object({ with: MatcherValueSchema }),
    z.object({ list: MatcherValueSchema }),
    z.object({ text: MatcherValueSchema }),
    z.object({ domain: MatcherValueSchema }),
    z.object({ header: HeaderMatcherSchema }),
    z.object({ raw: z.string() }),
  ]),
);

/**
 * Map a `FieldSpec.shape` (and `nullable`) to a zod schema. Keeps schema
 * definition colocated with the field registry so adding a new shape only
 * requires editing this file plus `fields.ts`.
 */
function zodForField(f: FieldSpec): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (f.shape) {
    case 'matcherValue':
      base = MatcherValueSchema;
      break;
    case 'bool':
      base = z.boolean();
      break;
    case 'string':
      base = z.string();
      break;
    case 'stringOrList':
      base = z.union([z.string(), z.array(z.string())]);
      break;
    case 'header':
      base = z.union([HeaderMatcherSchema, z.array(HeaderMatcherSchema)]);
      break;
    case 'searchExpr':
      base = SearchExprSchema;
      break;
    case 'snooze':
      base = z.object({ date: z.string() });
      break;
    case 'raw':
      base = z.string();
      break;
  }
  return f.nullable ? base.nullable() : base;
}

/**
 * Type-level map from `FieldShape` → the runtime zod type `zodForField`
 * produces for that shape. Used to derive `MatchersShape` / `ActionsShape`
 * so that `z.infer<typeof MatchersSchema>` retains literal field keys.
 */
type ShapeToZod<S extends FieldShape> =
  S extends 'matcherValue' ? typeof MatcherValueSchema
  : S extends 'bool' ? z.ZodBoolean
  : S extends 'string' ? z.ZodString
  : S extends 'stringOrList' ? z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString>]>
  : S extends 'header' ? z.ZodUnion<[typeof HeaderMatcherSchema, z.ZodArray<typeof HeaderMatcherSchema>]>
  : S extends 'searchExpr' ? z.ZodType<unknown>
  : S extends 'snooze' ? z.ZodObject<{ date: z.ZodString }>
  : S extends 'raw' ? z.ZodString
  : never;

type NullableIf<F extends FieldSpec, T extends z.ZodTypeAny> =
  F extends { nullable: true } ? z.ZodNullable<T> : T;

type FieldToZod<F extends FieldSpec> = z.ZodOptional<NullableIf<F, ShapeToZod<F['shape']>>>;

type ShapeFor<F extends FieldSpec> = { [K in F as K['yaml']]: FieldToZod<K> };

type MatchersShape = ShapeFor<MatcherField>;
type ActionsShape = ShapeFor<ActionField>;

function buildFieldSchema<S extends z.ZodRawShape>(kind: FieldKind): S {
  const shape: z.ZodRawShape = {};
  for (const f of FIELDS) {
    if (f.kind !== kind) continue;
    shape[f.yaml] = zodForField(f).optional();
  }
  return shape as S;
}

export const MatchersSchema = z.object(buildFieldSchema<MatchersShape>('matcher'));

export const ActionsSchema = z.object(buildFieldSchema<ActionsShape>('action'));

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
 * `{value}` in any string position inside the transform tree is
 * interpolated with the target matcher's concrete value at compile time.
 */
export const DeclarativeModuleSchema = z.object({
  module: z.string(),
  description: z.string().optional(),
  targets: z.union([z.string(), z.array(z.string())]),
  transform: z.record(z.string(), SearchExprSchema),
});
export type DeclarativeModuleYaml = z.infer<typeof DeclarativeModuleSchema>;
