import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["packages/**/*.test.ts", "test/**/*.test.ts", "packages/**/index.ts"],
      include: ["packages/*/src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
    include: ["packages/**/*.test.ts", "test/**/*.test.ts"],
  },
});
