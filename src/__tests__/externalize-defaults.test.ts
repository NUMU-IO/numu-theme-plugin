/**
 * Externalize defaults — T036 from tasks.md.
 *
 * FEDERATABLE_MODULES (react, react/jsx-runtime, react/jsx-dev-runtime,
 * react-dom, react-dom/client, @numueg/theme-sdk) MUST appear in the
 * merged rollupOptions.external list when federate: true. With
 * federate: false they MUST be absent.
 *
 * We assert by invoking the plugin's config() hook in-process and
 * inspecting the returned merged config — no actual build needed.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  createSandbox,
  type SandboxHandle,
} from "../../../numu-theme-v3-tests/tests/helpers/tmp";
import {
  invokePluginConfig,
  scaffoldValidTheme,
} from "../../../numu-theme-v3-tests/tests/helpers/run-plugin";
import { PLUGIN_EXTERNALIZE_DEFAULTS } from "../../../numu-theme-v3-tests/tests/contract-registry";

const FEDERATABLE_MODULES = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "@numueg/theme-sdk",
];

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

function externalToList(external: unknown): string[] {
  if (!external) return [];
  if (typeof external === "string") return [external];
  if (Array.isArray(external)) {
    return external.flatMap((e) =>
      typeof e === "string" ? [e] : e instanceof RegExp ? [`/${e.source}/`] : [],
    );
  }
  if (typeof external === "function") return ["<function>"];
  return [];
}

describe("plugin/externalize-defaults", () => {
  it("positive: federate=true (default) externalizes all FEDERATABLE_MODULES", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
    const external = externalToList(result.config?.build?.rollupOptions?.external);
    for (const mod of FEDERATABLE_MODULES) {
      expect(external).toContain(mod);
    }
  });

  it("positive: federate=false omits every FEDERATABLE_MODULES entry", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir, { federate: false });
    expect(result.error).toBeNull();
    const external = externalToList(result.config?.build?.rollupOptions?.external);
    const stillPresent = FEDERATABLE_MODULES.filter((m) => external.includes(m));
    expect(stillPresent).toEqual([]);
  });

  it("negative regression sentinel: if FEDERATABLE_MODULES drops `@numueg/theme-sdk` while federate=true, fail loudly", async () => {
    // This is the negative half of the clause: if a future refactor
    // ever lets the SDK escape externalization, every federated bundle
    // re-bundles the SDK and the host's React identity diverges from
    // the theme's. We pin the contract by name: when federate is the
    // default (true), @numueg/theme-sdk MUST be in external.
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
    const external = externalToList(result.config?.build?.rollupOptions?.external);
    const missing = ["@numueg/theme-sdk"].filter((m) => !external.includes(m));
    if (missing.length > 0) {
      // missing array is non-empty → clause fires
      expect(missing).toFailContractClause(PLUGIN_EXTERNALIZE_DEFAULTS.id, {
        observed: `@numueg/theme-sdk MISSING from external list when federate:true`,
        expected: "@numueg/theme-sdk in external when federate:true",
      });
    } else {
      expect(missing).toEqual([]);
    }
  });

  it("positive: extraExternal entries are preserved alongside federation defaults", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir, {
      extraExternal: ["my-custom-cms-sdk"],
    });
    expect(result.error).toBeNull();
    const external = externalToList(result.config?.build?.rollupOptions?.external);
    expect(external).toContain("my-custom-cms-sdk");
    for (const mod of FEDERATABLE_MODULES) {
      expect(external).toContain(mod);
    }
  });
});
