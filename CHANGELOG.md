# Changelog

All notable changes to `@numueg/theme-plugin` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-11

First public release. Full surface documented at [numueg.app/docs/cli-plugin/vite-plugin](https://numueg.app/docs/cli-plugin/vite-plugin).

### Added

- **Contract validation**: asserts `src/main.tsx` exports `mount`; rejects bundles that ship a second React copy.
- **Schema codegen**: `schemas/sections/*.json` → typed declarations at `src/__generated__/sections.d.ts` (and the same for blocks).
- **Dev-server middleware**: serves `/theme.js`, `/theme.css`, `/manifest.json`, `/sections.json`, `/runtime/*`, `/__numu/preview` for local theme dev.
- **Federation externals**: auto-injects `react`, `react-dom`, `react/jsx-runtime`, `react-dom/client`, `@numueg/theme-sdk` into Rollup's `external` list.
- **Asset pipeline**: content-hashes `assets/*` and emits `dist/asset-manifest.json`.
- **Manifest emission**: writes `dist/manifest.json` with integrity hashes the marketplace consumes at submission time.
- Vite 5 + 6 supported via `peerDependencies`.
