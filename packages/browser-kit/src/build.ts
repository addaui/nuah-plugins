// SPDX-License-Identifier: Apache-2.0
/**
 * Builds a Browser module (ADR 0095): one ES module file whose imports of the shared libraries become reads of the host's table.
 * Runs in Node or Bun (esbuild), so plugin builds and tests use the same code.
 */
import { build, type Plugin } from "esbuild";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export interface BuildOptions {
  entry: string;
  outfile: string;
  /** Library names (and subpaths such as `react/jsx-runtime`) the host provides. */
  shared: string[];
  minify?: boolean;
  /** Replaced in the code, like esbuild's `define`. */
  define?: Record<string, string>;
}

const ident = /^[A-Za-z_$][\w$]*$/;

/** The export names of a library, read from the copy installed next to the entry, so a module may import any of them by name. */
async function exportNames(name: string, from: string): Promise<string[]> {
  try {
    const require = createRequire(from);
    const m = await import(require.resolve(name));
    return Object.keys(m).filter((k) => k !== "default" && ident.test(k));
  } catch {
    return [];
  }
}

function sharedPlugin(names: string[], entry: string): Plugin {
  const set = new Set(names);
  return {
    name: "nuah-shared",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => (set.has(a.path) ? { path: a.path, namespace: "nuah-shared" } : undefined));
      b.onLoad({ filter: /.*/, namespace: "nuah-shared" }, async (a) => {
        const name = JSON.stringify(a.path);
        const keys = await exportNames(a.path, entry);
        const named = keys.length ? `export const { ${keys.join(", ")} } = m;` : "";
        return {
          loader: "js",
          contents: `const t = globalThis.__nuahShared;
if (!t || !(${name} in t)) throw new Error('shared library "' + ${name} + '" is not provided by the host');
const m = t[${name}];
export default (m && m.default !== undefined ? m.default : m);
${named}`,
        };
      });
    },
  };
}

export async function buildModule(o: BuildOptions): Promise<{ bytes: number }> {
  const r = await build({
    entryPoints: [o.entry],
    outfile: o.outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: o.minify ?? false,
    jsx: "automatic",
    define: o.define,
    absWorkingDir: dirname(o.entry),
    plugins: [sharedPlugin(o.shared, o.entry)],
    metafile: true,
    logLevel: "silent",
  });
  const out = Object.values(r.metafile!.outputs)[0];
  return { bytes: out ? out.bytes : 0 };
}
