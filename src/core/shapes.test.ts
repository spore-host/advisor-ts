import { describe, it, expect } from "vitest";
import { looksGpuAccelerated, recommendShape } from "./shapes.js";

describe("recommendShape", () => {
  it("reads an embarrassingly-parallel description as a job array", () => {
    const r = recommendShape({ description: "500 independent docking runs, one per ligand" });
    expect(r.shape).toBe("job-array");
    expect(r.efa).toBe(false);
    expect(r.confident).toBe(true);
    expect(r.rationale).toMatch(/independent/i);
  });

  it("reads a tightly-coupled description as MPI, with EFA", () => {
    const r = recommendShape({ description: "OpenFOAM CFD run with domain decomposition across nodes" });
    expect(r.shape).toBe("mpi");
    // EFA is the whole point of the shape — it must not be an optional extra a
    // caller has to remember to ask for.
    expect(r.efa).toBe(true);
    expect(r.confident).toBe(true);
  });

  it("honors an explicit mpi flag even with no keywords", () => {
    const r = recommendShape({ description: "my simulation", mpi: true });
    expect(r.shape).toBe("mpi");
    expect(r.efa).toBe(true);
    expect(r.rationale).toMatch(/stated the code uses MPI/);
  });

  it("MPI beats a task count — '500 ranks' is one job, not 500 jobs", () => {
    // The asymmetry that justifies the precedence: running an MPI job as an array
    // silently produces garbage; running an array as MPI only wastes money.
    const r = recommendShape({ description: "500 MPI ranks over a decomposed grid", taskCount: 500 });
    expect(r.shape).toBe("mpi");
    expect(r.count).toBe(500);
  });

  it("a task count above 1 implies an array even with no keywords", () => {
    const r = recommendShape({ description: "run the analysis", taskCount: 200 });
    expect(r.shape).toBe("job-array");
    expect(r.count).toBe(200);
    expect(r.rationale).toMatch(/200 independent tasks/);
  });

  it("treats a single task count as a single node, not a one-task array", () => {
    const r = recommendShape({ description: "run the analysis", taskCount: 1 });
    expect(r.shape).toBe("single-node");
  });

  it("reads GPU words as single-node when nothing suggests scaling out", () => {
    const r = recommendShape({ description: "fine-tune a model with pytorch on a GPU" });
    expect(r.shape).toBe("single-node");
    expect(r.efa).toBe(false);
    expect(r.count).toBe(1);
  });

  it("prefers MPI over a GPU hint for distributed training", () => {
    const r = recommendShape({ description: "distributed training across nodes with pytorch" });
    expect(r.shape).toBe("mpi");
    expect(r.efa).toBe(true);
  });

  it("marks an uninformative description as NOT confident and says so in the reason", () => {
    // The point of the test: a guess must be visibly a guess. A caller (or a UI)
    // has to be able to tell this apart from a real finding, which is exactly what
    // the `confident` flag and the wording are for.
    const r = recommendShape({ description: "some computing" });
    expect(r.shape).toBe("single-node");
    expect(r.confident).toBe(false);
    expect(r.rationale).toMatch(/guess, not a finding/);
    // And it tells the user what would change the answer.
    expect(r.rationale).toMatch(/how many tasks|uses MPI/);
  });

  it("never claims EFA for a non-MPI shape", () => {
    for (const description of ["500 independent tasks", "a jupyter notebook", "unclear"]) {
      const r = recommendShape({ description });
      if (r.shape !== "mpi") expect(r.efa).toBe(false);
    }
  });

  it("always states a rationale, whatever the shape", () => {
    for (const description of ["mpi run", "1000 replicates", "gpu inference", ""]) {
      expect(recommendShape({ description }).rationale.length).toBeGreaterThan(20);
    }
  });
});

describe("looksGpuAccelerated", () => {
  it("detects GPU words", () => {
    expect(looksGpuAccelerated("CUDA molecular dynamics")).toBe(true);
    expect(looksGpuAccelerated("pytorch training")).toBe(true);
  });

  it("does not invent a GPU need", () => {
    expect(looksGpuAccelerated("a big memory-bound sequence search")).toBe(false);
  });
});
