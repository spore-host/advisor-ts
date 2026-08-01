// Bind truffle-ts to advisor-ts's `InstanceSource` / `AppSource` / `LiveSource`.
//
// These adapters take truffle-ts's functions as ARGUMENTS rather than importing
// them, the same discipline lagotto-ts uses in `truffleFinderAdapter`
// (lagotto-ts/src/live/truffle-adapter.ts). Consequences, all of them wanted:
// truffle-ts stays a peer/optional dependency; advisor-ts installs and typechecks
// without it; nothing in the default entry can pull in the AWS SDK transitively;
// and every adapter is testable with a two-line stub.
//
// The caller does the importing, in one place:
//
//   import { find, CATALOG_AS_OF, lookupApp, AppCatalog } from "@spore-host/truffle-ts";
//   const instances = truffleInstanceSource({ find, catalogAsOf: CATALOG_AS_OF });
//   const apps = truffleAppSource({ lookupApp, appCatalog: AppCatalog });

import type {
  AdvisorAppEntry,
  AdvisorFindResult,
  AdvisorQuotaVerdict,
  AdvisorSpotPrice,
  AppSource,
  InstanceSource,
  LiveSource,
} from "../core/backends.js";

/** The slice of truffle-ts's `find` this adapter needs. */
export type TruffleFind = (
  query: string,
  opts?: { sort?: string },
) => Promise<AdvisorFindResult[]>;

export interface TruffleInstanceOptions {
  /** truffle-ts's `find`, or a `findInstances` bound to a live finder. */
  find: TruffleFind;
  /** truffle-ts's `CATALOG_AS_OF`. Required — an undated snapshot reads as current. */
  catalogAsOf: string;
  /** Source label. Defaults to "truffle-ts bundled catalog". */
  label?: string;
}

/** Wrap truffle-ts's `find` as an `InstanceSource`. Works fully offline. */
export function truffleInstanceSource(opts: TruffleInstanceOptions): InstanceSource {
  return {
    label: opts.label ?? "truffle-ts bundled catalog",
    asOf: opts.catalogAsOf,
    async find(query, findOpts) {
      // A parse error ("intel graviton" — conflicting architectures) is a real,
      // reportable answer, so it propagates: `runTool` turns it into a stated gap
      // and the model gets the parser's own explanation of what was wrong.
      return opts.find(query, findOpts);
    },
  };
}

export interface TruffleAppOptions {
  /** truffle-ts's `lookupApp`. */
  lookupApp: (name: string) => AdvisorAppEntry | undefined;
  /** truffle-ts's `AppCatalog`, so a miss can list the alternatives. */
  appCatalog: Record<string, unknown>;
}

/** Wrap truffle-ts's app catalog as an `AppSource`. */
export function truffleAppSource(opts: TruffleAppOptions): AppSource {
  return {
    lookupApp: (name) => opts.lookupApp(name),
    appNames: () => Object.keys(opts.appCatalog),
  };
}

/** The slice of truffle-ts's `LiveFinder` the live adapter needs. */
export interface TruffleLiveFinderLike {
  search(matcher: RegExp, filters: Record<string, unknown>): Promise<
    Array<{ instanceType: string; vcpus: number; onDemandPrice?: number }>
  >;
  getSpotPricing(
    instances: Array<{ instanceType: string }>,
    opts: { showSavings?: boolean },
  ): Promise<AdvisorSpotPrice[]>;
  getQuotas(opts?: { region?: string }): Promise<unknown>;
  canLaunch(instance: unknown, quotas: unknown, spot?: boolean): AdvisorQuotaVerdict;
}

export interface TruffleLiveOptions {
  finder: TruffleLiveFinderLike;
  region: string;
}

/**
 * Wrap truffle-ts's `AwsLiveFinder` as a `LiveSource`.
 *
 * `checkQuota` fetches a fresh quota snapshot per call. That is one extra API
 * call, and it is the right trade: a cached snapshot would let the advisor report
 * headroom that a launch two minutes ago already consumed, and "you have room"
 * is the one answer here that must not be stale.
 */
export function truffleLiveSource(opts: TruffleLiveOptions): LiveSource {
  const { finder, region } = opts;
  return {
    region,
    async getSpotPrices(instanceTypes) {
      if (instanceTypes.length === 0) return [];
      return finder.getSpotPricing(
        instanceTypes.map((instanceType) => ({ instanceType })),
        { showSavings: true },
      );
    },
    async checkQuota(instanceType, count, spot) {
      // The type's vCPU count is what quota is metered in, so it has to be looked
      // up rather than assumed. An anchored pattern: "g6.xlarge" must not also
      // match "g6.xlarge.something".
      const matcher = new RegExp(`^${escapeRegex(instanceType)}$`);
      const hits = await finder.search(matcher, {});
      const found = hits.find((h) => h.instanceType === instanceType);
      if (!found) {
        throw new Error(
          `instance type "${instanceType}" was not found in ${region}, so its vCPU quota ` +
            `family and size are unknown — quota was NOT checked`,
        );
      }
      const quotas = await finder.getQuotas({ region });
      const verdict = finder.canLaunch(found, quotas, spot);
      if (count <= 1) return verdict;
      // canLaunch prices a single instance; scale the request and re-decide from
      // the headroom it reported. Without this, "can I launch 64 of these?" would
      // be answered by checking whether one fits.
      const requestedVcpus = verdict.requestedVcpus * count;
      const available = verdict.availableVcpus;
      if (available === undefined) {
        // Headroom unknown — report it as unknown. Assuming it fits would turn a
        // missing measurement into a green light.
        return {
          ...verdict,
          canLaunch: false,
          requestedVcpus,
          reason:
            `${count} × ${instanceType} needs ${requestedVcpus} vCPUs in the ${verdict.family} ` +
            `quota, but current headroom could not be determined (${verdict.reason})`,
        };
      }
      const fits = requestedVcpus <= available;
      return {
        ...verdict,
        canLaunch: fits,
        requestedVcpus,
        availableVcpus: available,
        reason: fits
          ? `${count} × ${instanceType} needs ${requestedVcpus} vCPUs; ${available} available in the ${verdict.family} quota`
          : `${count} × ${instanceType} needs ${requestedVcpus} vCPUs but only ${available} are available in the ${verdict.family} quota`,
      };
    },
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
