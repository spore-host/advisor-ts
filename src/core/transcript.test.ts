import { describe, it, expect } from "vitest";
import {
  appendMessage,
  finishStream,
  gapsFromCalls,
  messageText,
  newStreamState,
  reduceStreamEvent,
  toolResultMessage,
  toolUses,
  userMessage,
  type Message,
  type StreamEvent,
} from "./transcript.js";

describe("messageText", () => {
  it("concatenates text blocks and ignores tool blocks", () => {
    const m: Message = {
      role: "assistant",
      content: [
        { text: "I'll check " },
        { toolUse: { toolUseId: "t1", name: "find_instances", input: {} } },
        { text: "pricing." },
      ],
    };
    expect(messageText(m)).toBe("I'll check pricing.");
  });

  it("returns an empty string for a tool-only message", () => {
    const m: Message = {
      role: "assistant",
      content: [{ toolUse: { toolUseId: "t1", name: "x", input: {} } }],
    };
    expect(messageText(m)).toBe("");
  });
});

describe("toolUses", () => {
  it("returns every tool request in order", () => {
    const m: Message = {
      role: "assistant",
      content: [
        { toolUse: { toolUseId: "a", name: "recommend_shape", input: {} } },
        { text: "and" },
        { toolUse: { toolUseId: "b", name: "find_instances", input: {} } },
      ],
    };
    expect(toolUses(m).map((t) => t.name)).toEqual(["recommend_shape", "find_instances"]);
  });
});

describe("toolResultMessage", () => {
  it("returns JSON for a success", () => {
    const m = toolResultMessage([{ toolUseId: "t1", ok: true, result: { price: 55.04 } }]);
    expect(m.role).toBe("user");
    expect(m.content[0].toolResult).toMatchObject({
      toolUseId: "t1",
      status: "success",
      content: [{ json: { price: 55.04 } }],
    });
  });

  it("marks a failure as an error, with the message as text", () => {
    // status:"error" is passed to the model by Bedrock. Returning a failure as a
    // success would teach it that the error text is data.
    const m = toolResultMessage([{ toolUseId: "t1", ok: false, error: "AccessDenied" }]);
    expect(m.content[0].toolResult).toMatchObject({
      status: "error",
      content: [{ text: "AccessDenied" }],
    });
  });

  it("emits one result per request, so a failure cannot be omitted", () => {
    // Bedrock rejects a turn with a missing toolResult, which happens to enforce
    // the invariant this library wants anyway.
    const m = toolResultMessage([
      { toolUseId: "a", ok: true, result: {} },
      { toolUseId: "b", ok: false, error: "boom" },
      { toolUseId: "c", ok: true, result: {} },
    ]);
    expect(m.content).toHaveLength(3);
    expect(m.content.map((c) => c.toolResult!.toolUseId)).toEqual(["a", "b", "c"]);
  });
});

describe("appendMessage", () => {
  it("does not mutate the input transcript", () => {
    const before: Message[] = [userMessage("hello")];
    const after = appendMessage(before, userMessage("again"));
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
  });
});

describe("gapsFromCalls", () => {
  it("reports one gap per failed call and nothing for successes", () => {
    const gaps = gapsFromCalls([
      { tool: "find_instances", input: {}, output: {} },
      { tool: "check_quota", input: {}, error: "AccessDenied" },
    ]);
    expect(gaps).toEqual(["check_quota could not be run: AccessDenied"]);
  });
});

// ---------------------------------------------------------------------------
// Streaming — canned event sequences, no network.
// ---------------------------------------------------------------------------

/** Drive a canned event list through the reducer. */
function stream(events: StreamEvent[]) {
  const state = newStreamState();
  for (const e of events) reduceStreamEvent(state, e);
  return { state, response: finishStream(state) };
}

describe("the streaming reducer", () => {
  it("assembles text deltas into one block", () => {
    const { response } = stream([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "For GROMACS " } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "use one node." } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    expect(messageText(response.message)).toBe("For GROMACS use one node.");
    expect(response.stopReason).toBe("end_turn");
  });

  it("assembles a tool input delivered as partial JSON fragments", () => {
    // The reason streaming needs a reducer rather than a callback: a tool call
    // doesn't exist until its input fragments have been concatenated and parsed.
    const { response } = stream([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "t1", name: "find_instances" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"h100 8 gpus"}' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "tool_use" } },
    ]);
    const uses = toolUses(response.message);
    expect(uses).toHaveLength(1);
    expect(uses[0].input).toEqual({ query: "h100 8 gpus" });
    expect(response.stopReason).toBe("tool_use");
  });

  it("orders blocks by index, not by arrival", () => {
    const { response } = stream([
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "second" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "first " } } },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    expect(messageText(response.message)).toBe("first second");
  });

  it("handles interleaved text and multiple tool calls", () => {
    const { response } = stream([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Checking. " } } },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "t1", name: "recommend_shape" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"description":"x"}' } } } },
      {
        contentBlockStart: {
          contentBlockIndex: 2,
          start: { toolUse: { toolUseId: "t2", name: "lookup_workload" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"name":"wrf"}' } } } },
      { messageStop: { stopReason: "tool_use" } },
    ]);
    expect(messageText(response.message)).toBe("Checking. ");
    expect(toolUses(response.message).map((u) => u.name)).toEqual([
      "recommend_shape",
      "lookup_workload",
    ]);
  });

  it("marks a truncated tool input as malformed instead of defaulting to {}", () => {
    // The dangerous case: an empty input object would run the tool on defaults and
    // produce a confident answer from the wrong arguments. The marker makes schema
    // validation reject it, so it lands as a stated gap.
    const { state, response } = stream([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "t1", name: "find_instances" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":"h1' } } } },
      { messageStop: { stopReason: "tool_use" } },
    ]);
    expect(state.malformed).toHaveLength(1);
    expect(state.malformed[0].name).toBe("find_instances");
    expect(toolUses(response.message)[0].input).toMatchObject({ __malformed: '{"query":"h1' });
    expect(toolUses(response.message)[0].input).not.toEqual({});
  });

  it("treats a genuinely empty tool input as {}, for a no-argument tool", () => {
    const { state, response } = stream([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "t1", name: "list_regions" } },
        },
      },
      { messageStop: { stopReason: "tool_use" } },
    ]);
    expect(state.malformed).toHaveLength(0);
    expect(toolUses(response.message)[0].input).toEqual({});
  });

  it("carries usage through", () => {
    const { response } = stream([
      { metadata: { usage: { inputTokens: 1200, outputTokens: 340 } } },
      { messageStop: { stopReason: "end_turn" } },
    ]);
    expect(response.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
  });

  it("defaults the stop reason rather than leaving it undefined", () => {
    const { response } = stream([{ contentBlockDelta: { delta: { text: "hi" } } }]);
    expect(response.stopReason).toBe("end_turn");
  });

  it("reduces to the SAME transcript the non-streaming path produces", () => {
    // The property that keeps one tool-use loop honest: if the two paths could
    // differ, only one of them would be tested.
    const nonStreaming: Message = {
      role: "assistant",
      content: [
        { text: "Checking pricing." },
        { toolUse: { toolUseId: "t1", name: "get_pricing", input: { instanceTypes: ["p5.48xlarge"] } } },
      ],
    };
    const { response } = stream([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Checking pricing." } } },
      {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "t1", name: "get_pricing" } },
        },
      },
      {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"instanceTypes":["p5.48xlarge"]}' } },
        },
      },
      { messageStop: { stopReason: "tool_use" } },
    ]);
    expect(response.message).toEqual(nonStreaming);
  });
});
