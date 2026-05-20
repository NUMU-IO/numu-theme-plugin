/**
 * @numueg/theme-plugin — the Vite plugin every NUMU theme uses to build.
 *
 * What it does (in order):
 *   1. validateContract  — at config-resolved time, verifies the project on
 *      disk has theme.json + settings_schema.json + an entry point. Same
 *      rules the backend `theme_upload_tasks._validate_theme_contract`
 *      enforces — failing here saves a worker round-trip.
 *   2. externalizeRuntimes — adds React, react/jsx-runtime, react-dom and
 *      `@numueg/theme-sdk` to `build.rollupOptions.external`. The host
 *      storefront supplies these via `@numueg/theme-sdk/utils/federation`
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
 *     import { numuTheme } from "@numueg/theme-plugin";
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

// Pin PLUGIN_VERSION to package.json.version — see the constant
// declaration below for the §6e-3 drift this avoids.
import pkgJson from "../package.json";

// ── Federation contract ──────────────────────────────────────────────────────
//
// Themes can be built in two modes:
//
//  - federated (default): bare-specifier imports of react/jsx-runtime,
//    react-dom, @numueg/theme-sdk are externalized, resolved at runtime
//    via the import map the storefront ships at /__numu-runtime/. Bundle
//    drops from ~350 KB → ~30 KB and shares one React instance with the
//    host (so context plumbing across the seam works without any
//    singleton-shim gymnastics).
//
//  - self-contained: pass `numuTheme({ federate: false })` to bundle
//    react + sdk inline. Useful when running against a host that
//    doesn't (yet) ship a runtime import map. Two-React risks are
//    acceptable because the bundle mounts inside `ByotThemeBoundary`,
//    which renders the theme as a leaf — no JSX crosses the boundary,
//    so the host React never reconciles bundle elements.
//
// As of plugin 0.2.0 (numu-storefront federation runtime shipped) we
// default to federated. Existing self-contained builds keep working.

const FEDERATABLE_MODULES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "@numueg/theme-sdk",
] as const;

interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  layout?: string;
  description?: string;
  author?: string;
  presets?: Record<string, unknown>;
  /**
   * Phase 7.3 — relative path to a static HTML file the storefront
   * injects on the client-side error boundary route. When set, BYOT
   * themes own the "something went wrong" UI completely; absent →
   * the platform's hardcoded fallback renders.
   *
   * Conventionally `"templates/error.html"`. Built path is
   * `dist/<path>` and the URL surfaced to the storefront is
   * `<external_theme.bundle_url_origin>/<path>`.
   */
  error_template?: string;
  /**
   * Phase 7.3 — same as `error_template` but for the streaming
   * loading skeleton. Conventionally `"templates/loading.html"`.
   */
  loading_template?: string;
  /**
   * Phase 7.7 — theme-level variants (light / dark / brand-X / etc).
   *
   * Each variant is a named bundle of global setting overrides — a
   * one-click way for merchants to swap the entire visual identity
   * of a theme without editing every section. The customizer adds a
   * dropdown above the locale toggle when this is non-empty; picking
   * an entry merges the variant's settings onto the current draft.
   *
   * Example:
   *   "variants": [
   *     { "name": "Light",  "settings": { "primary_color": "#000", "bg": "#FFF" } },
   *     { "name": "Dark",   "settings": { "primary_color": "#FFF", "bg": "#000" } },
   *     { "name": "Bold",   "settings": { "accent": "#FF3D00", "heading_weight": 900 } }
   *   ]
   */
  variants?: Array<{
    /** Display label in the customizer dropdown. */
    name: string;
    /** Arabic display label, surfaced when the customizer's locale is `ar`. */
    name_ar?: string;
    /** Setting overrides merged onto global_settings on apply. */
    settings: Record<string, unknown>;
  }>;
}

export interface NumuThemePluginOptions {
  /** Override the theme root (default: process.cwd()). */
  themeDir?: string;
  /** Skip the contract check (escape hatch for tests). */
  skipValidation?: boolean;
  /**
   * Externalize React + react-dom + jsx-runtime + @numueg/theme-sdk so the
   * bundle imports them as bare specifiers. Requires the host to provide
   * an import map. Default: true — host storefronts ≥ 0.2.0 ship the
   * runtime import map at /__numu-runtime/. Pass `federate: false` for a
   * self-contained bundle when targeting older hosts.
   */
  federate?: boolean;
  /** Additional modules to externalize beyond the federation defaults. */
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

// Sourced from package.json at build time (tsup inlines JSON imports
// when resolveJsonModule is on). This eliminates the §6e-3 drift
// class: the version embedded in dist/manifest.json and
// dist/import-map.json can no longer disagree with the npm-published
// `package.json.version`. To bump the plugin, change
// `package.json.version` only — this constant follows automatically.
const PLUGIN_VERSION: string = pkgJson.version;

/**
 * The minimum @numueg/theme-sdk major a federated bundle is compatible
 * with. The host advertises its sdk_version in
 * /__numu-runtime/manifest.json; install validation refuses bundles
 * whose `sdk_compat` major doesn't match the host's. Bumped on every
 * SDK breaking change.
 */
const SDK_COMPAT_MAJOR = 0;

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
      throw new Error(`[@numueg/theme-plugin] Missing required file: ${f}`);
    }
  }

  const entry = ENTRY_CANDIDATES.find((p) =>
    fs.existsSync(path.join(themeDir, p)),
  );
  if (!entry) {
    throw new Error(
      `[@numueg/theme-plugin] Missing entry point. Expected one of: ${ENTRY_CANDIDATES.join(", ")}`,
    );
  }

  // BYOT mount contract — the host's <ByotThemeBoundary> calls
  // `mod.mount(el, props)` with its own React copy. If the entry doesn't
  // export `mount`, the bundle still loads but the host can't render it
  // (we throw a runtime error there). Catch it at build time instead so
  // theme devs see a clear message immediately.
  //
  // We do a lightweight text-level check rather than parsing the full
  // module — any of `export function mount`, `export const mount`,
  // `export { mount }`, `export { … as mount }` count.
  try {
    const entrySource = fs.readFileSync(
      path.join(themeDir, entry),
      "utf-8",
    );
    const exportsMount =
      /\bexport\s+(?:async\s+)?function\s+mount\b/.test(entrySource) ||
      /\bexport\s+(?:const|let|var)\s+mount\b/.test(entrySource) ||
      /\bexport\s*\{[^}]*\bmount\b[^}]*\}/.test(entrySource);
    if (!exportsMount) {
      throw new Error(
        `[@numueg/theme-plugin] Theme entry ${entry} must export a \`mount(el, props)\` function. ` +
          `BYOT bundles need to own their React render cycle — without mount, ` +
          `the storefront throws "Cannot read properties of null (reading 'useContext')" ` +
          `the moment any SDK hook runs. \`numu-theme init\` scaffolds this for new themes.`,
      );
    }
  } catch (err) {
    // Re-throw our own clear error; suppress fs read errors (build will
    // surface those in its normal flow).
    if ((err as Error).message?.startsWith("[@numueg/theme-plugin]")) throw err;
  }

  let manifest: ThemeManifest;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(themeDir, "theme.json"), "utf-8"),
    );
  } catch (err) {
    throw new Error(
      `[@numueg/theme-plugin] theme.json is not valid JSON: ${(err as Error).message}`,
    );
  }

  // `author` is enforced by both CLI (`validateTheme()` rule 3) and now
  // the plugin — resolves CLAUDE.md §6e-4 (formerly: CLI rejected
  // missing author, plugin accepted it, theme devs saw the verdict
  // depend on which validator ran last). Keep the four fields in sync
  // when bumping either validator.
  for (const field of ["id", "name", "version", "author"] as const) {
    if (!manifest[field] || typeof manifest[field] !== "string") {
      throw new Error(
        `[@numueg/theme-plugin] theme.json missing required string field: ${field}`,
      );
    }
  }

  // Same semver rule the backend enforces.
  const semver = /^\d+\.\d+\.\d+(?:[-+][\w.\-]+)?$/;
  if (!semver.test(manifest.version)) {
    throw new Error(
      `[@numueg/theme-plugin] theme.json version "${manifest.version}" is not semver (x.y.z)`,
    );
  }

  // Validate id format (alphanumeric, dashes, underscores).
  if (!/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i.test(manifest.id)) {
    throw new Error(
      `[@numueg/theme-plugin] theme.json id "${manifest.id}" must be alphanumerics, dashes or underscores`,
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
      `[@numueg/theme-plugin] Bad JSON in ${path.basename(p)}: ${(err as Error).message}`,
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

/**
 * Phase 2.6 — registry/schema sync check.
 *
 * Verify that every section schema (`schemas/sections/<type>.json`) has
 * a matching component (`src/sections/<Type>.{tsx,ts,jsx,js}`) AND vice
 * versa. The two sides are read at different times (customizer reads
 * the schema; storefront mounts the component), so drift is invisible
 * in dev until a merchant adds the section in the customizer and the
 * storefront crashes with "unknown section type".
 *
 * Hard fails on schema-without-component (the storefront WILL crash).
 * Soft warns on component-without-schema (the section is just unreachable).
 *
 * Looks for components by basename match (case-insensitive). If a theme
 * uses defineSection({ schema: { type: "<id>" } }) with a non-matching
 * filename, the basename check is wrong — but our recommendation is
 * one section per file with `<Type>.tsx` named after `schema.type`,
 * which the codegen step also assumes for sections.d.ts.
 */
function validateSectionRegistry(themeDir: string): void {
  const sectionsDir = path.join(themeDir, "src", "sections");
  const schemaDir = path.join(themeDir, "schemas", "sections");

  const componentNames = new Set<string>();
  if (fs.existsSync(sectionsDir)) {
    for (const entry of fs.readdirSync(sectionsDir)) {
      if (!/\.(tsx|ts|jsx|js)$/.test(entry)) continue;
      componentNames.add(
        path.basename(entry, path.extname(entry)).toLowerCase(),
      );
    }
  }
  const schemaNames = new Set<string>();
  if (fs.existsSync(schemaDir)) {
    for (const entry of fs.readdirSync(schemaDir)) {
      if (!entry.endsWith(".json")) continue;
      schemaNames.add(path.basename(entry, ".json").toLowerCase());
    }
  }

  // Schema without component → hard fail. The storefront CAN'T render
  // this when a merchant adds it.
  const orphanSchemas: string[] = [];
  for (const name of schemaNames) {
    if (!componentNames.has(name)) orphanSchemas.push(name);
  }
  if (orphanSchemas.length > 0) {
    throw new Error(
      `[@numueg/theme-plugin] schemas/sections/ has ${orphanSchemas.length} ` +
        `entr${orphanSchemas.length === 1 ? "y" : "ies"} without a matching component:\n` +
        orphanSchemas.map((n) => `  - schemas/sections/${n}.json (no src/sections/${n}.tsx)`).join("\n") +
        `\n\nThe storefront throws "unknown section type" the moment a ` +
        `merchant adds one of these via the customizer. Either add the ` +
        `component file or remove the schema.`,
    );
  }

  // Component without schema → soft warn (won't crash, just unreachable).
  const orphanComponents: string[] = [];
  for (const name of componentNames) {
    if (!schemaNames.has(name)) orphanComponents.push(name);
  }
  if (orphanComponents.length > 0 && process.env.NUMU_THEME_VERBOSE) {
    console.warn(
      `[@numueg/theme-plugin] ${orphanComponents.length} section(s) have no ` +
        `schema and won't be addable from the customizer:`,
    );
    for (const n of orphanComponents) {
      console.warn(`  - src/sections/${n}.tsx (no schemas/sections/${n}.json)`);
    }
  }
}

// ── The plugin ──────────────────────────────────────────────────────────────

export function numuTheme(options: NumuThemePluginOptions = {}): Plugin {
  const themeDir = options.themeDir ?? process.cwd();
  const federate = options.federate ?? true;
  const externalList = [
    ...(federate ? FEDERATABLE_MODULES : []),
    ...(options.extraExternal ?? []),
  ];

  let manifest: ThemeManifest | null = null;
  let resolvedConfig: ResolvedConfig | null = null;

  return {
    name: "@numueg/theme-plugin",
    enforce: "pre",

    config(userConfig: UserConfig) {
      // 1. Contract check happens here — fail loudly before Vite spends
      //    time configuring the bundler.
      if (!options.skipValidation) {
        manifest = validateContract(themeDir);
        // Registry/schema sync (Phase 2.6). Catches the
        // schemas-without-components drift before customizer runtime.
        validateSectionRegistry(themeDir);
      }

      // 2. Externalize host-provided modules. We MERGE rather than replace
      //    so a theme can add its own externals (like a heavyweight CMS
      //    SDK shared with the host) via build.rollupOptions.external.
      //
      //    Also inline `process.env.NODE_ENV` — when React + react-dom are
      //    bundled in (federate=false), they reference `process.env.NODE_ENV`
      //    at runtime. Browsers have no `process`, so without a build-time
      //    replacement the bundle throws "process is not defined" the
      //    moment the host imports it. Themes are produced and consumed
      //    in production mode regardless of how the host runs.
      const merged: UserConfig = {
        define: {
          ...userConfig.define,
          "process.env.NODE_ENV": JSON.stringify("production"),
        },
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

    // Mount middleware so the dev server satisfies the backend dev-mode
    // contract (`POST /stores/{id}/themes/external/dev-mode`). The probe
    // expects:
    //   GET  /theme.json            (Vite already serves from project root)
    //   GET  /settings_schema.json  (Vite already serves from project root)
    //   GET  /sections.json         (optional — synthesized from schemas/)
    //   HEAD /theme.js              (this middleware — from dist/)
    //   GET  /theme.css             (this middleware — from dist/)
    //
    // The dev-mode connector also stores those URLs in
    // store_themes.external_theme so the storefront loads `theme.js` from
    // the dev server. After running `numu-theme build` once you can paste
    // `http://localhost:5173` into the hub's "Connect dev server" dialog.
    configureServer(server) {
      const distDir = path.join(themeDir, "dist");

      function sendFile(
        res: import("http").ServerResponse,
        filePath: string,
        contentType: string,
        method: string,
      ) {
        if (!fs.existsSync(filePath)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(
            `[@numueg/theme-plugin] ${path.basename(filePath)} not found. ` +
              `Run \`numu-theme build\` first so the dev-mode connector can ` +
              `find theme.js and theme.css.`,
          );
          return;
        }
        const stat = fs.statSync(filePath);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-store");
        if (method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(filePath).pipe(res);
      }

      server.middlewares.use("/theme.js", (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        sendFile(
          res,
          path.join(distDir, "theme.js"),
          "application/javascript; charset=utf-8",
          req.method,
        );
      });

      server.middlewares.use("/theme.css", (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        sendFile(
          res,
          path.join(distDir, "theme.css"),
          "text/css; charset=utf-8",
          req.method,
        );
      });

      // Phase 7.7 — HMR signal for schema changes.
      //
      // The customizer iframe in the merchant hub reads
      // `/sections.json` (sections + blocks) and `/settings_schema.json`
      // (theme-level settings) to render its input forms. When a
      // theme dev edits one of those files in their editor, the
      // customizer needs to refetch — otherwise the dev sees their
      // schema edit reflected in the bundle but NOT in the form
      // controls (which renders the old shape forever).
      //
      // We piggy-back on Vite's built-in WebSocket: `server.ws.send`
      // a custom event with the type the customizer listens for.
      // The customizer's iframe-watcher (in V3) subscribes to
      // `__numu_schema_changed` via window.addEventListener after
      // it sets up its Vite WS connection.
      const schemaWatchGlobs = [
        path.join(themeDir, "settings_schema.json"),
        path.join(themeDir, "schemas/sections"),
        path.join(themeDir, "schemas/blocks"),
        path.join(themeDir, "theme.json"),
      ];
      try {
        server.watcher.add(schemaWatchGlobs);
        const emitSchemaChanged = (changedPath: string) => {
          server.ws.send({
            type: "custom",
            event: "numu:schema-changed",
            data: { path: changedPath, at: Date.now() },
          });
        };
        server.watcher.on("change", (p: string) => {
          if (
            p.endsWith("settings_schema.json") ||
            p.endsWith("theme.json") ||
            (p.includes(`${path.sep}schemas${path.sep}`) && p.endsWith(".json"))
          ) {
            emitSchemaChanged(p);
          }
        });
        server.watcher.on("add", (p: string) => {
          if (
            p.includes(`${path.sep}schemas${path.sep}`) &&
            p.endsWith(".json")
          ) {
            emitSchemaChanged(p);
          }
        });
        server.watcher.on("unlink", (p: string) => {
          if (
            p.includes(`${path.sep}schemas${path.sep}`) &&
            p.endsWith(".json")
          ) {
            emitSchemaChanged(p);
          }
        });
      } catch {
        // Vite versions without the watcher API just won't emit
        // schema-changed; the customizer falls back to manual reload.
      }

      // Generic dist-file middleware.
      //
      // Vite's lib mode emits the entry as `theme.js` plus one or more
      // code-split chunks (e.g. `main-XXXX.js`, `Hero-YYYY.js`) whenever
      // the entry has dynamic imports — and every NUMU theme does, because
      // sections are lazy-loaded. The entry bundle then does
      // `import "./main-XXXX.js"`, which the host iframe resolves
      // against the dev server's origin.
      //
      // Without this middleware, those chunk URLs fall through to Vite's
      // SPA fallback, which returns the project's `index.html` with
      // `Content-Type: text/html`. Chrome rejects that as a module:
      // "Failed to fetch dynamically imported module". The theme bundle
      // entry loads but its dependencies don't, so the storefront's
      // ByotThemeBoundary catches the error and falls back to V2.
      //
      // We mirror what the marketplace CDN does in production: serve
      // every file in `dist/` at its corresponding URL. Files outside
      // `dist/` (or that don't exist) fall through to Vite untouched.
      const distContentTypes: Record<string, string> = {
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".map": "application/json; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
      };
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const rawUrl = req.url || "";
        const url = rawUrl.split("?")[0];
        if (!url || url === "/") return next();
        const rel = url.startsWith("/") ? url.slice(1) : url;
        if (rel.includes("..")) return next();
        // The specific middlewares above (theme.js, theme.css, sections.json)
        // already handled these — skip so we don't fight over the same URL.
        // theme.json and settings_schema.json have canonical copies at the
        // project root that get edited live in dev; serving the dist/ copies
        // here would risk a stale read between rebuilds.
        if (
          rel === "theme.js" ||
          rel === "theme.css" ||
          rel === "sections.json" ||
          rel === "theme.json" ||
          rel === "settings_schema.json"
        ) {
          return next();
        }
        const filePath = path.join(distDir, rel);
        if (!fs.existsSync(filePath)) return next();
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return next();
        const ext = path.extname(rel).toLowerCase();
        const contentType =
          distContentTypes[ext] || "application/octet-stream";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(filePath).pipe(res);
      });

      // sections.json: synthesize from schemas/sections + schemas/blocks
      // on the fly so themes don't have to maintain a redundant file.
      server.middlewares.use("/sections.json", (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        try {
          const schemas = collectSchemas(themeDir);
          const body = JSON.stringify({
            sections: schemas.sections,
            blocks: schemas.blocks,
          });
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Cache-Control", "no-store");
          if (req.method === "HEAD") {
            res.setHeader("Content-Length", String(Buffer.byteLength(body)));
            res.end();
            return;
          }
          res.end(body);
        } catch (err) {
          res.statusCode = 500;
          res.end(String((err as Error).message));
        }
      });
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

      // 3a. Copy styles.css → dist/theme.css.
      //
      // The contract requires every theme to ship a styles.css. We
      // can't rely on Vite to emit one — Vite only emits CSS that's
      // *imported* by the entry, and our themes import styles.css
      // from index.html (dev-only) rather than from src/main.tsx.
      // The host expects `theme.css` next to `theme.js` and loads it
      // via `loadExternalCSS(external_theme.css_url)`, so we copy
      // verbatim. Existing dist/theme.css from a real Vite emit (if
      // a theme later starts importing styles from main.tsx) takes
      // precedence — we only write the fallback when there isn't
      // already a CSS output.
      const stylesPath = path.join(themeDir, "styles.css");
      const distCssPath = path.join(outDir, "theme.css");
      if (fs.existsSync(stylesPath) && !fs.existsSync(distCssPath)) {
        fs.copyFileSync(stylesPath, distCssPath);
      }

      // 3b. Emit src/__generated__/sections.d.ts
      //
      // Theme devs would otherwise type section settings as
      // Record<string, any> and lose autocomplete + lose the safety
      // net when they rename/remove a setting in the schema. We map
      // each schema's settings array to a TypeScript interface and
      // produce a `SectionSettings` map keyed by section type. Themes
      // import like:
      //
      //   import type { SectionSettings } from "../__generated__/sections";
      //   const s = settings as SectionSettings["hero"];
      //
      // Regenerated on every build; the developer should `.gitignore`
      // the file (or commit if they prefer — it's deterministic).
      writeSectionTypes(themeDir, collectSchemas(themeDir).sections);

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

      // 3c. Copy theme.json + settings_schema.json into dist/.
      //
      // The backend's `connect_dev_server` (NUMU-api) probes the dev
      // server for /theme.json + /settings_schema.json + /sections.json
      // to fingerprint the bundle. Vite's `dev` server happens to serve
      // project-root files implicitly, but `vite preview` only serves
      // dist/. Copying these into dist/ makes BOTH `vite dev` and
      // `vite preview` reachable for the backend probe — merchants can
      // use either workflow.
      for (const fileName of ["theme.json", "settings_schema.json"] as const) {
        const src = path.join(themeDir, fileName);
        const dst = path.join(outDir, fileName);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
        }
      }

      // 3d. Synthesize dist/sections.json from schemas/sections/*.json
      // + schemas/blocks/*.json — same shape the dev middleware serves
      // at request time. Optional but lets the backend's section picker
      // bootstrap without spinning up the dev server.
      const sectionsManifest = {
        sections: collectSchemas(themeDir).sections,
        blocks: collectSchemas(themeDir).blocks,
      };
      const sectionsJsonPath = path.join(outDir, "sections.json");
      if (!fs.existsSync(sectionsJsonPath)) {
        fs.writeFileSync(
          sectionsJsonPath,
          JSON.stringify(sectionsManifest, null, 2),
        );
      }

      // 4. Emit dist/import-map.json so the host can verify SDK compatibility.
      //
      // The marketplace install endpoint reads this file (extracted from
      // the uploaded ZIP) and refuses bundles whose `sdk_compat_major`
      // doesn't match the host's currently-served SDK major. Without it
      // a theme built against an older SDK could silently 404 on hooks
      // that no longer exist or — worse — call API shapes the host has
      // since changed.
      //
      // `host_provided` is the list of bare specifiers the bundle
      // expects the import map to resolve. The host's runtime manifest
      // must satisfy all of them (today: react, react/jsx-runtime,
      // react-dom, react-dom/client, @numueg/theme-sdk).
      const importMap = {
        plugin: PLUGIN_VERSION,
        federate,
        sdk_compat_major: SDK_COMPAT_MAJOR,
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

/**
 * Map a schema setting type to its TypeScript representation.
 *
 * We deliberately go narrow on the unions (e.g. select → literal union
 * of option values) so theme devs catch typos at compile time. When a
 * setting has no constraint we widen to `string` / `number` / etc.
 */
function settingTsType(setting: unknown): string {
  if (!setting || typeof setting !== "object") return "unknown";
  const s = setting as { type?: string; options?: { value?: unknown }[] };
  switch (s.type) {
    case "text":
    case "textarea":
    case "richtext":
    case "url":
    case "image_picker":
    case "video_picker":
    case "html":
    case "color":
    case "color_scheme":
    case "font":
    case "font_picker":
    case "product":
    case "collection":
    case "blog_picker":
    case "page_picker":
    case "link_list_picker":
    case "date":
    case "time":
    case "file_upload":
      return "string";
    case "number":
    case "range":
      return "number";
    case "checkbox":
      return "boolean";
    case "select":
    case "radio": {
      const opts = Array.isArray(s.options) ? s.options : [];
      const literals = opts
        .map((o) => (typeof o.value === "string" ? `"${o.value}"` : null))
        .filter((v): v is string => !!v);
      return literals.length > 0 ? literals.join(" | ") : "string";
    }
    default:
      return "unknown";
  }
}

function writeSectionTypes(
  themeDir: string,
  sections: Record<string, unknown>,
): void {
  const outDir = path.join(themeDir, "src", "__generated__");
  fs.mkdirSync(outDir, { recursive: true });

  const lines: string[] = [
    "// This file is auto-generated by @numueg/theme-plugin. Do not edit.",
    "// Regenerated on every `numu-theme build` from schemas/sections/*.json.",
    "//",
    "// Use it to get typed section settings:",
    "//   import type { SectionSettings } from './__generated__/sections';",
    "//   const s = settings as SectionSettings['hero'];",
    "",
    "export interface SectionSettings {",
  ];

  for (const [type, raw] of Object.entries(sections)) {
    if (!raw || typeof raw !== "object") continue;
    const schema = raw as {
      settings?: { id?: unknown; type?: unknown; default?: unknown }[];
    };
    const fields: string[] = [];
    for (const s of schema.settings ?? []) {
      if (!s || typeof s !== "object") continue;
      const id = (s as { id?: unknown }).id;
      if (typeof id !== "string") continue;
      const tsType = settingTsType(s);
      // All settings are optional — merchants may not have set them yet
      // and presets only cover the initial state.
      fields.push(`    ${JSON.stringify(id)}?: ${tsType};`);
    }
    if (fields.length === 0) {
      lines.push(`  ${JSON.stringify(type)}: Record<string, never>;`);
    } else {
      lines.push(`  ${JSON.stringify(type)}: {`);
      lines.push(...fields);
      lines.push("  };");
    }
  }

  lines.push("}");
  lines.push("");

  fs.writeFileSync(path.join(outDir, "sections.d.ts"), lines.join("\n"));
}

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
