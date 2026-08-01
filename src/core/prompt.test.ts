// The system prompt is behaviour, so it gets tested.
//
// These assertions look like testing prose, and in one sense they are. But the
// grounding contract only exists where the model reads it, and the failure mode of
// this file is silent: someone tidies the prompt, drops the "label your inference"
// paragraph, and every answer afterwards still looks fine — just with the premise
// no longer stated. That's not detectable from an output sample. It is detectable
// here.

import { describe, it, expect } from "vitest";
import { systemPrompt } from "./prompt.js";
import { fullBackends, offlineBackends } from "./fixtures.test-util.js";

describe("systemPrompt — rule 1: facts come from tools", () => {
  const p = systemPrompt({ backends: fullBackends() });

  it("names each fact class and the only tool that may supply it", () => {
    expect(p).toMatch(/instance type names — only from find_instances/);
    expect(p).toMatch(/prices and savings percentages — only from get_pricing or get_spot_prices/);
    expect(p).toMatch(/quota and capacity — only from check_quota and check_capacity/);
  });

  it("explicitly forbids answering hardware questions from training data", () => {
    // The model does know a lot about EC2. The prompt has to head that off by name,
    // because the knowledge is real and therefore tempting.
    expect(p).toMatch(/Do not use it for these/);
    expect(p).toMatch(/price you remember is stale/);
  });

  it("says an uncheckable fact must be reported as unchecked", () => {
    expect(p).toMatch(/say that you could not check it/);
  });
});

describe("systemPrompt — rule 2: reasoning is labelled", () => {
  const p = systemPrompt({ backends: fullBackends() });

  it("invites the model's workload knowledge rather than suppressing it", () => {
    // Suppressing it would throw away the most useful thing the model contributes
    // for a workload nothing has catalogued.
    expect(p).toMatch(/You DO know what research codes need/);
    expect(p).toMatch(/Use it, and label it/);
  });

  it("says a KB miss is the normal case, not a failure", () => {
    expect(p).toMatch(/which is the normal case/);
  });

  it("requires the premise BEFORE the recommendation", () => {
    // Order matters: a premise stated after the advice is a premise the reader has
    // already acted on.
    expect(p).toMatch(/State the premise before the recommendation, not after/);
    expect(p).toMatch(/correct me if that's wrong/);
  });

  it("explains why — so a researcher can fix a wrong premise", () => {
    expect(p).toMatch(/can then fix your premise/);
  });
});

describe("systemPrompt — rule 3: gaps are stated", () => {
  const p = systemPrompt({ backends: fullBackends() });

  it("forbids filling a failed check from memory", () => {
    expect(p).toMatch(/do not fill the hole from memory/);
  });

  it("says why omission is the dangerous option", () => {
    // The invariant in one sentence: an omitted failed check reads like a passed one.
    expect(p).toMatch(/reads exactly like an answer where capacity was fine/s);
  });

  it("treats an empty result as a real answer", () => {
    expect(p).toMatch(/is a real, useful answer/);
  });
});

describe("systemPrompt — the rest of the contract", () => {
  it("orders the workflow shape-first", () => {
    const p = systemPrompt();
    const shapeAt = p.indexOf("recommend_shape");
    const findAt = p.indexOf("find_instances for the hardware");
    expect(shapeAt).toBeGreaterThan(-1);
    expect(findAt).toBeGreaterThan(shapeAt);
    expect(p).toMatch(/Do this first; it changes which instance advice is correct/);
  });

  it("says it cannot launch anything", () => {
    expect(systemPrompt()).toMatch(/You cannot launch anything/);
  });

  it("tells the model to ask rather than assume a duration", () => {
    // An assumed duration yields a confident total that is wrong by a factor.
    expect(systemPrompt()).toMatch(/ask rather than assume/);
  });

  it("bounds the scope, so the grounding rules can't lapse elsewhere", () => {
    expect(systemPrompt()).toMatch(/You are not a general assistant/);
  });

  it("requires 'approximately' for a catalog-estimate price", () => {
    expect(systemPrompt()).toMatch(/say "approximately"/);
  });
});

describe("systemPrompt — deployment context", () => {
  it("names the deployment's blind spots so the model can mention them", () => {
    // The model has to know what it cannot check in order to say so.
    const p = systemPrompt({ backends: offlineBackends() });
    expect(p).toMatch(/THIS DEPLOYMENT'S LIMITS/);
    expect(p).toMatch(/no AWS credentials/);
  });

  it("omits the limits section when nothing is missing", () => {
    expect(systemPrompt({ backends: fullBackends() })).not.toMatch(/THIS DEPLOYMENT'S LIMITS/);
  });

  it("states the region when known", () => {
    expect(systemPrompt({ region: "eu-west-1" })).toMatch(/region is eu-west-1/);
  });

  it("appends caller-supplied guidance verbatim", () => {
    expect(systemPrompt({ extra: "Site policy: no p5 instances." })).toMatch(/Site policy: no p5 instances\./);
  });

  it("is deterministic for the same input", () => {
    expect(systemPrompt({ region: "us-east-1" })).toBe(systemPrompt({ region: "us-east-1" }));
  });
});
