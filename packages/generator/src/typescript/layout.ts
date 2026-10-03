import { resolveType, type AggregateIR, type ContextAnalysis, type ModelIR, type Type } from "@ddd/core";
import { kebab } from "./names.ts";

export type DomainModule = "errors" | "enums" | "value-objects" | "entities" | "aggregates" | "events" | "commands" | "rules";
export type TypeKind = "enum" | "vo" | "entity" | "aggregate" | "event";

const join = (...parts: string[]) => parts.filter((p) => p && p !== ".").join("/");

/** Project-relative module paths (without extension) of the generated TypeScript package. */
export class TsPaths {
  readonly root: string;
  constructor(readonly model: ModelIR) {
    this.root = join(model.generation.srcDir, model.generation.package);
  }
  get generated(): string {
    return join(this.root, "generated");
  }
  get runtime(): string {
    return `${this.generated}/runtime`;
  }
  get testing(): string {
    return `${this.generated}/testing`;
  }
  get adapters(): string {
    return `${this.generated}/adapters`;
  }
  contextBase(context: string): string {
    return `${this.generated}/${kebab(context)}`;
  }
  extensions(context: string, file: "extensions" | "translators"): string {
    return join(this.root, "extensions", kebab(context), file);
  }
  /** Module path → file path. */
  file(module: string): string {
    return `${module}.ts`;
  }
}

/** Module / path layout for one bounded context. */
export class TsLayout extends TsPaths {
  readonly ctxDir: string;
  readonly base: string;

  constructor(
    model: ModelIR,
    readonly ca: ContextAnalysis,
  ) {
    super(model);
    this.ctxDir = kebab(ca.ir.name);
    this.base = this.contextBase(ca.ir.name);
  }

  mod(name: DomainModule): string {
    return `${this.base}/domain/${name}`;
  }
  get ports(): string {
    return `${this.base}/application/ports`;
  }
  get useCases(): string {
    return `${this.base}/application/use-cases`;
  }
  get policies(): string {
    return `${this.base}/application/policies`;
  }
  get contextTesting(): string {
    return `${this.base}/testing`;
  }
  get index(): string {
    return `${this.base}/index`;
  }
  eventsOf(context: string): string {
    return `${this.contextBase(context)}/domain/events`;
  }
  /** Test module (`tests/generated/<context>-<name>.test`); `.ts` is appended by `file()`. */
  testModule(name: string): string {
    return join(this.model.generation.testsDir, "generated", `${this.ctxDir}-${kebab(name)}.test`);
  }

  typeModule = (kind: TypeKind): string => {
    switch (kind) {
      case "enum":
        return this.mod("enums");
      case "vo":
        return this.mod("value-objects");
      case "entity":
        return this.mod("entities");
      case "aggregate":
        return this.mod("aggregates");
      case "event":
        return this.mod("events");
    }
  };

  fieldTypes(owner: string): Map<string, Type> {
    return this.ca.fieldTypes.get(owner) ?? new Map();
  }

  /** Aggregate or entity declaring `owner` (undefined for value objects, commands, errors). */
  entityOf(owner: string): { identity: string } | undefined {
    for (const a of this.ca.ir.aggregates) {
      if (a.name === owner) return a;
      const e = a.entities.find((x) => x.name === owner);
      if (e) return e;
    }
    return undefined;
  }

  /**
   * Field type as the TypeScript code sees it: the UUID identity of an aggregate or entity is its own branded id
   * (`Id<"Order">`), modelled as a Ref to the owner.
   */
  tsFieldType(owner: string, field: string): Type | undefined {
    const t = this.fieldTypes(owner).get(field);
    if (!t) return undefined;
    const ent = this.entityOf(owner);
    if (ent && ent.identity === field && t.k === "primitive" && t.name === "UUID") return { k: "ref", target: owner };
    return t;
  }

  aggregate(name: string): AggregateIR | undefined {
    return this.ca.ir.aggregates.find((a) => a.name === name);
  }

  paramTypes(owner: AggregateIR | undefined, params: { name: string; type: string; required: boolean }[]): Map<string, Type> {
    const m = new Map<string, Type>();
    for (const p of params) {
      const r = resolveType(p.type, { context: this.ca.ir, aggregate: owner?.name });
      if (!r.ok) throw new Error(`unresolved type ${p.type} (model must be validated before generation)`);
      m.set(p.name, p.required ? r.type : { k: "optional", inner: r.type });
    }
    return m;
  }

  resolve(src: string): Type {
    const r = resolveType(src, { context: this.ca.ir });
    if (!r.ok) throw new Error(`unresolved type ${src}`);
    return r.type;
  }
}
