import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as loro from "loro-crdt";
import { LoroDoc, VersionVector } from "loro-crdt";
import { LiveDoc, memoryStore, type LiveTransport } from "../src/index";

/** The server's copy, with what a real one does: import, refuse, relay to the other sessions. */
class Server {
  doc = new LoroDoc();
  online = true;
  refuse: ((d: LoroDoc) => boolean) | null = null;
  sessions: LiveDoc[] = [];
  pushes = 0;
  constructor(text = "") { this.doc.getText("t").insert(0, text); this.doc.commit(); }
  text() { return this.doc.getText("t").toString(); }
  transport(): LiveTransport {
    const down = () => { if (!this.online) throw new TypeError("Failed to fetch"); };
    return {
      pull: async (since) => {
        down();
        const update = since ? this.doc.export({ mode: "update", from: VersionVector.decode(since) }) : this.doc.export({ mode: "snapshot" });
        return { update, version: this.doc.oplogVersion().encode() };
      },
      push: async (update, client) => {
        down();
        this.pushes++;
        const trial = this.doc.fork();
        trial.import(update);
        if (this.refuse?.(trial)) throw Object.assign(new Error("refused"), { category: "invalid", reason: "pages.body_rejected" });
        const before = this.doc.oplogVersion();
        this.doc.import(update);
        const fresh = this.doc.export({ mode: "update", from: before });
        for (const s of this.sessions) if (s.client !== client) s.receive(fresh, client);
        return { version: this.doc.oplogVersion().encode() };
      },
      presence: async () => { down(); },
    };
  }
}

const type = (s: LiveDoc, at: number, text: string) => { s.doc.getText("t").insert(at, text); s.doc.commit(); };
const del = (s: LiveDoc, at: number, n: number) => { s.doc.getText("t").delete(at, n); s.doc.commit(); };
const textOf = (s: LiveDoc) => s.doc.getText("t").toString();
const settle = async () => { for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(400); } };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("LiveDoc", () => {
  it("two sessions converge", async () => {
    const server = new Server("hello world");
    const a = await LiveDoc.open("p1", { transport: server.transport(), store: memoryStore(), loro });
    const b = await LiveDoc.open("p1", { transport: server.transport(), store: memoryStore(), loro });
    server.sessions.push(a, b);
    type(a, 5, " big");
    type(b, 11, "!");
    await settle();
    expect(textOf(a)).toBe("hello big world!");
    expect(textOf(b)).toBe("hello big world!");
    expect(server.text()).toBe("hello big world!");
    expect(a.state).toBe("synced");
  });

  it("sends a burst of typing in a few batches", async () => {
    const server = new Server("");
    const a = await LiveDoc.open("p1", { transport: server.transport(), store: memoryStore(), loro });
    for (let i = 0; i < 20; i++) { type(a, i, "x"); await vi.advanceTimersByTimeAsync(20); }
    await settle();
    expect(server.text()).toBe("x".repeat(20));
    expect(server.pushes).toBeLessThanOrEqual(3);
  });

  it("edits made offline are sent once when back", async () => {
    const server = new Server("abc");
    const store = memoryStore();
    const a = await LiveDoc.open("p1", { transport: server.transport(), store, loro });
    server.online = false;
    type(a, 3, "d");
    await settle();
    expect(a.state).toBe("offline");
    type(a, 4, "e");
    await settle();
    server.online = true;
    a.online();
    await settle();
    expect(server.text()).toBe("abcde");
    expect(a.state).toBe("synced");
    const n = server.pushes;
    await settle();
    expect(server.pushes).toBe(n);
  });

  it("a session reopens from its store without the server, and sends what was left", async () => {
    const server = new Server("abc");
    const store = memoryStore();
    const a = await LiveDoc.open("p1", { transport: server.transport(), store, loro });
    server.online = false;
    type(a, 0, "X");
    await settle();
    await a.close();
    const again = await LiveDoc.open("p1", { transport: server.transport(), store, loro });
    expect(textOf(again)).toBe("Xabc");
    expect(again.state).toBe("offline");
    server.online = true;
    again.online();
    await settle();
    expect(server.text()).toBe("Xabc");
  });

  it("a page never opened here cannot open offline", async () => {
    const server = new Server("abc");
    server.online = false;
    await expect(LiveDoc.open("p1", { transport: server.transport(), store: memoryStore(), loro })).rejects.toThrow();
  });

  it("a refused push resets to the server and keeps what was refused", async () => {
    const server = new Server("ok");
    server.refuse = (d) => d.getText("t").toString().includes("bad");
    const a = await LiveDoc.open("p1", { transport: server.transport(), store: memoryStore(), loro });
    let resets = 0;
    a.subscribe((e) => { if (e === "reset") resets++; });
    type(a, 2, " bad");
    await settle();
    expect(a.state).toBe("rejected");
    expect(resets).toBe(1);
    expect(textOf(a)).toBe("ok");
    expect(a.rejected?.getText("t").toString()).toBe("ok bad");
    type(a, 2, "!");
    await settle();
    expect(server.text()).toBe("ok!");
    expect(a.state).toBe("synced");
  });

  it("a long offline burst converges with a peer that kept editing", async () => {
    const server = new Server("start");
    const a = await LiveDoc.open("p1", { transport: server.transport(), store: memoryStore(), loro });
    const b = await LiveDoc.open("p1", { transport: server.transport(), store: memoryStore(), loro });
    server.sessions.push(a, b);
    const flaky = server.transport();
    let aOnline = true;
    const aT: LiveTransport = { pull: (s) => (aOnline ? flaky.pull(s) : Promise.reject(new TypeError("offline"))), push: (u, c) => (aOnline ? flaky.push(u, c) : Promise.reject(new TypeError("offline"))), presence: async () => {} };
    a.setTransport(aT);
    aOnline = false;
    server.sessions = [b];
    for (let i = 0; i < 200; i++) { type(a, 0, "a"); type(b, textOf(b).length, "b"); await vi.advanceTimersByTimeAsync(30); }
    del(b, 0, 5);
    await settle();
    aOnline = true;
    server.sessions = [a, b];
    a.online();
    await settle();
    expect(textOf(a)).toBe(server.text());
    expect(textOf(b)).toBe(server.text());
    expect(server.text()).toBe("a".repeat(200) + "b".repeat(200));
  });

  it("an update that builds on something missing makes the session pull", async () => {
    const server = new Server("x");
    const a = await LiveDoc.open("p1", { transport: server.transport(), store: memoryStore(), loro });
    const other = new LoroDoc();
    other.import(server.doc.export({ mode: "snapshot" }));
    other.getText("t").insert(1, "1"); other.commit();
    const v1 = other.oplogVersion();
    other.getText("t").insert(2, "2"); other.commit();
    server.doc.import(other.export({ mode: "snapshot" }));
    a.receive(other.export({ mode: "update", from: v1 }), "someone");
    await settle();
    expect(textOf(a)).toBe("x12");
  });

  it("presence is relayed both ways", async () => {
    const server = new Server("x");
    const sent: Uint8Array[] = [];
    const t = { ...server.transport(), presence: async (s: Uint8Array) => { sent.push(s); } };
    const local: ((b: Uint8Array) => void)[] = [];
    const got: Uint8Array[] = [];
    const ephemeral = { subscribeLocalUpdates: (f: (b: Uint8Array) => void) => { local.push(f); return () => {}; }, apply: (b: Uint8Array) => { got.push(b); } };
    const a = await LiveDoc.open("p1", { transport: t, store: memoryStore(), loro, ephemeral });
    local[0](new Uint8Array([1])); local[0](new Uint8Array([2]));
    await settle();
    expect(sent.length).toBe(1);
    expect([...sent[0]]).toEqual([2]);
    a.receivePresence(new Uint8Array([9]));
    expect([...got[0]]).toEqual([9]);
  });
});
