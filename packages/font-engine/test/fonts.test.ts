import { describe, expect, it } from "vitest";
import { FontLibrary, familiesOf, facesFor, featureSettings, rangeHas, uiFamily, type Backend, type Family, type FaceLike, type Host } from "../src/index";

const LATIN = "U+0000-00FF,U+0131,U+2000-206F";
const ARABIC = "U+0600-06FF,U+0750-077F,U+FB50-FDFF";
const fam = (id: string, o: Partial<Family> = {}): Family => ({
  id, name: id.toUpperCase(), category: "sans", scripts: ["latin"], weights: [300, 900], variable: true, italic: false, features: [], licence: { spdx: "OFL-1.1", url: "https://x", credit: false },
  source: { name: "S", url: "https://s" }, popular: 5, faces: [{ script: "latin", style: "normal", weight: [300, 900], range: LATIN, url: `https://cdn.test/${id}-latin.woff2` }], ...o,
});
const readex = fam("readex", { scripts: ["arabic", "latin"], ui: "ar", faces: [
  { script: "arabic", style: "normal", weight: [160, 700], range: ARABIC, url: "https://cdn.test/readex-ar.woff2" },
  { script: "latin", style: "normal", weight: [160, 700], range: LATIN, url: "https://cdn.test/readex-la.woff2" }] });
const satoshi = fam("satoshi", { ui: "en", popular: 1 });

function setup() {
  const calls = { fetch: [] as string[], made: [] as { family: string; src: string; range: string }[], loaded: [] as string[] };
  const backend: Backend = { fetch: async (u) => { calls.fetch.push(u); return { key: "k" + calls.fetch.length }; }, status: async (urls) => urls.filter((u) => u.includes("satoshi")).map((url) => ({ url, key: "held" })) };
  const seen = new Set<string>();
  const host: Host = {
    make: (family, src, d): FaceLike => { calls.made.push({ family, src, range: d.unicodeRange }); return { family, status: "unloaded", load: async () => { calls.loaded.push(src); } }; },
    add: () => undefined,
    remember: { has: (u) => seen.has(u), add: (u) => void seen.add(u) },
  };
  return { calls, lib: new FontLibrary([satoshi, readex, fam("inter")], backend, host) };
}

describe("unicode ranges", () => {
  it("knows which code point a range covers", () => {
    expect(rangeHas(LATIN, 0x41)).toBe(true);
    expect(rangeHas(LATIN, 0x627)).toBe(false);
    expect(rangeHas(ARABIC, 0x627)).toBe(true);
    expect(rangeHas("U+4??", 0x4ff)).toBe(true);
    expect(rangeHas("U+0131", 0x131)).toBe(true);
    expect(rangeHas("nonsense", 0x41)).toBe(false);
  });
  it("picks the faces a text needs, so Latin and Arabic never share a file", () => {
    expect(facesFor(readex, "سلام").map((f) => f.script)).toEqual(["arabic"]);
    expect(facesFor(readex, "Hello").map((f) => f.script)).toEqual(["latin"]);
    expect(facesFor(readex, "Hello سلام").map((f) => f.script).sort()).toEqual(["arabic", "latin"]);
    expect(facesFor(readex).map((f) => f.script)).toEqual(["arabic"]);
  });
});

describe("the list", () => {
  it("is every family of every font plugin, the most used first, each once", () => {
    const list = familiesOf([{ id: "a", name: "A", families: { schema: "fonts/1", families: [fam("b", { popular: 3 }), fam("a", { popular: 1 })] } }, { id: "b", name: "B", families: { schema: "fonts/1", families: [fam("a", { popular: 9 })] } }, { id: "c", name: "C", families: { schema: "other", families: [fam("z")] } }]);
    expect(list.map((f) => f.id)).toEqual(["a", "b"]);
    expect(uiFamily([satoshi, readex], "ar")?.id).toBe("readex");
    expect(uiFamily([satoshi, readex], "en")?.id).toBe("satoshi");
  });
  it("writes font-feature-settings", () => {
    expect(featureSettings({ liga: true, ss01: false, "bad tag": true })).toBe('"liga" 1, "ss01" 0');
  });
});

describe("the library", () => {
  it("fetches a web font once on the server, then loads it from the server, never from its host", async () => {
    const { calls, lib } = setup();
    await lib.ensure("inter");
    await lib.ensure("inter");
    expect(calls.fetch).toEqual(["https://cdn.test/inter-latin.woff2"]);
    expect(calls.made).toHaveLength(1);
    expect(calls.made[0]!.src).toBe("/fonts/k1.woff2");
    expect(lib.state("inter")).toBe("ready");
  });
  it("knows what the server holds, so a preview skips the fetch", async () => {
    const { calls, lib } = setup();
    expect(lib.state("satoshi")).toBe("none");
    await lib.refresh();
    expect(lib.state("satoshi")).toBe("server");
    await lib.ensure("satoshi");
    expect(calls.fetch).toEqual([]);
    expect(calls.made[0]!.src).toBe("/fonts/held.woff2");
    expect(lib.state("satoshi")).toBe("ready");
  });
  it("loads the script a text needs now and leaves the others to the browser's unicode-range", async () => {
    const { calls, lib } = setup();
    await lib.ensure("readex", { text: "مرحبا" });
    expect(calls.loaded).toEqual(["/fonts/k1.woff2"]);
    expect(calls.made.map((m) => m.range).sort()).toEqual([ARABIC, LATIN].sort());
    expect(calls.fetch).toHaveLength(2);
    expect(lib.state("readex", "مرحبا")).toBe("ready");
    expect(lib.state("readex", "Hello")).toBe("server");
    await lib.ensure("readex", { text: "Hello" });
    expect(calls.made).toHaveLength(2);
    expect(calls.loaded).toHaveLength(2);
    expect(lib.state("readex", "Hello")).toBe("ready");
  });
  it("fetches only what a preview draws", async () => {
    const { calls, lib } = setup();
    await lib.ensure("readex", { text: "Readex", preview: true });
    expect(calls.fetch).toEqual(["https://cdn.test/readex-la.woff2"]);
    expect(calls.made).toHaveLength(1);
  });
  it("builds the interface font of a language from one family per script", async () => {
    const { calls, lib } = setup();
    await lib.composite("Madar UI en", [{ id: "satoshi", scripts: ["latin"] }, { id: "readex", scripts: ["arabic"] }]);
    expect(calls.made.map((m) => [m.family, m.range])).toEqual(expect.arrayContaining([["Madar UI en", LATIN], ["Madar UI en", ARABIC]]));
    expect(calls.made).toHaveLength(2);
  });
  it("remembers what this browser has had and says when a font failed", async () => {
    const { lib } = setup();
    expect(lib.cached("inter")).toBe(false);
    await lib.ensure("inter");
    expect(lib.cached("inter")).toBe(true);
    const bad = new FontLibrary([fam("x")], { fetch: async () => { throw new Error("down"); }, status: async () => [] }, { make: (f) => ({ family: f, status: "", load: async () => undefined }), add: () => undefined, remember: { has: () => false, add: () => undefined } });
    await bad.ensure("x");
    expect(bad.state("x")).toBe("failed");
  });
});
