/**
 * LLM assistance for domain modelling, via the Claude API (official SDK).
 * The server is the only place that talks to the model: the browser never sees the API key,
 * and nothing is sent unless the workspace owner enabled AI.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Board, Proposal } from "@ddd/core";
import dslReference from "../../../docs/10-dsl-reference.md" with { type: "text" };

export interface InlineRequest {
  yaml: string;
  offset: number;
}

export interface ProposeRequest {
  yaml: string;
  context: string;
  aggregate?: string;
  kind: string;
  instruction?: string;
  /** Diagnostics from a previous attempt, for one repair round. */
  repair?: { yaml: string; errors: string[] };
}

export interface BoardRequest {
  board: Board;
  instruction?: string;
}

export interface BoardSuggestion {
  kind: string;
  text: string;
  near_item_id: string;
  placement: "right" | "left" | "above" | "below";
  connect: "from_near" | "to_near" | "none";
  reason: string;
}

/** What the rest of the server needs from an LLM. Tests inject a fake implementation. */
export interface ModelAssistant {
  readonly model: string;
  inline(req: InlineRequest): Promise<string | undefined>;
  propose(req: ProposeRequest): Promise<Omit<Proposal, "source"> | undefined>;
  board(req: BoardRequest): Promise<BoardSuggestion[]>;
}

const SYSTEM = `You help software teams build domain models with DDD (Domain-Driven Design) in "DDD Presenter".
Models are YAML files in the DSL documented below. Code (Python) and tests are generated from them.

Principles:
- Follow the DSL exactly; every name you reference must exist or be added.
- Match the team's existing naming (PascalCase types and events, snake_case members) and write descriptions,
  messages and glossary text in the same natural language the model already uses.
- Keep aggregates small; a rule belongs to the aggregate that must keep it consistent in one change.
- Never invent business facts. When the model does not say something, make the smallest reasonable guess
  and report it as an assumption, and turn open points into questions for the domain expert.

<dsl_reference>
${dslReference}
</dsl_reference>`;

const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["yaml", "summary", "facts", "assumptions", "questions"],
  properties: {
    yaml: { type: "string", description: "The complete updated model file" },
    summary: { type: "array", items: { type: "string" }, description: "What was added or changed, one line each" },
    facts: { type: "array", items: { type: "string" }, description: "Facts taken from the current model that the proposal relies on" },
    assumptions: { type: "array", items: { type: "string" }, description: "Guesses that the team must confirm" },
    questions: { type: "array", items: { type: "string" }, description: "Open questions for the domain expert" },
  },
} as const;

const BOARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text", "near_item_id", "placement", "connect", "reason"],
        properties: {
          kind: { type: "string", enum: ["event", "command", "actor", "policy", "aggregate", "rule", "read_model", "external_system", "hotspot"] },
          text: { type: "string" },
          near_item_id: { type: "string" },
          placement: { type: "string", enum: ["right", "left", "above", "below"] },
          connect: { type: "string", enum: ["from_near", "to_near", "none"] },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

const KIND_HINT: Record<string, string> = {
  "next-operation": "Propose the next operation this aggregate needs (lifecycle transitions that are missing), with its guard, changes and emitted event.",
  guards: "Propose the state guards and invariants this aggregate needs, with domain errors for each.",
  scenarios: "Propose Given/When/Then scenarios that cover the success path and each rule's failure for this aggregate. Use concrete, realistic values.",
  events: "Propose or improve the domain events' payloads: what the consumers of each event need to know.",
  custom: "Do what the instruction asks.",
};

export function claudeAssistant(options: { client?: Anthropic; model?: string; inlineModel?: string } = {}): ModelAssistant {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? process.env.DDD_AI_MODEL ?? "claude-opus-5";
  const inlineModel = options.inlineModel ?? process.env.DDD_AI_INLINE_MODEL ?? model;
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }];

  /** Text of a response, or undefined when the model (and its fallback) declined. */
  const textOf = (r: Anthropic.Beta.BetaMessage): string | undefined => {
    if (r.stop_reason === "refusal") return undefined;
    return r.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };

  return {
    model,
    async inline({ yaml, offset }) {
      const r = await client.beta.messages.create({
        model: inlineModel,
        max_tokens: 1024,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system,
        messages: [
          {
            role: "user",
            content: `Continue the model at <cursor/>. Return ONLY the text to insert at the cursor (no code fences, no explanation). Continue the current YAML item or add the next sensible one, at most about 15 lines, indented to fit. Return an empty response if nothing useful fits.

<model>
${yaml.slice(0, offset)}<cursor/>${yaml.slice(offset)}
</model>`,
          },
        ],
      });
      const text = textOf(r);
      if (!text) return undefined;
      return text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "").replace(/\s+$/, "");
    },

    async propose({ yaml, context, aggregate, kind, instruction, repair }) {
      const task = [
        KIND_HINT[kind] ?? KIND_HINT.custom,
        `Target: context "${context}"${aggregate ? `, aggregate "${aggregate}"` : ""}.`,
        instruction ? `Instruction from the team: ${instruction}` : "",
        "Keep every existing element unless the instruction asks to change it. Return the complete updated model in `yaml`.",
      ]
        .filter(Boolean)
        .join("\n");
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `${task}\n\n<model>\n${yaml}\n</model>` }];
      if (repair) {
        messages.push({ role: "assistant", content: JSON.stringify({ yaml: repair.yaml }) });
        messages.push({ role: "user", content: `The model you returned has validation errors. Fix them and return the complete model again:\n${repair.errors.join("\n")}` });
      }
      const r = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: PROPOSAL_SCHEMA } },
        system,
        messages,
      });
      const text = textOf(r);
      if (!text) return undefined;
      try {
        return JSON.parse(text) as Omit<Proposal, "source">;
      } catch {
        return undefined;
      }
    },

    async board({ board, instruction }) {
      const compact = {
        frames: board.frames.map((f) => ({ id: f.id, title: f.title })),
        items: board.items.map((i) => ({ id: i.id, kind: i.kind, text: i.text })),
        connectors: board.connectors.map((c) => ({ from: c.from, to: c.to })),
      };
      const r = await client.beta.messages.create({
        model,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: BOARD_SCHEMA } },
        system,
        messages: [
          {
            role: "user",
            content: `This is an EventStorming board (JSON). Suggest up to 8 stickies that are most likely missing next: events that follow, commands that cause events, actors, policies between events and commands, aggregates, rules, or hotspots for unclear points. Write sticky text in the board's language. Each suggestion is placed next to an existing sticky (near_item_id) and may connect to it.${instruction ? `\nFocus: ${instruction}` : ""}

<board>
${JSON.stringify(compact)}
</board>`,
          },
        ],
      });
      const text = textOf(r);
      if (!text) return [];
      try {
        return (JSON.parse(text) as { suggestions: BoardSuggestion[] }).suggestions ?? [];
      } catch {
        return [];
      }
    },
  };
}

/** The assistant configured from the environment, or undefined when no Claude credentials are present. */
export function assistantFromEnv(): ModelAssistant | undefined {
  if (process.env.DDD_AI === "off") return undefined;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return undefined;
  return claudeAssistant();
}
