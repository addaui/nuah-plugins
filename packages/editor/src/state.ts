// SPDX-License-Identifier: Apache-2.0
/**
 * An element's own data (ADR 0094): a Loro container under the root map `elements`, keyed by the element's id, created mergeable so
 * two people who create it at the same time share one. Live values that are not kept travel in the Presence store under the element's key.
 */
import { LoroList, LoroMap, LoroMovableList, LoroText, LoroTree, type LoroDoc } from "loro-crdt";

export type StateType = "text" | "map" | "list" | "movableList" | "tree";
const make: Record<StateType, () => unknown> = { text: () => new LoroText(), map: () => new LoroMap(), list: () => new LoroList(), movableList: () => new LoroMovableList(), tree: () => new LoroTree() };

/** The element's container: the one already there, else a new one when this person may write, else an empty one that is not attached. */
export function stateFor(doc: LoroDoc, blockId: string | null, type: StateType, writable: boolean): { container: unknown; attached: boolean } {
  if (!blockId) return { container: make[type](), attached: false };
  const map = doc.getMap("elements");
  const have = map.get(blockId);
  if (have && typeof have === "object") return { container: have, attached: true };
  if (!writable) return { container: make[type](), attached: false };
  const m = map as unknown as Record<string, (k: string) => unknown>;
  const fn = { text: "ensureMergeableText", map: "ensureMergeableMap", list: "ensureMergeableList", movableList: "ensureMergeableMovableList", tree: "ensureMergeableTree" }[type];
  return { container: m[fn]!.call(map, blockId), attached: true };
}

/** The JSON of an element's container, or null (the raw data view, the compliance suite). */
export function stateJson(doc: LoroDoc, blockId: string | null): unknown {
  if (!blockId) return null;
  const c = doc.getMap("elements").get(blockId) as { toJSON?: () => unknown } | undefined;
  return c && typeof c.toJSON === "function" ? c.toJSON() : null;
}

/** An Ephemeral store's shape (Loro's EphemeralStore, or the cursor store built on it). */
export interface PresenceStore { set(key: string, value: unknown): void; getAllStates(): Record<string, unknown>; subscribe(f: () => void): () => void }

/** A store for when the page has none (no other people): values stay here. */
export function localPresence(): PresenceStore {
  const s: Record<string, unknown> = {}, ls = new Set<() => void>();
  return { set(k, v) { s[k] = v; ls.forEach((f) => f()); }, getAllStates: () => ({ ...s }), subscribe(f) { ls.add(f); return () => { ls.delete(f); }; } };
}

/** One element's slice of the Presence store: this person's value under `el:<id>:<peer>`, the others' values. */
export function elementPresence(store: PresenceStore, blockId: string, peer: string) {
  const prefix = `el:${blockId}:`;
  return {
    set: (value: unknown) => store.set(prefix + peer, value),
    others: () => Object.entries(store.getAllStates()).filter(([k]) => k.startsWith(prefix) && k !== prefix + peer).map(([, v]) => v),
    subscribe: (f: () => void) => store.subscribe(f),
  };
}
