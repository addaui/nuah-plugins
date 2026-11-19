// SPDX-License-Identifier: Apache-2.0
// Builds the host module into @nuah/editor's crate (crates/nuah-editor/browser/host.js), which embeds it (ADR 0095).
// The Face shares loro-crdt (one WebAssembly instance with the page's Live document); the host bundles its engine.
import { buildModule } from "@nuah/browser-kit/build";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const outfile = here("../../crates/nuah-editor/browser/host.js");
const r = await buildModule({ entry: here("./src/index.ts"), outfile, shared: ["loro-crdt"], minify: true });
if (readFileSync(outfile, "utf8").includes("import.meta")) throw new Error("the host module still says import.meta, which a Face's loader may not provide");
console.log(`host.js: ${(r.bytes / 1024).toFixed(0)} kB`);
