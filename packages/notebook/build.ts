// SPDX-License-Identifier: Apache-2.0
// Builds the module into @nuah/notebook's crate (crates/nuah-notebook/browser): index.js and the chunks (none),
// files.rs listing them for the crate, and kinds.json for its manifest (ADR 0095).
import { buildModule, writeFilesRs } from "@nuah/browser-kit/build";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const out = here("../../crates/nuah-notebook/browser");
rmSync(out, { recursive: true, force: true });
const r = await buildModule({ entry: here("./src/index.ts"), outdir: out, shared: [], minify: true });
const { DECL } = await import("./src/decl.ts");
writeFileSync(`${out}/kinds.json`, JSON.stringify({ kinds: [DECL] }, null, 1) + "\n");
const n = await writeFilesRs(out);
console.log(`notebook: ${n} files, ${(r.bytes / 1024).toFixed(0)} kB`);
