import { defineConfig, configDefaults } from "vitest/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same convention as numu-theme-sdk: the contract matchers + helpers live in
// the sibling numu-theme-v3-tests/ workspace. When it isn't checked out
// (standalone CI of this repo), the contract-pinning suites can't load —
// skip them gracefully instead of failing the whole run. Self-contained
// suites (ssr-pass) always run.
const harnessRoot = path.resolve(__dirname, "../numu-theme-v3-tests");
const HARNESS_PRESENT = fs.existsSync(harnessRoot);
const harnessCoupledTests = [
  "src/__tests__/externalize-defaults.test.ts",
  "src/__tests__/section-registry.test.ts",
  "src/__tests__/validate-contract.test.ts",
];
if (!HARNESS_PRESENT) {
  console.warn(
    `[vitest] numu-theme-v3-tests workspace not found — skipping contract suites: ${harnessCoupledTests.join(", ")}`,
  );
}

export default defineConfig({
  server: {
    fs: {
      allow: [path.resolve(__dirname, ".."), __dirname],
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      ...(HARNESS_PRESENT ? [] : harnessCoupledTests),
    ],
    testTimeout: 30_000,
    setupFiles: HARNESS_PRESENT
      ? [path.resolve(harnessRoot, "tests/matchers/index.ts")]
      : [],
  },
  resolve: {
    alias: {
      "@numueg/theme-plugin": path.resolve(__dirname, "src/index.ts"),
    },
  },
});
