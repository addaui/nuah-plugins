// SPDX-License-Identifier: Apache-2.0
// Builds the module into @nuah/editor-basic's crate (crates/nuah-editor-basic/browser/index.js), which embeds it (ADR 0095).
// It takes ProseMirror from the editor (prosemirror(pm)), so it shares nothing at import time.
import { buildModule } from "@nuah/browser-kit/build";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const r = await buildModule({ entry: here("./src/index.ts"), outfile: here("../../crates/nuah-editor-basic/browser/index.js"), shared: [], minify: true });
console.log(`editor-basic index.js: ${(r.bytes / 1024).toFixed(0)} kB`);
