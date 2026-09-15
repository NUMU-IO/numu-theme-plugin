/**
 * Preset <-> schema check — self-contained (like ssr-pass): the contract
 * suites need the numu-theme-v3-tests workspace, which vitest skips when
 * it's absent, so this lives in its own file to actually run.
 *
 * A preset section type with no schemas/sections/<type>.json must fail the
 * build (the storefront silently strips it). Covers both buckets: `hero` in
 * an array-shaped template, `header` in a map-shaped section group.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dir as tmpDir, type DirectoryResult } from "tmp-promise";
import { afterEach, describe, expect, it } from "vitest";

import { numuTheme } from "../index";

let sandbox: DirectoryResult | null = null;

afterEach(async () => {
  if (sandbox) {
    await sandbox.cleanup().catch(() => {});
    sandbox = null;
  }
});

async function scaffoldTheme(schemaTypes: string[]): Promise<string> {
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
      id: "preset-fixture",
      name: "Preset Fixture",
      version: "1.0.0",
      author: "tests@numueg.app",
      presets: {
        templates: { index: { sections: [{ type: "hero" }] } },
        section_groups: { header: { sections: { h1: { type: "header" } } } },
      },
    }),
  );
  write("settings_schema.json", "[]");
  write("styles.css", "");
  write("src/main.tsx", "export function mount() {}\n");
  for (const type of schemaTypes) {
    write(`schemas/sections/${type}.json`, JSON.stringify({ name: type }));
    write(`src/sections/${type}.tsx`, "export default () => null;\n");
  }
  return themeDir;
}

function runConfig(themeDir: string) {
  const hook = numuTheme({ themeDir, ssr: false }).config as (c: object) => unknown;
  return () => hook({});
}

describe("plugin/preset-section-types", () => {
  it("negative: a map-shaped section group type with no schema file fails the build", async () => {
    const themeDir = await scaffoldTheme(["hero"]);
    expect(runConfig(themeDir)).toThrow(
      /Preset references section type "header" with no schemas\/sections\/header\.json/,
    );
  });

  it("negative: an array-shaped template type with no schema file fails the build", async () => {
    const themeDir = await scaffoldTheme(["header"]);
    expect(runConfig(themeDir)).toThrow(
      /Preset references section type "hero" with no schemas\/sections\/hero\.json/,
    );
  });

  it("positive: every preset type has a schema file", async () => {
    const themeDir = await scaffoldTheme(["hero", "header"]);
    expect(runConfig(themeDir)).not.toThrow();
  });
});
