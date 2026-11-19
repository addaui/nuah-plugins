import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildModule } from "../src/build";
import { setShared, shared, resetSharedForTests } from "../src/index";

const out = () => join(mkdtempSync(join(tmpdir(), "kit-")), "m.js");
const here = (f: string) => new URL(f, import.meta.url).pathname;

describe("browser-kit", () => {
  beforeEach(() => resetSharedForTests());

  it("built_module_reads_shared_table", async () => {
    const file = out();
    await buildModule({ entry: here("./fixture/entry.ts"), outfile: file, shared: ["loro-crdt"] });
    const code = readFileSync(file, "utf8");
    expect(code).not.toMatch(/class LoroDoc/);
    expect(code.length).toBeLessThan(20000);
    class Fake { fake = true; }
    setShared({ "loro-crdt": { LoroDoc: Fake } });
    const m = await import(pathToFileURL(file).href);
    expect(m.default()).toBeInstanceOf(Fake);
  });

  it("missing_shared_name_throws_clear_message", async () => {
    const file = out();
    await buildModule({ entry: here("./fixture/entry.ts"), outfile: file, shared: ["loro-crdt"] });
    await expect(import(pathToFileURL(file).href + "?missing")).rejects.toThrow('shared library "loro-crdt" is not provided by the host');
    expect(() => shared("nothing")).toThrow('shared library "nothing" is not provided by the host');
  });

  it("jsx_runtime_is_shared", async () => {
    const file = out();
    await buildModule({ entry: here("./fixture/jsx.tsx"), outfile: file, shared: ["react", "react/jsx-runtime"] });
    const code = readFileSync(file, "utf8");
    expect(code).toContain("react/jsx-runtime");
    expect(code).not.toMatch(/function jsxDEV|REACT_ELEMENT_TYPE/);
  });

  it("refuses_to_replace_a_shared_library_with_another", () => {
    const a = { x: 1 };
    setShared({ lib: a });
    setShared({ lib: a });
    expect(() => setShared({ lib: { x: 2 } })).toThrow('shared library "lib" is already set to another value');
  });
});

describe("split builds", () => {
  it("chunks_are_listed_for_the_crate", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "kit-split-"));
    const src = join(dir, "src"); mkdirSync(src);
    writeFileSync(join(src, "entry.ts"), 'export default async function register() { const m = await import("./later"); return m.value; }');
    writeFileSync(join(src, "later.ts"), "export const value = 42;");
    const out = join(dir, "browser");
    const { buildModule, writeFilesRs } = await import("../src/build");
    await buildModule({ entry: join(src, "entry.ts"), outdir: out, shared: [] });
    expect(existsSync(join(out, "index.js"))).toBe(true);
    const n = await writeFilesRs(out);
    expect(n).toBeGreaterThanOrEqual(2);
    const rs = readFileSync(join(out, "files.rs"), "utf8");
    expect(rs).toContain('("index.js", include_bytes!("index.js")),');
    expect(rs).toMatch(/\("chunks\/later-[A-Z0-9]+\.js", include_bytes!\("chunks\/later-[A-Z0-9]+\.js"\)\),/);
  });
});
