// The transcript: Bedrock Converse message shapes as plain data, plus the pure
// reductions over them.
//
// These types mirror the Bedrock Converse API wire format rather than inventing
// an abstraction over it, so a canned API response can be fed straight into the
// reducer in a test. That is the point: the whole multi-turn tool-use loop is
// exercised with zero network and no credentials, and the SDK is imported in
// exactly one directory (src/bedrock) that no test needs.
//
// Nothing here calls a tool or a model. Reductions in, reductions out.

import type { ToolCallRecord } from "./types.js";

/** A content block in a message. Exactly one field is set. */
export interface ContentBlock {
  text?: string;
  toolUse?: ToolUseBlock;
  toolResult?: ToolResultBlock;
}

/** The model asking for a tool call. */
export interface ToolUseBlock {
  /** Correlates the result back to this request. Must be echoed verbatim. */
  toolUseId: string;
  name: string;
  input: unknown;
}

/** Our answer to a tool call. */
export interface ToolResultBlock {
  toolUseId: string;
  content: Array<{ text?: string; json?: unknown }>;
  /**
   * "error" when the tool failed. Set it: Bedrock passes the status to the model,
   * and a failure returned as a success teaches it that the error text is data.
   */
  status?: "success" | "error";
}

/** One turn. */
export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** Why the model stopped. `tool_use` means it wants tools run and will continue. */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "content_filtered"
  | "guardrail_intervened";

/** A Converse response, trimmed to what the loop reads. */
export interface ConverseResponse {
  /** The assistant message. */
  message: Message;
  stopReason: StopReason;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Concatenated text of a message — the human-readable part. */
export function messageText(message: Message): string {
  return message.content
    .map((b) => b.text ?? "")
    .filter((t) => t.length > 0)
    .join("");
}

/** Every tool the model asked for in a message, in order. */
export function toolUses(message: Message): ToolUseBlock[] {
  return message.content.flatMap((b) => (b.toolUse ? [b.toolUse] : []));
}

/**
 * Build the user message that carries tool results back to the model.
 *
 * Bedrock requires one toolResult per toolUse in the preceding assistant
 * message, so a failure cannot be handled by omitting its result — the API
 * rejects the turn. That constraint happens to enforce the invariant this library
 * wants anyway: an error is reported as an error, never as an absence.
 */
export function toolResultMessage(
  results: Array<{ toolUseId: string; ok: boolean; result?: unknown; error?: string }>,
): Message {
  return {
    role: "user",
    content: results.map((r) => ({
      toolResult: {
        toolUseId: r.toolUseId,
        // JSON for success (the model reads structure well and it survives
        // round-tripping); plain text for an error, so the message is unmissable.
        content: r.ok ? [{ json: r.result ?? {} }] : [{ text: r.error ?? "the tool failed" }],
        status: r.ok ? ("success" as const) : ("error" as const),
      },
    })),
  };
}

/** Append a message, returning a new array (the transcript is never mutated). */
export function appendMessage(messages: Message[], message: Message): Message[] {
  return [...messages, message];
}

/** A plain user question as a message. */
export function userMessage(text: string): Message {
  return { role: "user", content: [{ text }] };
}

/**
 * The gaps implied by a set of tool calls: one line per failure, phrased for a
 * user rather than for a log. Derived from the record rather than collected as
 * the loop runs, so a caller reconstructing a transcript gets the same gaps.
 */
export function gapsFromCalls(calls: ToolCallRecord[]): string[] {
  return calls.filter((c) => c.error !== undefined).map((c) => `${c.tool} could not be run: ${c.error}`);
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * A ConverseStream event, trimmed to the fields the reducer reads. The stream
 * delivers a tool's input as a sequence of partial JSON strings, so a tool call
 * only exists once its blocks have been assembled — which is why streaming needs
 * a reducer rather than a callback.
 */
export interface StreamEvent {
  messageStart?: { role: "assistant" | "user" };
  contentBlockStart?: {
    contentBlockIndex?: number;
    start?: { toolUse?: { toolUseId: string; name: string } };
  };
  contentBlockDelta?: {
    contentBlockIndex?: number;
    delta?: { text?: string; toolUse?: { input?: string } };
  };
  contentBlockStop?: { contentBlockIndex?: number };
  messageStop?: { stopReason?: StopReason };
  metadata?: { usage?: { inputTokens?: number; outputTokens?: number } };
}

/** Incremental stream state. Start from `newStreamState()`. */
export interface StreamState {
  /** Blocks in wire order, keyed by contentBlockIndex. */
  blocks: Map<number, { text?: string; toolUseId?: string; name?: string; inputJson?: string }>;
  stopReason?: StopReason;
  usage?: { inputTokens?: number; outputTokens?: number };
  /**
   * Blocks whose accumulated tool input was not valid JSON. Recorded rather than
   * thrown: a truncated stream must not silently produce a tool call with an
   * empty input object, which would run the tool on defaults and look successful.
   */
  malformed: Array<{ toolUseId: string; name: string; raw: string }>;
}

export function newStreamState(): StreamState {
  return { blocks: new Map(), malformed: [] };
}

/**
 * Fold one stream event into the state, returning it (mutated in place — this
 * runs per token, and the state is private to one stream).
 */
export function reduceStreamEvent(state: StreamState, event: StreamEvent): StreamState {
  if (event.contentBlockStart) {
    const idx = event.contentBlockStart.contentBlockIndex ?? 0;
    const tu = event.contentBlockStart.start?.toolUse;
    const block = state.blocks.get(idx) ?? {};
    if (tu) {
      block.toolUseId = tu.toolUseId;
      block.name = tu.name;
      block.inputJson = "";
    }
    state.blocks.set(idx, block);
    return state;
  }

  if (event.contentBlockDelta) {
    const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
    const block = state.blocks.get(idx) ?? {};
    const delta = event.contentBlockDelta.delta;
    if (delta?.text !== undefined) block.text = (block.text ?? "") + delta.text;
    if (delta?.toolUse?.input !== undefined) {
      block.inputJson = (block.inputJson ?? "") + delta.toolUse.input;
    }
    state.blocks.set(idx, block);
    return state;
  }

  if (event.messageStop) {
    state.stopReason = event.messageStop.stopReason;
    return state;
  }

  if (event.metadata?.usage) {
    state.usage = event.metadata.usage;
    return state;
  }

  // messageStart / contentBlockStop carry nothing the reduction needs; block order
  // comes from the index, not from arrival order.
  return state;
}

/**
 * Collapse stream state into the same `ConverseResponse` the non-streaming path
 * produces, so exactly one code path handles the tool-use loop. A stream and a
 * single call must reduce to the same transcript or the two paths will drift and
 * only one of them will be tested.
 */
export function finishStream(state: StreamState): ConverseResponse {
  const content: ContentBlock[] = [];
  for (const idx of [...state.blocks.keys()].sort((a, b) => a - b)) {
    const block = state.blocks.get(idx)!;
    if (block.toolUseId && block.name) {
      let input: unknown = {};
      const raw = block.inputJson ?? "";
      if (raw.trim().length === 0) {
        // An empty input is legitimate for a no-argument tool; schema validation
        // downstream decides whether it's acceptable for THIS tool.
        input = {};
      } else {
        try {
          input = JSON.parse(raw);
        } catch {
          state.malformed.push({ toolUseId: block.toolUseId, name: block.name, raw });
          // Deliberately NOT `{}`: an unparseable input becomes a marker that
          // validation will reject, so a truncated stream surfaces as a failed
          // tool call instead of one that ran on defaults.
          input = { __malformed: raw };
        }
      }
      content.push({ toolUse: { toolUseId: block.toolUseId, name: block.name, input } });
    } else if (block.text !== undefined) {
      content.push({ text: block.text });
    }
  }
  return {
    message: { role: "assistant", content },
    stopReason: state.stopReason ?? "end_turn",
    usage: state.usage,
  };
}
