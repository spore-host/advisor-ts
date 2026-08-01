import { describe, it, expect } from "vitest";
import { truffleAppSource, truffleInstanceSource, truffleLiveSource } from "./truffle.js";
import type { TruffleLiveFinderLike } from "./truffle.js";

describe("truffleInstanceSource", () => {
  it("passes the query and sort through and carries the catalog date", () => {
    const calls: Array<[string, unknown]> = [];
    const src = truffleInstanceSource({
      catalogAsOf: "2026-07",
      find: async (query, opts) => {
        calls.push([query, opts]);
        return [];
      },
    });
    expect(src.asOf).toBe("2026-07");
    expect(src.label).toMatch(/truffle-ts/);
    return src.find("h100", { sort: "cheapest" }).then(() => {
      expect(calls).toEqual([["h100", { sort: "cheapest" }]]);
    });
  });

  it("lets a parse error propagate, so it becomes a stated gap", async () => {
    // truffle's parser throws on a contradictory query ("intel graviton"). That
    // explanation is the most useful thing to return, so it isn't swallowed —
    // runTool turns it into a gap carrying the parser's own words.
    const src = truffleInstanceSource({
      catalogAsOf: "2026-07",
      find: async () => {
        throw new Error("conflicting architectures");
      },
    });
    await expect(src.find("intel graviton")).rejects.toThrow(/conflicting architectures/);
  });
});

describe("truffleAppSource", () => {
  const src = truffleAppSource({
    lookupApp: (name) =>
      name === "paraview"
        ? {
            name: "paraview",
            description: "viz",
            instanceFamilies: ["g6"],
            minVcpus: 4,
            minMemoryGiB: 16,
            gpu: true,
          }
        : undefined,
    appCatalog: { paraview: {}, igv: {} },
  });

  it("looks an app up", () => {
    expect(src.lookupApp("paraview")!.gpu).toBe(true);
  });

  it("lists the catalog's names so a miss can offer alternatives", () => {
    expect(src.appNames()).toEqual(["paraview", "igv"]);
  });
});

describe("truffleLiveSource", () => {
  /** A stub live finder with a controllable quota verdict. */
  function stubFinder(over: Partial<TruffleLiveFinderLike> = {}): TruffleLiveFinderLike {
    return {
      async search(matcher) {
        return [
          { instanceType: "p5.48xlarge", vcpus: 192, onDemandPrice: 55.04 },
          { instanceType: "g6e.xlarge", vcpus: 4, onDemandPrice: 1.861 },
        ].filter((i) => matcher.test(i.instanceType));
      },
      async getSpotPricing(instances) {
        return instances.map((i) => ({
          instanceType: i.instanceType,
          region: "us-east-1",
          availabilityZone: "us-east-1a",
          spotPrice: 20,
          onDemandPrice: 55.04,
          savingsPercent: 64,
        }));
      },
      async getQuotas() {
        return { region: "us-east-1" };
      },
      canLaunch() {
        return {
          canLaunch: true,
          reason: "within quota",
          family: "P",
          requestedVcpus: 192,
          availableVcpus: 768,
        };
      },
      ...over,
    };
  }

  it("requests savings when fetching spot prices", async () => {
    let opts: unknown;
    const src = truffleLiveSource({
      region: "us-east-1",
      finder: stubFinder({
        getSpotPricing: async (_i, o) => {
          opts = o;
          return [];
        },
      }),
    });
    await src.getSpotPrices(["p5.48xlarge"]);
    expect(opts).toEqual({ showSavings: true });
  });

  it("skips the API call entirely for an empty type list", async () => {
    let called = false;
    const src = truffleLiveSource({
      region: "us-east-1",
      finder: stubFinder({
        getSpotPricing: async () => {
          called = true;
          return [];
        },
      }),
    });
    expect(await src.getSpotPrices([])).toEqual([]);
    expect(called).toBe(false);
  });

  it("checks quota for a single instance", async () => {
    const src = truffleLiveSource({ region: "us-east-1", finder: stubFinder() });
    const v = await src.checkQuota("p5.48xlarge", 1, false);
    expect(v).toMatchObject({ canLaunch: true, family: "P", requestedVcpus: 192 });
  });

  it("scales the request by count instead of checking whether ONE fits", async () => {
    // canLaunch prices one instance. Without scaling, "can I launch 64 of these?"
    // would be answered by checking whether a single one fits — a green light for a
    // launch that cannot happen.
    const src = truffleLiveSource({ region: "us-east-1", finder: stubFinder() });
    const v = await src.checkQuota("p5.48xlarge", 8, false);
    expect(v.requestedVcpus).toBe(192 * 8);
    expect(v.canLaunch).toBe(false);
    expect(v.reason).toMatch(/1536 vCPUs but only 768/);
  });

  it("allows a multi-instance launch that genuinely fits", async () => {
    const src = truffleLiveSource({ region: "us-east-1", finder: stubFinder() });
    const v = await src.checkQuota("p5.48xlarge", 4, false);
    expect(v.canLaunch).toBe(true);
    expect(v.requestedVcpus).toBe(768);
  });

  it("refuses to assume a scaled launch fits when headroom is unknown", async () => {
    // A missing measurement must not become a green light.
    const src = truffleLiveSource({
      region: "us-east-1",
      finder: stubFinder({
        canLaunch: () => ({
          canLaunch: true,
          reason: "quota limit retrieved but current usage unavailable",
          family: "P",
          requestedVcpus: 192,
        }),
      }),
    });
    const v = await src.checkQuota("p5.48xlarge", 8, false);
    expect(v.canLaunch).toBe(false);
    expect(v.reason).toMatch(/headroom could not be determined/);
  });

  it("throws — rather than guessing — when the type isn't in the region", async () => {
    const src = truffleLiveSource({ region: "us-east-1", finder: stubFinder() });
    await expect(src.checkQuota("made.up", 1, false)).rejects.toThrow(/quota was NOT checked/);
  });

  it("anchors the type lookup so a prefix can't match the wrong type", async () => {
    // An unanchored /g6e.xlarge/ would also match "g6e.xlarge.metal"; the dot would
    // additionally match any character.
    const seen: RegExp[] = [];
    const src = truffleLiveSource({
      region: "us-east-1",
      finder: stubFinder({
        async search(matcher) {
          seen.push(matcher);
          return [{ instanceType: "g6e.xlarge", vcpus: 4 }];
        },
      }),
    });
    await src.checkQuota("g6e.xlarge", 1, false);
    expect(seen[0].source).toBe("^g6e\\.xlarge$");
    expect(seen[0].test("g6eaxlarge")).toBe(false);
    expect(seen[0].test("g6e.xlarge.metal")).toBe(false);
  });
});
