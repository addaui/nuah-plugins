// SPDX-License-Identifier: Apache-2.0
/**
 * @nuah/python (ADR 0096): a Runner for Python in the browser. Code runs in a Web Worker (Pyodide), never on the page or the server; a
 * run longer than the limit ends the worker and the next run starts a new one. The first run loads Python, which takes a while; the
 * element hears it as the `loading` stage.
 */
import type { EditorApi, RunReport, RunResult } from "@nuah/editor-api";

export const LIMIT = { ms: 60_000 };
export interface WorkerLike { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void; terminate(): void }
type Req = { language: string; source: string };

export function makeRunner(create: () => WorkerLike) {
  let worker: WorkerLike | null = null, seq = 0;
  const waiting = new Map<number, { report: (r: RunReport) => void; done: (r: RunResult) => void }>();
  const start = () => {
    const w = create();
    w.onmessage = (e) => {
      const m = e.data as { id: number; progress?: RunReport; result?: RunResult };
      const p = waiting.get(m.id);
      if (!p) return;
      if (m.progress) p.report(m.progress);
      if (m.result) { waiting.delete(m.id); p.done(m.result); }
    };
    return w;
  };
  return (req: Req, report: (r: RunReport) => void): Promise<RunResult> =>
    new Promise((resolve) => {
      const id = ++seq;
      const first = !worker;
      worker ??= start();
      if (first) report({ stage: "loading" });
      const timer = setTimeout(() => {
        waiting.delete(id);
        worker?.terminate();
        worker = null;
        resolve({ ok: false, stdout: "", stderr: `Stopped after ${Math.round(LIMIT.ms / 1000)} seconds.\n`, files: [], ms: LIMIT.ms });
      }, LIMIT.ms);
      waiting.set(id, { report, done: (r) => { clearTimeout(timer); resolve(r); } });
      worker.postMessage({ id, source: req.source });
    });
}

export default function register(api: EditorApi) {
  api.runner(["python"], makeRunner(() => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }) as unknown as WorkerLike));
}
