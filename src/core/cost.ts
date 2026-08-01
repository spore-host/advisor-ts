// Cost estimation — pure arithmetic over a price the TOOLS supplied.
//
// This mirrors spawn-ts's `accumulatedCost` (src/core/lifecycle.ts:38):
// dollars = computeSeconds/3600 × pricePerHour, per instance, summed. Same
// formula deliberately, so an estimate here and the meter a running instance
// shows can't disagree.
//
// The estimate exists because spawn-ts today has no real pricing at all — its
// dashboard falls back to a hardcoded 0.153 $/hr — so "how much will this cost?"
// can only be answered by composing truffle-ts pricing with spawn-ts's lifecycle
// arithmetic. That composition is this file.
//
// Everything here refuses to produce a number it can't justify. An estimate whose
// price came from nowhere is worse than no estimate: it gets quoted.

/** What an estimate needs. `pricePerHour` must come from a pricing tool. */
export interface CostInput {
  /** On-demand or spot $/hr for ONE instance. Tool-sourced, never model-supplied. */
  pricePerHour: number;
  /** How long the work runs, in hours. */
  hours: number;
  /** How many instances run concurrently for that time. */
  count?: number;
  /** True when `pricePerHour` is a static estimate, not live pricing. */
  estimatedPrice?: boolean;
}

/** A cost estimate, with the caveats that apply to it. */
export interface CostEstimate {
  /** Total dollars for `count` instances over `hours`. */
  total: number;
  /** Dollars per hour for the whole fleet. */
  perHour: number;
  hours: number;
  count: number;
  /**
   * Caveats that must be shown WITH the number, not filed elsewhere. A cost
   * figure travels — into a grant budget, into an email — and it takes its
   * qualifications with it or it stops having any.
   */
  caveats: string[];
}

/**
 * Estimate cost. Throws on inputs that cannot yield a meaningful number, rather
 * than returning 0 or NaN: a zero total reads as "free", and `$NaN` at least
 * fails loudly but only after it has reached the user.
 */
export function estimateCost(input: CostInput): CostEstimate {
  const count = input.count ?? 1;
  if (!Number.isFinite(input.pricePerHour) || input.pricePerHour <= 0) {
    throw new Error(
      "cannot estimate cost: no hourly price available for this instance type — " +
        "run get_pricing or get_spot_prices first, and report the gap if it returns nothing",
    );
  }
  if (!Number.isFinite(input.hours) || input.hours <= 0) {
    throw new Error("cannot estimate cost: duration in hours must be greater than zero");
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("cannot estimate cost: instance count must be a whole number of at least 1");
  }

  const perHour = input.pricePerHour * count;
  const caveats: string[] = [];

  if (input.estimatedPrice) {
    caveats.push(
      "the hourly rate is a static catalog estimate, not live AWS pricing — treat it as an order of magnitude",
    );
  }
  // Named because they are the two biggest ways a real bill exceeds this number,
  // and both are invisible in an hourly-rate calculation.
  caveats.push("compute only — EBS volumes, data transfer, and any attached storage are extra");
  caveats.push("assumes the instance runs for the full duration and is then stopped or terminated");

  return {
    total: round2(perHour * input.hours),
    perHour: round2(perHour),
    hours: input.hours,
    count,
    caveats,
  };
}

/**
 * Cost of a spot alternative alongside on-demand, when both prices are known.
 * Returns `undefined` if the spot price is missing — an unavailable comparison is
 * reported as unavailable, never as "no savings".
 */
export function spotComparison(
  onDemandPerHour: number,
  spotPerHour: number | undefined,
  hours: number,
  count = 1,
): { spotTotal: number; onDemandTotal: number; savings: number; savingsPercent: number } | undefined {
  if (!spotPerHour || spotPerHour <= 0 || !onDemandPerHour || onDemandPerHour <= 0) return undefined;
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  const spotTotal = spotPerHour * count * hours;
  const onDemandTotal = onDemandPerHour * count * hours;
  return {
    spotTotal: round2(spotTotal),
    onDemandTotal: round2(onDemandTotal),
    savings: round2(onDemandTotal - spotTotal),
    savingsPercent: Math.round(((onDemandTotal - spotTotal) / onDemandTotal) * 100),
  };
}

/**
 * Whether spot is a sensible recommendation for an execution shape, with the
 * reason. Shape-driven, not price-driven: a 40% saving is irrelevant if an
 * interruption destroys twelve hours of MPI work.
 */
export function spotAdvice(shape: string, hours?: number): { recommended: boolean; reason: string } {
  if (shape === "job-array") {
    return {
      recommended: true,
      reason:
        "independent tasks tolerate interruption — a reclaimed task is re-run on its own, " +
        "so spot's discount comes with no risk to the rest of the work",
    };
  }
  if (shape === "mpi") {
    return {
      recommended: false,
      reason:
        "every rank must stay up: losing one instance to a spot reclaim kills the whole job, " +
        "not one task, so on-demand (or a capacity reservation) is the safer buy",
    };
  }
  if (hours !== undefined && hours > 8) {
    return {
      recommended: false,
      reason: `a single ${hours}-hour run has no checkpoint to fall back to — an interruption late in the run loses the work`,
    };
  }
  return {
    recommended: true,
    reason: "a short single-node run is cheap to restart if it is interrupted",
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
