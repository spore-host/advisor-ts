import { describe, it, expect } from "vitest";
import { estimateCost, spotAdvice, spotComparison } from "./cost.js";

describe("estimateCost", () => {
  it("computes total and fleet hourly rate", () => {
    const e = estimateCost({ pricePerHour: 2.5, hours: 4, count: 3 });
    expect(e.perHour).toBe(7.5);
    expect(e.total).toBe(30);
    expect(e.count).toBe(3);
  });

  it("defaults to one instance", () => {
    expect(estimateCost({ pricePerHour: 1.5, hours: 2 }).total).toBe(3);
  });

  it("throws rather than returning zero when no price is available", () => {
    // A zero total reads as "free" — the one output worse than an error here.
    expect(() => estimateCost({ pricePerHour: 0, hours: 4 })).toThrow(/no hourly price available/);
    expect(() => estimateCost({ pricePerHour: NaN, hours: 4 })).toThrow(/no hourly price available/);
  });

  it("names the tools to call in the no-price error", () => {
    // The error text becomes a tool result the model reads, so it says what to do.
    expect(() => estimateCost({ pricePerHour: 0, hours: 1 })).toThrow(/get_pricing or get_spot_prices/);
  });

  it("throws on a non-positive duration", () => {
    expect(() => estimateCost({ pricePerHour: 1, hours: 0 })).toThrow(/hours/);
  });

  it("throws on a fractional or zero instance count", () => {
    expect(() => estimateCost({ pricePerHour: 1, hours: 1, count: 0 })).toThrow(/whole number/);
    expect(() => estimateCost({ pricePerHour: 1, hours: 1, count: 1.5 })).toThrow(/whole number/);
  });

  it("always carries the compute-only and full-duration caveats", () => {
    // A cost figure travels — into a budget, into an email — and it takes its
    // qualifications with it or it stops having any.
    const e = estimateCost({ pricePerHour: 1, hours: 1 });
    expect(e.caveats.some((c) => /EBS|data transfer/.test(c))).toBe(true);
    expect(e.caveats.some((c) => /full duration/.test(c))).toBe(true);
  });

  it("flags an estimated price as an estimate", () => {
    const e = estimateCost({ pricePerHour: 1, hours: 1, estimatedPrice: true });
    expect(e.caveats.some((c) => /static catalog estimate/.test(c))).toBe(true);
  });

  it("does not claim a live price when estimatedPrice is unset", () => {
    const e = estimateCost({ pricePerHour: 1, hours: 1 });
    expect(e.caveats.some((c) => /static catalog estimate/.test(c))).toBe(false);
  });
});

describe("spotComparison", () => {
  it("computes savings against on-demand", () => {
    const c = spotComparison(10, 3, 2, 1)!;
    expect(c.onDemandTotal).toBe(20);
    expect(c.spotTotal).toBe(6);
    expect(c.savings).toBe(14);
    expect(c.savingsPercent).toBe(70);
  });

  it("returns undefined — not zero savings — when the spot price is unknown", () => {
    // "no spot data" and "spot saves nothing" are different answers, and only one
    // of them is true here.
    expect(spotComparison(10, undefined, 2)).toBeUndefined();
    expect(spotComparison(10, 0, 2)).toBeUndefined();
  });

  it("returns undefined when on-demand is unknown", () => {
    expect(spotComparison(0, 3, 2)).toBeUndefined();
  });

  it("returns undefined for a non-positive duration", () => {
    expect(spotComparison(10, 3, 0)).toBeUndefined();
  });
});

describe("spotAdvice", () => {
  it("recommends spot for a job array, because a lost task is just re-run", () => {
    const a = spotAdvice("job-array");
    expect(a.recommended).toBe(true);
    expect(a.reason).toMatch(/re-run/);
  });

  it("recommends against spot for MPI, because one reclaim kills the whole job", () => {
    // Shape-driven, not price-driven: a 40% saving is irrelevant if an interruption
    // destroys twelve hours of coupled work.
    const a = spotAdvice("mpi");
    expect(a.recommended).toBe(false);
    expect(a.reason).toMatch(/whole job/);
  });

  it("recommends against spot for a long single-node run with no checkpoint", () => {
    expect(spotAdvice("single-node", 24).recommended).toBe(false);
  });

  it("allows spot for a short single-node run", () => {
    expect(spotAdvice("single-node", 2).recommended).toBe(true);
  });

  it("always gives a reason", () => {
    for (const shape of ["job-array", "mpi", "single-node"]) {
      expect(spotAdvice(shape, 3).reason.length).toBeGreaterThan(20);
    }
  });
});
