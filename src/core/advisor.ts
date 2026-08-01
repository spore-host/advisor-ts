// The tool-use loop.
//
// The model arrives as an injected function (`ConverseFn`), not as a Bedrock
// client. That single choice is what makes the interesting behaviour testable:
// the multi-turn loop, the tool dispatch, the failure handling, and the gap
// reporting all run against canned responses with no network, no credentials, and
// no billable inference. `src/bedrock/` supplies a real ConverseFn and contains
// no logic worth testing.
//
// The loop's contract with the caller: it returns the answer text AND the record
// of every tool call, including the failures. A caller can therefore show what was
// checked, not merely what was concluded — which is the difference between an
// advisor and an oracle.

import type { AdvisorBackends } from "./backends.js";
import { systemPrompt, type PromptOptions } from "./prompt.js";
import { buildToolset, missingCapabilities, runTool, type Tool } from "./tools.js";
import {
  appendMessage,
  messageText,
  toolResultMessage,
  toolUses,
  userMessage,
  type ConverseResponse,
  type Message,
} from "./transcript.js";
import type { ToolCallRecord } from "./types.js";

/** What the loop hands a model implementation. */
export interface ConverseRequest {
  system: string;
  messages: Message[];
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
}

/** A model. `src/bedrock/converse.ts` provides one; tests provide canned ones. */
export type ConverseFn = (req: ConverseRequest) => Promise<ConverseResponse>;

export interface AdvisorOptions {
  converse: ConverseFn;
  backends: AdvisorBackends;
  /** Extra system-prompt context (region, site policy). */
  prompt?: PromptOptions;
  /**
   * Cap on model round-trips. Each one is billable, and a model that loops
   * calling the same tool would otherwise spend real money doing it. Reaching the
   * cap is reported as a gap rather than passed off as a finished answer.
   */
  maxTurns?: number;
  /** Called after each tool runs, for a live "checking quota…" UI. */
  onToolCall?: (record: ToolCallRecord) => void;
}

/** The result of one question. */
export interface AdvisorAnswer {
  /** The model's prose. Empty if it never produced any. */
  text: string;
  /** Every tool call attempted, in order, successes and failures alike. */
  calls: ToolCallRecord[];
  /**
   * Everything the advisor could not establish: failed calls, checks this
   * deployment cannot perform, and a truncated loop. Shown WITH the answer. A gap
   * list that is filed away separately is a gap list nobody reads.
   */
  gaps: string[];
  /** The full transcript, for a follow-up question in the same conversation. */
  messages: Message[];
  /** How many model round-trips it took. */
  turns: number;
}

const DEFAULT_MAX_TURNS = 8;

/**
 * Ask the advisor a question, running tools until the model stops asking for them.
 *
 * `history` continues an earlier conversation — pass a previous answer's
 * `messages`. The system prompt and toolset are rebuilt each call so a
 * deployment that gains credentials mid-session gains its tools.
 */
export async function ask(
  question: string,
  opts: AdvisorOptions,
  history: Message[] = [],
): Promise<AdvisorAnswer> {
  const tools = buildToolset(opts.backends);
  const system = systemPrompt({ ...opts.prompt, backends: opts.backends });
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

  let messages = appendMessage(history, userMessage(question));
  const calls: ToolCallRecord[] = [];
  // Capability gaps are seeded up front: they are true regardless of what the
  // model does, and a deployment that cannot check capacity must say so even on a
  // question where the model never thought to look.
  const gaps: string[] = [...missingCapabilities(opts.backends)];
  let turns = 0;

  for (; turns < maxTurns; turns++) {
    const response = await opts.converse({ system, messages, tools: toolSpecs(tools) });
    messages = appendMessage(messages, response.message);

    const requested = toolUses(response.message);
    if (response.stopReason !== "tool_use" || requested.length === 0) {
      // The model is done. A truncated answer is flagged: max_tokens means the
      // prose stops mid-thought, which can silently drop the caveats.
      if (response.stopReason === "max_tokens") {
        gaps.push("the answer was cut off by a length limit — ask for a shorter answer or a specific part");
      }
      if (response.stopReason === "content_filtered" || response.stopReason === "guardrail_intervened") {
        gaps.push(`the answer was blocked by a content filter (${response.stopReason})`);
      }
      return { text: messageText(response.message), calls, gaps: [...gaps], messages, turns: turns + 1 };
    }

    const outcomes = [];
    for (const use of requested) {
      const outcome = await runTool(tools, use.name, use.input);
      const record: ToolCallRecord = outcome.ok
        ? { tool: use.name, input: use.input, output: outcome.result }
        : { tool: use.name, input: use.input, error: outcome.error };
      calls.push(record);
      opts.onToolCall?.(record);
      if (!outcome.ok) gaps.push(`${use.name} could not be run: ${outcome.error}`);
      outcomes.push({ toolUseId: use.toolUseId, ...outcome });
    }
    // One result per request, in the same turn — Bedrock requires it, and it means
    // a failed tool physically cannot be hidden from the model.
    messages = appendMessage(messages, toolResultMessage(outcomes));
  }

  // Out of turns with the model still asking for tools. This is reported as an
  // incomplete answer rather than dressed up as a conclusion: the last thing the
  // model said was a tool request, so whatever prose exists predates the facts.
  gaps.push(
    `stopped after ${maxTurns} model turns while the model was still gathering data — ` +
      `the answer below is incomplete; ask a narrower question`,
  );
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return {
    text: lastAssistant ? messageText(lastAssistant) : "",
    calls,
    gaps: [...gaps],
    messages,
    turns,
  };
}

/** The tool list in the shape a ConverseFn passes to the API. */
export function toolSpecs(tools: Tool[]): Array<{ name: string; description: string; inputSchema: unknown }> {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}
