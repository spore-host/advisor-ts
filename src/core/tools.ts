// The tool registry — every fact the advisor is allowed to state comes from here.
//
// Two rules govern this file, and they are the whole design:
//
// 1. READ-ONLY. There is no `launch` tool, and adding one is a decision, not a
//    convenience. An LLM must not be one hallucinated tool-call away from a
//    billable RunInstances. The advisor's output is a *proposal* a human submits
//    through spawn-ts's existing form — advice, then a human hand on the trigger.
//
// 2. A TOOL THAT CANNOT WORK IS NOT OFFERED. `buildToolset` returns only the
//    tools whose backend is actually present. Offering `check_quota` with no
//    credentials would return an error every time, and a model that sees a tool
//    fail repeatedly stops calling it and answers from memory instead — which is
//    precisely the failure this library exists to prevent. Fewer tools with a
//    stated gap beats more tools that lie.
//
// Every handler returns plain JSON-serializable data. Nothing here imports the
// AWS SDK, truffle-ts, or lagotto-ts: backends arrive through the structural
// seams in backends.ts, so the entire registry is testable with object literals.

import type { AdvisorBackends } from "./backends.js";
import type { JsonSchema } from "./schema.js";
import { validate } from "./schema.js";
import { estimateCost, spotAdvice, spotComparison } from "./cost.js";
import { recommendShape } from "./shapes.js";
import { lookupWorkload, knownWorkloads } from "./workloads.js";

/** A tool the model may call. */
export interface Tool {
  name: string;
  /**
   * What the tool does, written FOR THE MODEL. These descriptions are prompt
   * text: they decide whether a tool gets called at the right moment, so they say
   * when to use the tool, not just what it does.
   */
  description: string;
  inputSchema: JsonSchema;
  /** Runs the tool. Throws on failure; the caller records the failure as a gap. */
  handler(input: Record<string, unknown>): Promise<unknown>;
}

/** The outcome of running a tool: never an exception at this boundary. */
export interface ToolOutcome {
  ok: boolean;
  /** Present when `ok`. */
  result?: unknown;
  /** Present when not `ok` — the message that becomes both a tool result and a gap. */
  error?: string;
}

/**
 * Build the tool set for a given set of backends. `recommend_shape` and
 * `estimate_cost` are always present because they are pure; everything else
 * appears only if its backend does.
 */
export function buildToolset(backends: AdvisorBackends): Tool[] {
  const tools: Tool[] = [shapeTool(), costTool(), workloadTool()];
  if (backends.instances) tools.push(findInstancesTool(backends), pricingTool(backends));
  if (backends.apps) tools.push(lookupAppTool(backends));
  if (backends.live) tools.push(spotPricesTool(backends), quotaTool(backends));
  if (backends.capacity) tools.push(capacityTool(backends));
  return tools;
}

/**
 * Names of the checks a toolset CANNOT perform, phrased as user-facing gaps. The
 * advisor states these up front. A missing capability that is never mentioned is
 * indistinguishable from a capability that ran and found nothing wrong.
 */
export function missingCapabilities(backends: AdvisorBackends): string[] {
  const gaps: string[] = [];
  if (!backends.instances) {
    gaps.push("no instance catalog is available, so no instance type can be recommended by name");
  }
  if (!backends.live) {
    gaps.push("no AWS credentials, so spot prices and service-quota headroom were not checked");
  }
  if (!backends.capacity) {
    gaps.push("capacity was not checked — a recommended type may not be launchable right now");
  }
  return gaps;
}

/**
 * Run a tool by name with validated input. Never throws: a bad name, invalid
 * input, and a failing handler all come back as `{ ok: false, error }`, because
 * the transcript must carry the failure to the model AND to the user's gap list.
 * A silently dropped tool error is the Go #63 defect — an error that reads as an
 * absence of data.
 */
export async function runTool(
  tools: Tool[],
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      ok: false,
      error: `no such tool "${name}" — available tools: ${tools.map((t) => t.name).join(", ")}`,
    };
  }
  const problems = validate(input, tool.inputSchema);
  if (problems.length > 0) {
    return { ok: false, error: `invalid input for ${name}: ${problems.join("; ")}` };
  }
  try {
    const result = await tool.handler(input as Record<string, unknown>);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: `${name} failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Pure tools — always available, no backend, no credentials.
// ---------------------------------------------------------------------------

function shapeTool(): Tool {
  return {
    name: "recommend_shape",
    description:
      "Decide HOW a workload runs: as a single node, an indexed job array of " +
      "independent tasks, or one tightly-coupled MPI job. Call this FIRST, before " +
      "looking for instance types — the shape changes which instance advice is " +
      "correct (an array of 500 tasks wants a cheap type on spot; an MPI job wants " +
      "one placement group and an EFA fabric). Pass the user's own description of " +
      "the work verbatim, plus a task count if they gave one.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "The user's description of the work, in their words.",
        },
        taskCount: {
          type: "integer",
          minimum: 1,
          description: "Number of independent tasks, if the user said. Omit if unknown — do not guess.",
        },
        mpi: { type: "boolean", description: "True only if the user stated the code uses MPI." },
        gpu: { type: "boolean", description: "True only if the user stated it is GPU-accelerated." },
      },
      required: ["description"],
    },
    async handler(input) {
      return recommendShape({
        description: String(input.description),
        taskCount: input.taskCount as number | undefined,
        mpi: input.mpi as boolean | undefined,
        gpu: input.gpu as boolean | undefined,
      });
    },
  };
}

function costTool(): Tool {
  return {
    name: "estimate_cost",
    description:
      "Turn an hourly price into a total for a run. You must supply pricePerHour " +
      "from a previous get_pricing or get_spot_prices call — never from memory. " +
      "Returns the total, the fleet hourly rate, and caveats that MUST be repeated " +
      "alongside the number. Errors if no price is available, which is the correct " +
      "answer to report rather than an invented figure.",
    inputSchema: {
      type: "object",
      properties: {
        pricePerHour: {
          type: "number",
          minimum: 0,
          description: "Hourly USD for ONE instance, from a pricing tool result.",
        },
        hours: { type: "number", minimum: 0, description: "How long the run takes, in hours." },
        count: { type: "integer", minimum: 1, description: "Concurrent instance count. Defaults to 1." },
        estimatedPrice: {
          type: "boolean",
          description: "Pass through the estimatedPrice flag from the pricing result, if it was set.",
        },
        shape: {
          type: "string",
          enum: ["single-node", "job-array", "mpi"],
          description: "The execution shape, so spot suitability can be judged.",
        },
        spotPricePerHour: {
          type: "number",
          minimum: 0,
          description: "Spot $/hr for one instance, if get_spot_prices returned one.",
        },
      },
      required: ["pricePerHour", "hours"],
    },
    async handler(input) {
      const hours = input.hours as number;
      const count = (input.count as number | undefined) ?? 1;
      const estimate = estimateCost({
        pricePerHour: input.pricePerHour as number,
        hours,
        count,
        estimatedPrice: input.estimatedPrice as boolean | undefined,
      });
      const spot = spotComparison(
        input.pricePerHour as number,
        input.spotPricePerHour as number | undefined,
        hours,
        count,
      );
      return {
        ...estimate,
        spot,
        spotAdvice: input.shape ? spotAdvice(String(input.shape), hours) : undefined,
      };
    },
  };
}

function workloadTool(): Tool {
  return {
    name: "lookup_workload",
    description:
      "Check whether a named research code has a VERIFIED entry in the local " +
      "knowledge base. The KB is deliberately small — most workloads are NOT in " +
      "it, and a miss is completely normal, not an error. On a hit, use the entry " +
      "and cite its provenance. On a miss, describe the workload from your own " +
      "knowledge and say explicitly that the characterisation is your inference, " +
      "then use find_instances to get real instance types for that shape.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The workload/code name as the user said it." },
      },
      required: ["name"],
    },
    async handler(input) {
      const name = String(input.name);
      const entry = lookupWorkload(name);
      if (!entry) {
        return {
          found: false,
          asked: name,
          provenance: "none",
          // Spelled out so the model does not treat a miss as a dead end. This is
          // the common path, and it must degrade to labelled inference rather than
          // to a refusal or a bluff.
          guidance:
            `"${name}" has no verified entry. This is expected — the knowledge base only ` +
            `covers workloads with a citable published opinion. Describe the workload's ` +
            `hardware needs from your own knowledge, state clearly that this is your ` +
            `inference and not a retrieved fact, and then call find_instances to get real ` +
            `instance types. Do not invent instance names, prices, or quota numbers.`,
          verifiedEntries: knownWorkloads(),
        };
      }
      return {
        found: true,
        asked: name,
        canonicalName: entry.name,
        shape: entry.shape,
        rationale: entry.rationale,
        gpuAccelerated: entry.gpuAccelerated,
        multiNode: entry.multiNode,
        efa: entry.efa,
        memoryBound: entry.memoryBound,
        provenance: "catalog",
        citation: entry.provenance,
        suggestedFamilies: entry.families,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog-backed tools — offline, but need an InstanceSource / AppSource.
// ---------------------------------------------------------------------------

function findInstancesTool(backends: AdvisorBackends): Tool {
  const src = backends.instances!;
  return {
    name: "find_instances",
    description:
      "THE ONLY WAY to obtain real EC2 instance type names. Takes a short " +
      "hardware query in plain language ('nvidia h100 8 gpus efa', 'graviton 32 " +
      "cores 128gb', 'gpu with 80gb vram') and returns matching types with vCPU, " +
      "memory, GPU, architecture, an approximate hourly price, and the reasons " +
      "each one matched. Never state an instance type that did not come from this " +
      "tool. If the result is empty, say so and broaden the query — an empty " +
      "result is information, not a failure.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Hardware constraints in plain language. Understood: GPU model/vendor, " +
            "GPU count ('8 gpus'), per-GPU VRAM ('80gb vram'), vCPU count, memory, " +
            "architecture (graviton/arm64/intel/amd), efa, and instance-type globs ('c7*').",
        },
        sort: {
          type: "string",
          enum: ["cheapest", "expensive", "performant", "newest"],
          description: "Ranking preference. Use 'cheapest' whenever the user mentions budget.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "How many results to return. Defaults to 8; ask for more only if needed.",
        },
      },
      required: ["query"],
    },
    async handler(input) {
      const limit = (input.limit as number | undefined) ?? 8;
      const sort = input.sort as string | undefined;
      const results = await src.find(String(input.query), sort ? { sort } : {});
      return {
        source: src.label,
        catalogAsOf: src.asOf,
        // The total is reported alongside the truncated list so a capped result set
        // can't read as an exhaustive one.
        totalMatches: results.length,
        returned: Math.min(limit, results.length),
        matches: results.slice(0, limit).map((r) => ({
          instanceType: r.instance.instanceType,
          vcpus: r.instance.vcpus,
          memoryGiB: Math.round(r.instance.memoryMib / 1024),
          gpus: r.instance.gpus,
          gpuModel: r.instance.gpuModel,
          gpuMemoryGiBPerGpu:
            r.instance.gpus && r.instance.gpuMemoryMib
              ? Math.round(r.instance.gpuMemoryMib / r.instance.gpus / 1024)
              : undefined,
          architecture: r.instance.architecture,
          onDemandPricePerHour: r.instance.onDemandPrice,
          priceIsEstimate: r.instance.estimatedPrice === true,
          matchedBecause: r.reasons,
        })),
      };
    },
  };
}

function pricingTool(backends: AdvisorBackends): Tool {
  const src = backends.instances!;
  return {
    name: "get_pricing",
    description:
      "Get the on-demand hourly price for specific instance types by name. Use " +
      "this before estimate_cost. If a type has no price in the catalog, the " +
      "result says so — report that gap rather than substituting a number you " +
      "remember, and note when priceIsEstimate is true.",
    inputSchema: {
      type: "object",
      properties: {
        instanceTypes: {
          type: "array",
          items: { type: "string" },
          description: "Exact instance type names, e.g. ['p5.48xlarge', 'g6e.xlarge'].",
        },
      },
      required: ["instanceTypes"],
    },
    async handler(input) {
      const names = input.instanceTypes as string[];
      const prices: Array<Record<string, unknown>> = [];
      const notFound: string[] = [];
      for (const name of names) {
        // An exact-name query goes through the same pattern path `find` uses, so
        // pricing can never disagree with what find_instances reported.
        const hits = await src.find(name);
        const exact = hits.find((h) => h.instance.instanceType === name);
        if (!exact) {
          notFound.push(name);
          continue;
        }
        if (exact.instance.onDemandPrice === undefined) {
          notFound.push(`${name} (in the catalog, but with no price recorded)`);
          continue;
        }
        prices.push({
          instanceType: name,
          onDemandPricePerHour: exact.instance.onDemandPrice,
          priceIsEstimate: exact.instance.estimatedPrice === true,
        });
      }
      return {
        source: src.label,
        catalogAsOf: src.asOf,
        currency: "USD",
        prices,
        // Named, not omitted: a shorter list than the one asked for must not read
        // as "these were the ones that exist".
        noPriceAvailable: notFound,
      };
    },
  };
}

function lookupAppTool(backends: AdvisorBackends): Tool {
  const src = backends.apps!;
  return {
    name: "lookup_app",
    description:
      "Look up an INTERACTIVE VISUALIZATION application (paraview, chimerax, igv, " +
      "qgis, fiji, ds9) for its recommended instance families and minimum sizing. " +
      "This catalog covers desktop/streaming apps ONLY — it knows nothing about " +
      "batch or MPI codes. For those, use lookup_workload instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The application name." },
      },
      required: ["name"],
    },
    async handler(input) {
      const name = String(input.name);
      const entry = src.lookupApp(name);
      if (!entry) {
        return {
          found: false,
          asked: name,
          knownApps: src.appNames(),
          guidance:
            `"${name}" is not an interactive-visualization app in this catalog. If it is a ` +
            `batch or simulation code, call lookup_workload; if that also misses, describe ` +
            `it from your own knowledge and label that as inference.`,
        };
      }
      return { found: true, provenance: "catalog", ...entry };
    },
  };
}

// ---------------------------------------------------------------------------
// Live tools — need credentials. Absent from the toolset when the backend is.
// ---------------------------------------------------------------------------

function spotPricesTool(backends: AdvisorBackends): Tool {
  const live = backends.live!;
  return {
    name: "get_spot_prices",
    description:
      "Get CURRENT per-availability-zone spot prices for instance types, with the " +
      "saving against on-demand. Spot prices differ per AZ, so the result lists " +
      "each AZ separately — do not average them into one figure. Call this " +
      "whenever cost matters, and pair the saving with whether the workload can " +
      "survive an interruption.",
    inputSchema: {
      type: "object",
      properties: {
        instanceTypes: {
          type: "array",
          items: { type: "string" },
          description: "Exact instance type names from find_instances.",
        },
      },
      required: ["instanceTypes"],
    },
    async handler(input) {
      const observations = await live.getSpotPrices(input.instanceTypes as string[]);
      const asked = new Set(input.instanceTypes as string[]);
      for (const o of observations) asked.delete(o.instanceType);
      return {
        region: live.region,
        provenance: "live AWS spot price history",
        observations,
        // A type with no spot offering must be visible as such. Dropping it would
        // make "not offered on spot" look identical to "not asked about".
        noSpotDataFor: [...asked],
      };
    },
  };
}

function quotaTool(backends: AdvisorBackends): Tool {
  const live = backends.live!;
  return {
    name: "check_quota",
    description:
      "Check whether the account's EC2 vCPU service quota allows launching a " +
      "given count of an instance type. Call this before recommending anything " +
      "large: a perfect recommendation the account cannot launch is not a useful " +
      "answer. Report the reason verbatim when the answer is no.",
    inputSchema: {
      type: "object",
      properties: {
        instanceType: { type: "string", description: "Exact instance type name." },
        count: { type: "integer", minimum: 1, description: "How many instances. Defaults to 1." },
        spot: { type: "boolean", description: "True to check the Spot vCPU quota instead of On-Demand." },
      },
      required: ["instanceType"],
    },
    async handler(input) {
      const verdict = await live.checkQuota(
        String(input.instanceType),
        (input.count as number | undefined) ?? 1,
        (input.spot as boolean | undefined) ?? false,
      );
      return { region: live.region, provenance: "live AWS Service Quotas", ...verdict };
    },
  };
}

function capacityTool(backends: AdvisorBackends): Tool {
  const cap = backends.capacity!;
  return {
    name: "check_capacity",
    description:
      "Check whether an instance type is actually available RIGHT NOW in the " +
      "region, and in which availability zones. Quota says what the account is " +
      "allowed; this says what AWS currently has. Use it for scarce types (P and " +
      "Trn families especially) before telling someone to launch one.",
    inputSchema: {
      type: "object",
      properties: {
        instanceTypePattern: {
          type: "string",
          description: "An exact type ('p5.48xlarge') or a glob ('p5.*').",
        },
        spot: { type: "boolean", description: "Check spot capacity rather than on-demand." },
        maxPrice: { type: "number", minimum: 0, description: "Only match spot at or below this $/hr." },
      },
      required: ["instanceTypePattern"],
    },
    async handler(input) {
      const result = await cap.check(String(input.instanceTypePattern), {
        spot: input.spot as boolean | undefined,
        maxPrice: input.maxPrice as number | undefined,
      });
      return { provenance: "live EC2 capacity check", ...result };
    },
  };
}
