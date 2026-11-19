import { describe, expect, it, vi } from "vitest";
import { createLoader, type ModuleEntry } from "../src/loader";

const ui = () => ({ loading: vi.fn(() => vi.fn()) });
const entry = (plugin: string, kinds: string[], content = false): ModuleEntry => ({
  plugin, url: `/plugins/${plugin.slice(1)}/index.js?v=1`, data: { kinds: kinds.map((k) => ({ kind: k, version: 1, shape: content ? "content" : "card", placement: "block", label: { en: k } })) },
});
const list = [entry("@nuah/editor-basic", ["@nuah/editor-basic/paragraph"], true), entry("@nuah/mermaid", ["@nuah/mermaid/diagram"]), entry("@nuah/excalidraw", ["@nuah/excalidraw/sketch"])];

describe("the loader", () => {
  it("module_loaded_once_per_plugin", async () => {
    const importer = vi.fn(async () => ({ default: () => {} }));
    const l = createLoader({ list, importer, ui: ui() as never, api: () => ({}) as never });
    await Promise.all([l.loadFor(new Set(["@nuah/mermaid/diagram"])), l.loadFor(new Set(["@nuah/mermaid/diagram"]))]);
    await l.loadFor(new Set(["@nuah/mermaid/diagram"]));
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("only_needed_modules_load", async () => {
    const importer = vi.fn(async (_u: string) => ({ default: () => {} }));
    const l = createLoader({ list, importer, ui: ui() as never, api: () => ({}) as never });
    await l.loadContent();
    expect(importer.mock.calls.map((c) => c[0])).toEqual(["/plugins/nuah/editor-basic/index.js?v=1"]);
    await l.loadFor(new Set(["@nuah/excalidraw/sketch", "@nobody/x/y"]));
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("loading_toast_after_300ms", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const u = { loading: vi.fn(() => done) };
    const importer = (url: string): Promise<{ default?: unknown }> => new Promise((r) => setTimeout(() => r({ default: () => {} }), url.includes("mermaid") ? 400 : 100));
    const l = createLoader({ list, importer, ui: u as never, api: () => ({}) as never });
    const fast = l.loadFor(new Set(["@nuah/excalidraw/sketch"]));
    await vi.advanceTimersByTimeAsync(150);
    await fast;
    expect(u.loading).not.toHaveBeenCalled();
    const slow = l.loadFor(new Set(["@nuah/mermaid/diagram"]));
    await vi.advanceTimersByTimeAsync(350);
    expect(u.loading).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await slow;
    expect(done).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("register_throw_marks_plugin_failed", async () => {
    const importer = vi.fn(async (u: string) => ({ default: () => { if (u.includes("mermaid")) throw new Error("boom"); } }));
    const l = createLoader({ list, importer, ui: ui() as never, api: () => ({}) as never });
    await l.loadFor(new Set(["@nuah/mermaid/diagram", "@nuah/excalidraw/sketch"]));
    expect(l.failed("@nuah/mermaid")).toMatch(/boom/);
    expect(l.failed("@nuah/excalidraw")).toBeNull();
    expect(l.loaded("@nuah/excalidraw")).toBe(true);
  });

  it("each_module_gets_an_api_for_its_own_plugin", async () => {
    const seen: string[] = [];
    const importer = async () => ({ default: (api: { plugin: string }) => { seen.push(api.plugin); } });
    const l = createLoader({ list, importer, ui: ui() as never, api: (plugin) => ({ plugin }) as never });
    await l.loadFor(new Set(["@nuah/mermaid/diagram"]));
    expect(seen).toEqual(["@nuah/mermaid"]);
  });
});
