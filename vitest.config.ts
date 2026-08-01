import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Tests, pure type declarations, and barrels carry no executable logic.
      exclude: [
        "src/**/*.test.ts",
        "src/core/types.ts",
        "src/index.ts",
        "src/bedrock/index.ts",
      ],
      reporter: ["text", "html", "lcov"],
    },
  },
});
