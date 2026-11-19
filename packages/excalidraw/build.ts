// SPDX-License-Identifier: Apache-2.0
// Builds the module into @nuah/excalidraw's crate (crates/nuah-excalidraw/browser): index.js, its chunks, index.css, the fonts
// (all but the 13 MB Xiaolai family: Chinese, Japanese and Korean text falls back to a system font), files.rs and kinds.json.
import { buildModule, writeFilesRs } from "@nuah/browser-kit/build";
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const out = here("../../crates/nuah-excalidraw/browser");
rmSync(out, { recursive: true, force: true });
const shared = ["react", "react-dom", "react-dom/client", "react/jsx-runtime"];
const r = await buildModule({ entry: here("./src/index.tsx"), outdir: out, shared, minify: true, define: { "process.env.NODE_ENV": '"production"' } });
const pkg = here("./node_modules/@excalidraw/excalidraw");
const prod = join(pkg, "dist/prod");
if (!existsSync(join(out, "index.css"))) cpSync(join(prod, "index.css"), join(out, "index.css"));
for (const f of readdirSync(join(prod, "fonts"))) if (f !== "Xiaolai") cpSync(join(prod, "fonts", f), join(out, "fonts", f), { recursive: true });
const { DECL } = await import("./src/decl.ts");
writeFileSync(`${out}/kinds.json`, JSON.stringify({ kinds: [DECL] }, null, 1) + "\n");
const n = await writeFilesRs(out);
console.log(`excalidraw: ${n} files, ${(r.bytes / 1024).toFixed(0)} kB of code`);
