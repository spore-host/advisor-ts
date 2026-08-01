import { describe, it, expect } from "vitest";
import { buildToolset, missingCapabilities, runTool } from "./tools.js";
import { validate } from "./schema.js";
import {
  fullBackends,
  offlineBackends,
  stubCapacity,
  stubInstances,
  stubLive,
} from "./fixtures.test-util.js";

describe("buildToolset", () => {
  it("offers every tool when every backend is wired", () => {
    const names = buildToolset(fullBackends()).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "recommend_shape",
        "estimate_cost",
        "lookup_workload",
        "find_instances",
        "get_pricing",
        "lookup_app",
        "get_spot_prices",
        "check_quota",
        "check_capacity",
      ]),
    );
  });

  it("NEVER offers a launch tool", () => {
    // The security property, asserted rather than assumed: an LLM must not be one
    // hallucinated tool-call away from a billable RunInstances. Adding one is a
    // decision, and this test is where that decision has to be made explicitly.
    const names = buildToolset(fullBackends()).map((t) => t.name);
    expect(names.some((n) => /launch|create|run_instance|terminate|delete/.test(n))).toBe(false);
  });

  it("omits the live tools when there are no credentials", () => {
    // A tool that always fails teaches the model to answer from memory instead —
    // the exact failure this library exists to prevent.
    const names = buildToolset(offlineBackends()).map((t) => t.name);
    expect(names).not.toContain("check_quota");
    expect(names).not.toContain("get_spot_prices");
    expect(names).not.toContain("check_capacity");
  });

  it("still offers the pure tools with no backends at all", () => {
    const names = buildToolset({}).map((t) => t.name);
    expect(names).toEqual(["recommend_shape", "estimate_cost", "lookup_workload"]);
  });

  it("gives every tool a description written for the model", () => {
    for (const t of buildToolset(fullBackends())) {
      expect(t.description.length, t.name).toBeGreaterThan(80);
    }
  });

  it("gives every tool an object input schema with required fields declared", () => {
    for (const t of buildToolset(fullBackends())) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(Object.keys(t.inputSchema.properties ?? {}).length, t.name).toBeGreaterThan(0);
    }
  });

  it("documents every schema property, since the schema is prompt text", () => {
    for (const t of buildToolset(fullBackends())) {
      for (const [key, prop] of Object.entries(t.inputSchema.properties ?? {})) {
        expect(prop.description, `${t.name}.${key}`).toBeTruthy();
      }
    }
  });
});

describe("missingCapabilities", () => {
  it("names the checks an offline deployment cannot run", () => {
    const gaps = missingCapabilities(offlineBackends());
    expect(gaps.some((g) => /credentials/.test(g))).toBe(true);
    expect(gaps.some((g) => /capacity/.test(g))).toBe(true);
  });

  it("is empty when everything is wired", () => {
    expect(missingCapabilities(fullBackends())).toEqual([]);
  });

  it("names the absent catalog when there is no instance source", () => {
    expect(missingCapabilities({}).some((g) => /no instance catalog/.test(g))).toBe(true);
  });
});

describe("runTool", () => {
  const tools = buildToolset(fullBackends());

  it("runs a tool with valid input", async () => {
    const out = await runTool(tools, "recommend_shape", { description: "500 independent runs" });
    expect(out.ok).toBe(true);
    expect((out.result as { shape: string }).shape).toBe("job-array");
  });

  it("reports an unknown tool name and lists the real ones", async () => {
    const out = await runTool(tools, "launch_instance", {});
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no such tool "launch_instance"/);
    expect(out.error).toMatch(/find_instances/);
  });

  it("rejects invalid input before the handler runs", async () => {
    const out = await runTool(tools, "estimate_cost", { pricePerHour: "cheap", hours: 4 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/invalid input for estimate_cost/);
  });

  it("turns a handler throw into a recorded failure, never an exception", async () => {
    // The Go #63 invariant: an error must never be indistinguishable from an
    // absence of data — so it comes back as data, marked as an error.
    const broken = buildToolset({ instances: stubInstances({ fail: "network unreachable" }) });
    const out = await runTool(broken, "find_instances", { query: "h100" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/find_instances failed: network unreachable/);
  });

  it("validates against the tool's own declared schema", async () => {
    // Round-trip: what the model is told is the same thing that gets enforced.
    for (const t of tools) {
      const problems = validate({}, t.inputSchema);
      const required = t.inputSchema.required ?? [];
      expect(problems.length, t.name).toBe(required.length);
    }
  });
});

describe("find_instances", () => {
  const tools = buildToolset(fullBackends());

  it("returns instance types with per-GPU VRAM and the reasons they matched", async () => {
    const out = await runTool(tools, "find_instances", { query: "h100 8 gpus" });
    const r = out.result as {
      matches: Array<Record<string, unknown>>;
      catalogAsOf: string;
      source: string;
    };
    const p5 = r.matches.find((m) => m.instanceType === "p5.48xlarge")!;
    // Per-GPU, not aggregate: 8 × 80 GiB must report 80, not 640.
    expect(p5.gpuMemoryGiBPerGpu).toBe(80);
    expect(p5.matchedBecause).toContain("GPUs: 8 >= 8");
    // The snapshot date travels with the data — undated catalog data reads as current.
    expect(r.catalogAsOf).toBe("2026-07");
    expect(r.source).toBe("test catalog");
  });

  it("reports the total alongside a truncated list", async () => {
    // A capped result set must not read as an exhaustive one.
    const out = await runTool(tools, "find_instances", { query: "gpu", limit: 2 });
    const r = out.result as { totalMatches: number; returned: number; matches: unknown[] };
    expect(r.matches).toHaveLength(2);
    expect(r.returned).toBe(2);
    expect(r.totalMatches).toBe(4);
  });

  it("flags a price that is only an estimate", async () => {
    const out = await runTool(tools, "find_instances", { query: "p3.2xlarge" });
    const r = out.result as { matches: Array<{ priceIsEstimate: boolean }> };
    expect(r.matches[0].priceIsEstimate).toBe(true);
  });

  it("passes the sort preference through", async () => {
    const queries: string[] = [];
    const t = buildToolset({ instances: stubInstances({ queries }) });
    await runTool(t, "find_instances", { query: "gpu", sort: "cheapest" });
    expect(queries).toEqual(["gpu"]);
  });

  it("rejects a sort value the finder doesn't understand", async () => {
    const out = await runTool(tools, "find_instances", { query: "gpu", sort: "biggest" });
    expect(out.ok).toBe(false);
  });
});

describe("get_pricing", () => {
  const tools = buildToolset(fullBackends());

  it("returns the on-demand price for a named type", async () => {
    const out = await runTool(tools, "get_pricing", { instanceTypes: ["p5.48xlarge"] });
    const r = out.result as { prices: Array<{ instanceType: string; onDemandPricePerHour: number }> };
    expect(r.prices[0]).toMatchObject({ instanceType: "p5.48xlarge", onDemandPricePerHour: 55.04 });
  });

  it("names the types it has no price for instead of omitting them", async () => {
    // A shorter list than the one asked for must not read as "these are the ones
    // that exist" — that's how a missing price becomes an invented one.
    const out = await runTool(tools, "get_pricing", {
      instanceTypes: ["p5.48xlarge", "p6e-gb200.36xlarge", "made.up"],
    });
    const r = out.result as { prices: unknown[]; noPriceAvailable: string[] };
    expect(r.prices).toHaveLength(1);
    expect(r.noPriceAvailable).toHaveLength(2);
    expect(r.noPriceAvailable.some((s) => /p6e-gb200/.test(s))).toBe(true);
  });

  it("marks an estimated price as an estimate", async () => {
    const out = await runTool(tools, "get_pricing", { instanceTypes: ["p3.2xlarge"] });
    const r = out.result as { prices: Array<{ priceIsEstimate: boolean }> };
    expect(r.prices[0].priceIsEstimate).toBe(true);
  });
});

describe("lookup_workload", () => {
  const tools = buildToolset(fullBackends());

  it("cites the entry on a hit", async () => {
    const out = await runTool(tools, "lookup_workload", { name: "OpenFOAM" });
    const r = out.result as { found: boolean; provenance: string; citation: string; efa: boolean };
    expect(r.found).toBe(true);
    expect(r.provenance).toBe("catalog");
    expect(r.citation).toMatch(/OpenFOAM/);
    expect(r.efa).toBe(true);
  });

  it("tells the model exactly what to do on a miss", async () => {
    // The headline path. A miss is the common case, and it must degrade to labelled
    // inference — not to a refusal, and not to a bluff.
    const out = await runTool(tools, "lookup_workload", { name: "lammps" });
    const r = out.result as { found: boolean; guidance: string; provenance: string };
    expect(r.found).toBe(false);
    expect(r.provenance).toBe("none");
    expect(r.guidance).toMatch(/expected/);
    expect(r.guidance).toMatch(/your own knowledge/);
    expect(r.guidance).toMatch(/inference and not a retrieved fact/);
    expect(r.guidance).toMatch(/Do not invent instance names, prices, or quota numbers/);
  });

  it("succeeds on a miss — an unknown workload is not a tool failure", async () => {
    const out = await runTool(tools, "lookup_workload", { name: "nothing-like-this" });
    expect(out.ok).toBe(true);
  });
});

describe("lookup_app", () => {
  const tools = buildToolset(fullBackends());

  it("returns the catalog entry for a known app", async () => {
    const out = await runTool(tools, "lookup_app", { name: "ParaView" });
    expect(out.result).toMatchObject({ found: true, provenance: "catalog", gpu: true });
  });

  it("points a batch code at lookup_workload instead", async () => {
    const out = await runTool(tools, "lookup_app", { name: "gromacs" });
    const r = out.result as { found: boolean; guidance: string; knownApps: string[] };
    expect(r.found).toBe(false);
    expect(r.guidance).toMatch(/lookup_workload/);
    expect(r.knownApps).toContain("paraview");
  });
});

describe("get_spot_prices", () => {
  const tools = buildToolset(fullBackends());

  it("returns one observation per availability zone", async () => {
    // Spot prices differ per AZ; collapsing them to one number loses the AZ that
    // is actually cheap.
    const out = await runTool(tools, "get_spot_prices", { instanceTypes: ["p5.48xlarge"] });
    const r = out.result as { observations: Array<{ availabilityZone: string }> };
    expect(new Set(r.observations.map((o) => o.availabilityZone)).size).toBe(2);
  });

  it("names types with no spot data instead of dropping them", async () => {
    const out = await runTool(tools, "get_spot_prices", {
      instanceTypes: ["p5.48xlarge", "g6e.xlarge"],
    });
    const r = out.result as { noSpotDataFor: string[] };
    expect(r.noSpotDataFor).toEqual(["g6e.xlarge"]);
  });
});

describe("check_quota", () => {
  const tools = buildToolset(fullBackends());

  it("reports the verdict and the reason verbatim", async () => {
    const out = await runTool(tools, "check_quota", { instanceType: "p5.48xlarge", count: 8 });
    expect(out.result).toMatchObject({ canLaunch: false, reason: "P quota exhausted", family: "P" });
  });

  it("defaults to a count of one", async () => {
    const out = await runTool(tools, "check_quota", { instanceType: "p5.48xlarge" });
    expect((out.result as { canLaunch: boolean }).canLaunch).toBe(true);
  });

  it("surfaces a quota lookup failure as a failure", async () => {
    const t = buildToolset({
      live: stubLive({
        checkQuota: async () => {
          throw new Error("AccessDenied: servicequotas:GetServiceQuota");
        },
      }),
    });
    const out = await runTool(t, "check_quota", { instanceType: "p5.48xlarge" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/AccessDenied/);
  });
});

describe("check_capacity", () => {
  it("reports the AZs where capacity exists", async () => {
    const tools = buildToolset(fullBackends());
    const out = await runTool(tools, "check_capacity", { instanceTypePattern: "p5.*", spot: true });
    expect(out.result).toMatchObject({ available: true, availabilityZone: "us-east-1d" });
  });

  it("distinguishes 'nothing available' from a failed check", async () => {
    // available:false is an observation; a throw is a broken check. A caller must be
    // able to tell them apart.
    const tools = buildToolset({ capacity: stubCapacity(false) });
    const out = await runTool(tools, "check_capacity", { instanceTypePattern: "p5.*" });
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ available: false });
  });
});

describe("estimate_cost", () => {
  const tools = buildToolset(fullBackends());

  it("computes a total and attaches the spot comparison and advice", async () => {
    const out = await runTool(tools, "estimate_cost", {
      pricePerHour: 55.04,
      hours: 4,
      count: 2,
      shape: "mpi",
      spotPricePerHour: 19.75,
    });
    const r = out.result as {
      total: number;
      spot: { savingsPercent: number };
      spotAdvice: { recommended: boolean };
    };
    expect(r.total).toBeCloseTo(440.32, 2);
    expect(r.spot.savingsPercent).toBe(64);
    // Real savings, and still not recommended — because the shape can't survive a
    // reclaim. Cheapness is not the only input.
    expect(r.spotAdvice.recommended).toBe(false);
  });

  it("fails loudly rather than estimating from a zero price", async () => {
    const out = await runTool(tools, "estimate_cost", { pricePerHour: 0, hours: 4 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no hourly price available/);
  });

  it("omits the spot comparison when no spot price was supplied", async () => {
    const out = await runTool(tools, "estimate_cost", { pricePerHour: 10, hours: 1 });
    expect((out.result as { spot?: unknown }).spot).toBeUndefined();
  });
});
