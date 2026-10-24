/**
 * Proofs about the aggregates of a model with Z3 (docs/09 §29).
 *
 * For every factory and operation, each check that can reject it — a field constraint, an invariant of the new state,
 * the constraints and invariants of the value objects and entities it builds — is an obligation: "once the require
 * guards hold (and the earlier checks pass), this check passes". The starting state is any state that satisfies every
 * invariant and constraint, with its state fields at reachable values (an inductive check: what holds before every
 * operation holds after it). A satisfiable negation is a counterexample (concrete values); unsatisfiable is a proof.
 *
 * Lists are slots that are present or not: a proof with lists covers lists of at most N elements (N is reported).
 * Counterexamples are then searched from the factories (a few operations deep) to tell a reachable one from one that
 * starts in a state the model never produces (then an invariant is missing).
 */
import {
  aggregateStateMachines,
  exprChildren,
  formatPath,
  PROOF_ASSUMPTIONS,
  proofId,
  referencedFields,
  resolveType,
  type AggregateIR,
  type Analysis,
  type ContextAnalysis,
  type FactoryIR,
  type OperationIR,
  type ProofExample,
  type ProofReport,
  type ProofResult,
  type ProofRun,
  type ProofSource,
  type TExpr,
  type Type,
} from "@ddd/core";
import { constraintSource, Encoder, hasConstraints, invariantSource, Unsupported, unwrap, type Check, type V, type ZBool } from "./encode.ts";
import { Session, Smt, z3Version, type T } from "./smt.ts";

export interface VerifyOptions {
  /** Time limit of one solver query (ms). */
  timeoutMs?: number;
  /** Largest number of list elements to check (the bound grows with the numbers a model compares list sizes with). */
  maxListElements?: number;
  /** Operations after a factory to search for a counterexample's starting state (0 = do not search). */
  traceDepth?: number;
  /** Time for the whole reachability search (ms). */
  traceBudgetMs?: number;
  /** Receives every obligation as a standalone SMT-LIB script (to re-check with another solver). */
  onQuery?: (name: string, script: string) => void;
}

type Rec = Extract<V, { k: "rec" }>;

interface Group {
  source: ProofSource;
  fail: ZBool;
  pass: ZBool;
}

/** One factory or operation, encoded: its guards, its checks (grouped by source, in order) and the new state. */
interface Encoded {
  requires: ZBool;
  groups: Group[];
  post: Rec;
  params: Map<string, V>;
}

const SMALL = 2;

export async function verifyModel(analysis: Analysis, options: VerifyOptions = {}): Promise<ProofReport> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 4000;
  const maxList = options.maxListElements ?? 60;
  const results: ProofResult[] = [];
  const runs: ProofRun[] = [];
  for (const ca of analysis.contexts.values()) {
    for (const ag of ca.ir.aggregates) {
      if (!ag.factories.length && !ag.operations.length) continue;
      const v = new AggregateVerifier(ca, ag, { timeoutMs, maxList, ...(options.onQuery ? { onQuery: options.onQuery } : {}) });
      await v.run(results, runs);
      if ((options.traceDepth ?? 2) > 0) await v.traces(results, options.traceDepth ?? 2, options.traceBudgetMs ?? 8_000);
    }
  }
  return { results, runs, assumptions: PROOF_ASSUMPTIONS, solver: await z3Version(), elapsedMs: Date.now() - started };
}

/** Largest integer a model compares the size of each list field with (`count(lines) <= 50` → 50). */
function listThresholds(ca: ContextAnalysis, ag: AggregateIR): Map<string, number> {
  const out = new Map<string, number>();
  const note = (field: string, n: number) => out.set(field, Math.max(out.get(field) ?? 0, n));
  const sizeOf = (e: TExpr): string | undefined => {
    if (e.t === "builtin" && (e.fn === "count" || e.fn === "length") && e.args.length === 1) {
      const a = e.args[0]!;
      if (a.t === "field" && !a.owner) return a.name;
    }
    return undefined;
  };
  const walk = (e: TExpr) => {
    if (e.t === "binary") {
      const l = sizeOf(e.left);
      const r = sizeOf(e.right);
      if (l && e.right.t === "lit" && typeof e.right.value === "number") note(l, e.right.value);
      if (r && e.left.t === "lit" && typeof e.left.value === "number") note(r, e.left.value);
    }
    for (const c of exprChildren(e)) walk(c);
  };
  const paths = [
    ...ag.invariants.map((i) => [...i.path, "expression"]),
    ...ag.stateGuards.map((g) => [...g.path, "expression"]),
    ...ag.operations.flatMap((o) => [...o.require.map((_, i) => [...o.path, "require", i]), ...Object.keys(o.changes).map((f) => [...o.path, "changes", f])]),
  ];
  for (const p of paths) {
    const e = ca.exprs.get(formatPath(p));
    if (e) walk(e);
  }
  for (const f of ag.fields) {
    if (f.constraints.max_items !== undefined) note(f.name, f.constraints.max_items);
    if (f.constraints.min_items !== undefined) note(f.name, f.constraints.min_items);
  }
  return out;
}

class AggregateVerifier {
  private thresholds: Map<string, number>;
  private machines;
  /** Counterexamples to look for from the factories (result index → operation). */
  private open: { result: ProofResult; op: string; source: ProofSource }[] = [];

  constructor(
    private ca: ContextAnalysis,
    private ag: AggregateIR,
    private opts: { timeoutMs: number; maxList: number; onQuery?: (name: string, script: string) => void },
  ) {
    this.thresholds = listThresholds(ca, ag);
    this.machines = aggregateStateMachines(ca, ag);
  }

  /** Slots for the list fields: `small`, or enough to show the largest size the model compares the list with. */
  private bounds(small: boolean) {
    return {
      list: (owner: string, field: string) => {
        if (small || owner !== this.ag.name) return SMALL;
        return Math.min(this.opts.maxList, Math.max(SMALL + 1, (this.thresholds.get(field) ?? 0) + 1));
      },
    };
  }

  private fullBound(): number {
    const lists = this.ag.fields.filter((f) => f.type.trim().startsWith("List["));
    return Math.max(SMALL + 1, ...lists.map((f) => this.bounds(false).list(this.ag.name, f.name)));
  }

  private type(src: string, required = true): Type {
    const r = resolveType(src, { context: this.ca.ir, aggregate: this.ag.name });
    if (!r.ok) throw new Unsupported(r.message);
    return required ? r.type : { k: "optional", inner: r.type };
  }

  private expr(path: (string | number)[]): TExpr {
    const e = this.ca.exprs.get(formatPath(path));
    if (!e) throw new Unsupported(`${formatPath(path)} did not type-check`);
    return e;
  }

  /** A valid state of the aggregate: invariants and constraints hold, state fields are reachable. */
  private freshState(enc: Encoder, prefix: string): Rec {
    const types = enc.fieldTypes(this.ag.name);
    const fields = new Map<string, V>();
    for (const f of this.ag.fields) fields.set(f.name, enc.fresh(types.get(f.name)!, `${prefix}.${f.name}`, true, enc.bounds.list(this.ag.name, f.name)));
    const rec: Rec = { k: "rec", name: this.ag.name, kind: "aggregate", fields };
    enc.assumeValid(rec);
    for (const sm of this.machines) {
      const v = unwrap(fields.get(sm.field)!);
      if (v.k !== "enum") continue;
      const allowed = sm.reachable.map((s) => sm.states.indexOf(s));
      enc.facts.push(allowed.length ? enc.z.Or(...allowed.map((i) => v.e.eq(i))) : enc.z.Bool.val(false));
    }
    return rec;
  }

  private freshParams(enc: Encoder, params: { name: string; type: string; required: boolean }[], prefix: string): Map<string, V> {
    const out = new Map<string, V>();
    for (const p of params) out.set(p.name, enc.fresh(this.type(p.type, p.required), `${prefix}${p.name}`, true));
    return out;
  }

  /** Groups checks by source (first occurrence keeps the order): fails if any instance fails. */
  private group(enc: Encoder, checks: Check[]): Group[] {
    const z = enc.z;
    const order: string[] = [];
    const by = new Map<string, { source: ProofSource; fails: ZBool[]; passes: ZBool[] }>();
    for (const c of checks) {
      const key = `${c.source.kind}\u0000${c.source.owner}\u0000${c.source.name}`;
      let g = by.get(key);
      if (!g) {
        g = { source: c.source, fails: [], passes: [] };
        by.set(key, g);
        order.push(key);
      }
      g.fails.push(z.And(c.when, z.Not(c.ok)));
      g.passes.push(z.Implies(c.when, c.ok));
    }
    return order.map((k) => {
      const g = by.get(k)!;
      return { source: g.source, fail: z.Or(...g.fails), pass: z.And(...g.passes) };
    });
  }

  /** The aggregate's own checks on a new state: constraints of `fields`, then invariants reading them (construct, then transition). */
  private stateChecks(enc: Encoder, post: Rec, fields: Set<string> | "all", timing: "factory" | "operation"): Check[] {
    const z = enc.z;
    const out: Check[] = [];
    const touched = (inv: { path: (string | number)[] }) => {
      if (fields === "all") return true;
      const e = this.ca.exprs.get(formatPath([...inv.path, "expression"]));
      return !e || [...referencedFields(e)].some((f) => fields.has(f));
    };
    for (const f of this.ag.fields) {
      if (fields !== "all" && !fields.has(f.name)) continue;
      if (!hasConstraints(f.constraints)) continue;
      out.push({ source: constraintSource(this.ag.name, f), ok: enc.constraint(f.constraints, post.fields.get(f.name)!), when: z.Bool.val(true) });
    }
    const construct = this.ag.invariants.filter((i) => i.checkOn.includes("construct"));
    const transition = this.ag.invariants.filter((i) => i.checkOn.includes("transition") && !i.checkOn.includes("construct"));
    for (const inv of construct) if (touched(inv)) out.push({ source: invariantSource(this.ag.name, inv, "invariant"), ok: enc.invariant(this.ag, inv, post), when: z.Bool.val(true) });
    if (timing === "operation") for (const inv of transition) if (touched(inv)) out.push({ source: invariantSource(this.ag.name, inv, "invariant"), ok: enc.invariant(this.ag, inv, post), when: z.Bool.val(true) });
    return out;
  }

  /**
   * Value objects built for the events' payloads (`Money(amount=..., ...)` in an emitted field): their checks run after
   * the new state is checked, for the events whose `when` holds.
   */
  private eventChecks(enc: Encoder, x: FactoryIR | OperationIR, post: Rec, params: Map<string, V>): Check[] {
    const out: Check[] = [];
    for (const em of x.emits) {
      const when = em.when !== undefined ? enc.bool(enc.evalIn(this.expr([...em.path, "when"]), post, params)) : enc.z.Bool.val(true);
      for (const fd of em.fields) {
        if (fd.value === undefined) continue;
        enc.checks = [];
        enc.evalIn(this.expr([...fd.path, "value"]), post, params, when);
        out.push(...enc.checks);
      }
    }
    enc.checks = [];
    return out;
  }

  private encodeOperation(enc: Encoder, op: OperationIR, pre: Rec, prefix: string): Encoded {
    const z = enc.z;
    const params = this.freshParams(enc, op.parameters, prefix);
    const requires = op.require.map((_, i) => enc.bool(enc.evalIn(this.expr([...op.path, "require", i]), pre, params)));
    enc.checks = [];
    const fields = new Map(pre.fields);
    const types = enc.fieldTypes(this.ag.name);
    for (const f of this.ag.fields) {
      if (op.changes[f.name] === undefined) continue;
      fields.set(f.name, enc.coerce(enc.evalIn(this.expr([...op.path, "changes", f.name]), pre, params), types.get(f.name)!));
    }
    const built = enc.checks;
    enc.checks = [];
    const post: Rec = { ...pre, fields };
    const checks = [...built, ...this.stateChecks(enc, post, new Set(Object.keys(op.changes)), "operation"), ...this.eventChecks(enc, op, post, params)];
    return { requires: requires.length ? z.And(...requires) : z.Bool.val(true), groups: this.group(enc, checks), post, params };
  }

  private encodeFactory(enc: Encoder, f: FactoryIR, prefix: string): Encoded {
    const z = enc.z;
    const params = this.freshParams(enc, f.parameters, prefix);
    const requires = f.require.map((_, i) => enc.bool(enc.evalIn(this.expr([...f.path, "require", i]), undefined, params)));
    enc.checks = [];
    const types = enc.fieldTypes(this.ag.name);
    const fields = new Map<string, V>();
    for (const fd of this.ag.fields) {
      const src = f.fields[fd.name];
      fields.set(fd.name, src === undefined ? { k: "null" } : enc.coerce(enc.evalIn(this.expr([...f.path, "fields", fd.name]), undefined, params), types.get(fd.name)!));
    }
    const built = enc.checks;
    enc.checks = [];
    const post: Rec = { k: "rec", name: this.ag.name, kind: "aggregate", fields };
    const checks = [...built, ...this.stateChecks(enc, post, "all", "factory"), ...this.eventChecks(enc, f, post, params)];
    return { requires: requires.length ? z.And(...requires) : z.Bool.val(true), groups: this.group(enc, checks), post, params };
  }

  /** Transition-only invariants a factory's new state must satisfy for the inductive assumption to start. */
  private initialGroups(enc: Encoder, post: Rec): Group[] {
    const z = enc.z;
    return this.ag.invariants
      .filter((i) => i.checkOn.includes("transition") && !i.checkOn.includes("construct"))
      .map((inv) => {
        const ok = enc.invariant(this.ag, inv, post);
        return { source: invariantSource(this.ag.name, inv, "initial"), fail: z.Not(ok), pass: ok };
      });
  }

  /** State fields that matter to a result: read by the failing check, the guards and the changes, or changed. */
  private focus(x: FactoryIR | OperationIR, kind: "factory" | "operation", source: ProofSource): string[] {
    const out = new Set<string>();
    const read = (p: (string | number)[]) => {
      const e = this.ca.exprs.get(formatPath(p));
      if (!e) return;
      referencedFields(e, out);
      const guards = (n: TExpr) => {
        if (n.t === "guard" && !n.receiver) {
          const g = this.ag.stateGuards.find((y) => y.name === n.guard);
          if (g) read([...g.path, "expression"]);
        }
        exprChildren(n).forEach(guards);
      };
      guards(e);
    };
    x.require.forEach((_, i) => read([...x.path, "require", i]));
    if (kind === "operation") for (const f of Object.keys((x as OperationIR).changes)) {
      out.add(f);
      read([...x.path, "changes", f]);
    }
    if (source.owner === this.ag.name) {
      if (source.kind === "constraint") out.add(source.name);
      else read([...source.path, "expression"]);
    }
    // A value object built for an event: the fields its payload reads.
    if (source.owner !== this.ag.name) for (const em of x.emits) for (const fd of em.fields) if (fd.value !== undefined) read([...fd.path, "value"]);
    return this.ag.fields.map((f) => f.name).filter((f) => out.has(f));
  }

  private depends(kind: "factory" | "operation", x: FactoryIR | OperationIR): string {
    const guards = x.require.map((r) => this.ag.stateGuards.find((g) => g.name === r.replace(/\(.*$/, ""))?.expression ?? "");
    const body = kind === "factory" ? (x as FactoryIR).fields : (x as OperationIR).changes;
    return JSON.stringify([x.parameters.map((p) => [p.name, p.type, p.required]), x.require, guards, body]);
  }

  private sessions = new WeakMap<Encoder, Session>();

  /** Checks the encoder's facts plus `extra`; when satisfiable, the values of `read`'s leaves. */
  private async check(enc: Encoder, extra: ZBool[], read: V[] = [], name?: string, timeoutMs = this.opts.timeoutMs): Promise<{ status: "sat" | "unsat" | "unknown"; values?: Map<string, string> }> {
    let s = this.sessions.get(enc);
    if (!s) {
      s = await Session.open(enc.z, timeoutMs);
      this.sessions.set(enc, s);
    }
    const terms: T[] = read.flatMap((v) => enc.leaves(v));
    if (name && this.opts.onQuery) this.opts.onQuery(name, s.standalone(extra));
    const t0 = Date.now();
    const r = await s.check(extra, terms);
    if (process.env.DDD_VERIFY_DEBUG) console.error(`[z3] ${r.status} ${Date.now() - t0}ms ${name ?? ""}`);
    return r;
  }

  private done(enc: Encoder): void {
    this.sessions.get(enc)?.close();
    this.sessions.delete(enc);
  }

  /** Every obligation of one factory or operation, at one list bound. */
  private async obligations(kind: "factory" | "operation", x: FactoryIR | OperationIR, small: boolean) {
    const enc = new Encoder(new Smt(), this.ca, this.bounds(small));
    try {
      const pre = kind === "operation" ? this.freshState(enc, "pre") : undefined;
      const e = kind === "operation" ? this.encodeOperation(enc, x as OperationIR, pre!, "") : this.encodeFactory(enc, x as FactoryIR, "");
      const groups = kind === "factory" ? [...e.groups, ...this.initialGroups(enc, e.post)] : e.groups;
      const shown = [...(pre ? [pre] : []), ...e.params.values(), e.post];
      const example = (vals: Map<string, string>): ProofExample => ({
        ...(pre ? { state: enc.read(vals, pre) as Record<string, unknown> } : {}),
        args: Object.fromEntries([...e.params].map(([n, v]) => [n, enc.read(vals, v)])),
        after: enc.read(vals, e.post) as Record<string, unknown>,
      });
      const label = `${this.ca.ir.name}.${this.ag.name}.${x.name}`;
      const out: { source: ProofSource; status: "sat" | "unsat" | "unknown"; example?: ProofExample }[] = [];
      for (let j = 0; j < groups.length; j++) {
        const g = groups[j]!;
        // Initial-state obligations assume the factory succeeded (every regular check passed).
        const before = g.source.kind === "initial" ? e.groups.map((y) => y.pass) : groups.slice(0, j).map((y) => y.pass);
        const r = await this.check(enc, [e.requires, ...before, g.fail], shown, `${label}.${g.source.kind}.${g.source.owner}.${g.source.name}${small ? "" : ".full"}`);
        out.push({ source: g.source, status: r.status, ...(r.values ? { example: example(r.values) } : {}) });
      }
      const run = await this.check(enc, [e.requires, ...e.groups.map((y) => y.pass)], shown, `${label}.succeeds${small ? "" : ".full"}`);
      return { out, run: { status: run.status, ...(run.values ? { example: example(run.values) } : {}) }, lists: enc.usedLists };
    } finally {
      this.done(enc);
    }
  }

  async run(results: ProofResult[], runs: ProofRun[]): Promise<void> {
    const ctx = this.ca.ir.name;
    const items: { kind: "factory" | "operation"; x: FactoryIR | OperationIR }[] = [
      ...this.ag.factories.map((x) => ({ kind: "factory" as const, x })),
      ...this.ag.operations.map((x) => ({ kind: "operation" as const, x })),
    ];
    for (const { kind, x } of items) {
      const base = { context: ctx, aggregate: this.ag.name, kind, name: x.name, path: x.path };
      let small;
      try {
        small = await this.obligations(kind, x, true);
      } catch (err) {
        if (!(err instanceof Unsupported)) throw err;
        runs.push({ ...base, canSucceed: undefined, note: `対象外: ${err.message}` });
        continue;
      }
      // Proofs that used lists are redone with the full bound (counterexamples found with few elements are kept).
      let full: Awaited<ReturnType<AggregateVerifier["obligations"]>> | undefined;
      const bound = this.fullBound();
      if (small.lists && bound > SMALL && (small.out.some((o) => o.status === "unsat") || small.run.status === "unsat")) {
        try {
          full = await this.obligations(kind, x, false);
        } catch (err) {
          if (!(err instanceof Unsupported)) throw err;
        }
      }
      for (let i = 0; i < small.out.length; i++) {
        const o = small.out[i]!;
        const f = full?.out.find((y) => y.source.kind === o.source.kind && y.source.owner === o.source.owner && y.source.name === o.source.name);
        const id = proofId(ctx, this.ag.name, kind, x.name, o.source, this.depends(kind, x));
        let r: ProofResult;
        const focus = this.focus(x, kind, o.source);
        const ex = (e: ProofExample) => ({ ...e, focus });
        if (o.status === "sat") r = { ...base, id, source: o.source, outcome: "counterexample", ...(small.lists ? { bound: SMALL } : {}), example: ex(o.example!) };
        else if (o.status === "unknown") r = { ...base, id, source: o.source, outcome: "unknown", note: "時間切れ（Z3 が決められなかった）" };
        else if (!small.lists) r = { ...base, id, source: o.source, outcome: "proven" };
        else if (f?.status === "unsat") r = { ...base, id, source: o.source, outcome: "proven", bound };
        else if (f?.status === "sat") r = { ...base, id, source: o.source, outcome: "counterexample", bound, example: ex(f.example!) };
        else r = { ...base, id, source: o.source, outcome: "proven", bound: SMALL, note: `要素 ${bound} 個までは${f ? "時間切れ" : "調べられなかった"}` };
        results.push(r);
        if (r.outcome === "counterexample" && kind === "operation") this.open.push({ result: r, op: x.name, source: o.source });
      }
      runs.push({ ...base, ...this.success(small, full, bound) });
    }
  }

  /** Whether the call can succeed: a witness, a proof that it cannot (with the list bound), or undecided. */
  private success(small: { run: { status: string; example?: ProofExample }; lists: boolean }, full: { run: { status: string; example?: ProofExample } } | undefined, bound: number): Pick<ProofRun, "canSucceed" | "bound" | "witness"> {
    if (small.run.status === "sat") return { canSucceed: true, ...(small.run.example ? { witness: small.run.example } : {}) };
    if (small.run.status === "unknown") return { canSucceed: undefined };
    if (!small.lists) return { canSucceed: false };
    if (!full || bound <= SMALL) return bound <= SMALL ? { canSucceed: false, bound: SMALL } : { canSucceed: undefined, bound: SMALL };
    if (full.run.status === "sat") return { canSucceed: true, ...(full.run.example ? { witness: full.run.example } : {}) };
    return full.run.status === "unsat" ? { canSucceed: false, bound } : { canSucceed: undefined, bound: SMALL };
  }

  /**
   * Looks for the counterexamples' starting states from the factories: a factory, then up to `depth` operations that
   * succeed, then the operation with the failing check. Found → the counterexample gets the steps (`trace`).
   */
  async traces(results: ProofResult[], depth: number, budgetMs: number): Promise<void> {
    if (!this.open.length || !this.ag.factories.length) return;
    const deadline = Date.now() + budgetMs;
    const ops = this.ag.operations;
    const prefixes: string[][] = [[]];
    for (let d = 1; d <= depth; d++) for (const p of prefixes.filter((x) => x.length === d - 1)) for (const o of ops) prefixes.push([...p, o.name]);
    const pending = new Set(this.open);
    for (const f of this.ag.factories) {
      for (const prefix of prefixes) {
        if (!pending.size || Date.now() > deadline) return;
        const enc = new Encoder(new Smt(), this.ca, this.bounds(true));
        try {
          const created = this.encodeFactory(enc, f, `${f.name}:`);
          // The steps before the last one succeed: facts shared by every query on this prefix.
          enc.facts.push(created.requires, ...created.groups.map((g) => g.pass));
          let state = created.post;
          prefix.forEach((name, i) => {
            const e = this.encodeOperation(enc, ops.find((o) => o.name === name)!, state, `${i}.${name}:`);
            enc.facts.push(e.requires, ...e.groups.map((g) => g.pass));
            state = e.post;
          });
          for (const item of [...pending]) {
            if (Date.now() > deadline) return;
            const op = ops.find((o) => o.name === item.op)!;
            const last = this.encodeOperation(enc, op, state, `last.${op.name}:`);
            const at = last.groups.findIndex((g) => g.source.kind === item.source.kind && g.source.owner === item.source.owner && g.source.name === item.source.name);
            if (at < 0) continue;
            // A search, not a proof: a short limit per query (an undecided prefix is just not a trace).
            const r = await this.check(enc, [last.requires, ...last.groups.slice(0, at).map((g) => g.pass), last.groups[at]!.fail], [], undefined, Math.min(1000, this.opts.timeoutMs));
            if (r.status === "sat") {
              item.result.trace = [f.name, ...prefix, item.op];
              pending.delete(item);
            }
          }
        } catch (err) {
          if (!(err instanceof Unsupported)) throw err;
        } finally {
          this.done(enc);
        }
      }
    }
    void results;
  }
}
