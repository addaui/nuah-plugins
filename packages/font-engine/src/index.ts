// SPDX-License-Identifier: Apache-2.0
// Fonts for a Face (Nuah ADR 0090). Font plugins describe families as data (`fonts/1`); this loads them with the FontFace API, one face per
// script (unicode-range) so the browser takes a font by code point and downloads a subset only when a character needs it. A web-hosted face
// is fetched once by the instance (the `fonts.fetch` operation) and loaded from `/fonts/<key>.woff2`, so the browser never contacts the font's host.

export type Script = "latin" | "arabic" | "cyrillic" | "greek" | "hebrew" | "devanagari";
export interface Face { script: Script; subset?: string; style: "normal" | "italic"; weight: [number, number]; range: string; url: string }
export interface Feature { tag: string; label: string; default: boolean }
export interface Family {
  id: string; name: string; category: "sans" | "serif" | "mono" | "display" | "handwriting"; scripts: Script[]; weights: [number, number];
  variable: boolean; italic: boolean; features: Feature[]; licence: { spdx: string; url: string; credit: boolean }; source: { name: string; url: string };
  popular: number; rehost?: boolean; bundle?: boolean; ui?: string; faces: Face[];
}
/** What `describe` carries for fonts: one entry per enabled font plugin. */
export interface FontPluginData { id: string; name: string; families: { schema: string; families: Family[] } }

/** Every family of every enabled font plugin, the most used first. */
export function familiesOf(plugins: FontPluginData[] | undefined): Family[] {
  const seen = new Set<string>();
  const out: Family[] = [];
  for (const p of plugins ?? []) {
    if (p.families?.schema !== "fonts/1") continue;
    for (const f of p.families.families) if (!seen.has(f.id)) { seen.add(f.id); out.push(f); }
  }
  return out.sort((a, b) => a.popular - b.popular || a.name.localeCompare(b.name));
}

/** The interface font of a language: the family that says `ui: "<lang>"`. */
export const uiFamily = (families: Family[], lang: string): Family | undefined => families.find((f) => f.ui === lang);

/** Whether a unicode-range ("U+0020-007E,U+00A0") covers a code point. */
export function rangeHas(range: string, cp: number): boolean {
  for (const part of range.split(",")) {
    const m = /^\s*U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?\s*$/.exec(part);
    if (!m) continue;
    const a = m[1]!;
    if (a.includes("?")) { if (cp >= parseInt(a.replace(/\?/g, "0"), 16) && cp <= parseInt(a.replace(/\?/g, "F"), 16)) return true; continue; }
    const lo = parseInt(a, 16), hi = m[2] ? parseInt(m[2], 16) : lo;
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** The faces a piece of text needs: those whose range covers one of its characters (all of the first script's faces when there is no text). */
export function facesFor(f: Family, text?: string, all = false): Face[] {
  if (all) return f.faces;
  if (!text) return f.faces.filter((x) => x.script === f.scripts[0]);
  const cps = [...new Set([...text].map((c) => c.codePointAt(0)!))];
  return f.faces.filter((x) => cps.some((cp) => rangeHas(x.range, cp)));
}

/** `font-feature-settings` for a set of choices ({ liga: true, ss01: false }). */
export const featureSettings = (on: Record<string, boolean>): string =>
  Object.entries(on).filter(([t]) => /^[a-z0-9]{4}$/i.test(t)).map(([t, v]) => `"${t}" ${v ? 1 : 0}`).join(", ");

/** The part of a family's use that is not the browser's: asking the instance. */
export interface Backend {
  /** Fetch the file once on the server; says the key it is served under. */
  fetch(url: string): Promise<{ key: string }>;
  /** Which addresses the server already holds, with their keys. */
  status(urls: string[]): Promise<{ url: string; key: string }[]>;
}

/** The browser's side: made so tests can stand in for it. */
export interface FaceLike { family: string; status: string; load(): Promise<unknown> }
export interface Host {
  make(family: string, src: string, d: { weight: string; style: string; unicodeRange: string }): FaceLike;
  add(face: FaceLike): void;
  remember: { has(url: string): boolean; add(url: string): void };
}

export function browserHost(): Host {
  const known = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem("fonts.ready") ?? "[]") as string[]); } catch { return new Set(); } };
  return {
    make: (family, src, d) => new FontFace(family, `url("${src}") format("woff2")`, { ...d, display: "swap" }) as unknown as FaceLike,
    add: (f) => document.fonts.add(f as unknown as FontFace),
    remember: {
      has: (u) => known().has(u),
      add: (u) => { try { const s = known(); s.add(u); localStorage.setItem("fonts.ready", JSON.stringify([...s].slice(-400))); } catch { /* storage may be blocked */ } },
    },
  };
}

/** none: not on the server; server: kept by the instance; loading; ready: loaded here (and cached by the browser); failed. */
export type State = "none" | "server" | "loading" | "ready" | "failed";

export class FontLibrary {
  private keys = new Map<string, string>();       // address -> key, once the server holds it
  private loaded = new Set<string>();             // "family|url" loaded
  private ready = new Set<string>();              // addresses loaded under any name: the state of a family does not depend on what it was registered as
  private added = new Set<string>();              // "family|url" registered with the document (loaded or waiting for a character)
  private faceObjects = new Map<string, FaceLike>();
  private loading = new Map<string, Promise<void>>();
  private failed = new Set<string>();
  private busy = new Set<string>();
  private subs = new Set<() => void>();
  /** Counts changes, for a store that re-renders on them. */
  version = 0;
  constructor(readonly families: Family[], private backend: Backend, private host: Host = browserHost()) {}

  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private tell() { this.version++; for (const f of this.subs) f(); }
  family(id: string): Family | undefined { return this.families.find((f) => f.id === id); }
  /** The CSS family name to put in `font-family`. */
  css(f: Family | string): string { const n = typeof f === "string" ? this.family(f)?.name ?? f : f.name; return `"${n}"`; }

  private remote = (face: Face): boolean => face.url.startsWith("https://");
  /** Where the browser loads a face from, once it can: its own path, or the server's copy. */
  private src(face: Face): string | undefined { return this.remote(face) ? (this.keys.has(face.url) ? `/fonts/${this.keys.get(face.url)}.woff2` : undefined) : face.url; }

  /** Ask the server which of these families' files it already holds (for the status dots). */
  async refresh(ids?: string[]): Promise<void> {
    const urls = (ids ? ids.map((i) => this.family(i)).filter(Boolean) as Family[] : this.families).flatMap((f) => f.faces.map((x) => x.url)).filter((u) => u.startsWith("https://"));
    const unknown = [...new Set(urls)].filter((u) => !this.keys.has(u));
    for (let i = 0; i < unknown.length; i += 400) for (const p of await this.backend.status(unknown.slice(i, i + 400))) this.keys.set(p.url, p.key);
    this.tell();
  }

  state(id: string, text?: string): State {
    const f = this.family(id);
    if (!f) return "none";
    const faces = facesFor(f, text);
    if (faces.length === 0) return "none";
    if (faces.some((x) => this.failed.has(x.url))) return "failed";
    if (this.busy.has(id)) return "loading";
    if (faces.every((x) => this.ready.has(x.url))) return "ready";
    if (faces.every((x) => !this.remote(x) || this.keys.has(x.url))) return "server";
    return "none";
  }

  /** Whether this browser has had the family's faces before (so a preview is quick even after a reload). */
  cached(id: string, text?: string): boolean {
    const f = this.family(id);
    return !!f && facesFor(f, text).every((x) => this.host.remember.has(x.url));
  }

  /** Make a family drawable: fetch its files on the server if needed, then load the faces a text needs under `as` (default: its own name). */
  ensure(id: string, o: { text?: string; as?: string; all?: boolean; preview?: boolean } = {}): Promise<void> {
    const f = this.family(id);
    if (!f) return Promise.resolve();
    const as = o.as ?? f.name;
    const tag = `${id}|${as}|${o.text ?? ""}|${o.all ? 1 : 0}|${o.preview ? 1 : 0}`;
    const prior = this.loading.get(tag);
    if (prior) return prior;
    const run = (async () => {
      this.busy.add(id); this.tell();
      try {
        const need = new Set(facesFor(f, o.text, o.all).map((x) => x.url));
        // every face is kept by the instance and registered with its unicode-range, so the browser fetches another script's subset only when a character needs it;
        // the faces this call is for are loaded now
        // a preview (a row of the picker) fetches and registers only what its text draws; use fetches the whole family
        await Promise.all((o.preview ? facesFor(f, o.text, o.all) : f.faces).map(async (face) => {
          const k = `${as}|${face.url}`;
          if (this.loaded.has(k) || (this.added.has(k) && !need.has(face.url))) return;
          try {
            if (this.remote(face) && !this.keys.has(face.url)) this.keys.set(face.url, (await this.backend.fetch(face.url)).key);
            let ff = this.faceObjects.get(k);
            if (!ff) {
              ff = this.host.make(as, this.src(face)!, { weight: `${face.weight[0]} ${face.weight[1]}`, style: face.style, unicodeRange: face.range });
              this.host.add(ff);
              this.faceObjects.set(k, ff); this.added.add(k);
            }
            if (need.has(face.url)) {
              await ff.load();
              this.loaded.add(k);
              this.ready.add(face.url);
              this.host.remember.add(face.url);
            }
            this.failed.delete(face.url);
          } catch { this.failed.add(face.url); }
        }));
      } finally { this.busy.delete(id); this.loading.delete(tag); this.tell(); }
    })();
    this.loading.set(tag, run);
    return run;
  }

  /** A family of one name made of other families, one per script: the interface font of a language. */
  async composite(name: string, parts: { id: string; scripts: Script[] }[]): Promise<void> {
    await Promise.all(parts.map(async (p) => {
      const f = this.family(p.id);
      if (!f) return;
      const only = { ...f, faces: f.faces.filter((x) => p.scripts.includes(x.script)) };
      const lib = new FontLibrary([only], this.backend, this.host);
      lib.keys = this.keys;
      await lib.ensure(p.id, { as: name, all: true });
      for (const k of lib.loaded) this.loaded.add(k);
      for (const u of lib.ready) this.ready.add(u);
      for (const k of lib.added) this.added.add(k);
    }));
    this.tell();
  }
}
