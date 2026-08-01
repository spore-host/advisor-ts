// Bind lagotto-ts's CapacityWatcher to advisor-ts's `CapacitySource`.
//
// Same discipline as the truffle adapter: the watcher arrives as an argument, so
// lagotto-ts stays a peer/optional dependency and this file is testable with a
// stub that returns a literal.
//
//   import { CapacityWatcher, truffleFinderAdapter } from "@spore-host/lagotto-ts/live";
//   const capacity = lagottoCapacitySource({
//     watcher: new CapacityWatcher({ finder: truffleFinderAdapter(awsFinder, "us-east-1") }),
//     region: "us-east-1",
//   });

import type { AdvisorCapacityResult, CapacitySource } from "../core/backends.js";

/** The slice of lagotto-ts's `CapacityWatcher` this adapter needs. */
export interface LagottoWatcherLike {
  check(watch: {
    watchId: string;
    instanceTypePattern: string;
    regions: string[];
    spot?: boolean;
    maxPrice?: number;
  }): Promise<{
    instanceType: string;
    region: string;
    availabilityZone: string;
    candidateAzs: string[];
    price: number;
    isSpot: boolean;
  } | null>;
}

export interface LagottoCapacityOptions {
  watcher: LagottoWatcherLike;
  region: string;
  /**
   * Watch id used for the one-shot check. lagotto-ts holds no store, so this is
   * only a correlation label.
   */
  watchId?: string;
}

/**
 * Wrap a lagotto-ts watcher as a `CapacitySource`, doing a single check rather
 * than polling — the advisor answers a question now; it does not wait for
 * capacity to appear. (A "tell me when it's free" flow is a watch, and it belongs
 * to lagotto-ts directly.)
 */
export function lagottoCapacitySource(opts: LagottoCapacityOptions): CapacitySource {
  const { watcher, region } = opts;
  return {
    region,
    async check(instanceTypePattern, checkOpts): Promise<AdvisorCapacityResult> {
      const match = await watcher.check({
        watchId: opts.watchId ?? "advisor-check",
        instanceTypePattern,
        regions: [region],
        spot: checkOpts.spot,
        maxPrice: checkOpts.maxPrice,
      });
      if (!match) {
        // `available: false` is a real observation ("nothing matching is on offer
        // right now"), distinct from a thrown error ("the check itself failed").
        // A caller must be able to tell those apart, so the two paths differ.
        return { available: false, region };
      }
      return {
        available: true,
        instanceType: match.instanceType,
        region: match.region,
        availabilityZone: match.availabilityZone,
        candidateAzs: match.candidateAzs,
        price: match.price,
        isSpot: match.isSpot,
      };
    },
  };
}
