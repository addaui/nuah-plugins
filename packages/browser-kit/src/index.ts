// SPDX-License-Identifier: Apache-2.0
/**
 * The libraries a host shares with the Browser modules it loads (ADR 0095). The host sets them once, before it loads any module;
 * a module built with `buildModule` reads them from here instead of bundling its own copy, so there is one React, one Loro, one
 * editor engine on the page.
 */
type Table = Record<string, unknown>;
const KEY = "__nuahShared";

function table(): Table {
  const g = globalThis as unknown as Record<string, Table | undefined>;
  return (g[KEY] ??= Object.create(null) as Table);
}

/** Adds libraries to the table. Setting a name again to the same value is fine; to another value it is refused. */
export function setShared(libs: Table): void {
  const t = table();
  for (const [name, value] of Object.entries(libs)) {
    if (name in t && t[name] !== value) throw new Error(`shared library "${name}" is already set to another value`);
    t[name] = value;
  }
}

/** A library the host shares. */
export function shared<T = unknown>(name: string): T {
  const t = table();
  if (!(name in t)) throw new Error(`shared library "${name}" is not provided by the host`);
  return t[name] as T;
}

/** Empties the table (tests only). */
export function resetSharedForTests(): void {
  (globalThis as unknown as Record<string, unknown>)[KEY] = Object.create(null);
}
