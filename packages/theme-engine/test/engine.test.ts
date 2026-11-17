// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { apca, apply, lum, mix, resolve, tokens, type Preset } from "../src";

const pal = (bg: string, text: string) => ({ bg, surface: "#ffffff", side: "#f4f4f4", sunk: "#eeeeee", text, muted: "#666666", line: "#d0d0d0", accent: "#0b7a70", primary: "#111111", warn: "#d9a232", ok: "#3fa56b", danger: "#c23b28", sh: "20,40,36" });
const preset: Preset = {
  schema: "theme/1",
  tokens: { d: 1, r: 16, rbtn: 12, rcard: "auto", rchip: "auto", material: "hairline", depth: 50, alpha: 100, blur: 0, bw: 1, bcol: "line", gap: 12, frame: 12, fs: 15, font: "system", head: "system", hw: 650, hls: "0", ls: "0", tt: "none", texture: "none" },
  sig: { r_tier: false },
  light: pal("#e4eae8", "#12201d"),
  dark: pal("#0f1112", "#e8eceb"),
};

describe("theme engine", () => {
  it("mixes and measures colours", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(lum("#ffffff")).toBeCloseTo(1, 3);
    expect(apca("#000000", "#ffffff")).toBeGreaterThan(100);
  });

  it("writes the variables the stylesheet reads, for the chosen scheme", () => {
    const light = tokens(resolve(preset, {}, "light", false), preset);
    expect(light["--bg"]).toBe("#e4eae8");
    expect(light["--r-lg"]).toBe("16px");
    const dark = tokens(resolve(preset, {}, "dark", false), preset);
    expect(dark["--bg"]).toBe("#0f1112");
  });

  it("a person's colour override wins, and a new background re-derives the surfaces", () => {
    const t = tokens(resolve(preset, { "light:accent": "#ff0000", "light:bg": "#ddeeff" }, "light", false), preset);
    expect(t["--accent"]).toBe("#ff0000");
    expect(t["--bg"]).toBe("#ddeeff");
    expect(t["--surface"]).not.toBe("#ffffff");
  });

  it("puts the Arabic font first for right-to-left, and lets a product supply its own with --font-ar", () => {
    expect(tokens(resolve(preset, {}, "light", true), preset)["--font"]).toMatch(/^var\(--font-ar,"Noto Sans Arabic"\)/);
  });

  it("applies to <html> through the CSSOM", () => {
    apply(preset, {}, "dark", false);
    expect(document.documentElement.dataset.scheme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#0f1112");
  });
});
