// The seams advisor-ts reads its facts through.
//
// advisor-ts core NEVER imports truffle-ts or lagotto-ts. It declares the narrow
// slice of each one's API it needs, structurally, exactly as lagotto-ts does with
// its `CapacityFinder` (src/live/watcher.ts). That keeps the sibling libraries
// peer/optional dependencies, keeps this package installable on its own, and —
// the part that matters for tests — lets every tool be exercised with a plain
// object literal and no AWS, no network, and no credentials.
//
// The adapters that bind these to the real libraries live in `src/adapters/`,
// where importing them is the point.

/** An instance type, as advisor-ts reads it. A subset of truffle-ts's `InstanceType`. */
export interface AdvisorInstanceType {
  instanceType: string;
  instanceFamily?: string;
  vcpus: number;
  memoryMib: number;
  architecture?: string;
  gpus?: number;
  gpuMemoryMib?: number;
  gpuModel?: string;
  onDemandPrice?: number;
  /**
   * True when the price/specs are a static estimate rather than live AWS data.
   * Carried through deliberately: an estimate presented as a price is the exact
   * defect truffle-ts#39 records, and the advisor must say "estimated" when it is.
   */
  estimatedPrice?: boolean;
}

/** One matched instance type plus the reasons it matched (truffle-ts `FindResult`). */
export interface AdvisorFindResult {
  instance: AdvisorInstanceType;
  /** Why it matched — passed through verbatim, so a citation quotes truffle's own words. */
  reasons: string[];
}

/**
 * Instance discovery. Backed by truffle-ts `find()`, which works fully offline
 * from the bundled catalog — so `find_instances` is available even with no AWS
 * credentials at all. The `asOf` label is required, not optional: a catalog
 * snapshot presented without its date reads as current data.
 */
export interface InstanceSource {
  /** e.g. "bundled catalog" or "aws:us-east-1". Shown to the user. */
  readonly label: string;
  /** Snapshot date of the underlying catalog, e.g. "2026-07". */
  readonly asOf: string;
  /** Run a natural-language or pattern query. */
  find(query: string, opts?: { sort?: string }): Promise<AdvisorFindResult[]>;
}

/** A per-AZ spot observation (truffle-ts `SpotPriceResult`). */
export interface AdvisorSpotPrice {
  instanceType: string;
  region: string;
  availabilityZone: string;
  spotPrice: number;
  onDemandPrice?: number;
  savingsPercent?: number;
}

/** A quota verdict (truffle-ts `QuotaVerdict`). */
export interface AdvisorQuotaVerdict {
  canLaunch: boolean;
  reason: string;
  family: string;
  requestedVcpus: number;
  availableVcpus?: number;
}

/**
 * Live AWS reads — spot pricing and quota. Backed by truffle-ts's `AwsLiveFinder`.
 * Optional: absent when the user has no credentials, in which case the tools that
 * need it are NOT offered to the model. Offering a tool that always fails teaches
 * the model to guess the answer instead.
 */
export interface LiveSource {
  readonly region: string;
  getSpotPrices(instanceTypes: string[]): Promise<AdvisorSpotPrice[]>;
  /**
   * Whether a launch of `count` × `instanceType` fits in quota. Implementations
   * fetch a quota snapshot and evaluate against it.
   */
  checkQuota(instanceType: string, count: number, spot: boolean): Promise<AdvisorQuotaVerdict>;
}

/** An app catalog entry (truffle-ts `AppEntry`). */
export interface AdvisorAppEntry {
  name: string;
  description: string;
  instanceFamilies: string[];
  highVramFamilies?: string[];
  minVcpus: number;
  minMemoryGiB: number;
  gpu: boolean;
}

/** The interactive-app catalog. Backed by truffle-ts `lookupApp`. */
export interface AppSource {
  lookupApp(name: string): AdvisorAppEntry | undefined;
  /** Every known app name, so a miss can list the alternatives. */
  appNames(): string[];
}

/** A capacity check outcome (shaped after lagotto-ts's `MatchResult`). */
export interface AdvisorCapacityResult {
  available: boolean;
  instanceType?: string;
  region: string;
  availabilityZone?: string;
  candidateAzs?: string[];
  price?: number;
  isSpot?: boolean;
}

/**
 * Right-now capacity. Backed by lagotto-ts's `CapacityWatcher.check`. Optional
 * for the same reason as `LiveSource`.
 */
export interface CapacitySource {
  readonly region: string;
  check(instanceTypePattern: string, opts: { spot?: boolean; maxPrice?: number }): Promise<AdvisorCapacityResult>;
}

/**
 * What a given deployment can actually see. Every field is optional, and which
 * ones are present decides which tools exist — see `buildToolset`. A caller with
 * only the bundled catalog gets a working advisor with fewer tools and an answer
 * that says which checks it couldn't run; it does not get a fluent answer built
 * on invented numbers.
 */
export interface AdvisorBackends {
  instances?: InstanceSource;
  live?: LiveSource;
  apps?: AppSource;
  capacity?: CapacitySource;
}
