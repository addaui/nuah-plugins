// SPDX-License-Identifier: Apache-2.0
// Builds the Runner into @nuah/python's crate (crates/nuah-python/browser): index.js (the module), worker.js (the Web Worker) and
// Pyodide's core files beside them; files.rs lists them for the crate (ADR 0095, 0096).
import { buildModule, writeFilesRs } from "@nuah/browser-kit/build";
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const out = here("../../crates/nuah-python/browser");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await buildModule({ entry: here("./src/index.ts"), outfile: join(out, "index.js"), shared: [], minify: true });
await buildModule({ entry: here("./src/worker.ts"), outfile: join(out, "worker.js"), shared: [], minify: true });
const py = here("./node_modules/pyodide");
for (const f of ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]) cpSync(join(py, f), join(out, f));
console.log(`python: ${await writeFilesRs(out)} files`);
