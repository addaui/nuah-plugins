// SPDX-License-Identifier: Apache-2.0
/**
 * One Live document open in a browser (ADR 0093). The Loro document is the editor's: typing changes it at once. This session keeps it in the
 * browser's storage, sends its local changes in batches and keeps them until the server has them, merges what arrives from others, and
 * catches up after being away. It knows nothing of pages or of a framework.
 */
import type { LoroDoc, VersionVector } from "loro-crdt";
import type { LiveStore } from "./store";

/** How the session reaches the server: operations on the Link, in the app. */
export interface LiveTransport {
  /** What the server has that `since` lacks (everything when `since` is missing), and the server's version. */
  pull(since?: Uint8Array): Promise<{ update: Uint8Array; version: Uint8Array }>;
  /** Local changes; the answer is the server's version after it took them. */
  push(update: Uint8Array, client: string): Promise<{ version: Uint8Array }>;
  /** This person's Presence state, passed on to the others and never stored. */
  presence(state: Uint8Array): Promise<void>;
}

/** The Loro classes, handed in so that the app and its editor share one WebAssembly instance. */
export interface LoroModule {
  LoroDoc: typeof LoroDoc;
  VersionVector: typeof VersionVector;
}

/** Presence: an ephemeral store whose local changes are sent and whose remote ones are applied (Loro's EphemeralStore has this shape). */
export interface Ephemeral {
  subscribeLocalUpdates(f: (bytes: Uint8Array) => void): () => void;
  apply(bytes: Uint8Array): void;
}

export interface LiveOptions {
  transport: LiveTransport;
  store: LiveStore;
  loro: LoroModule;
  ephemeral?: Ephemeral;
  /** Wait this long after a change before sending, so a burst of typing is one push. */
  batchMs?: number;
  /** Whether an error means the server refused the change (as opposed to not being reachable). */
  isRejection?: (e: unknown) => boolean;
}

/** synced: the server has everything; sending: a push is on its way; offline: the server cannot be reached and changes wait here; rejected: the server refused a change and the document was reset to the server's. */
export type LiveState = "synced" | "sending" | "offline" | "rejected";
/** What a subscriber hears: the state changed, the document was replaced (rebind the editor), or a remote change was merged. */
export type LiveEvent = "state" | "reset" | "remote";

const RETRY_MS = [1000, 2000, 5000, 10000];
const PRESENCE_MS = 200;
const SAVE_MS = 500;
const defaultRejection = (e: unknown) => typeof e === "object" && e !== null && (e as { category?: string }).category === "invalid";

let sessions = 0;

export class LiveDoc {
  doc: LoroDoc;
  readonly client: string;
  state: LiveState = "synced";
  /** The document as it was when the server refused it, so the person can copy what they typed. */
  rejected: LoroDoc | null = null;

  #o: Required<Omit<LiveOptions, "ephemeral">> & { ephemeral?: Ephemeral };
  #server: VersionVector | null;
  #listeners = new Set<(e: LiveEvent) => void>();
  #unsub: (() => void) | null = null;
  #unsubPresence: (() => void) | null = null;
  #batch: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #save: ReturnType<typeof setTimeout> | undefined;
  #presence: ReturnType<typeof setTimeout> | undefined;
  #presenceNext: Uint8Array | null = null;
  #attempt = 0;
  #inflight = false;
  #closed = false;

  private constructor(readonly key: string, doc: LoroDoc, server: VersionVector | null, o: LiveOptions) {
    this.doc = doc;
    this.#server = server;
    this.#o = { batchMs: 300, isRejection: defaultRejection, ...o };
    this.client = `s${Date.now().toString(36)}${(++sessions).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Open a document: from this browser's storage first, then caught up with the server. Without either, it cannot open (the error is the transport's). */
  static async open(key: string, o: LiveOptions): Promise<LiveDoc> {
    const saved = await o.store.load(key);
    const doc = new o.loro.LoroDoc();
    if (saved?.snapshot) doc.import(saved.snapshot);
    const s = new LiveDoc(key, doc, saved?.server ? o.loro.VersionVector.decode(saved.server) : null, o);
    try {
      await s.#pull();
    } catch (e) {
      if (!saved?.snapshot) throw e;
      s.#set("offline");
      s.#retryLater();
    }
    s.#bind();
    if (o.ephemeral) s.#unsubPresence = o.ephemeral.subscribeLocalUpdates((b) => s.#queuePresence(b));
    if (s.state !== "offline" && s.#unsent()) s.#schedule(0);
    return s;
  }

  subscribe(f: (e: LiveEvent) => void): () => void {
    this.#listeners.add(f);
    return () => { this.#listeners.delete(f); };
  }

  /** Use another way to reach the server (the app's Link changed). */
  setTransport(t: LiveTransport) { this.#o.transport = t; }

  /** A change someone else made, as the server passed it on. One this session sent itself is skipped. */
  receive(update: Uint8Array, client?: string) {
    if (this.#closed || (client && client === this.client)) return;
    const status = this.doc.import(update);
    this.#tell("remote");
    this.#persist();
    // it builds on something this copy does not have: ask for everything missing
    if (status.pending) void this.#pull().catch(() => { this.#set("offline"); this.#retryLater(); });
  }

  /** The server says there is something new but did not send it (too big for a Signal): pull it. */
  pullSoon() { void this.#pull().then(() => this.#tell("remote"), () => { this.#set("offline"); this.#retryLater(); }); }

  /** Another person's Presence state. */
  receivePresence(bytes: Uint8Array) { this.#o.ephemeral?.apply(bytes); }

  /** The connection is back: catch up and send what waited, now. */
  online() {
    clearTimeout(this.#retry);
    this.#attempt = 0;
    void this.#reconnect();
  }

  /** Stop: what is not stored yet is stored now. Unsent changes stay in storage for the next open. */
  async close() {
    this.#closed = true;
    for (const t of [this.#batch, this.#retry, this.#save, this.#presence]) clearTimeout(t);
    this.#unsub?.();
    this.#unsubPresence?.();
    await this.#store();
  }

  #tell(e: LiveEvent) { for (const f of this.#listeners) f(e); }
  #set(s: LiveState) { if (this.state !== s) { this.state = s; this.#tell("state"); } }

  #bind() {
    this.#unsub?.();
    this.#unsub = this.doc.subscribeLocalUpdates(() => {
      this.#persist();
      if (this.state !== "offline") this.#schedule(this.#o.batchMs);
    });
  }

  /** Local changes the server does not have yet. */
  #unsent(): boolean {
    if (!this.#server) return this.doc.oplogVersion().length() > 0;
    const c = this.doc.oplogVersion().compare(this.#server);
    return c === 1 || c === undefined;
  }

  #schedule(ms: number) {
    if (this.#closed) return;
    clearTimeout(this.#batch);
    this.#batch = setTimeout(() => void this.#flush(), ms);
  }

  async #pull() {
    const res = await this.#o.transport.pull(this.doc.oplogVersion().encode());
    this.doc.import(res.update);
    this.#server = this.#o.loro.VersionVector.decode(res.version);
    this.#persist();
  }

  async #flush() {
    if (this.#closed || this.#inflight) return;
    if (!this.#unsent()) {
      if (this.state !== "rejected") this.#set("synced");
      return;
    }
    const update = this.#server ? this.doc.export({ mode: "update", from: this.#server }) : this.doc.export({ mode: "update" });
    this.#inflight = true;
    this.#set("sending");
    try {
      const res = await this.#o.transport.push(update, this.client);
      this.#server = this.#o.loro.VersionVector.decode(res.version);
      this.#attempt = 0;
      this.#persist();
      this.#inflight = false;
      // the server has something this copy lacks (a change whose Signal has not arrived, or was missed): fetch it
      const c = this.doc.oplogVersion().compare(this.#server);
      if (c === -1 || c === undefined) await this.#pull().catch(() => undefined);
      if (this.#unsent()) this.#schedule(this.#o.batchMs);
      else this.#set("synced");
    } catch (e) {
      this.#inflight = false;
      if (this.#o.isRejection(e)) await this.#reset();
      else { this.#set("offline"); this.#retryLater(); }
    }
  }

  /** The server refused this copy's changes: keep them aside and start again from the server's document. */
  async #reset() {
    const kept = this.doc;
    const fresh = new this.#o.loro.LoroDoc();
    try {
      const res = await this.#o.transport.pull();
      fresh.import(res.update);
      this.#server = this.#o.loro.VersionVector.decode(res.version);
    } catch {
      this.#set("offline");
      this.#retryLater();
      return;
    }
    this.rejected = kept;
    this.doc = fresh;
    this.#bind();
    this.#set("rejected");
    this.#tell("reset");
    this.#persist();
  }

  #retryLater() {
    if (this.#closed) return;
    clearTimeout(this.#retry);
    const ms = RETRY_MS[Math.min(this.#attempt++, RETRY_MS.length - 1)];
    this.#retry = setTimeout(() => void this.#reconnect(), ms);
  }

  async #reconnect() {
    if (this.#closed) return;
    try {
      await this.#pull();
      this.#tell("remote");
    } catch {
      this.#set("offline");
      this.#retryLater();
      return;
    }
    if (this.#unsent()) await this.#flush();
    else if (this.state !== "rejected") this.#set("synced");
  }

  #persist() {
    if (this.#closed) return;
    clearTimeout(this.#save);
    this.#save = setTimeout(() => void this.#store(), SAVE_MS);
  }

  async #store() {
    await this.#o.store.save(this.key, { snapshot: this.doc.export({ mode: "snapshot" }), server: this.#server ? this.#server.encode() : null }).catch(() => undefined);
  }

  #queuePresence(bytes: Uint8Array) {
    this.#presenceNext = bytes;
    if (this.#presence !== undefined) return;
    this.#presence = setTimeout(() => {
      this.#presence = undefined;
      const b = this.#presenceNext;
      this.#presenceNext = null;
      if (b && !this.#closed) void this.#o.transport.presence(b).catch(() => undefined);
    }, PRESENCE_MS);
  }
}
