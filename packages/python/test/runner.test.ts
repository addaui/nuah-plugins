import { describe, expect, it, beforeAll } from "vitest";
import { loadPyodide } from "pyodide";
import { execute } from "../src/core";
import { makeRunner, LIMIT, type WorkerLike } from "../src/index";

let py: Awaited<ReturnType<typeof loadPyodide>>;
import { fileURLToPath } from "node:url";
const indexURL = fileURLToPath(new URL("../node_modules/pyodide/", import.meta.url));
beforeAll(async () => { py = await loadPyodide({ indexURL }); }, 120_000);
const online = async () => { try { await fetch("https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide-lock.json", { method: "HEAD" }); return true; } catch { return false; } };

describe("running python", () => {
  it("runs_python_and_captures_stdout", async () => {
    const r = await execute(py as never, "x = 6 * 7\nprint('answer', x)");
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("answer 42\n");
    expect(r.files).toEqual([]);
  });

  it("error_reported_not_thrown", async () => {
    const r = await execute(py as never, "print('before')\n1 / 0");
    expect(r.ok).toBe(false);
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toContain("ZeroDivisionError");
  });

  it("figure_saved_as_png", async (t) => {
    if (!(await online())) return t.skip();
    const r = await execute(py as never, "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [1, 4, 9])", { packageBaseUrl: "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/" });
    expect(r.ok, r.stderr).toBe(true);
    expect(r.files.length).toBe(1);
    expect(r.files[0]!.type).toBe("image/png");
    expect([...r.files[0]!.bytes.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  }, 180_000);
});

/** A worker that answers after `ms`, or never. */
function fakeWorker(ms: number | null, log: string[]): WorkerLike {
  const w: WorkerLike = {
    onmessage: null,
    postMessage(m: { id: number; source: string }) {
      log.push("sent");
      w.onmessage?.({ data: { id: m.id, progress: { stage: "running" } } } as never);
      if (ms !== null) setTimeout(() => w.onmessage?.({ data: { id: m.id, result: { ok: true, stdout: "done\n", stderr: "", files: [], ms } } } as never), ms);
    },
    terminate() { log.push("terminated"); },
  };
  return w;
}

describe("the runner", () => {
  it("long_run_stopped_at_limit", async () => {
    const log: string[] = [], made: string[] = [];
    LIMIT.ms = 50;
    const run = makeRunner(() => { made.push("worker"); return fakeWorker(made.length === 1 ? null : 1, log); });
    const stages: string[] = [];
    const r = await run({ language: "python", source: "while True: pass" }, (p) => stages.push(p.stage));
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/Stopped after/);
    expect(log).toContain("terminated");
    expect(stages).toContain("running");
    // the next run gets a fresh worker
    const again = await run({ language: "python", source: "print('done')" }, () => {});
    expect(again.stdout).toBe("done\n");
    expect(made.length).toBe(2);
    LIMIT.ms = 60_000;
  });
});
