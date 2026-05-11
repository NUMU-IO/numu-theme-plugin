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
| **Contract validation** | Asserts `src/main.tsx` exports `mount`; asserts React + SDK are externalized |
| **Schema codegen** | `schemas/sections/*.json` → `src/__generated__/sections.d.ts` |
| **Dev middleware** | Serves `/theme.js`, `/theme.css`, `/manifest.json`, `/sections.json`, `/runtime/*`, `/__numu/preview` |
| **Federation externals** | Auto-injects React + SDK into `rollupOptions.external` |
| **Asset pipeline** | Content-hashes `assets/*` and emits `dist/asset-manifest.json` |
| **Manifest emission** | Writes `dist/manifest.json` with integrity hashes |

## Options

```ts
numuTheme({
  themeRoot:      ".",                  // default
  schemaDir:      "schemas",            // default
  localeDir:      "locales",            // default
  assetDir:       "assets",             // default
  outDir:         "dist",               // default
  manifestPath:   "theme.json",         // default
  generatedDir:   "src/__generated__",  // default
  strictContract: true,                 // default — fail on contract violation
  emitMockPreview: true,                // default — serves /__numu/preview in dev
  schemaWatchMs:  100,                  // debounce
});
```

## Docs

- [Plugin Reference](https://numueg.app/docs/cli-plugin/vite-plugin)
- [Theme Engine Architecture](https://numueg.app/docs/theme-engine/architecture)
- [BYOT Contract](https://numueg.app/docs/theme-engine/byot-contract)

## License

MIT — see [LICENSE](./LICENSE).
