/**
 * SSR pass (0.3.0) — self-contained end-to-end test of the nested server
 * build. Unlike the contract suites this does NOT depend on the
 * numu-theme-v3-tests workspace: it scaffolds a minimal federated theme in
 * a temp dir (bare react/sdk imports stay external, so no node_modules is
 * needed) and runs a REAL `vite build` through the theme's own config file
 * — the exact path `numu-theme build` takes.
 *
 * Pins the storefront-worker-facing artifact contract:
 *   - dist/theme.server.js exists, single-file (dynamic imports inlined)
 *   - react/sdk remain bare specifiers in it (worker resolves them against
 *     the HOST's node_modules)
 *   - manifest.json.ssr {capable, server_bundle, server_bundle_checksum}
 *     and the checksum matches the artifact
 *   - import-map.json gains ssr_capable + bundle fields
 *   - federate:false themes ship client-only (capable:false, no artifact)
 *   - ssr:true + federate:false is rejected at plugin construction
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { dir as tmpDir, type DirectoryResult } from "tmp-promise";
import { afterEach, describe, expect, it } from "vitest";

import { numuTheme } from "../index";

const PLUGIN_SRC = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.ts")
  .replace(/\\/g, "/");

let sandbox: DirectoryResult | null = null;

afterEach(async () => {
  if (sandbox) {
    await sandbox.cleanup().catch(() => {});
    sandbox = null;
  }
});

async function scaffoldTheme(opts: { federate: boolean; ssr?: boolean }): Promise<string> {
  sandbox = await tmpDir({ unsafeCleanup: true });
  const themeDir = sandbox.path;

  const write = (rel: string, content: string) => {
    const p = path.join(themeDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  write(
    "theme.json",
    JSON.stringify({
      id: "ssr-fixture",
      name: "SSR Fixture",
      version: "1.0.0",
      author: "tests@numueg.app",
    }),
  );
  write("settings_schema.json", "[]");
  write("styles.css", ".ssr-fixture{color:#000}");
  write(
    "schemas/sections/hero.json",
    JSON.stringify({
      type: "hero",
      name: "Hero",
      settings: [{ type: "text", id: "headline", label: "Headline" }],
    }),
  );

  if (opts.federate) {
    // Real-theme shape: tsconfig declares the automatic JSX runtime (vite
    // reads it; without it esbuild falls back to classic `React.createElement`
    // against a global React — broken output). The lazy section proves
    // inlineDynamicImports folds chunks into ONE file.
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", module: "esnext", target: "es2020" },
      }),
    );
    write(
      "src/sections/hero.tsx",
      `export default function Hero({ headline }: { headline?: string }) {
        return <section data-section="hero">{headline ?? "hi"}</section>;
      }`,
    );
    write(
      "src/main.tsx",
      `import { lazy } from "react";
const Hero = lazy(() => import("./sections/hero"));
function App({ template }: { template: string }) {
  return <main data-template={template}><Hero /></main>;
}
export function mount(el: HTMLElement, ctx: { page?: { type?: string } }) {
  void el; void ctx;
  return { cleanup() {}, applyDraft() {} };
}
export function createApp(ctx: { page?: { type?: string } }) {
  return <App template={ctx.page?.type ?? "home"} />;
}`,
    );
  } else {
    // federate:false inlines react — which the sandbox doesn't have. The
    // behavior under test is "no SSR pass", which is entry-content
    // independent, so this variant ships a dependency-free entry.
    write(
      "src/sections/hero.ts",
      `export default function Hero() { return null; }`,
    );
    write(
      "src/main.ts",
      `export function mount(el: HTMLElement, ctx: unknown) {
  void el; void ctx;
  return { cleanup() {}, applyDraft() {} };
}`,
    );
  }
  const pluginOpts = [
    `themeDir: ${JSON.stringify(themeDir.replace(/\\/g, "/"))}`,
    `federate: ${opts.federate}`,
    ...(opts.ssr === undefined ? [] : [`ssr: ${opts.ssr}`]),
  ].join(", ");
  // NOTE: no `import { defineConfig } from "vite"` — the sandbox has no
  // node_modules, and bare specifiers in the config would fail to resolve
  // from %TEMP%. A plain object export is config-equivalent. The plugin
  // itself is imported by absolute path into the bundled config.
  write(
    "vite.config.ts",
    `import { numuTheme } from "${PLUGIN_SRC}";
export default {
  plugins: [numuTheme({ ${pluginOpts} })],
};`,
  );
  return themeDir;
}

async function runBuild(themeDir: string): Promise<void> {
  await build({
    configFile: path.join(themeDir, "vite.config.ts"),
    root: themeDir,
    logLevel: "error",
  });
}

function readJson(themeDir: string, rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(themeDir, "dist", rel), "utf-8"));
}

describe("plugin/ssr-pass", () => {
  it("federated build emits a single-file theme.server.js with bare react/sdk imports", async () => {
    const themeDir = await scaffoldTheme({ federate: true });
    await runBuild(themeDir);

    const dist = path.join(themeDir, "dist");
    expect(fs.existsSync(path.join(dist, "theme.js"))).toBe(true);
    const serverPath = path.join(dist, "theme.server.js");
    expect(fs.existsSync(serverPath)).toBe(true);

    const server = fs.readFileSync(serverPath, "utf-8");
    // Bare specifier preserved (worker resolves against host node_modules) —
    // and the PRODUCTION runtime even under vitest's NODE_ENV=test (the
    // plugin forces production mode for the nested pass).
    expect(server).toMatch(/from\s*["']react\/jsx-runtime["']/);
    expect(server).not.toContain("jsx-dev-runtime");
    // Lazy section inlined — no sibling chunk emitted, no relative import.
    expect(server).toContain('data-section');
    expect(server).not.toMatch(/from\s*["']\.\//);
    const siblingChunks = fs
      .readdirSync(dist)
      .filter((f) => f.endsWith(".js") && f !== "theme.js" && f !== "theme.server.js");
    expect(siblingChunks).toEqual([]);
    // createApp export survives.
    expect(server).toMatch(/\bcreateApp\b/);

    const manifest = readJson(themeDir, "manifest.json");
    const ssr = manifest.ssr as Record<string, unknown>;
    expect(ssr.capable).toBe(true);
    expect(ssr.server_bundle).toBe("theme.server.js");
    const expectedChecksum = crypto
      .createHash("sha256")
      .update(fs.readFileSync(serverPath))
      .digest("hex");
    expect(ssr.server_bundle_checksum).toBe(expectedChecksum);

    const importMap = readJson(themeDir, "import-map.json");
    expect(importMap.ssr_capable).toBe(true);
    expect(importMap.server_bundle).toBe("theme.server.js");
    expect(importMap.server_bundle_checksum).toBe(expectedChecksum);
  });

  it("federate:false ships client-only — no server bundle, capable:false", async () => {
    const themeDir = await scaffoldTheme({ federate: false });
    await runBuild(themeDir);

    expect(fs.existsSync(path.join(themeDir, "dist", "theme.server.js"))).toBe(false);
    const manifest = readJson(themeDir, "manifest.json");
    expect((manifest.ssr as Record<string, unknown>).capable).toBe(false);
    const importMap = readJson(themeDir, "import-map.json");
    expect(importMap.ssr_capable).toBe(false);
    expect(importMap).not.toHaveProperty("server_bundle");
  });

  it("ssr:true + federate:false is rejected at construction", () => {
    expect(() => numuTheme({ ssr: true, federate: false })).toThrow(
      /requires `federate: true`/,
    );
  });
});
