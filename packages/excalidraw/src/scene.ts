// SPDX-License-Identifier: Apache-2.0
/**
 * A sketch's shapes in the element's Loro map: one entry per shape id, holding the whole shape. Two people drawing different shapes
 * both keep theirs; the same shape changed by both ends as one of the two whole shapes, never half of each.
 */
import type { LoroMap } from "loro-crdt";

export interface Shape { id: string; version: number; type: string; isDeleted?: boolean; text?: string; [k: string]: unknown }
export interface SceneDiff { put: Shape[]; remove: string[] }

/** What changed between the versions last written (`prev`, by id) and the shapes the editor has now. */
export function diffScene(prev: Map<string, number>, next: readonly Shape[]): SceneDiff {
  const put: Shape[] = [], seen = new Set<string>();
  for (const s of next) {
    seen.add(s.id);
    const v = prev.get(s.id);
    if (v === undefined || s.version > v) put.push(s);
  }
  return { put, remove: [...prev.keys()].filter((id) => !seen.has(id)) };
}

export function applyDiff(map: LoroMap, d: SceneDiff) {
  for (const s of d.put) map.set(s.id, JSON.parse(JSON.stringify(s)));
  for (const id of d.remove) map.delete(id);
}

/** The shapes, in a stable order (by Excalidraw's own `index` when it has one, else by id). */
export function readScene(map: LoroMap | null): Shape[] {
  if (!map) return [];
  const all = Object.values(map.toJSON() as Record<string, Shape>);
  return all.sort((a, b) => String(a.index ?? a.id).localeCompare(String(b.index ?? b.id)));
}

export const versions = (shapes: readonly Shape[]) => new Map(shapes.map((s) => [s.id, s.version]));

/** The sketch's words, for its Fallback and for search. */
export function textOf(shapes: readonly Shape[]): string {
  return shapes.filter((s) => s.type === "text" && !s.isDeleted && typeof s.text === "string" && s.text.trim()).map((s) => (s.text as string).trim()).join(" · ");
}
