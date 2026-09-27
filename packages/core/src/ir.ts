/**
 * Canonical domain IR. Produced from YAML by `parseModel`, consumed by the
 * validator, the generators, the CLI and the Web editor. Plain JSON-serializable data.
 */
import type { Path } from "./diagnostics.ts";

export const SCHEMA_VERSION = 1 as const;

export interface ModelIR {
  schemaVersion: number;
  project: string;
  description?: string;
  generation: GenerationSettings;
  contexts: ContextIR[];
}

export interface GenerationSettings {
  package: string;
  srcDir: string;
  testsDir: string;
}

interface Located {
  /** YAML path of the element; used to attach diagnostics. */
  path: Path;
}

export interface ContextIR extends Located {
  name: string;
  description?: string;
  glossary: GlossaryEntryIR[];
  errors: ErrorIR[];
  enums: EnumIR[];
  valueObjects: ValueObjectIR[];
  aggregates: AggregateIR[];
  extensionPoints: ExtensionPointIR[];
  useCases: UseCaseIR[];
}

export interface GlossaryEntryIR {
  term: string;
  definition: string;
}

export interface ErrorIR extends Located {
  name: string;
  code: string;
  message: string;
  description?: string;
  /** Extra diagnostic fields carried by the exception (internal, not shown to end users). */
  details: FieldIR[];
}

export interface EnumIR extends Located {
  name: string;
  description?: string;
  values: string[];
}

export interface Constraints {
  min_length?: number;
  max_length?: number;
  pattern?: string;
  min?: number;
  max?: number;
  max_digits?: number;
  decimal_places?: number;
  min_items?: number;
  max_items?: number;
}

export interface FieldIR extends Located {
  name: string;
  /** Raw type expression, e.g. `String`, `List[EmailAddress]`, `Ref[Order]`. */
  type: string;
  required: boolean;
  description?: string;
  constraints: Constraints;
}

export type NormalizeStep = "strip" | "lower" | "upper";

export interface ValueObjectIR extends Located {
  name: string;
  description?: string;
  fields: FieldIR[];
  normalize: Record<string, NormalizeStep[]>;
  invariants: InvariantIR[];
}

export interface EntityIR extends Located {
  name: string;
  description?: string;
  identity: string;
  fields: FieldIR[];
  invariants: InvariantIR[];
}

export interface AggregateIR extends EntityIR {
  entities: EntityIR[];
  stateGuards: StateGuardIR[];
  factories: FactoryIR[];
  operations: OperationIR[];
  scenarios: AggregateScenarioIR[];
}

export type CheckTiming = "construct" | "transition";

export interface InvariantIR extends Located {
  name: string;
  description?: string;
  expression: string;
  error: string;
  checkOn: CheckTiming[];
}

export interface ParameterIR extends Located {
  name: string;
  type: string;
  required: boolean;
}

export interface StateGuardIR extends Located {
  name: string;
  description?: string;
  parameters: ParameterIR[];
  expression: string;
  error: string;
}

export interface EventEmissionIR extends Located {
  name: string;
  /** Payload: `name` alone copies a parameter or (post-transition) field; `value` is an expression. */
  fields: { name: string; value?: string; path: Path }[];
  /** Optional condition expression; the event is emitted only when it holds. */
  when?: string;
}

export interface FactoryIR extends Located {
  name: string;
  description?: string;
  parameters: ParameterIR[];
  require: string[];
  /** field name → expression */
  fields: Record<string, string>;
  emits: EventEmissionIR[];
}

export interface OperationIR extends Located {
  name: string;
  description?: string;
  parameters: ParameterIR[];
  /** Guard calls applied automatically before the change, e.g. `pending_until_expiry(at)`. */
  require: string[];
  /** field name → expression evaluated against the pre-transition state. */
  changes: Record<string, string>;
  emits: EventEmissionIR[];
}

export interface ExtensionPointIR extends Located {
  name: string;
  description?: string;
  parameters: ParameterIR[];
  returns: string;
  /** Value returned by the generated test double when a scenario does not stub it. */
  testDefault?: unknown;
}

export type TransactionMode = "required" | "none";

export interface UseCaseIR extends Located {
  name: string;
  description?: string;
  actor?: string;
  command: string;
  input: FieldIR[];
  transaction: TransactionMode;
  idempotencyKey?: string;
  retry: boolean;
  steps: StepIR[];
  scenarios: UseCaseScenarioIR[];
}

export type StepIR =
  | ({ kind: "load"; aggregate: string; by: string; as: string; notFound?: string } & Located)
  | ({ kind: "create"; aggregate: string; factory: string; as: string; args: Record<string, string> } & Located)
  | ({ kind: "invoke"; target: string; operation: string; args: Record<string, string> } & Located)
  | ({ kind: "save"; target: string } & Located)
  | ({ kind: "publish"; event: string; afterCommit: boolean } & Located)
  | ({ kind: "if"; condition: string; then: StepIR[]; else: StepIR[] } & Located)
  | ({ kind: "fail"; error: string } & Located)
  | ({ kind: "return"; value: string } & Located);

/** Literal scenario data as written in YAML (strings, numbers, booleans, nested maps). */
export type ScenarioValue = unknown;

export interface AggregateScenarioIR extends Located {
  name: string;
  description?: string;
  given?: { aggregate: Record<string, ScenarioValue>; path: Path };
  when:
    | { kind: "construct"; fields: Record<string, ScenarioValue>; path: Path }
    | { kind: "operation"; operation: string; args: Record<string, ScenarioValue>; path: Path }
    | { kind: "factory"; factory: string; args: Record<string, ScenarioValue>; path: Path };
  then: ScenarioThenIR;
}

export interface UseCaseScenarioIR extends Located {
  name: string;
  description?: string;
  given: {
    clock?: string;
    ids: string[];
    aggregates: { type: string; fields: Record<string, ScenarioValue>; path: Path }[];
    extensions: Record<string, ScenarioValue>;
    path: Path;
  };
  when: { input: Record<string, ScenarioValue>; path: Path };
  then: ScenarioThenIR;
}

export interface ScenarioThenIR extends Located {
  raises?: string;
  /** Aggregate scenarios: single state map. Use case scenarios: list of stored aggregates. */
  state?: Record<string, ScenarioValue> | { aggregate: string; id: ScenarioValue; fields: Record<string, ScenarioValue>; path: Path }[];
  emits?: { event: string; fields: Record<string, ScenarioValue>; path: Path }[];
  hasReturns: boolean;
  returns?: ScenarioValue;
}
