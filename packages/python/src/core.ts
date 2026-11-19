// SPDX-License-Identifier: Apache-2.0
/**
 * Running one piece of Python in a Pyodide instance (ADR 0096): what it printed, what went wrong, and every matplotlib figure it
 * left open as a PNG. Packages named in its imports are loaded first. Never throws: an error is a result.
 */
import type { RunResult } from "@nuah/editor-api";

export interface Py {
  setStdout(o: { batched: (s: string) => void }): void;
  setStderr(o: { batched: (s: string) => void }): void;
  loadPackagesFromImports(src: string, o?: { messageCallback?: (m: string) => void }): Promise<unknown>;
  runPythonAsync(src: string): Promise<unknown>;
}

// matplotlib draws into memory (no screen in a worker); every open figure becomes a PNG, then all are closed
const SETUP = 'import os\nos.environ.setdefault("MPLBACKEND", "AGG")';
const FIGURES = `
def __nuah_figures():
    import sys
    if "matplotlib.pyplot" not in sys.modules:
        return []
    import io
    import matplotlib.pyplot as plt
    out = []
    for n in plt.get_fignums():
        b = io.BytesIO()
        plt.figure(n).savefig(b, format="png", bbox_inches="tight")
        out.append(b.getvalue())
    plt.close("all")
    return out
__nuah_figures()`;

const prepared = new WeakSet<object>();

export async function execute(py: Py, source: string, o: { packageBaseUrl?: string } = {}): Promise<RunResult> {
  void o;
  const t0 = Date.now();
  let stdout = "", stderr = "";
  py.setStdout({ batched: (s) => { stdout += s + "\n"; } });
  py.setStderr({ batched: (s) => { stderr += s + "\n"; } });
  try {
    if (!prepared.has(py)) { await py.runPythonAsync(SETUP); prepared.add(py); }
    await py.loadPackagesFromImports(source, { messageCallback: () => {} });
    const value = await py.runPythonAsync(source);
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") stdout += String(value) + "\n";
    else (value as { destroy?: () => void } | undefined)?.destroy?.();
    const figs = (await py.runPythonAsync(FIGURES)) as { toJs(): Uint8Array[]; destroy?: () => void };
    const list = figs.toJs();
    figs.destroy?.();
    const files = list.map((bytes, i) => ({ name: `figure-${i + 1}.png`, type: "image/png", bytes: new Uint8Array(bytes) }));
    return { ok: true, stdout, stderr, files, ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, stdout, stderr: stderr + msg + (msg.endsWith("\n") ? "" : "\n"), files: [], ms: Date.now() - t0 };
  }
}
