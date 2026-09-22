import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The corpus contains deliberately bad test files and generated git
    // repositories. They must never be picked up as TestSlop's own tests.
    exclude: ["node_modules/**", "dist/**", "corpus/**", "work/**"],
    environment: "node",
    testTimeout: 120_000,
  },
});
