/**
 * Plugin contract regressions — T026–T033 from tasks.md.
 *
 * Every clause has one negative test (proves the assertion fires on
 * bad input) AND one positive test (proves valid input still passes)
 * per Q4 clarification.
 *
 * Failures cite the clause via `toFailContractClause(id, detail)` —
 * Principle V wire-format enforcement.
 */

import { describe, it, expect, afterEach } from "vitest";
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
  PLUGIN_REQUIRED_FILES_THEME_JSON,
  PLUGIN_REQUIRED_FILES_SETTINGS_SCHEMA,
  PLUGIN_REQUIRED_FILES_STYLES_CSS,
  PLUGIN_ENTRY_DETECTION,
  PLUGIN_MOUNT_EXPORT_REQUIRED,
  PLUGIN_THEME_JSON_ID_PRESENT,
  PLUGIN_THEME_JSON_NAME_PRESENT,
  PLUGIN_THEME_JSON_VERSION_PRESENT,
  PLUGIN_THEME_JSON_SEMVER,
  PLUGIN_THEME_JSON_ID_CHARSET,
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

/* ─── T026 plugin/required-files-theme-json ────────────────────────────────── */

describe("plugin/required-files-theme-json", () => {
  it("negative: removing theme.json triggers the required-file clause", async () => {
    const themeDir = await freshThemeDir();
    await fs.rm(path.join(themeDir, "theme.json"));
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_REQUIRED_FILES_THEME_JSON.id, {
      observed: "theme.json missing from theme root",
      expected: "theme.json exists at theme root",
      source: PLUGIN_REQUIRED_FILES_THEME_JSON.source_file,
    });
    expect(result.error?.message).toMatch(/Missing required file: theme\.json/);
  });

  it("positive: scaffolded theme with theme.json present passes config()", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });
});

/* ─── T027 plugin/required-files-settings-schema ───────────────────────────── */

describe("plugin/required-files-settings-schema", () => {
  it("negative: removing settings_schema.json fires the required-file clause", async () => {
    const themeDir = await freshThemeDir();
    await fs.rm(path.join(themeDir, "settings_schema.json"));
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_REQUIRED_FILES_SETTINGS_SCHEMA.id, {
      observed: "settings_schema.json missing",
      expected: "settings_schema.json exists at theme root",
    });
    expect(result.error?.message).toMatch(/Missing required file: settings_schema\.json/);
  });

  it("positive: settings_schema.json present passes config()", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });
});

/* ─── T028 plugin/required-files-styles-css ────────────────────────────────── */

describe("plugin/required-files-styles-css", () => {
  it("negative: removing styles.css fires the required-file clause", async () => {
    const themeDir = await freshThemeDir();
    await fs.rm(path.join(themeDir, "styles.css"));
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_REQUIRED_FILES_STYLES_CSS.id, {
      observed: "styles.css missing",
      expected: "styles.css exists at theme root",
    });
    expect(result.error?.message).toMatch(/Missing required file: styles\.css/);
  });

  it("positive: styles.css present passes config()", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });
});

/* ─── T029 plugin/entry-detection ──────────────────────────────────────────── */

describe("plugin/entry-detection", () => {
  it("negative: no entry candidate file fires the entry-detection clause", async () => {
    const themeDir = await freshThemeDir();
    await fs.rm(path.join(themeDir, "src", "main.tsx"));
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_ENTRY_DETECTION.id, {
      observed: "no entry file under src/main.tsx, src/main.ts, src/index.tsx, src/index.ts, numu.config.tsx, numu.config.ts",
      expected: "at least one entry candidate exists",
    });
    expect(result.error?.message).toMatch(/Missing entry point/);
  });

  it("positive: src/main.tsx as entry passes config()", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });

  it("positive: numu.config.ts as the only entry candidate also passes", async () => {
    const themeDir = await freshThemeDir();
    // remove the default entry, then create an alternate one
    await fs.rm(path.join(themeDir, "src", "main.tsx"));
    await fs.writeFile(
      path.join(themeDir, "numu.config.ts"),
      `export const mount = (_el: HTMLElement) => null;\n`,
      "utf-8",
    );
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });
});

/* ─── T030 plugin/mount-export-required ────────────────────────────────────── */

describe("plugin/mount-export-required", () => {
  it("negative: entry without `export ... mount` fires the mount clause", async () => {
    const themeDir = await freshThemeDir();
    await fs.writeFile(
      path.join(themeDir, "src", "main.tsx"),
      `// Intentionally missing mount export\nexport function notMount() { return null; }\n`,
      "utf-8",
    );
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_MOUNT_EXPORT_REQUIRED.id, {
      observed: "entry has no `export ... mount`",
      expected: "entry exports `mount` as function/const or re-exported",
    });
    expect(result.error?.message).toMatch(/must export a `mount\(el, props\)` function/);
  });

  it("positive: `export function mount` is accepted", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });

  it("positive: `export const mount` is accepted", async () => {
    const themeDir = await freshThemeDir();
    await fs.writeFile(
      path.join(themeDir, "src", "main.tsx"),
      `export const mount = (_el: HTMLElement) => null;\n`,
      "utf-8",
    );
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });

  it("positive: `export { mount }` re-export form is accepted", async () => {
    const themeDir = await freshThemeDir();
    await fs.writeFile(
      path.join(themeDir, "src", "mount.ts"),
      `export function mount(_el: HTMLElement) { return null; }\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(themeDir, "src", "main.tsx"),
      `import { mount } from "./mount";\nexport { mount };\n`,
      "utf-8",
    );
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });
});

/* ─── T031 plugin/theme-json-required-fields (id / name / version) ─────────── */

describe("plugin/theme-json-required-fields", () => {
  async function patchThemeJson(themeDir: string, mutator: (obj: Record<string, unknown>) => void) {
    const fp = path.join(themeDir, "theme.json");
    const obj = JSON.parse(await fs.readFile(fp, "utf-8"));
    mutator(obj);
    await fs.writeFile(fp, JSON.stringify(obj, null, 2), "utf-8");
  }

  it("negative: missing `id` fires the id-present clause", async () => {
    const themeDir = await freshThemeDir();
    await patchThemeJson(themeDir, (o) => delete o.id);
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_THEME_JSON_ID_PRESENT.id, {
      observed: "theme.json missing `id`",
      expected: "theme.json contains string `id`",
    });
    expect(result.error?.message).toMatch(/missing required string field: id/);
  });

  it("negative: missing `name` fires the name-present clause", async () => {
    const themeDir = await freshThemeDir();
    await patchThemeJson(themeDir, (o) => delete o.name);
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_THEME_JSON_NAME_PRESENT.id, {
      observed: "theme.json missing `name`",
      expected: "theme.json contains string `name`",
    });
    expect(result.error?.message).toMatch(/missing required string field: name/);
  });

  it("negative: missing `version` fires the version-present clause", async () => {
    const themeDir = await freshThemeDir();
    await patchThemeJson(themeDir, (o) => delete o.version);
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_THEME_JSON_VERSION_PRESENT.id, {
      observed: "theme.json missing `version`",
      expected: "theme.json contains string `version`",
    });
    expect(result.error?.message).toMatch(/missing required string field: version/);
  });

  it("positive: theme.json with id/name/version passes", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });
});

/* ─── T032 plugin/theme-json-semver ────────────────────────────────────────── */

describe("plugin/theme-json-semver", () => {
  async function setVersion(themeDir: string, version: string) {
    const fp = path.join(themeDir, "theme.json");
    const obj = JSON.parse(await fs.readFile(fp, "utf-8"));
    obj.version = version;
    await fs.writeFile(fp, JSON.stringify(obj, null, 2), "utf-8");
  }

  it("negative: `1.0` is not semver and fires the semver clause", async () => {
    const themeDir = await freshThemeDir();
    await setVersion(themeDir, "1.0");
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_THEME_JSON_SEMVER.id, {
      observed: "1.0",
      expected: "semver x.y.z (with optional -prerelease / +build)",
    });
    expect(result.error?.message).toMatch(/is not semver/);
  });

  it("negative: empty string version fails the present-field check before semver", async () => {
    const themeDir = await freshThemeDir();
    await setVersion(themeDir, "");
    const result = await invokePluginConfig(themeDir);
    // Empty string is falsy so the plugin throws the required-field
    // error, not the semver error — that's fine. The clause we cite
    // here is the version-present clause, not the semver clause.
    expect(result.error).toFailContractClause(PLUGIN_THEME_JSON_VERSION_PRESENT.id, {
      observed: "version is empty string",
      expected: "non-empty string version",
    });
  });

  it("positive: `1.0.0` passes", async () => {
    const themeDir = await freshThemeDir();
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });

  it("positive: `1.0.0-beta.1` (prerelease) passes", async () => {
    const themeDir = await freshThemeDir();
    await setVersion(themeDir, "1.0.0-beta.1");
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });
});

/* ─── T033 plugin/theme-json-id-charset ────────────────────────────────────── */

describe("plugin/theme-json-id-charset", () => {
  async function setId(themeDir: string, id: string) {
    const fp = path.join(themeDir, "theme.json");
    const obj = JSON.parse(await fs.readFile(fp, "utf-8"));
    obj.id = id;
    await fs.writeFile(fp, JSON.stringify(obj, null, 2), "utf-8");
  }

  it("negative: `My Theme!` (space + punctuation) fires the id-charset clause", async () => {
    const themeDir = await freshThemeDir();
    await setId(themeDir, "My Theme!");
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toFailContractClause(PLUGIN_THEME_JSON_ID_CHARSET.id, {
      observed: "My Theme!",
      expected: "alphanumeric + `_-`, must start and end with alphanumeric",
    });
    expect(result.error?.message).toMatch(/must be alphanumerics, dashes or underscores/);
  });

  it("positive: `numu-modern` is a valid id", async () => {
    const themeDir = await freshThemeDir();
    await setId(themeDir, "numu-modern");
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });

  it("positive: `theme_with_underscores` is a valid id", async () => {
    const themeDir = await freshThemeDir();
    await setId(themeDir, "theme_with_underscores");
    const result = await invokePluginConfig(themeDir);
    expect(result.error).toBeNull();
  });
});
