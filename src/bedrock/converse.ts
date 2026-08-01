// The Bedrock binding — the ONLY module in advisor-ts that imports the AWS SDK.
//
// Everything interesting lives in src/core: this file translates advisor-ts's
// `ConverseRequest` into a Bedrock ConverseCommand and translates the response
// back. It is deliberately thin and deliberately untested-by-unit-test, because
// the alternative — logic here — would be logic that can only be tested by paying
// for inference.
//
// Bedrock's runtime endpoints are CORS-enabled (verified by preflight: `converse`,
// `converse-stream`, `invoke`, and `invoke-with-response-stream` all return
// `access-control-allow-origin: *`), so this works from a browser tab against the
// user's own account with no proxy and no backend — the same property that makes
// `sts.amazonaws.com` usable in spawn-ts's `credsFromIdToken`.
//
// BILLING. Every call here costs money in the caller's account. Nothing in this
// repository invokes it during tests, and nothing invokes it implicitly: a caller
// must construct a client and pass it in.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock as SdkContentBlock,
  type Message as SdkMessage,
  type Tool as SdkTool,
} from "@aws-sdk/client-bedrock-runtime";
import type { ConverseFn, ConverseRequest } from "../core/advisor.js";
import {
  finishStream,
  newStreamState,
  reduceStreamEvent,
  type ConverseResponse,
  type Message,
  type StopReason,
  type StreamEvent,
} from "../core/transcript.js";

export interface BedrockOptions {
  client: BedrockRuntimeClient;
  /**
   * The model id or inference-profile ARN, e.g.
   * "us.anthropic.claude-sonnet-4-5-20250929-v1:0". Required and not defaulted:
   * a defaulted model id silently bills for a model the caller did not choose,
   * and model availability differs per account and region.
   */
  modelId: string;
  /**
   * Sampling temperature. Defaults to 0 — this is a factual advisor, and variety
   * in which tool gets called is not a feature.
   */
  temperature?: number;
  maxTokens?: number;
}

/**
 * A `ConverseFn` backed by Bedrock's non-streaming Converse API. Pass it to
 * `ask()`.
 */
export function bedrockConverse(opts: BedrockOptions): ConverseFn {
  return async (req: ConverseRequest): Promise<ConverseResponse> => {
    const out = await opts.client.send(
      new ConverseCommand({
        modelId: opts.modelId,
        system: [{ text: req.system }],
        messages: toSdkMessages(req.messages),
        toolConfig: req.tools.length > 0 ? { tools: toSdkTools(req.tools) } : undefined,
        inferenceConfig: {
          temperature: opts.temperature ?? 0,
          maxTokens: opts.maxTokens ?? 4096,
        },
      }),
    );
    if (!out.output?.message) {
      // A response with no message is not an empty answer — it's a broken call, and
      // it must not reduce to "the model had nothing to say".
      throw new Error("Bedrock Converse returned no message");
    }
    return {
      message: fromSdkMessage(out.output.message),
      stopReason: (out.stopReason ?? "end_turn") as StopReason,
      usage: out.usage
        ? { inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens }
        : undefined,
    };
  };
}

/**
 * A `ConverseFn` backed by ConverseStream, calling `onText` with each text delta
 * so a UI can render the answer as it arrives. It reduces the event stream to the
 * SAME `ConverseResponse` the non-streaming path returns, so `ask()` has exactly
 * one tool-use loop — the streaming and non-streaming paths cannot drift, because
 * only one of them has any logic.
 */
export function bedrockConverseStream(
  opts: BedrockOptions & { onText?: (delta: string) => void },
): ConverseFn {
  return async (req: ConverseRequest): Promise<ConverseResponse> => {
    const out = await opts.client.send(
      new ConverseStreamCommand({
        modelId: opts.modelId,
        system: [{ text: req.system }],
        messages: toSdkMessages(req.messages),
        toolConfig: req.tools.length > 0 ? { tools: toSdkTools(req.tools) } : undefined,
        inferenceConfig: {
          temperature: opts.temperature ?? 0,
          maxTokens: opts.maxTokens ?? 4096,
        },
      }),
    );
    if (!out.stream) throw new Error("Bedrock ConverseStream returned no stream");

    const state = newStreamState();
    for await (const event of out.stream) {
      const delta = event.contentBlockDelta?.delta?.text;
      if (delta) opts.onText?.(delta);
      reduceStreamEvent(state, event as StreamEvent);
    }
    const response = finishStream(state);
    if (state.malformed.length > 0) {
      // Surfaced, not swallowed: a truncated tool input would otherwise run the
      // tool on defaults and produce a confident answer from the wrong arguments.
      // Schema validation rejects the `__malformed` marker, so it lands as a gap.
      for (const m of state.malformed) {
        opts.onText?.(`\n[stream: tool input for ${m.name} was incomplete]\n`);
      }
    }
    return response;
  };
}

// ---------------------------------------------------------------------------
// Wire translation. Mechanical: advisor-ts's transcript types were shaped after
// the Converse format precisely so this stays mechanical.
// ---------------------------------------------------------------------------

function toSdkMessages(messages: Message[]): SdkMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b): SdkContentBlock => {
      if (b.text !== undefined) return { text: b.text } as SdkContentBlock;
      if (b.toolUse) {
        return {
          toolUse: { toolUseId: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input },
        } as SdkContentBlock;
      }
      if (b.toolResult) {
        return {
          toolResult: {
            toolUseId: b.toolResult.toolUseId,
            content: b.toolResult.content.map((c) =>
              c.text !== undefined ? { text: c.text } : { json: c.json },
            ),
            status: b.toolResult.status,
          },
        } as SdkContentBlock;
      }
      return { text: "" } as SdkContentBlock;
    }),
  }));
}

function fromSdkMessage(message: SdkMessage): Message {
  return {
    role: (message.role ?? "assistant") as "user" | "assistant",
    content: (message.content ?? []).map((b) => {
      if (b.text !== undefined) return { text: b.text };
      if (b.toolUse) {
        return {
          toolUse: {
            toolUseId: b.toolUse.toolUseId ?? "",
            name: b.toolUse.name ?? "",
            input: b.toolUse.input,
          },
        };
      }
      return { text: "" };
    }),
  };
}

function toSdkTools(tools: ConverseRequest["tools"]): SdkTool[] {
  // The SDK models Tool as a discriminated union whose members declare
  // `$unknown?: never`, so an object literal doesn't structurally satisfy it
  // without the assertion. The shape itself is exactly the ToolSpecMember.
  return tools.map(
    (t) =>
      ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.inputSchema as Record<string, unknown> },
        },
      }) as SdkTool,
  );
}
