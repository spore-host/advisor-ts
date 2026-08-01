// Shared stub backends for the tests.
//
// Every backend is a plain object literal, which is the payoff of the structural
// seams in backends.ts: the whole tool registry, the tool-use loop, the gap
// reporting and the citations are exercised with no AWS, no network, no
// credentials, and no billable inference.
//
// Named `.test-util.ts` rather than `.test.ts` so vitest doesn't try to run it as
// a suite.

import type {
  AdvisorBackends,
  AdvisorFindResult,
  AppSource,
  CapacitySource,
  InstanceSource,
  LiveSource,
} from "./backends.js";

export const p5: AdvisorFindResult = {
  instance: {
    instanceType: "p5.48xlarge",
    instanceFamily: "p5",
    vcpus: 192,
    memoryMib: 2048 * 1024,
    architecture: "x86_64",
    gpus: 8,
    gpuMemoryMib: 8 * 80 * 1024,
    gpuModel: "H100",
    onDemandPrice: 55.04,
  },
  reasons: ["GPUs: 8 >= 8", "GPU memory: 80 GiB/GPU >= 80 GiB", "EFA capable"],
};

export const g6e: AdvisorFindResult = {
  instance: {
    instanceType: "g6e.xlarge",
    instanceFamily: "g6e",
    vcpus: 4,
    memoryMib: 32 * 1024,
    architecture: "x86_64",
    gpus: 1,
    gpuMemoryMib: 48 * 1024,
    gpuModel: "L40S",
    onDemandPrice: 1.861,
  },
  reasons: ["GPUs: 1 × L40S"],
};

/** A type with no recorded price — the case get_pricing must report, not skip. */
export const noPrice: AdvisorFindResult = {
  instance: {
    instanceType: "p6e-gb200.36xlarge",
    instanceFamily: "p6e-gb200",
    vcpus: 144,
    memoryMib: 1024 * 1024,
    architecture: "arm64",
    gpus: 4,
    gpuMemoryMib: 4 * 186 * 1024,
    gpuModel: "GB200",
  },
  reasons: ["GPUs: 4 × GB200"],
};

/** A type whose price is a static estimate, not live pricing. */
export const estimated: AdvisorFindResult = {
  instance: {
    instanceType: "p3.2xlarge",
    instanceFamily: "p3",
    vcpus: 8,
    memoryMib: 61 * 1024,
    architecture: "x86_64",
    gpus: 1,
    gpuMemoryMib: 16 * 1024,
    gpuModel: "V100",
    onDemandPrice: 3.06,
    estimatedPrice: true,
  },
  reasons: ["GPUs: 1 × V100"],
};

export interface StubInstanceOptions {
  results?: AdvisorFindResult[];
  /** Make `find` throw, to exercise the failed-tool path. */
  fail?: string;
  /** Records the queries `find` was called with. */
  queries?: string[];
}

export function stubInstances(opts: StubInstanceOptions = {}): InstanceSource {
  const all = opts.results ?? [p5, g6e, noPrice, estimated];
  return {
    label: "test catalog",
    asOf: "2026-07",
    async find(query) {
      opts.queries?.push(query);
      if (opts.fail) throw new Error(opts.fail);
      // An exact instance-type name returns just that type, so get_pricing's
      // name lookup behaves like the real `find`'s pattern path.
      const exact = all.find((r) => r.instance.instanceType === query);
      return exact ? [exact] : all;
    },
  };
}

export function stubApps(): AppSource {
  return {
    lookupApp(name) {
      if (name.toLowerCase() !== "paraview") return undefined;
      return {
        name: "paraview",
        description: "Scientific visualization — CFD, FEA, large mesh",
        instanceFamilies: ["g6", "g5", "g4dn"],
        highVramFamilies: ["g6e"],
        minVcpus: 4,
        minMemoryGiB: 16,
        gpu: true,
      };
    },
    appNames: () => ["paraview", "chimerax", "igv", "qgis", "fiji", "ds9"],
  };
}

export function stubLive(overrides: Partial<LiveSource> = {}): LiveSource {
  return {
    region: "us-east-1",
    async getSpotPrices(instanceTypes) {
      return instanceTypes
        .filter((t) => t === "p5.48xlarge")
        .flatMap((instanceType) => [
          {
            instanceType,
            region: "us-east-1",
            availabilityZone: "us-east-1a",
            spotPrice: 21.5,
            onDemandPrice: 55.04,
            savingsPercent: 61,
          },
          {
            instanceType,
            region: "us-east-1",
            availabilityZone: "us-east-1d",
            spotPrice: 19.75,
            onDemandPrice: 55.04,
            savingsPercent: 64,
          },
        ]);
    },
    async checkQuota(_instanceType, count) {
      return {
        canLaunch: count <= 2,
        reason: count <= 2 ? "within quota" : "P quota exhausted",
        family: "P",
        requestedVcpus: 192 * count,
        availableVcpus: 384,
      };
    },
    ...overrides,
  };
}

export function stubCapacity(available = true): CapacitySource {
  return {
    region: "us-east-1",
    async check(instanceTypePattern) {
      if (!available) return { available: false, region: "us-east-1" };
      return {
        available: true,
        instanceType: instanceTypePattern.replace(/\.\*$/, ".48xlarge"),
        region: "us-east-1",
        availabilityZone: "us-east-1d",
        candidateAzs: ["us-east-1d", "us-east-1a"],
        price: 19.75,
        isSpot: true,
      };
    },
  };
}

/** Every backend wired — the fully-capable deployment. */
export function fullBackends(): AdvisorBackends {
  return {
    instances: stubInstances(),
    apps: stubApps(),
    live: stubLive(),
    capacity: stubCapacity(),
  };
}

/** Catalog only — no credentials. The offline-portal deployment. */
export function offlineBackends(): AdvisorBackends {
  return { instances: stubInstances(), apps: stubApps() };
}
