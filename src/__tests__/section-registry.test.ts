/**
 * Section-registry sync regressions — T034 + T035 from tasks.md.
 *
 *   T034: schema without component → hard fail (storefront crash risk)
 *   T035: component without schema → soft warn (only unreachable from
 *         the customizer); emitted only when NUMU_THEME_VERBOSE=1.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createSandbox,
  type SandboxHandle,
} from "../../../numu-theme-v3-tests/tests/helpers/tmp";
import {
  invokePluginConfig,
  scaffoldValidTheme,
} from "../../../numu-theme-v3-tests/tests/helpers/run-plugin";
import {
  PLUGIN_SECTION_REGISTRY_SCHEMA_WITHOUT_COMPONENT,
  PLUGIN_SECTION_REGISTRY_COMPONENT_WITHOUT_SCHEMA,
} from "../../../numu-theme-v3-tests/tests/contract-registry";

let activeSandbox: SandboxHandle | null = null;
async function freshThemeDir(): Promise<string> {
  if (activeSandbox) await activeSandbox.cleanup();
  activeSandbox = await createSandbox();
  return scaffoldValidTheme(activeSandbox.cwd);
}
afterEach(async () => {
  if (activeSandbox) {
    await activeSandbox.cleanup();
    activeSandbox = null;
  }
});

/* ─── T034 schema without component (hard fail) ─────────────────────────────── */

describe("plugin/section-registry-schema-without-component", () => {
  it("negative: a schema with no matching component fires the hard-fail clause", async () => {
    const themeDir = await freshThemeDir();
    // Add a schema that has no component
    await fs.writeFile(
      path.join(themeDir, "schemas", "sections", "promo.json"),
      JSON.stringify({ type: "promo", name: "Promo", settings: [] }),
      "utf-8",
    );
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(
      PLUGIN_SECTION_REGISTRY_SCHEMA_WITHOUT_COMPONENT.id,
      {
        observed: "schemas/sections/promo.json with no src/sections/Promo.{tsx,ts,jsx,js}",
        expected: "every schema has a matching component",
      },
    );
    expect(result.error?.message).toMatch(/without a matching component/);
    expect(result.error?.message).toMatch(/promo/);
  });

  it("positive: every schema has a matching component → no error", async () => {
    const themeDir = await freshThemeDir();
    // Scaffolded theme already has hero.json + Hero.tsx in sync
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });
});

/* ─── T035 component without schema (soft warn, NUMU_THEME_VERBOSE only) ───── */

describe("plugin/section-registry-component-without-schema", () => {
  it("negative: a component without schema emits a soft warning when NUMU_THEME_VERBOSE=1", async () => {
    const themeDir = await freshThemeDir();
    // Add a component with no matching schema
    await fs.writeFile(
      path.join(themeDir, "src", "sections", "Orphan.tsx"),
      `export function Orphan() { return null; }\n`,
      "utf-8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previousVerbose = process.env.NUMU_THEME_VERBOSE;
    process.env.NUMU_THEME_VERBOSE = "1";
    try {
      const result = await invokePluginConfig(themeDir);
      // Should NOT throw — this is a warn, not a fail
      expect(result.error).toBeNull();
      // But it should have emitted a warning citing the orphan
      const warningTexts = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
      const merged = warningTexts.join("\n");
      expect(merged).toFailContractClause(
        PLUGIN_SECTION_REGISTRY_COMPONENT_WITHOUT_SCHEMA.id,
        {
          observed: "component `orphan` has no schema",
          expected: "console.warn output mentions orphan + no schemas/sections/orphan.json",
        },
      );
      expect(merged).toMatch(/no schemas\/sections\/orphan\.json|orphan/i);
    } finally {
      warnSpy.mockRestore();
      if (previousVerbose === undefined) delete process.env.NUMU_THEME_VERBOSE;
      else process.env.NUMU_THEME_VERBOSE = previousVerbose;
    }
  });

  it("positive: with NUMU_THEME_VERBOSE unset, the warn is silent", async () => {
    const themeDir = await freshThemeDir();
    await fs.writeFile(
      path.join(themeDir, "src", "sections", "Orphan.tsx"),
      `export function Orphan() { return null; }\n`,
      "utf-8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previousVerbose = process.env.NUMU_THEME_VERBOSE;
    delete process.env.NUMU_THEME_VERBOSE;
    try {
      const result = await invokePluginConfig(themeDir);
      expect(result.error).toBeNull();
      const warnings = warnSpy.mock.calls
        .map((c) => c.map(String).join(" "))
        .filter((s) => /no schemas\/sections\/orphan\.json/.test(s));
      expect(warnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      if (previousVerbose !== undefined) process.env.NUMU_THEME_VERBOSE = previousVerbose;
    }
  });
});
