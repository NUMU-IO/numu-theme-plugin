# @numueg/theme-plugin

> Vite plugin for NUMU themes. Contract validation, schema codegen, federation externals, asset pipeline, manifest emission.

[![npm](https://img.shields.io/npm/v/@numueg/theme-plugin.svg)](https://www.npmjs.com/package/@numueg/theme-plugin)
[![license](https://img.shields.io/npm/l/@numueg/theme-plugin.svg)](./LICENSE)

The plugin every NUMU theme registers in its `vite.config.ts`. It enforces the BYOT contract at build time and generates typed declarations from your `schemas/sections/*.json` so section components get fully-typed `settings`.

## Install

```bash
npm install --save-dev @numueg/theme-plugin
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import numuTheme from "@numueg/theme-plugin";

export default defineConfig({
  plugins: [react(), numuTheme()],
  build: {
    lib: {
      entry: "src/main.tsx",
      formats: ["es"],
      fileName: "theme",
    },
    cssCodeSplit: false,
  },
});
```

`numu-theme init <name>` scaffolds a config with the plugin pre-wired.

## What it does

| Step | What |
|---|---|
| **Contract validation** | Requires `theme.json` + `settings_schema.json` + `styles.css`; finds the entry (`src/main.tsx` etc.) and asserts it exports `mount`; validates manifest fields (`id`, `name`, semver `version`); registry sync — every `schemas/sections/<type>.json` must have a matching `src/sections/<Type>.tsx` (hard fail), component-without-schema is a soft warning |
| **Federation externals** | `federate: true` (default) externalizes `react`, `react-dom`, jsx runtimes, and `@numueg/theme-sdk` — the host provides them via its import map. `federate: false` builds a self-contained bundle |
| **Dev middleware** | Serves `/theme.js`, `/theme.css`, `/sections.json` (synthesized live from schemas), and code-split chunks from `dist/`; emits a `numu:schema-changed` WebSocket event when schemas change so the customizer refetches forms |
| **Schema codegen** | `schemas/sections/*.json` → `src/__generated__/sections.d.ts` (typed `settings` per section) |
| **Manifest emission** | Writes `dist/manifest.json` (normalized theme.json + all section/block schemas + locale catalogs + build metadata) and `dist/import-map.json` (`plugin`, `federate`, `sdk_compat_major`, `host_provided`) — the host install endpoint refuses bundles with a mismatched `sdk_compat_major` |
| **CSS fallback** | Copies `styles.css` → `dist/theme.css` if Vite didn't emit one |

`theme.json` extras the plugin understands: `error_template` / `loading_template` (static HTML fallbacks) and `variants[]` (theme-level style variants).

## Options

```ts
numuTheme({
  themeDir: process.cwd(),  // theme root override
  skipValidation: false,    // escape hatch for tests
  federate: true,           // externalize React + SDK (default)
  extraExternal: [],        // additional modules to externalize
});
```

## Docs

- [Plugin Reference](https://numueg.app/docs/cli-plugin/vite-plugin)
- [Theme Engine Architecture](https://numueg.app/docs/theme-engine/architecture)
- [BYOT Contract](https://numueg.app/docs/theme-engine/byot-contract)

## License

MIT — see [LICENSE](./LICENSE).
