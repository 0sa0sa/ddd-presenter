/**
 * Yes/no questions for a product manager's review of a model (docs/09 §27): plain statements about who may see or
 * change what, how the aggregates relate, what states they go through and what happens automatically. Each states
 * what the model currently says (`modelAnswer`), so an answer that differs is a finding: the model (or the DSL) has
 * to change. Questions the model cannot answer (`modelAnswer: "undefined"`) are there to discover what is missing,
 * such as a hierarchy of organizations the flat tenancy has no place for.
 *
 * Deterministic and derived from the model only; ids are built from element names, so answers keep their question
 * when the model is edited elsewhere.
 */
import { proofQuestions, type ProofReport } from "./proofs.ts";
import { parse as yamlParse } from "yaml";
import { referencedFields, type TExpr } from "./checker.ts";
import type { Path } from "./diagnostics.ts";
import { formatPath } from "./diagnostics.ts";
import type { AggregateIR, AuthorizeIR, ContextIR, EntityIR, FieldIR, ModelIR, SecurityIR, UseCaseIR } from "./ir.ts";
import type { QueryIR } from "./queries.ts";
import { aggregateScope, isTenantScoped, leadingLoads, makePrincipal, roleIncludes, rolePermissions, satisfies, useCaseScope, type AccessScope } from "./security.ts";
import { conditionText, describeCondition, plainName, words, type Names } from "./conditions.ts";
import { flowDiagrams, flowReviewTargets } from "./flows.ts";
import { stateMachines, type StateMachine } from "./statemachine.ts";
import type { Analysis, ContextAnalysis } from "./validate.ts";

export const REVIEW_CATEGORIES = {
  tenancy: "組織（テナント）の分離",
  access: "誰が何をできるか",
  lifecycle: "状態の移り変わり",
  relations: "つながり（エンティティ・値・参照）",
  rules: "守るべきルール",
  proofs: "断られる場合（Z3 の反例）",
  data: "入力する情報",
  automation: "自動で起きること",
  flows: "手順の流れ（フロー図）",
} as const;
export type ReviewCategory = keyof typeof REVIEW_CATEGORIES;

/** What the model says about a statement; `undefined`: the model does not say (a question to discover). */
export type ModelAnswer = "yes" | "no" | "undefined";

export interface ReviewQuestion {
  /** Stable id (category and element names): answers are keyed by it. */
  id: string;
  category: ReviewCategory;
  /** The statement to answer with yes or no (Japanese). */
  text: string;
  modelAnswer: ModelAnswer;
  /** Why the model answers so (what in the model says it). */
  basis: string;
  /** What to change when the answer differs from the model's. */
  ifDifferent: string;
  /** `Context › Element`, for finding it in the model. */
  element: string;
  /** YAML path of the element the question is about. */
  path: Path;
}

export function reviewQuestions(analysis: Analysis, opts: { proofs?: ProofReport } = {}): ReviewQuestion[] {
  const model = analysis.model;
  const out: ReviewQuestion[] = [];
  const seen = new Set<string>();
  const add = (q: ReviewQuestion) => {
    if (seen.has(q.id)) return;
    seen.add(q.id);
    out.push({ ...q, text: spaced(q.text), basis: spaced(q.basis), ifDifferent: spaced(q.ifDifferent) });
  };
  const machines = stateMachines(analysis);
  tenancyQuestions(model, analysis, add);
  for (const ca of analysis.contexts.values()) {
    accessQuestions(model, ca, add);
    for (const sm of machines.filter((m) => m.context === ca.ir.name)) lifecycleQuestions(ca, sm, add);
    relationQuestions(model, analysis, ca, add);
    ruleQuestions(ca, machines.filter((m) => m.context === ca.ir.name), add);
    dataQuestions(ca, add);
    automationQuestions(model, ca, add);
  }
  flowQuestions(analysis, add);
  // Counterexamples of the proofs (docs/09 §29): asked only when a report was computed (it needs the solver).
  if (opts.proofs) for (const q of proofQuestions(analysis, opts.proofs)) add({ ...q, category: "proofs" });
  const order = Object.keys(REVIEW_CATEGORIES);
  return out.map((q, i) => ({ q, i })).sort((a, b) => order.indexOf(a.q.category) - order.indexOf(b.q.category) || a.i - b.i).map((x) => x.q);
}

type Add = (q: ReviewQuestion) => void;

/** A space between Latin words and Japanese (「Order は」), as the docs write it. */
const spaced = (text: string) =>
  text.replace(/([A-Za-z0-9_\]])(?=[\u3040-\u30fa\u30fc-\u30ff\u4e00-\u9fff])/g, "$1 ").replace(/([\u3040-\u30fa\u30fc-\u30ff\u4e00-\u9fff])(?=[A-Za-z0-9_])/g, "$1 ");

// -- names ---------------------------------------------------------------------------

/** How an element is called in a question: its description when it has a short one, else its name. */
const called = (x: { name: string; description?: string }) => {
  const d = x.description?.trim().split("\n")[0]?.replace(/[。.]$/, "");
  return d && d.length <= 30 ? `${d}（${x.name}）` : x.name;
};
const fieldCalled = (f: FieldIR) => (f.description && f.description.length <= 30 ? `${f.description.replace(/[。.]$/, "")}（${f.name}）` : f.name);
/** `「description」（name）`, or `「name」` without a description. */
const quoted = (x: { name: string; description?: string }) => {
  const d = x.description?.trim().split("\n")[0]?.replace(/[。.]$/, "");
  return d ? `「${d}」（${x.name}）` : `「${x.name}」`;
};
const ucCalled = quoted;
const opCalled = quoted;
const el = (ctx: ContextIR, ...names: string[]) => [ctx.name, ...names].join(" › ");

const refTarget = (type: string) => /^Ref\[(\w+)\]$/.exec(type.trim())?.[1];
const listItem = (type: string) => /^List\[(.+)\]$/.exec(type.trim())?.[1]?.trim();

// -- organizations (tenancy) -----------------------------------------------------------

function tenancyQuestions(model: ModelIR, analysis: Analysis, add: Add): void {
  const security = model.security;
  const tenancy = security?.tenancy;
  const sp: Path = security ? [...security.path] : ["security"];
  if (!tenancy) {
    add({
      id: "tenancy:multi-organization",
      category: "tenancy",
      text: "このシステムは複数の組織（会社）が使い、組織ごとにデータを分ける。",
      modelAnswer: "no",
      basis: security ? "security.tenancy がないので、すべてのデータを一つの組織のものとして扱う。" : "security（認証・認可）も security.tenancy もない。",
      ifDifferent: "security.tenancy（claim・type）を宣言し、組織で分ける Aggregate を決める（共有するものは tenancy: global）。",
      element: "security",
      path: sp,
    });
    return;
  }
  const claim = tenancy.claim;
  for (const ca of analysis.contexts.values()) {
    const ctx = ca.ir;
    for (const ag of ctx.aggregates) {
      const name = called(ag);
      if (isTenantScoped(security, ag)) {
        add({
          id: `tenancy:read-other:${ctx.name}.${ag.name}`,
          category: "tenancy",
          text: `ある組織のユーザーは、別の組織の${name}を見られる。`,
          modelAnswer: "no",
          basis: `${ag.name} は組織ごとに保存され（tenant_id 列${tenancy.rls ? "と行レベルセキュリティ" : ""}）、読み書きはトークンの ${claim} が示す組織の中だけで行われる。`,
          ifDifferent: `組織をまたいで見せるなら ${ag.name} を tenancy: global にするか、運営側のロール（platform_roles）と cross_tenant の Use case を用意する。`,
          element: el(ctx, ag.name),
          path: ag.path,
        });
        if (ctx.useCases.some((uc) => touches(uc, ag.name, true))) {
          add({
            id: `tenancy:change-other:${ctx.name}.${ag.name}`,
            category: "tenancy",
            text: `ある組織のユーザーは、別の組織の${name}を変更できる。`,
            modelAnswer: "no",
            basis: `${ag.name} を変える Use case は、アクティブな組織（${claim}）の ${ag.name} だけを読み込み、保存する。`,
            ifDifferent: "組織をまたいで変更する操作は、cross_tenant の Use case と運営側のロール（platform_roles）で表す。",
            element: el(ctx, ag.name),
            path: ag.path,
          });
        }
      } else {
        add({
          id: `tenancy:shared:${ctx.name}.${ag.name}`,
          category: "tenancy",
          text: `${name}はすべての組織で共有され、どの組織のユーザーにも同じものが見える。`,
          modelAnswer: "yes",
          basis: `${ag.name} は tenancy: global（組織に属さない共有のデータ）。`,
          ifDifferent: `組織ごとに分けるなら ${ag.name} の tenancy: global を外す。`,
          element: el(ctx, ag.name),
          path: ag.path,
        });
      }
    }
  }
  add({
    id: "tenancy:hierarchy",
    category: "tenancy",
    text: "組織には親子関係（本社と支社、部と課のような配下の組織）がある。",
    modelAnswer: "undefined",
    basis: "モデルの組織は平らで、組織どうしの関係を持たない（security.tenancy は 1 つの組織 ID だけを扱う）。",
    ifDifferent: "親子関係があるなら、組織を表す Aggregate（親の組織への Ref）を足し、配下の組織の扱いを Use case と allow_if で決める。DSL に組織の階層の書き方を足す検討も必要。",
    element: "security › tenancy",
    path: tenancy.path,
  });
  add({
    id: "tenancy:parent-reads-children",
    category: "tenancy",
    text: "上位の組織の管理者は、配下の組織のメンバーやデータをすべて見られる。",
    modelAnswer: "no",
    basis: `データは組織（${claim}）ごとに完全に分かれていて、上位・配下という関係もないので、ほかの組織のデータは見えない。`,
    ifDifferent: "組織の階層をモデルに足し、配下の組織を読む Use case（またはクエリ）を、上位の組織の管理者のロールで許す。",
    element: "security › tenancy",
    path: tenancy.path,
  });
  add({
    id: "tenancy:multiple-memberships",
    category: "tenancy",
    text: "1 人のユーザーが複数の組織に所属し、組織を切り替えて使える。",
    modelAnswer: "undefined",
    basis: `モデルはトークンの ${claim}（いま操作している組織）だけを見る。どの組織に所属できるか・切り替えられるかは認証基盤で決まり、モデルにはない。`,
    ifDifferent: "所属の管理（招待・退会・切り替え）を認証基盤で行うか、所属を表す Aggregate をモデルに足すかを決める。",
    element: "security › tenancy",
    path: tenancy.path,
  });
  if (security.platformRoles.length) {
    add({
      id: "tenancy:platform-roles-inside",
      category: "tenancy",
      text: `運営側のロール（${security.platformRoles.map((r) => r.name).join("・")}）は、cross_tenant と書いた操作のほかに、組織の中の通常の操作もできる。`,
      modelAnswer: "no",
      basis: "運営側のロールは組織に属さず、cross_tenant の Use case（と共有のデータ）でだけ効く。",
      ifDifferent: "組織の中の操作も許すなら、その組織のロールを運営者にも割り当てるか、該当の Use case を cross_tenant にする。",
      element: "security › platform_roles",
      path: [...security.path, "platform_roles"],
    });
  }
}

/** Whether a use case loads or creates the aggregate (and, with `changes`, saves it). */
function touches(uc: UseCaseIR, aggregate: string, changes = false): boolean {
  const vars = new Map<string, string>();
  let found = false;
  const walk = (steps: UseCaseIR["steps"]) => {
    for (const s of steps) {
      if (s.kind === "load" || s.kind === "create") {
        vars.set(s.as, s.aggregate);
        if (!changes && s.aggregate === aggregate) found = true;
        if (changes && s.kind === "create" && s.aggregate === aggregate) found = true;
      }
      if (changes && s.kind === "save" && vars.get(s.target) === aggregate) found = true;
      if (s.kind === "if") {
        walk(s.then);
        walk(s.else);
      }
    }
  };
  walk(uc.steps);
  return found;
}

// -- access --------------------------------------------------------------------------

interface RoleRef {
  name: string;
  kind: "tenant" | "platform";
}

function rolesOf(security: SecurityIR): RoleRef[] {
  return [...security.roles.map((name) => ({ name, kind: "tenant" as const })), ...security.platformRoles.map((r) => ({ name: r.name, kind: "platform" as const }))];
}

function accessQuestions(model: ModelIR, ca: ContextAnalysis, add: Add): void {
  const security = model.security;
  const ctx = ca.ir;
  if (!security) {
    if (ctx.useCases.length && ctx === model.contexts[0]) {
      add({
        id: "access:no-login",
        category: "access",
        text: "ログインしなくても、すべての操作ができる。",
        modelAnswer: "yes",
        basis: "security（認証・認可）が宣言されていないので、生成される API は誰でも呼べる。",
        ifDifferent: "security を宣言し、Use case と Aggregate ごとに authorize（ロール・権限・条件）を書く。",
        element: ctx.name,
        path: ["security"],
      });
    }
    return;
  }
  if (ctx === model.contexts[0]) roleHierarchyQuestions(security, add);
  for (const uc of ctx.useCases) {
    const a = uc.authorize;
    if (!a) continue;
    const name = ucCalled(uc);
    const base = { category: "access" as const, element: el(ctx, uc.name), path: a.path };
    if (a.kind === "internal") {
      add({
        ...base,
        id: `access:internal:${ctx.name}.${uc.name}`,
        text: `${name}は、画面や API からは実行できず、システムの中（自動の処理）からだけ実行される。`,
        modelAnswer: "yes",
        basis: "authorize: internal（HTTP では公開しない）。",
        ifDifferent: "人が実行するなら authorize にロールか権限を書く。",
      });
      continue;
    }
    if (a.kind === "public") {
      add({
        ...base,
        id: `access:public:${ctx.name}.${uc.name}`,
        text: `ログインしていない人も${name}を実行できる。`,
        modelAnswer: "yes",
        basis: "authorize: public。",
        ifDifferent: "ログインを必須にするなら authorize: authenticated か、ロール・権限を書く。",
      });
      continue;
    }
    const scope = useCaseScope(security, ctx, uc);
    const allowIf = ca.exprs.get(formatPath([...a.path, "allow_if"]));
    // Inputs and the leading loads are the variables allow_if reads.
    const locals = Object.fromEntries([
      ...uc.input.map((f) => [f.name, `入力の ${f.name}`]),
      ...leadingLoads(uc.steps).map((l) => {
        const t = ctx.aggregates.find((x) => x.name === l.aggregate);
        return [l.as, t ? plainName(t) : l.aggregate];
      }),
    ]);
    principalQuestions(security, a, scope, allowIf, { id: `${ctx.name}.${uc.name}`, subject: name, verb: "を実行できる", base, names: { locals } }, add);
  }
  for (const ag of ctx.aggregates) {
    const a = ag.authorize;
    if (!a || a.kind === "internal") continue;
    const base = { category: "access" as const, element: el(ctx, ag.name), path: a.path };
    if (a.kind === "public") {
      add({
        ...base,
        id: `access:public-read:${ctx.name}.${ag.name}`,
        text: `ログインしていない人も、ID を指定して${called(ag)}を見られる。`,
        modelAnswer: "yes",
        basis: "Aggregate の authorize: public。",
        ifDifferent: "ログインを必須にするなら authorize にロールか権限を書く。",
      });
      continue;
    }
    const allowIf = ca.exprs.get(formatPath([...a.path, "allow_if"]));
    principalQuestions(security, a, aggregateScope(security, ag), allowIf, { id: `${ctx.name}.${ag.name}:read`, subject: called(ag), verb: "を（ID を指定して）見られる", base, names: { self: plainName(ag) } }, add);
  }
  for (const q of ctx.queries) queryQuestions(security, ca, q, add);
}

function roleHierarchyQuestions(security: SecurityIR, add: Add): void {
  for (const r of security.roleDefs ?? []) {
    for (const parent of r.inherits) {
      add({
        id: `access:inherits:${r.name}.${parent}`,
        category: "access",
        text: `${r.name} は、${parent} ができることをすべてできる。`,
        modelAnswer: "yes",
        basis: `${r.name} は ${parent} を継承する（inherits）。`,
        ifDifferent: `inherits から ${parent} を外し、${r.name} に要る権限だけを並べる。`,
        element: `security › roles › ${r.name}`,
        path: r.path,
      });
    }
  }
}

/**
 * Questions for an authorize block that needs a principal: per role, whether it may at all, and when `allow_if`
 * still depends on the data, under which condition.
 */
function principalQuestions(
  security: SecurityIR,
  a: AuthorizeIR,
  scope: AccessScope,
  allowIf: TExpr | undefined,
  what: { id: string; subject: string; verb: string; base: { category: "access"; element: string; path: Path }; names?: Names },
  add: Add,
): void {
  const open = !a.roles.length && !a.permissions?.length;
  const items = [...a.roles.map((r) => `${r} のロール`), ...(a.permissions ?? []).map((p) => `${p} の権限`)];
  const listed = items.length === 1 ? items[0]! : `${items.join("・")}のどれか`;
  for (const role of rolesOf(security)) {
    // Platform roles act only across tenants (cross_tenant use cases) and on shared data.
    if (role.kind === "platform" && scope !== "cross_tenant" && scope !== "global") continue;
    if (role.kind === "tenant" && scope === "cross_tenant") continue;
    const p = makePrincipal(security, { roles: role.kind === "tenant" ? [role.name] : [], platformRoles: role.kind === "platform" ? [role.name] : [], claims: {} });
    const passes = satisfies(security, a, p, scope);
    const who = role.kind === "platform" ? `運営側の ${role.name}` : role.name;
    const where = scope === "cross_tenant" ? "（指定した組織に対して）" : "";
    const id = `access:${role.name}:${what.id}`;
    if (!passes) {
      add({
        ...what.base,
        id,
        text: `${who} は${where}${what.subject}${what.verb}。`,
        modelAnswer: "no",
        basis: `許可されているのは ${listed}を持つ人だけで、${role.name} は持たない。`,
        ifDifferent: `${role.name} にも許すなら、authorize に ${role.name} か、${role.name} が持つ権限を足す。`,
      });
      continue;
    }
    const residual = allowIf ? partial(allowIf, security, role) : true;
    const reason = open ? "ログインしていれば誰でもよい。" : `${listed}を持つ人に許可されている。`;
    if (residual === true) {
      add({ ...what.base, id, text: `${who} は${where}${what.subject}${what.verb}。`, modelAnswer: "yes", basis: reason + (allowIf ? ` allow_if は ${role.name} なら常に成り立つ。` : ""), ifDifferent: `${role.name} には許さないなら、authorize から外す（または allow_if で除く）。` });
      continue;
    }
    if (residual === false) {
      add({ ...what.base, id, text: `${who} は${where}${what.subject}${what.verb}。`, modelAnswer: "no", basis: `${reason} ただし allow_if が ${role.name} では成り立たない。`, ifDifferent: "allow_if を見直す。" });
      continue;
    }
    const cond = conditionText(residual, what.names, a.allowIf ?? "");
    add({
      ...what.base,
      id: `${id}:when`,
      text: `${who} は、${cond}ときだけ${where}${what.subject}${what.verb}。`,
      modelAnswer: "yes",
      basis: `${reason} さらに allow_if（${role.name} の場合: ${cond}）が成り立つ必要がある。`,
      ifDifferent: "条件が違うなら allow_if を直す。",
    });
    add({
      ...what.base,
      id: `${id}:always`,
      text: `${who} は、条件なしで${where}${what.subject}${what.verb}。`,
      modelAnswer: "no",
      basis: `allow_if により、${cond}ときに限られる。`,
      ifDifferent: `${role.name} には条件なしで許すなら、allow_if に has_role(principal, ${role.name}) を or で足す。`,
    });
  }
}

/** `allow_if` with the role's has_role / has_permission decided: true, false, or what still depends on the data. */
function partial(e: TExpr, security: SecurityIR, role: RoleRef): TExpr | boolean {
  switch (e.t) {
    case "hasRole":
      return (roleIncludes(security, role.kind).get(role.name) ?? [role.name]).includes(e.role);
    case "hasPermission":
      return (rolePermissions(security, role.kind).get(role.name) ?? []).includes(e.permission);
    case "lit":
      return typeof e.value === "boolean" ? e.value : e;
    case "not": {
      const v = partial(e.operand, security, role);
      return typeof v === "boolean" ? !v : { ...e, operand: v };
    }
    case "binary": {
      if (e.op !== "and" && e.op !== "or") return e;
      const l = partial(e.left, security, role);
      const r = partial(e.right, security, role);
      if (e.op === "and") {
        if (l === false || r === false) return false;
        if (l === true) return r;
        if (r === true) return l;
      } else {
        if (l === true || r === true) return true;
        if (l === false) return r;
        if (r === false) return l;
      }
      return { ...e, left: l as TExpr, right: r as TExpr };
    }
    default:
      return e;
  }
}

function queryQuestions(security: SecurityIR, ca: ContextAnalysis, q: QueryIR, add: Add): void {
  const ctx = ca.ir;
  const a = q.authorize;
  if (!a) return;
  const subject = quoted(q);
  const base = { category: "access" as const, element: el(ctx, q.name), path: a.path };
  if (a.kind === "public") {
    add({ ...base, id: `access:public-query:${ctx.name}.${q.name}`, text: `ログインしていない人も${subject}の一覧を見られる。`, modelAnswer: "yes", basis: "クエリの authorize: public。", ifDifferent: "ログインを必須にするなら authorize にロールか権限を書く。" });
  } else {
    const ag = ctx.aggregates.find((x) => x.name === q.from);
    principalQuestions(security, a, ag ? aggregateScope(security, ag) : "none", undefined, { id: `${ctx.name}.${q.name}:query`, subject, verb: "の一覧を見られる", base }, add);
  }
  for (const f of q.where.filter((w) => w.principal)) {
    add({
      ...base,
      id: `access:own-rows:${ctx.name}.${q.name}.${f.field}`,
      text: `${subject}には、${f.field} が本人の ${f.principal} と${f.op === "eq" ? "同じ" : "合う"}ものだけが出る（ほかの人の分は出ない）。`,
      modelAnswer: "yes",
      basis: `where に { field: ${f.field}, principal: ${f.principal} } がある。`,
      ifDifferent: "ほかの人の分も出すなら、この絞り込みを外す（ロールで分けるなら別のクエリにする）。",
      path: f.path,
    });
  }
}

// -- states -------------------------------------------------------------------------

function lifecycleQuestions(ca: ContextAnalysis, sm: StateMachine, add: Add): void {
  const ctx = ca.ir;
  const ag = ctx.aggregates.find((a) => a.name === sm.aggregate)!;
  const name = called(ag);
  const key = `${ctx.name}.${ag.name}.${sm.field}`;
  const base = { category: "lifecycle" as const, element: el(ctx, ag.name, sm.field) };
  const states = (xs: string[]) => xs.map((s) => `「${s}」`).join("・");
  if (sm.hasFactory && sm.initial.length) {
    add({
      ...base,
      id: `lifecycle:initial:${key}`,
      text: sm.initial.length === 1 ? `${name}は、作られた時点で必ず「${sm.initial[0]}」である。` : `${name}は、${states(sm.initial)}のどれかで作られる。`,
      modelAnswer: "yes",
      basis: `Factory（${ag.factories.map((f) => f.name).join("・")}）が ${sm.field} を ${sm.initial.join(" / ")} にする。`,
      ifDifferent: `Factory の ${sm.field} を直す。`,
      path: ag.factories[0]!.path,
    });
  }
  for (const t of sm.transitions) {
    if (t.keepsState && t.unguarded) continue;
    const op = ag.operations.find((o) => o.name === t.operation)!;
    const guards = op.require.map((r) => r.replace(/\(.*$/, "")).map((g) => ag.stateGuards.find((x) => x.name === g)).filter((g) => !!g);
    const guardText = guards.map((g) => (g!.description ? `「${g!.description}」（${g!.name}）` : g!.name)).join("・");
    // In a statement, a guard without a description reads as its condition.
    // Guards that read only the state are already met in that state; the condition is what is left.
    const onlyState = (g: (typeof guards)[number]) => {
      const body = ca.exprs.get(formatPath([...g!.path, "expression"]));
      return !g!.parameters.length && !!body && [...referencedFields(body)].every((f) => f === sm.field);
    };
    const guardWords = guards.filter((g) => !onlyState(g)).map((g) => (g!.description ? `「${g!.description}」（${g!.name}）` : `「${g!.expression}」`)).join("かつ");
    for (const s of sm.reachable) {
      const ok = t.from.includes(s);
      // Allowed in this state only when the rest of the guard holds (a deadline, another field): say so.
      const when = ok && t.conditional.includes(s);
      add({
        ...base,
        id: `lifecycle:can:${key}.${t.operation}.${s}`,
        text: when ? `「${s}」の${name}は、${guardWords}のときなら、${opCalled(op)}ができる。` : `「${s}」の${name}に対して、${opCalled(op)}ができる。`,
        modelAnswer: ok ? "yes" : "no",
        basis: ok
          ? when
            ? `${t.operation} の条件 ${guardText} は「${s}」で成り立ちうる（状態のほかの部分は実行時に確かめる）。`
            : guards.length
              ? `${t.operation} の条件 ${guardText} は「${s}」なら成り立つ。`
              : `${t.operation} にはいまの状態の条件（require）がない。`
          : `${t.operation} の条件 ${guardText} が「${s}」では成り立たない。`,
        ifDifferent: ok ? `「${s}」では許さないなら、${t.operation} の require に状態の条件（State guard）を足す。` : `「${s}」でも許すなら、${t.operation} の require の State guard を見直す。`,
        path: op.path,
      });
    }
  }
  for (const s of sm.terminal) {
    add({
      ...base,
      id: `lifecycle:final:${key}.${s}`,
      text: `一度「${s}」になった${name}は、その後ほかの状態に変わらない。`,
      modelAnswer: "yes",
      basis: `「${s}」から ${sm.field} を変える操作がない。`,
      ifDifferent: `「${s}」から戻す・進める操作（Operation）を足す。`,
      path: sm.path,
    });
  }
  // Going back: a state reached from another that has no way back to it.
  for (const t of sm.transitions) {
    if (t.keepsState) continue;
    for (const from of t.from.filter((s) => sm.reachable.includes(s))) {
      for (const to of t.to.filter((s) => s !== from && !sm.terminal.includes(s))) {
        const back = sm.transitions.some((x) => !x.keepsState && x.from.includes(to) && x.to.includes(from));
        if (back) continue;
        add({
          ...base,
          id: `lifecycle:back:${key}.${to}.${from}`,
          text: `「${to}」になった${name}を、「${from}」に戻せる。`,
          modelAnswer: "no",
          basis: `「${to}」から「${from}」に変える操作がない。`,
          ifDifferent: `戻せるなら、「${to}」から ${sm.field}: ${from} にする操作を足す。`,
          path: sm.path,
        });
      }
    }
  }
  for (const s of sm.unreachable) {
    add({
      ...base,
      id: `lifecycle:reachable:${key}.${s}`,
      text: `${name}が「${s}」になることがある。`,
      modelAnswer: "no",
      basis: `${sm.enumName} に「${s}」はあるが、作るときも操作でも「${s}」にならない（警告 unreachable-state）。`,
      ifDifferent: `「${s}」にする操作を足す。そうでなければ ${sm.enumName} から「${s}」を消す。`,
      path: sm.path,
    });
  }
  add({
    ...base,
    id: `lifecycle:delete:${ctx.name}.${ag.name}`,
    text: `${name}を完全に削除することがある。`,
    modelAnswer: "undefined",
    basis: "モデルには削除の操作がない（状態で終わりを表す）。",
    ifDifferent: "削除が要るなら、いつ・誰が・関係するデータをどうするかを決める（削除の代わりに状態で表すことも多い）。",
    path: ag.path,
  });
}

// -- how things are connected --------------------------------------------------------

function relationQuestions(model: ModelIR, analysis: Analysis, ca: ContextAnalysis, add: Add): void {
  const ctx = ca.ir;
  const aggregates = new Map(ctx.aggregates.map((a) => [a.name, a]));
  for (const ag of ctx.aggregates) {
    const name = called(ag);
    for (const f of ag.fields) {
      if (f.name === ag.identity) continue;
      const base = { category: "relations" as const, element: el(ctx, ag.name, f.name), path: f.path };
      const one = refTarget(f.type);
      const many = listItem(f.type) && refTarget(listItem(f.type)!);
      const guessed = !one && !many ? guessedRef(ctx, ag, f) : undefined;
      const target = one ?? guessed?.name;
      if (target) {
        const t = aggregates.get(target);
        const tName = t ? called(t) : target;
        add({
          ...base,
          id: `relations:belongs:${ctx.name}.${ag.name}.${f.name}`,
          text: `${name}は、必ず 1 つの${tName}に紐づく（${tName}なしでは存在しない）。`,
          modelAnswer: f.required ? "yes" : "no",
          basis: `${f.name}: ${f.type}${f.required ? "（必須）" : "（省略できる）"}${guessed ? `。型は UUID だが、名前から ${target} を指すと読んだ` : ""}。`,
          ifDifferent: f.required ? `紐づかない場合があるなら ${f.name} を required: false にする。` : `必ず紐づくなら ${f.name} を必須にする。`,
        });
        add({
          ...base,
          id: `relations:many-per:${ctx.name}.${ag.name}.${f.name}`,
          text: `1 つの${tName}に、複数の${name}が紐づくことがある。`,
          modelAnswer: "yes",
          basis: `${ag.name}.${f.name} が同じ ${target} を指すことを禁じるルールがない。`,
          ifDifferent: `1 つだけなら、その決まりを Use case（既存のものを探して失敗する）か Invariant で表す。`,
        });
        if (t && model.security?.tenancy && isTenantScoped(model.security, ag) !== isTenantScoped(model.security, t)) {
          add({
            ...base,
            id: `relations:tenant-mix:${ctx.name}.${ag.name}.${f.name}`,
            text: `組織ごとの${isTenantScoped(model.security, ag) ? name : tName}が、全組織で共有する${isTenantScoped(model.security, ag) ? tName : name}を指す。`,
            modelAnswer: "yes",
            basis: `${ag.name} と ${target} で tenancy が違う（片方が global）。`,
            ifDifferent: "どちらも組織ごと（または共有）にそろえる。",
          });
        }
        continue;
      }
      if (many) {
        const t = aggregates.get(many);
        add({
          ...base,
          id: `relations:refs-many:${ctx.name}.${ag.name}.${f.name}`,
          text: `1 つの${name}は、複数の${t ? called(t) : many}を指せる。`,
          modelAnswer: "yes",
          basis: `${f.name}: ${f.type}${f.constraints.max_items !== undefined ? `（最大 ${f.constraints.max_items}）` : ""}。`,
          ifDifferent: `1 つだけなら ${f.name} を Ref[${many}] にする。`,
        });
      }
    }
    for (const en of ag.entities) entityQuestions(ca, ag, en, add);
  }
  // Value objects used by several aggregates (in any context): the same meaning and rules everywhere.
  if (ctx === analysis.model.contexts[0]) {
    const users = new Map<string, string[]>();
    for (const c of analysis.model.contexts) {
      for (const ag of c.aggregates) {
        for (const f of [...ag.fields, ...ag.entities.flatMap((e) => e.fields)]) {
          const vo = c.valueObjects.find((v) => v.name === (listItem(f.type) ?? f.type.trim()));
          if (vo) users.set(vo.name, [...new Set([...(users.get(vo.name) ?? []), `${c.name}.${ag.name}`])]);
        }
      }
    }
    for (const [vo, list] of users) {
      if (list.length < 2) continue;
      add({
        id: `relations:shared-value:${vo}`,
        category: "relations",
        text: `${vo} は、${list.map((x) => x.split(".")[1]).join("・")} で同じ意味・同じ決まり（形式・長さ）で使う。`,
        modelAnswer: "yes",
        basis: `${list.join("・")} が同じ Value Object ${vo} を使う。`,
        ifDifferent: "意味や決まりが違うなら、それぞれに別の Value Object を作る。",
        element: vo,
        path: ["contexts"],
      });
    }
  }
  for (const vo of ctx.valueObjects) {
    for (const [field, steps] of Object.entries(vo.normalize)) {
      const base = { category: "relations" as const, element: el(ctx, vo.name, field), path: vo.path };
      const subject = vo.fields.length > 1 ? `${called(vo)}の ${field}` : called(vo);
      if (steps.includes("lower") || steps.includes("upper")) {
        add({ ...base, id: `relations:case:${ctx.name}.${vo.name}.${field}`, text: `${subject}は、大文字と小文字を区別しない（「A」と「a」は同じものとして扱う）。`, modelAnswer: "yes", basis: `normalize: ${field}: [${steps.join(", ")}]。`, ifDifferent: `区別するなら normalize から ${steps.includes("lower") ? "lower" : "upper"} を外す。` });
      }
      if (steps.includes("strip")) {
        add({ ...base, id: `relations:strip:${ctx.name}.${vo.name}.${field}`, text: `${subject}の前後の空白は無視する。`, modelAnswer: "yes", basis: `normalize: ${field}: [${steps.join(", ")}]。`, ifDifferent: "空白も意味を持つなら normalize から strip を外す。" });
      }
    }
  }
  // Values that look like they should be unique (email, code, number, slug) but nothing makes them so.
  for (const ag of ctx.aggregates) {
    for (const f of ag.fields) {
      if (f.name === ag.identity || !/(^|_)(email|code|number|slug|username|login)($|_)/.test(f.name)) continue;
      add({
        id: `relations:unique:${ctx.name}.${ag.name}.${f.name}`,
        category: "relations",
        text: `同じ ${f.name} を持つ${called(ag)}が 2 つ以上あってもよい。`,
        modelAnswer: "yes",
        basis: `${ag.name}.${f.name} を一意にするルールがない。`,
        ifDifferent: "一意にするなら、作る Use case で同じ値のものを探して失敗させる（クエリかリポジトリの検索を足す）。",
        element: el(ctx, ag.name, f.name),
        path: f.path,
      });
    }
  }
}

/** The fewest and most items an aggregate's invariants allow in a list field (`not is_empty(f)`, `count(f) <= 50`). */
function countBounds(ca: ContextAnalysis, ag: AggregateIR, field: string): { min?: number; max?: number; minRule?: string; maxRule?: string } {
  const out: { min?: number; max?: number; minRule?: string; maxRule?: string } = {};
  const isField = (e: TExpr) => e.t === "field" && !e.owner && e.name === field;
  const counted = (e: TExpr) => e.t === "builtin" && (e.fn === "count" || e.fn === "length") && e.args.length === 1 && isField(e.args[0]!);
  const conj = (e: TExpr): TExpr[] => (e.t === "binary" && e.op === "and" ? [...conj(e.left), ...conj(e.right)] : [e]);
  for (const inv of ag.invariants) {
    const e = ca.exprs.get(formatPath([...inv.path, "expression"]));
    if (!e) continue;
    for (const c of conj(e)) {
      if (c.t === "not" && c.operand.t === "builtin" && c.operand.fn === "is_empty" && isField(c.operand.args[0]!)) {
        out.min = Math.max(out.min ?? 0, 1);
        out.minRule = inv.name;
      }
      if (c.t !== "binary" || !counted(c.left) || c.right.t !== "lit" || typeof c.right.value !== "number") continue;
      const n = c.right.value;
      if (c.op === ">=" || c.op === ">") {
        out.min = Math.max(out.min ?? 0, c.op === ">" ? n + 1 : n);
        out.minRule = inv.name;
      }
      if (c.op === "<=" || c.op === "<") {
        out.max = Math.min(out.max ?? Infinity, c.op === "<" ? n - 1 : n);
        out.maxRule = inv.name;
      }
    }
  }
  return out;
}

function entityQuestions(ca: ContextAnalysis, ag: AggregateIR, en: EntityIR, add: Add): void {
  const ctx = ca.ir;
  const holder = ag.fields.find((f) => f.type.trim() === en.name || listItem(f.type) === en.name);
  const base = { category: "relations" as const, element: el(ctx, ag.name, en.name), path: en.path };
  add({
    ...base,
    id: `relations:part-of:${ctx.name}.${ag.name}.${en.name}`,
    text: `${called(en)}は${called(ag)}の一部で、${ag.name} を通さずに単独で作ったり変えたりすることはない。`,
    modelAnswer: "yes",
    basis: `${en.name} は Aggregate ${ag.name} の中の Entity。変更は ${ag.name} の操作だけで行われ、${ag.name} と一緒に保存される。`,
    ifDifferent: `単独で扱うなら、${en.name} を別の Aggregate にして ${ag.name} からは ID（Ref）で指す。`,
  });
  if (holder && listItem(holder.type) === en.name) {
    const byRule = countBounds(ca, ag, holder.name);
    const min = Math.max(holder.constraints.min_items ?? 0, byRule.min ?? 0);
    const max = Math.min(holder.constraints.max_items ?? Infinity, byRule.max ?? Infinity);
    const c = holder.constraints;
    const minBy = [...(c.min_items ? [`min_items: ${c.min_items}`] : []), ...(byRule.minRule ? [`Invariant ${byRule.minRule}`] : [])].join("・");
    const maxBy = [...(c.max_items !== undefined ? [`max_items: ${c.max_items}`] : []), ...(byRule.maxRule ? [`Invariant ${byRule.maxRule}`] : [])].join("・");
    add({
      ...base,
      id: `relations:entity-none:${ctx.name}.${ag.name}.${en.name}`,
      text: `${called(en)}を 1 つも持たない${called(ag)}がある。`,
      modelAnswer: min > 0 ? "no" : "yes",
      basis: min > 0 ? `${minBy} により、少なくとも ${min} 個。` : `${holder.name}: ${holder.type} に最小の数の決まりがない。`,
      ifDifferent: min > 0 ? "0 個も許すなら、その決まり（min_items / Invariant）を外す。" : `少なくとも 1 つ要るなら ${holder.name} に min_items: 1 を書く。`,
      path: holder.path,
    });
    add({
      ...base,
      id: `relations:entity-max:${ctx.name}.${ag.name}.${en.name}`,
      text: `1 つの${called(ag)}が持てる${called(en)}の数に上限がある。`,
      modelAnswer: Number.isFinite(max) ? "yes" : "no",
      basis: Number.isFinite(max) ? `${maxBy} により、最大 ${max} 個。` : "max_items も、数を制限する Invariant もない。",
      ifDifferent: Number.isFinite(max) ? "上限がないなら、その決まり（max_items / Invariant）を外す。" : "上限があるなら max_items を書く。",
      path: holder.path,
    });
  }
}

/** The aggregate a UUID field named `<aggregate>_id` (`job_id` → Job) most likely refers to. */
function guessedRef(ctx: ContextIR, ag: AggregateIR, f: FieldIR): AggregateIR | undefined {
  if (!/_id$/.test(f.name) || f.type.trim() !== "UUID") return undefined;
  return ctx.aggregates.find((a) => a !== ag && toSnake(a.name) === f.name.replace(/_id$/, ""));
}

const toSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

// -- rules ---------------------------------------------------------------------------

function ruleQuestions(ca: ContextAnalysis, machines: StateMachine[], add: Add): void {
  const ctx = ca.ir;
  const owners = [...ctx.valueObjects, ...ctx.aggregates.flatMap((a) => [a, ...a.entities])];
  for (const o of owners) {
    for (const inv of o.invariants) {
      add({
        id: `rules:invariant:${ctx.name}.${o.name}.${inv.name}`,
        category: "rules",
        text: `${called(o)}では、いつでも「${inv.description?.replace(/[。.]$/, "") || inv.expression}」が成り立つ。`,
        modelAnswer: "yes",
        basis: `Invariant ${inv.name}: ${inv.expression}（破ると ${inv.error}）。`,
        ifDifferent: "例外があるなら Invariant の式を直すか、特定の操作の前だけの条件（State guard）にする。",
        element: el(ctx, o.name, inv.name),
        path: inv.path,
      });
    }
  }
  for (const ag of ctx.aggregates) {
    for (const op of ag.operations) {
      for (const req of op.require) {
        const g = ag.stateGuards.find((x) => x.name === req.replace(/\(.*$/, ""));
        if (!g) continue;
        // A guard that reads only the state is already asked state by state (lifecycle).
        const body = ca.exprs.get(formatPath([...g.path, "expression"]));
        const read = body ? [...referencedFields(body)] : [];
        const stateField = machines.find((m) => m.aggregate === ag.name && read.length === 1 && read[0] === m.field);
        if (stateField && !g.parameters.length) continue;
        add({
          id: `rules:guard:${ctx.name}.${ag.name}.${op.name}.${g.name}`,
          category: "rules",
          text: `${opCalled(op)}ができるのは、「${g.description?.replace(/[。.]$/, "") || g.expression}」のときだけ。`,
          modelAnswer: "yes",
          basis: `${op.name} の require: ${req}（${g.expression}、満たさないと ${g.error}）。`,
          ifDifferent: "条件が違うなら State guard の式を直す。条件がないなら require から外す。",
          element: el(ctx, ag.name, op.name),
          path: op.path,
        });
      }
    }
  }
}

// -- data ----------------------------------------------------------------------------

function dataQuestions(ca: ContextAnalysis, add: Add): void {
  const ctx = ca.ir;
  for (const ag of ctx.aggregates) {
    const stateFields = new Set(ag.fields.filter((f) => ctx.enums.some((e) => e.name === f.type.trim())).map((f) => f.name));
    for (const f of ag.fields) {
      if (f.name === ag.identity || refTarget(f.type) || guessedRef(ctx, ag, f) || stateFields.has(f.name)) continue;
      const base = { category: "data" as const, element: el(ctx, ag.name, f.name), path: f.path };
      add({
        ...base,
        id: `data:required:${ctx.name}.${ag.name}.${f.name}`,
        text: `${called(ag)}の${fieldCalled(f)}は、必ず値がある（空にできない）。`,
        modelAnswer: f.required ? "yes" : "no",
        basis: f.required ? `${f.name} は必須。` : `${f.name} は required: false（なくてもよい）。`,
        ifDifferent: f.required ? `空を許すなら ${f.name} に required: false を書く。` : `必須なら ${f.name} の required: false を外す。`,
      });
      const c = f.constraints;
      if (c.max_length !== undefined) {
        add({ ...base, id: `data:max-length:${ctx.name}.${ag.name}.${f.name}`, text: `${fieldCalled(f)}は ${c.max_length} 文字まで。`, modelAnswer: "yes", basis: `max_length: ${c.max_length}。`, ifDifferent: "上限を直す。" });
      }
      if (c.min !== undefined || c.max !== undefined) {
        const range = `${c.min ?? ""}〜${c.max ?? ""}`;
        add({ ...base, id: `data:range:${ctx.name}.${ag.name}.${f.name}`, text: `${fieldCalled(f)}は ${range} の範囲に収まる。`, modelAnswer: "yes", basis: `${c.min !== undefined ? `min: ${c.min} ` : ""}${c.max !== undefined ? `max: ${c.max}` : ""}。`, ifDifferent: "範囲を直す。" });
      }
    }
  }
}

// -- what happens by itself ----------------------------------------------------------

function automationQuestions(model: ModelIR, ca: ContextAnalysis, add: Add): void {
  const ctx = ca.ir;
  for (const p of ctx.policies) {
    const uc = ctx.useCases.find((u) => u.name === p.run);
    add({
      id: `automation:policy:${ctx.name}.${p.name}`,
      category: "automation",
      text: `${p.when.includes(".") ? `${p.when.split(".")[0]} の「${p.when.split(".")[1]}」` : `「${p.when}」`}が起きたら、自動で${uc ? ucCalled(uc) : `「${p.run}」`}が行われる。`,
      modelAnswer: "yes",
      basis: `ポリシー ${p.name}: when ${p.when} → run ${p.run}。`,
      ifDifferent: "自動でなく人が判断するなら、ポリシーを外す。",
      element: el(ctx, p.name),
      path: p.path,
    });
  }
  // Events nothing reacts to: is there really nothing else to do (notify, update another context, …)?
  const consumed = new Set(
    model.contexts.flatMap((c) =>
      c.policies.map((p) => {
        const [a, b] = p.when.split(".");
        return b ? `${a}.${b}` : `${c.name}.${a}`;
      }),
    ),
  );
  for (const [name, info] of ca.events) {
    if (consumed.has(`${ctx.name}.${name}`)) continue;
    const src = info.sources[0];
    const owner = src && ctx.aggregates.find((a) => a.name === src.aggregate);
    const member = owner && [...owner.factories, ...owner.operations].find((m) => m.name === src.member);
    add({
      id: `automation:no-reaction:${ctx.name}.${name}`,
      category: "automation",
      text: `${member?.description ? `${quoted(member)}で「${name}」が起きたとき` : `「${name}」が起きたとき`}、ほかに自動で行うこと（通知・別の記録の更新など）はない。`,
      modelAnswer: "yes",
      basis: `${name} に反応するポリシーがない。`,
      ifDifferent: `行うことがあるなら、${name} を受けるポリシーと、それが実行する Use case を足す。`,
      element: el(ctx, src ? `${src.aggregate} › ${src.member}` : name),
      path: member?.path ?? ctx.path,
    });
  }
  for (const uc of ctx.useCases) {
    if (!uc.steps.some((s) => s.kind === "create")) continue;
    add({
      id: `automation:idempotent:${ctx.name}.${uc.name}`,
      category: "automation",
      text: `同じ${ucCalled(uc)}の依頼が（通信のやり直しなどで）2 回届いても、1 回分だけ行われる。`,
      modelAnswer: uc.idempotencyKey ? "yes" : "no",
      basis: uc.idempotencyKey ? `idempotency_key: ${uc.idempotencyKey}。` : "idempotency_key がないので、2 回目も新しく作る。",
      ifDifferent: uc.idempotencyKey ? "毎回作り直してよいなら idempotency_key を外す。" : "1 回分だけにするなら、入力のどれかを idempotency_key にする。",
      element: el(ctx, uc.name),
      path: uc.path,
    });
  }
  for (const r of model.relationships.filter((x) => x.downstream === ctx.name)) {
    for (const ev of r.events) {
      add({
        id: `automation:contract:${r.upstream}.${ev}->${r.downstream}`,
        category: "automation",
        text: `${r.downstream} は、${r.upstream} の「${ev}」を受け取って使う。`,
        modelAnswer: "yes",
        basis: `コンテキストマップ（relationships）で ${r.upstream} → ${r.downstream} に ${ev} が渡る。`,
        ifDifferent: "受け取らないなら relationships の events から外す。",
        element: `${r.upstream} → ${r.downstream}`,
        path: r.path,
      });
    }
  }
}

// -- flows ---------------------------------------------------------------------------

/** One question per flow diagram (docs/11 §12): its id carries a fingerprint, so a changed flow is asked again. */
function flowQuestions(analysis: Analysis, add: Add): void {
  for (const t of flowReviewTargets(analysis.model, flowDiagrams(analysis.model, analysis))) {
    if (t.diagram === "events") {
      add({
        id: t.id,
        category: "flows",
        text: "「イベントのつながり」の図のとおり、ある処理が終わると自動で次の処理が起き、それ以外は自動では起きない。",
        modelAnswer: "yes",
        basis: "Use case が発行するイベントと、それに反応するポリシーから作った図。",
        ifDifferent: "足りない・余計なつながりをメモに書き、ポリシー（.flow の policy）を足すか外す。",
        element: t.element,
        path: t.path,
      });
      continue;
    }
    const d = t.diagram;
    const keyword = d.ref.kind === "query" ? "query" : "flow";
    add({
      id: t.id,
      category: "flows",
      text: `「${d.title}」の図の流れ（順番・止まる所・どこで何をするか）は、業務の手順として合っている。`,
      modelAnswer: "yes",
      basis: `.flow の ${keyword} ${d.ref.name} から作った図。`,
      ifDifferent: `違う所をメモに書き、フロー図の画面で ${keyword} ${d.ref.name} を直す。`,
      element: t.element,
      path: t.path,
    });
  }
}

// -- answers ---------------------------------------------------------------------------

export type ReviewVerdict = "yes" | "no";

export interface ReviewFinding {
  question: ReviewQuestion;
  answer: ReviewVerdict;
  /** `differs`: the model says otherwise; `missing`: a yes to something the model has no place for yet. */
  kind: "differs" | "missing";
}

/**
 * Answers that change the model: those that differ from what it says, and a yes to a question it cannot answer
 * (those are phrased so that yes means something has to be added; a no keeps the model as it is).
 */
export function reviewFindings(questions: readonly ReviewQuestion[], answers: Readonly<Record<string, ReviewVerdict | undefined>>): ReviewFinding[] {
  return questions.flatMap((q): ReviewFinding[] => {
    const answer = answers[q.id];
    if (answer !== "yes" && answer !== "no") return [];
    if (q.modelAnswer === "undefined") return answer === "yes" ? [{ question: q, answer, kind: "missing" }] : [];
    return answer === q.modelAnswer ? [] : [{ question: q, answer, kind: "differs" }];
  });
}

// -- sheets ------------------------------------------------------------------------------

const ANSWER_WORDS: Record<string, ReviewVerdict> = { yes: "yes", no: "no", y: "yes", n: "no", true: "yes", false: "no", はい: "yes", いいえ: "no" };

/**
 * Answers from a file a reviewer filled in: a YAML (or JSON) map of question id → yes / no (はい / いいえ, true /
 * false); an empty value is unanswered. Unknown ids and other values are reported, not guessed.
 */
export function parseReviewAnswers(text: string, questions: readonly ReviewQuestion[]): { answers: Record<string, ReviewVerdict>; problems: string[] } {
  const answers: Record<string, ReviewVerdict> = {};
  const problems: string[] = [];
  let doc: unknown;
  try {
    doc = yamlParse(text);
  } catch (e) {
    return { answers, problems: [`The answers are not valid YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  if (doc === null || doc === undefined) return { answers, problems };
  if (typeof doc !== "object" || Array.isArray(doc)) return { answers, problems: ["The answers must be a map of question id → yes / no"] };
  const ids = new Set(questions.map((q) => q.id));
  for (const [id, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (raw === null || raw === undefined || raw === "") continue;
    const v = ANSWER_WORDS[String(raw).trim().toLowerCase()];
    if (!ids.has(id)) problems.push(`Unknown question "${id}" (the model changed, or a typo); it is ignored`);
    else if (!v) problems.push(`"${id}": answer yes or no, not "${String(raw)}"`);
    else answers[id] = v;
  }
  return { answers, problems };
}

/** A file for a reviewer to fill in: each question as a comment above its id. */
export function reviewAnswersTemplate(questions: readonly ReviewQuestion[], answers: Readonly<Record<string, ReviewVerdict>> = {}): string {
  const lines = ["# 各文に yes（はい）か no（いいえ）で答えてください。わからないものは空のままにします。", ""];
  let cat = "";
  for (const q of questions) {
    if (q.category !== cat) {
      cat = q.category;
      lines.push(`# ── ${REVIEW_CATEGORIES[q.category]} ──`);
    }
    lines.push(`# ${q.text}`, `${JSON.stringify(q.id)}: ${answers[q.id] ?? ""}`, "");
  }
  return lines.join("\n");
}

const MODEL_ANSWER_LABEL: Record<ModelAnswer, string> = { yes: "はい", no: "いいえ", undefined: "モデルにない" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/**
 * The review as Markdown. `key: false` is the sheet for the reviewer (no model answers, so they are not led by them);
 * `key: true` adds what the model says and why; with answers, each row shows the answer and the findings come first.
 */
export function reviewMarkdown(project: string, questions: readonly ReviewQuestion[], opts: { key?: boolean; answers?: Readonly<Record<string, ReviewVerdict>> } = {}): string {
  const answers = opts.answers;
  const out: string[] = [`# ${project}: モデルの確認`, ""];
  if (answers) {
    const findings = reviewFindings(questions, answers);
    const answered = questions.filter((q) => answers[q.id]).length;
    out.push(`回答 ${answered} / ${questions.length} 問。モデルを直す必要があるもの: ${findings.length} 件。`, "");
    if (findings.length) {
      out.push("## モデルを直すもの", "");
      for (const f of findings) {
        const q = f.question;
        out.push(
          `- **${cell(q.text)}** → 回答: ${f.answer === "yes" ? "はい" : "いいえ"}（モデル: ${MODEL_ANSWER_LABEL[q.modelAnswer]}）`,
          `  - いまのモデル: ${q.basis}`,
          `  - 直し方: ${q.ifDifferent}`,
          `  - 場所: ${q.element}（\`${formatPath(q.path)}\`）`,
        );
      }
      out.push("");
    }
  } else if (!opts.key) {
    out.push("それぞれの文が、作ろうとしている業務として正しければ「はい」、違えば「いいえ」に印を付けてください。迷うものはメモに理由を書いてください。", "");
  }
  let cat = "";
  let n = 0;
  for (const q of questions) {
    if (q.category !== cat) {
      cat = q.category;
      out.push(`## ${REVIEW_CATEGORIES[q.category]}`, "");
      if (opts.key || answers) out.push(`| # | 文 | モデル | ${answers ? "回答 | " : ""}根拠 |`, `|---|---|---|${answers ? "---|" : ""}---|`);
      else out.push("| # | 文 | はい | いいえ | メモ |", "|---|---|---|---|---|");
    }
    n++;
    if (opts.key || answers) {
      const a = answers?.[q.id];
      const mark = a ? `${a === "yes" ? "はい" : "いいえ"}${q.modelAnswer !== "undefined" && a !== q.modelAnswer ? " ⚠" : ""}` : "";
      out.push(`| ${n} | ${cell(q.text)} | ${MODEL_ANSWER_LABEL[q.modelAnswer]} | ${answers ? `${mark} | ` : ""}${cell(q.basis)} |`);
    } else {
      out.push(`| ${n} | ${cell(q.text)} | ☐ | ☐ | |`);
    }
    if (questions[n]?.category !== cat) out.push("");
  }
  return out.join("\n");
}
