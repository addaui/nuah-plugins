// SPDX-License-Identifier: Apache-2.0
/**
 * The Web Worker Python runs in (ADR 0096). Pyodide's core files are served next to this file by the plugin; packages named in imports
 * load from the Pyodide CDN, which the plugin declares in `connect` (the policy allows exactly that origin while the plugin is on).
 */
import { execute, type Py } from "./core";

declare const self: { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };
export const PYODIDE_VERSION = "0.29.5";
const base = new URL("./", import.meta.url).href;
let py: Promise<Py> | null = null;
const load = () => (py ??= import(/* @vite-ignore */ `${base}pyodide.mjs`).then((m: { loadPyodide(o: Record<string, unknown>): Promise<Py> }) =>
  m.loadPyodide({ indexURL: base, packageBaseUrl: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` })));

self.onmessage = async (e: MessageEvent) => {
  const { id, source } = e.data as { id: number; source: string };
  self.postMessage({ id, progress: { stage: "running" } });
  const r = await execute(await load(), source);
  self.postMessage({ id, result: r }, r.files.map((f) => f.bytes.buffer as ArrayBuffer));
};
