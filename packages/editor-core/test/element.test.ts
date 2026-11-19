import { describe, expect, it } from "vitest";
import { parseKind, resolveOption, type OptionDecl } from "../src";

describe("element kinds", () => {
  it("parse_kind_takes_plugin_from_kind", () => {
    expect(parseKind("@nuah/mermaid/diagram")).toEqual({ plugin: "@nuah/mermaid", name: "diagram" });
    expect(parseKind("@madar/task-block/task")).toEqual({ plugin: "@madar/task-block", name: "task" });
  });
  it("kind_outside_plugin_refused", () => {
    for (const k of ["mermaid", "@nuah/mermaid", "nuah/mermaid/diagram", "@nuah/mermaid/", "@nuah//x", "@Nuah/m/x", "@nuah/m/x/y"]) {
      expect(() => parseKind(k), k).toThrow(/element kind/);
    }
  });
});

describe("option layers", () => {
  const o: OptionDecl = { id: "theme", type: "choice", label: { en: "Theme" }, default: "default", inherit: true, choices: [] };
  it("option_layers_in_order", () => {
    const page = { diagram: { theme: "page" } };
    const more = { person: { diagram: { theme: "person" } }, admin: { diagram: { theme: "admin" } } };
    expect(resolveOption(o, "diagram", { theme: "own" }, page, more)).toEqual({ value: "own", source: "element" });
    expect(resolveOption(o, "diagram", {}, page, more)).toEqual({ value: "page", source: "page" });
    expect(resolveOption(o, "diagram", {}, undefined, more)).toEqual({ value: "person", source: "person" });
    expect(resolveOption(o, "diagram", {}, undefined, { admin: more.admin })).toEqual({ value: "admin", source: "admin" });
    expect(resolveOption(o, "diagram", {})).toEqual({ value: "default", source: "default" });
  });
});

import { textEdit } from "../src";
describe("text edits", () => {
  it("one_change_between_two_texts", () => {
    expect(textEdit("abc", "abc")).toBeNull();
    expect(textEdit("flowchart LR", "flowchart TD")).toEqual({ at: 10, remove: 2, insert: "TD" });
    expect(textEdit("ab", "aXb")).toEqual({ at: 1, remove: 0, insert: "X" });
    expect(textEdit("aXb", "ab")).toEqual({ at: 1, remove: 1, insert: "" });
  });
});
