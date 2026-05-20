import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    testTimeout: 30_000,
    setupFiles: [
      path.resolve(__dirname, "../numu-theme-v3-tests/tests/matchers/index.ts"),
    ],
  },
  resolve: {
    alias: {
      "@numueg/theme-plugin": path.resolve(__dirname, "src/index.ts"),
    },
  },
});
