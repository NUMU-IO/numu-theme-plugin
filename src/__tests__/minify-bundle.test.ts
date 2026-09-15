/**
 * The plugin whitespace-minifies the client bundle in `generateBundle` —
 * `build.minify` can't in an ES library build — and leaves it alone when
 * `minify: false` or outside `vite build`.
 */

import { describe, expect, it } from "vitest";
import { numuTheme } from "../index";

const SOURCE = `/** A block comment that must not ship. */
export function greet(name) {
    // indentation and comments survive Vite's library build
    return "hello " + name;
}
`;

async function runGenerateBundle(options: Parameters<typeof numuTheme>[0], command: "build" | "serve") {
  const plugin = numuTheme({ skipValidation: true, ...options }) as unknown as {
    configResolved: (c: unknown) => void;
    generateBundle: (o: unknown, b: Record<string, unknown>) => Promise<void>;
  };
  plugin.configResolved({ command });
  const chunk = { type: "chunk", code: SOURCE };
  const asset = { type: "asset", source: "/* css comment */ a { color: red }" };
  await plugin.generateBundle({}, { "theme.js": chunk, "theme.css": asset });
  return { chunk, asset };
}

describe("bundle minification", () => {
  it("minifies JS chunks on build and leaves assets untouched", async () => {
    const { chunk, asset } = await runGenerateBundle({}, "build");
    expect(chunk.code).not.toContain("block comment");
    expect(chunk.code).not.toContain("\n    ");
    expect(chunk.code).toContain("greet");
    expect(asset.source).toContain("/* css comment */");
  });

  it("is a no-op with minify: false and in dev", async () => {
    expect((await runGenerateBundle({ minify: false }, "build")).chunk.code).toBe(SOURCE);
    expect((await runGenerateBundle({}, "serve")).chunk.code).toBe(SOURCE);
  });
});
