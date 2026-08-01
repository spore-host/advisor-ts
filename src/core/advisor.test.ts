// The tool-use loop, driven by CANNED model responses.
//
// This is where the library's central claims are checked: that facts in an answer
// trace to a tool call, that an unknown workload still yields cited hardware with
// its premise labelled, and that a failed or impossible check appears as a stated
// gap rather than as silence. All of it with no network, no credentials, and no
// billable inference — which is the entire reason `converse` is an injected
// function rather than a Bedrock client.

import { describe, it, expect } from "vitest";
import { ask, type ConverseFn, type ConverseRequest } from "./advisor.js";
import type { ConverseResponse, Message } from "./transcript.js";
import { fullBackends, offlineBackends } from "./fixtures.test-util.js";

/** A model that replays a fixed script of responses, recording what it was sent. */
function scriptedModel(script: ConverseResponse[]): ConverseFn & { requests: ConverseRequest[] } {
  const requests: ConverseRequest[] = [];
  let i = 0;
  const fn = async (req: ConverseRequest): Promise<ConverseResponse> => {
    requests.push(req);
    if (i >= script.length) throw new Error(`model called ${i + 1} times but the script has ${script.length}`);
    return script[i++];
  };
  return Object.assign(fn, { requests });
}

function wantsTool(name: string, input: unknown, id = "t1"): ConverseResponse {
  return {
    message: { role: "assistant", content: [{ toolUse: { toolUseId: id, name, input } }] },
    stopReason: "tool_use",
  };
}

function says(text: string, stopReason: ConverseResponse["stopReason"] = "end_turn"): ConverseResponse {
  return { message: { role: "assistant", content: [{ text }] }, stopReason };
}

describe("ask — the loop", () => {
  it("returns the answer when the model needs no tools", async () => {
    const model = scriptedModel([says("Use one node.")]);
    const answer = await ask("what shape?", { converse: model, backends: fullBackends() });
    expect(answer.text).toBe("Use one node.");
    expect(answer.calls).toEqual([]);
    expect(answer.turns).toBe(1);
  });

  it("runs a requested tool and feeds the result back", async () => {
    const model = scriptedModel([
      wantsTool("find_instances", { query: "h100 8 gpus" }),
      says("p5.48xlarge — 8 × H100, 80 GiB each, $55.04/hr."),
    ]);
    const answer = await ask("what for h100 training?", { converse: model, backends: fullBackends() });
    expect(answer.turns).toBe(2);
    expect(answer.calls).toHaveLength(1);
    expect(answer.calls[0].tool).toBe("find_instances");
    expect(answer.calls[0].error).toBeUndefined();
    // The second request carries the tool result, so the model's answer rests on it.
    const results = model.requests[1].messages.at(-1)!;
    expect(results.role).toBe("user");
    expect(results.content[0].toolResult!.status).toBe("success");
  });

  it("runs several tools requested in one turn, all of them", async () => {
    const model = scriptedModel([
      {
        message: {
          role: "assistant",
          content: [
            { toolUse: { toolUseId: "a", name: "recommend_shape", input: { description: "500 runs" } } },
            { toolUse: { toolUseId: "b", name: "lookup_workload", input: { name: "blast" } } },
          ],
        },
        stopReason: "tool_use",
      },
      says("Run it as an array of 500 tasks."),
    ]);
    const answer = await ask("how do I run 500 blast searches?", {
      converse: model,
      backends: fullBackends(),
    });
    expect(answer.calls.map((c) => c.tool)).toEqual(["recommend_shape", "lookup_workload"]);
    expect(model.requests[1].messages.at(-1)!.content).toHaveLength(2);
  });

  it("records the tool OUTPUT, so a caller can show what was checked", async () => {
    const model = scriptedModel([wantsTool("get_pricing", { instanceTypes: ["p5.48xlarge"] }), says("done")]);
    const answer = await ask("price?", { converse: model, backends: fullBackends() });
    const out = answer.calls[0].output as { prices: Array<{ onDemandPricePerHour: number }> };
    expect(out.prices[0].onDemandPricePerHour).toBe(55.04);
  });

  it("calls onToolCall for a live progress view", async () => {
    const seen: string[] = [];
    const model = scriptedModel([wantsTool("recommend_shape", { description: "mpi run" }), says("ok")]);
    await ask("q", {
      converse: model,
      backends: fullBackends(),
      onToolCall: (r) => seen.push(r.tool),
    });
    expect(seen).toEqual(["recommend_shape"]);
  });

  it("continues an earlier conversation when history is passed", async () => {
    const history: Message[] = [
      { role: "user", content: [{ text: "what for gromacs?" }] },
      { role: "assistant", content: [{ text: "one GPU node" }] },
    ];
    const model = scriptedModel([says("About $220 for four hours.")]);
    const answer = await ask("and the cost?", { converse: model, backends: fullBackends() }, history);
    expect(model.requests[0].messages).toHaveLength(3);
    expect(answer.messages).toHaveLength(4);
  });

  it("does not mutate the history it was given", async () => {
    const history: Message[] = [{ role: "user", content: [{ text: "hi" }] }];
    await ask("q", { converse: scriptedModel([says("a")]), backends: fullBackends() }, history);
    expect(history).toHaveLength(1);
  });
});

describe("ask — failures become stated gaps, never silence", () => {
  it("reports a failed tool call as a gap AND tells the model", async () => {
    // The Go #63 invariant. An error that vanishes reads exactly like a check that
    // passed, and the user cannot tell the difference from the answer.
    const backends = fullBackends();
    backends.live = {
      region: "us-east-1",
      getSpotPrices: async () => {
        throw new Error("AccessDenied: ec2:DescribeSpotPriceHistory");
      },
      checkQuota: async () => {
        throw new Error("unused");
      },
    };
    const model = scriptedModel([
      wantsTool("get_spot_prices", { instanceTypes: ["p5.48xlarge"] }),
      says("I couldn't check spot pricing."),
    ]);
    const answer = await ask("is spot cheaper?", { converse: model, backends });

    expect(answer.calls[0].error).toMatch(/AccessDenied/);
    expect(answer.gaps.some((g) => /get_spot_prices could not be run/.test(g))).toBe(true);
    // And the model was told, as an error-status tool result.
    const sent = model.requests[1].messages.at(-1)!.content[0].toolResult!;
    expect(sent.status).toBe("error");
    expect(sent.content[0].text).toMatch(/AccessDenied/);
  });

  it("reports an invalid tool call as a gap without running the handler", async () => {
    const model = scriptedModel([
      wantsTool("estimate_cost", { pricePerHour: "about fifty", hours: 4 }),
      says("Let me get a real price first."),
    ]);
    const answer = await ask("cost?", { converse: model, backends: fullBackends() });
    expect(answer.gaps.some((g) => /invalid input for estimate_cost/.test(g))).toBe(true);
  });

  it("reports a hallucinated tool name as a gap", async () => {
    const model = scriptedModel([wantsTool("launch_instance", { type: "p5.48xlarge" }), says("I can't launch.")]);
    const answer = await ask("just launch it", { converse: model, backends: fullBackends() });
    expect(answer.gaps.some((g) => /no such tool "launch_instance"/.test(g))).toBe(true);
    // Nothing was launched, and nothing could have been: there is no such tool.
    expect(answer.calls[0].output).toBeUndefined();
  });

  it("seeds gaps from the deployment's missing capabilities, before the model runs", async () => {
    // True regardless of what the model does. A deployment that cannot check
    // capacity must say so even on a question where the model never looked.
    const answer = await ask("what should I run?", {
      converse: scriptedModel([says("g6e.xlarge")]),
      backends: offlineBackends(),
    });
    expect(answer.gaps.some((g) => /credentials/.test(g))).toBe(true);
    expect(answer.gaps.some((g) => /capacity was not checked/.test(g))).toBe(true);
  });

  it("has no gaps when everything was available and everything worked", async () => {
    // The other half of the invariant: silence has to be earned, so it must be
    // possible to earn it.
    const answer = await ask("q", {
      converse: scriptedModel([wantsTool("recommend_shape", { description: "mpi" }), says("ok")]),
      backends: fullBackends(),
    });
    expect(answer.gaps).toEqual([]);
  });

  it("flags a length-truncated answer, which would silently drop the caveats", async () => {
    const answer = await ask("q", {
      converse: scriptedModel([says("It will cost approximately", "max_tokens")]),
      backends: fullBackends(),
    });
    expect(answer.gaps.some((g) => /cut off by a length limit/.test(g))).toBe(true);
  });

  it("flags a filtered answer", async () => {
    const answer = await ask("q", {
      converse: scriptedModel([says("", "content_filtered")]),
      backends: fullBackends(),
    });
    expect(answer.gaps.some((g) => /content filter/.test(g))).toBe(true);
  });

  it("stops at maxTurns and says the answer is incomplete", async () => {
    // Each turn is billable, so a model looping on one tool must not spend real
    // money doing it — and the truncated result must not pass as a conclusion.
    const model = scriptedModel(
      Array.from({ length: 5 }, (_, i) => wantsTool("recommend_shape", { description: "x" }, `t${i}`)),
    );
    const answer = await ask("q", { converse: model, backends: fullBackends(), maxTurns: 3 });
    expect(answer.turns).toBe(3);
    expect(answer.calls).toHaveLength(3);
    expect(answer.gaps.some((g) => /stopped after 3 model turns/.test(g))).toBe(true);
    expect(answer.gaps.some((g) => /incomplete/.test(g))).toBe(true);
  });
});

describe("ask — the grounding contract end to end", () => {
  it("cites a real price for a CATALOGUED workload", async () => {
    const model = scriptedModel([
      wantsTool("lookup_workload", { name: "openfoam" }, "a"),
      wantsTool("find_instances", { query: "hpc7a efa" }, "b"),
      wantsTool("get_pricing", { instanceTypes: ["p5.48xlarge"] }, "c"),
      says("OpenFOAM is MPI-coupled (per the OpenFOAM v12 User Guide); p5.48xlarge at $55.04/hr."),
    ]);
    const answer = await ask("what should I run OpenFOAM on?", {
      converse: model,
      backends: fullBackends(),
    });
    const kb = answer.calls[0].output as { provenance: string; citation: string };
    expect(kb.provenance).toBe("catalog");
    expect(kb.citation).toBeTruthy();
    // The price in the answer is the price a tool returned.
    const priced = answer.calls[2].output as { prices: Array<{ onDemandPricePerHour: number }> };
    expect(answer.text).toContain(String(priced.prices[0].onDemandPricePerHour));
  });

  it("THE HEADLINE CASE: an UNCATALOGUED workload still gets cited hardware, premise labelled", async () => {
    // The common path, by design. "lammps" has no KB entry, so:
    //   - the tool tells the model to characterise it and SAY it's inferring
    //   - instance names and prices still come from tools
    // If this degraded to a refusal, or to a fluent answer with invented numbers,
    // the library would have failed at the thing it exists for.
    const model = scriptedModel([
      wantsTool("recommend_shape", { description: "molecular dynamics across several nodes" }, "a"),
      wantsTool("lookup_workload", { name: "lammps" }, "b"),
      wantsTool("find_instances", { query: "gpu 80gb vram efa" }, "c"),
      says(
        "I don't have a verified profile for LAMMPS, so I'm treating it as a GPU-accelerated " +
          "MD code that can scale across nodes — correct me if that's wrong. For that shape: " +
          "p5.48xlarge, 8 × H100 with 80 GiB each.",
      ),
    ]);
    const answer = await ask("what should I run LAMMPS on?", {
      converse: model,
      backends: fullBackends(),
    });

    // The KB miss is a success, carrying explicit instructions to label inference.
    const miss = answer.calls[1].output as { found: boolean; provenance: string; guidance: string };
    expect(miss.found).toBe(false);
    expect(miss.provenance).toBe("none");
    expect(miss.guidance).toMatch(/inference and not a retrieved fact/);

    // The instance type in the answer came from find_instances, not from the model.
    const found = answer.calls[2].output as { matches: Array<{ instanceType: string }> };
    expect(found.matches.map((m) => m.instanceType)).toContain("p5.48xlarge");
    expect(answer.text).toContain("p5.48xlarge");

    // And the premise is visible in the prose, which is the point.
    expect(answer.text).toMatch(/don't have a verified profile/);
    expect(answer.text).toMatch(/correct me/);
  });

  it("gets shape before instance advice when the model follows the prompt", async () => {
    const model = scriptedModel([
      wantsTool("recommend_shape", { description: "500 independent docking runs", taskCount: 500 }, "a"),
      wantsTool("find_instances", { query: "cheapest 8 cores 32gb" }, "b"),
      says("Run it as a 500-task array on spot."),
    ]);
    const answer = await ask("500 docking runs — what do I need?", {
      converse: model,
      backends: fullBackends(),
    });
    expect(answer.calls.map((c) => c.tool)).toEqual(["recommend_shape", "find_instances"]);
    const shape = answer.calls[0].output as { shape: string; count: number; efa: boolean };
    expect(shape.shape).toBe("job-array");
    expect(shape.count).toBe(500);
    expect(shape.efa).toBe(false);
  });

  it("passes the toolset and system prompt on every turn", async () => {
    const model = scriptedModel([wantsTool("recommend_shape", { description: "x" }), says("ok")]);
    await ask("q", { converse: model, backends: fullBackends() });
    for (const req of model.requests) {
      expect(req.system).toMatch(/research-computing advisor/);
      expect(req.tools.map((t) => t.name)).toContain("find_instances");
      expect(req.tools.some((t) => /launch/.test(t.name))).toBe(false);
    }
  });

  it("offers fewer tools when the deployment has fewer backends", async () => {
    const model = scriptedModel([says("ok")]);
    await ask("q", { converse: model, backends: offlineBackends() });
    const names = model.requests[0].tools.map((t) => t.name);
    expect(names).toContain("find_instances");
    expect(names).not.toContain("check_quota");
  });
});
