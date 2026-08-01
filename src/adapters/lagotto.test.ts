import { describe, it, expect } from "vitest";
import { lagottoCapacitySource, type LagottoWatcherLike } from "./lagotto.js";

function stubWatcher(match: Awaited<ReturnType<LagottoWatcherLike["check"]>>): LagottoWatcherLike & {
  watches: unknown[];
} {
  const watches: unknown[] = [];
  return {
    watches,
    async check(watch) {
      watches.push(watch);
      return match;
    },
  };
}

describe("lagottoCapacitySource", () => {
  it("reports available capacity with its AZs", async () => {
    const watcher = stubWatcher({
      instanceType: "p5.48xlarge",
      region: "us-east-1",
      availabilityZone: "us-east-1d",
      candidateAzs: ["us-east-1d", "us-east-1a"],
      price: 19.75,
      isSpot: true,
    });
    const src = lagottoCapacitySource({ watcher, region: "us-east-1" });
    const r = await src.check("p5.*", { spot: true, maxPrice: 25 });
    expect(r).toMatchObject({
      available: true,
      instanceType: "p5.48xlarge",
      availabilityZone: "us-east-1d",
      isSpot: true,
    });
    // Candidate AZs travel with the answer: a consumer retries the next one on
    // InsufficientInstanceCapacity.
    expect(r.candidateAzs).toEqual(["us-east-1d", "us-east-1a"]);
  });

  it("builds a single-region watch from the check's arguments", async () => {
    const watcher = stubWatcher(null);
    const src = lagottoCapacitySource({ watcher, region: "eu-west-1", watchId: "w-7" });
    await src.check("g6e.*", { spot: true, maxPrice: 2 });
    expect(watcher.watches[0]).toEqual({
      watchId: "w-7",
      instanceTypePattern: "g6e.*",
      regions: ["eu-west-1"],
      spot: true,
      maxPrice: 2,
    });
  });

  it("returns available:false for no capacity — an observation, not an error", async () => {
    // "nothing on offer right now" and "the check itself failed" are different
    // answers. A thrown error is the second; this is the first, and a caller must be
    // able to tell them apart.
    const src = lagottoCapacitySource({ watcher: stubWatcher(null), region: "us-east-1" });
    const r = await src.check("p5.*", {});
    expect(r).toEqual({ available: false, region: "us-east-1" });
  });

  it("lets a failed check throw, so it lands as a gap", async () => {
    const src = lagottoCapacitySource({
      region: "us-east-1",
      watcher: {
        async check() {
          throw new Error("AccessDenied: ec2:DescribeInstanceTypeOfferings");
        },
      },
    });
    await expect(src.check("p5.*", {})).rejects.toThrow(/AccessDenied/);
  });

  it("checks once rather than polling — the advisor answers now", async () => {
    let calls = 0;
    const src = lagottoCapacitySource({
      region: "us-east-1",
      watcher: {
        async check() {
          calls++;
          return null;
        },
      },
    });
    await src.check("p5.*", {});
    expect(calls).toBe(1);
  });
});
