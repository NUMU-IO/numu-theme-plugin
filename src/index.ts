/**
 * @numu/theme-plugin — the Vite plugin every NUMU theme uses to build.
 *
 * What it does (in order):
 *   1. validateContract  — at config-resolved time, verifies the project on
 *      disk has theme.json + settings_schema.json + an entry point. Same
 *      rules the backend `theme_upload_tasks._validate_theme_contract`
 *      enforces — failing here saves a worker round-trip.
 *   2. externalizeRuntimes — adds React, react/jsx-runtime, react-dom and
 *      `@numu/theme-sdk` to `build.rollupOptions.external`. The host
 *      storefront supplies these via `@numu/theme-sdk/utils/federation`
 *      at runtime, so they must NOT be bundled into the theme artifact.
 *   3. emitManifest — at build end, writes `dist/manifest.json` with
 *      a normalized snapshot of theme.json + every section/block schema
 *      the host needs to render the customizer. The marketplace build
 *      pipeline reads this file directly (faster than re-parsing the
 *      project tree post-build).
 *   4. emitImportMap — writes `dist/import-map.json` declaring the SDK +
 *      React names the bundle expects to be supplied with. The storefront
 *      verifies this on install so a theme submitted against an older SDK
 *      version is flagged before activation.
 *
 * Usage in a theme's vite.config.ts:
 *
 *     import { defineConfig } from "vite";
 *     import react from "@vitejs/plugin-react";
 *     import { numuTheme } from "@numu/theme-plugin";
 *
 *     export default defineConfig({
 *       plugins: [react(), numuTheme()],
 *       build: {
 *         lib: {
 *           entry: "src/main.tsx",
 *           formats: ["es"],
 *           fileName: () => "theme.js",
 *         },
 *         cssCodeSplit: false,
 *       },
 *     });
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin, UserConfig, ResolvedConfig } from "vite";

// ── Federation contract ──────────────────────────────────────────────────────
//
// The host storefront supplies these modules via `globalThis` at runtime
// (see `@numu/theme-sdk/utils/federation`). Themes import from them as
// usual; rollup leaves the imports as bare specifiers and the host's
// import-map / module shim resolves them.

const HOST_PROVIDED_MODULES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "@numu/theme-sdk",
] as const;

interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  layout?: string;
  description?: string;
  author?: string;
  presets?: Record<string, unknown>;
}

export interface NumuThemePluginOptions {
  /** Override the theme root (default: process.cwd()). */
  themeDir?: string;
  /** Skip the contract check (escape hatch for tests). */
  skipValidation?: boolean;
  /** Additional modules to externalize beyond the host-provided defaults. */
  extraExternal?: readonly string[];
}

interface SchemaBundle {
  settings: unknown;
  sections: Record<string, unknown>;
  blocks: Record<string, unknown>;
}

interface BuiltManifest extends ThemeManifest {
  /** Embedded schemas — host reads these to render the customizer without
   *  shipping the whole source tree. */
  settings_schema: unknown;
  section_schemas: Record<string, unknown>;
  block_schemas: Record<string, unknown>;
  /** Build metadata. */
  built_at: string;
  plugin_version: string;
}

const PLUGIN_VERSION = "0.1.0";

// ── Contract validation ─────────────────────────────────────────────────────

const REQUIRED_FILES = [
  "theme.json",
  "settings_schema.json",
  "styles.css",
] as const;
const ENTRY_CANDIDATES = [
  "src/main.tsx",
  "src/main.ts",
  "src/index.tsx",
  "src/index.ts",
  "numu.config.tsx",
  "numu.config.ts",
] as const;

function validateContract(themeDir: string): ThemeManifest {
  for (const f of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(themeDir, f))) {
      throw new Error(`[@numu/theme-plugin] Missing required file: ${f}`);
    }
  }

  const hasEntry = ENTRY_CANDIDATES.some((p) =>
    fs.existsSync(path.join(themeDir, p)),
  );
  if (!hasEntry) {
    throw new Error(
      `[@numu/theme-plugin] Missing entry point. Expected one of: ${ENTRY_CANDIDATES.join(", ")}`,
    );
  }

  let manifest: ThemeManifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(themeDir, "theme.json"), "utf-8"),
    );
  } catch (err) {
    throw new Error(
      `[@numu/theme-plugin] theme.json is not valid JSON: ${(err as Error).message}`,
    );
  }

  for (const field of ["id", "name", "version"] as const) {
    if (!manifest[field] || typeof manifest[field] !== "string") {
      throw new Error(
        `[@numu/theme-plugin] theme.json missing required string field: ${field}`,
      );
    }
  }

  // Same semver rule the backend enforces.
  const semver = /^\d+\.\d+\.\d+(?:[-+][\w.\-]+)?$/;
  if (!semver.test(manifest.version)) {
    throw new Error(
      `[@numu/theme-plugin] theme.json version "${manifest.version}" is not semver (x.y.z)`,
    );
  }

  // Validate id format (alphanumeric, dashes, underscores).
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i.test(manifest.id)) {
    throw new Error(
      `[@numu/theme-plugin] theme.json id "${manifest.id}" must be alphanumerics, dashes or underscores`,
    );
  }

  return manifest;
}

// ── Schema collection ───────────────────────────────────────────────────────

function readJsonOrEmpty(p: string): unknown {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    throw new Error(
      `[@numu/theme-plugin] Bad JSON in ${path.basename(p)}: ${(err as Error).message}`,
    );
  }
}

function readSchemaDir(dir: string): Record<string, unknown> {
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, unknown> = {};
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const key = path.basename(entry, ".json");
    out[key] = readJsonOrEmpty(path.join(dir, entry));
  }
  return out;
}

function collectSchemas(themeDir: string): SchemaBundle {
  const settings = readJsonOrEmpty(
    path.join(themeDir, "settings_schema.json"),
  );
  const sections = readSchemaDir(path.join(themeDir, "schemas", "sections"));
  const blocks = readSchemaDir(path.join(themeDir, "schemas", "blocks"));
  return { settings, sections, blocks };
}

// ── The plugin ──────────────────────────────────────────────────────────────

export function numuTheme(options: NumuThemePluginOptions = {}): Plugin {
  const themeDir = options.themeDir ?? process.cwd();
  const externalList = [
    ...HOST_PROVIDED_MODULES,
    ...(options.extraExternal ?? []),
  ];

  let manifest: ThemeManifest | null = null;
  let resolvedConfig: ResolvedConfig | null = null;

  return {
    name: "@numu/theme-plugin",
    enforce: "pre",

    config(userConfig: UserConfig) {
      // 1. Contract check happens here — fail loudly before Vite spends
      //    time configuring the bundler.
      if (!options.skipValidation) {
        manifest = validateContract(themeDir);
      }

      // 2. Externalize host-provided modules. We MERGE rather than replace
      //    so a theme can add its own externals (like a heavyweight CMS
      //    SDK shared with the host) via build.rollupOptions.external.
      const merged: UserConfig = {
        build: {
          ...userConfig.build,
          rollupOptions: {
            ...userConfig.build?.rollupOptions,
            external: mergeExternal(
              userConfig.build?.rollupOptions?.external,
              externalList,
            ),
          },
          // Themes always emit ESM; the host import()'s the bundle.
          lib: userConfig.build?.lib ?? {
            entry: detectEntry(themeDir),
            formats: ["es"],
            fileName: () => "theme.js",
          },
          // Host wants one CSS file, not split.
          cssCodeSplit: false,
        },
      };

      return merged;
    },

    configResolved(config) {
      resolvedConfig = config;
    },

    closeBundle() {
      if (!manifest && !options.skipValidation) {
        // Either validation is off or we somehow lost it; reload.
        manifest = validateContract(themeDir);
      }
      if (!manifest) return;
      if (!resolvedConfig) return;

      const outDir = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir);
      if (!fs.existsSync(outDir)) {
        // Vite would have errored already if there was no output, but
        // be defensive.
        return;
      }

      // 3. Emit dist/manifest.json
      const schemas = collectSchemas(themeDir);
      const built: BuiltManifest = {
        ...manifest,
        settings_schema: schemas.settings,
        section_schemas: schemas.sections,
        block_schemas: schemas.blocks,
        built_at: new Date().toISOString(),
        plugin_version: PLUGIN_VERSION,
      };
      fs.writeFileSync(
        path.join(outDir, "manifest.json"),
        JSON.stringify(built, null, 2),
      );

      // 4. Emit dist/import-map.json so the host can verify SDK compatibility.
      const importMap = {
        plugin: PLUGIN_VERSION,
        host_provided: externalList,
      };
      fs.writeFileSync(
        path.join(outDir, "import-map.json"),
        JSON.stringify(importMap, null, 2),
      );
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function detectEntry(themeDir: string): string {
  for (const candidate of ENTRY_CANDIDATES) {
    if (fs.existsSync(path.join(themeDir, candidate))) {
      return path.resolve(themeDir, candidate);
    }
  }
  // The contract validator already errored; this is just for type safety.
  return path.resolve(themeDir, "src/main.tsx");
}

/**
 * Merge required externals into Rollup's `external` option without
 * dropping anything the user already declared. We accept Rollup's
 * `ExternalOption` shape (string | RegExp | array | function with up to
 * 3 args) and return the same shape so we don't widen the type Vite
 * sees downstream.
 */
type ExternalFn = (
  source: string,
  importer: string | undefined,
  isResolved: boolean,
) => boolean | null | undefined | void;

type RollupExternal = string | RegExp | (string | RegExp)[] | ExternalFn;

function mergeExternal(
  existing: RollupExternal | undefined,
  required: readonly string[],
): RollupExternal {
  if (existing === undefined) return [...required];

  if (typeof existing === "function") {
    return (source, importer, isResolved) => {
      const fromFn = existing(source, importer, isResolved);
      if (fromFn === true) return true;
      if (required.includes(source)) return true;
      return fromFn;
    };
  }

  const asArray = Array.isArray(existing) ? existing : [existing];
  const out: (string | RegExp)[] = [...asArray];
  for (const r of required) {
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

export default numuTheme;
