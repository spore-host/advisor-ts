// @vitest-environment node
//
// The load-bearing guarantee of the ./bedrock split: the default "." import must
// NEVER pull in the AWS SDK, so a browser consumer of the pure core doesn't ship
// megabytes of Bedrock client it never calls. Adapted from
// truffle-ts/src/live/isolation.test.ts — it walks the SOURCE import graph
// reachable from src/index.ts and asserts no file imports "@aws-sdk/*" or anything
// under src/bedrock/. A source-graph check needs no build and catches the
// regression the moment a stray import is added.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const srcDir = fileURLToPath(new URL("..", import.meta.url)); // .../src

/**
 * Read a source file with comments stripped.
 *
 * truffle-ts's version of this test regexes the raw text, which makes a doc
 * comment showing `import { find } from "@spore-host/truffle-ts"` look like a real
 * import — a false positive that would either fail the guard or, worse, push
 * someone to delete the usage example. The adapters here are *documented by* such
 * examples, since the whole point is that the caller does the importing. So the
 * guard reads code, not prose.
 */
function readCode(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, including /** … */
    .replace(/^[ \t]*\/\/.*$/gm, ""); // whole-line // comments
}

/** Collect every local module reachable from `entry` via static imports. */
function importGraph(entryRel: string): string[] {
  const seen = new Set<string>();
  const importsOf = (file: string): string[] => {
    const text = readCode(file);
    const re = /(?:import|export)[^'"]*from\s*["']([^"']+)["']/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  };
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (!spec.startsWith(".")) continue; // external — recorded by the caller
      const path = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      try {
        walk(path);
      } catch {
        // .json or missing — ignore for graph purposes
      }
    }
  };
  walk(resolve(srcDir, entryRel));
  return [...seen];
}

/** External (bare) specifiers imported anywhere in the graph. */
function externalImports(files: string[]): string[] {
  const ext = new Set<string>();
  for (const file of files) {
    const text = readCode(file);
    const re = /(?:import|export)[^'"]*from\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!m[1].startsWith(".")) ext.add(m[1]);
    }
  }
  return [...ext];
}

describe("SDK-import isolation", () => {
  it("the default '.' entry graph never imports the AWS SDK or src/bedrock", () => {
    const graph = importGraph("index.ts");
    expect(graph.some((f) => f.includes("/bedrock/"))).toBe(false);
    expect(externalImports(graph).some((e) => e.startsWith("@aws-sdk/"))).toBe(false);
  });

  it("the default entry never imports the sibling libraries either", () => {
    // truffle-ts and lagotto-ts are PEER/OPTIONAL deps: advisor-ts must install
    // and typecheck without them, and the adapters take their functions as
    // arguments rather than importing them. A direct import here would silently
    // make both hard requirements.
    const graph = importGraph("index.ts");
    const ext = externalImports(graph);
    expect(ext.some((e) => e.startsWith("@spore-host/"))).toBe(false);
  });

  it("the './bedrock' entry DOES use the AWS SDK (sanity: it's the billable path)", () => {
    const graph = importGraph("bedrock/index.ts");
    expect(externalImports(graph).some((e) => e.startsWith("@aws-sdk/"))).toBe(true);
  });

  it("the guard reads code, not comments (so the preceding test isn't vacuous)", () => {
    // The adapters document themselves with a usage example that contains a real
    // `import … from "@spore-host/truffle-ts"` line in a comment. If comment
    // stripping ever broke, the sibling-library assertion above would fail — but if
    // someone "fixed" that by deleting the examples, it would pass for the wrong
    // reason. This pins both: the example text exists, and it isn't counted.
    const raw = readFileSync(resolve(srcDir, "adapters/truffle.ts"), "utf8");
    expect(raw).toContain('from "@spore-host/truffle-ts"');
    expect(readCode(resolve(srcDir, "adapters/truffle.ts"))).not.toContain("@spore-host/truffle-ts");
  });
});
