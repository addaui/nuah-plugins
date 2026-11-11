import { describe, expect, it, vi } from "vitest";
import { Link, NuahError } from "../src";

type Ops = { "tasks.update": { input: { id: string }; output: { id: string }; kind: "command" }; "tasks.list": { input: object; output: { tasks: unknown[] }; kind: "query" } };

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function link(fetchImpl: typeof fetch, extra: object = {}) {
  return new Link<Ops>({ face: "web-react", fetch: fetchImpl, retries: 2, timeoutMs: 0, ...extra });
}

describe("keys", () => {
  it("makes a v4 key even where crypto.randomUUID does not exist (plain http)", async () => {
    const { newKey } = await import("../src");
    const real = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try { expect(newKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); }
    finally { Object.defineProperty(crypto, "randomUUID", { value: real, configurable: true }); }
  });
});

describe("Link.call", () => {
  it("sends the Face, the contract and a key for a Command, and returns the output", async () => {
    const f = vi.fn(async () => reply({ ok: true, output: { id: "t1" } }));
    const l = link(f as unknown as typeof fetch, { contract: () => "abc" });
    expect(await l.call("tasks.update", { id: "t1" })).toEqual({ id: "t1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const h = init.headers as Headers;
    expect(url).toBe("/link/call/tasks.update");
    expect(h.get("X-Nuah-Face")).toBe("web-react");
    expect(h.get("X-Nuah-Contract")).toBe("abc");
    expect(h.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("retries after a network failure with the same key", async () => {
    const keys: (string | null)[] = [];
    let n = 0;
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      keys.push((init.headers as Headers).get("Idempotency-Key"));
      if (++n < 3) throw new TypeError("network");
      return reply({ ok: true, output: { id: "t1" } });
    });
    vi.useFakeTimers();
    const p = link(f as unknown as typeof fetch).call("tasks.update", { id: "t1" });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ id: "t1" });
    vi.useRealTimers();
    expect(new Set(keys).size).toBe(1);
    expect(keys).toHaveLength(3);
  });

  it("uses the key the caller made, so a retry of the whole mutation reuses it", async () => {
    const f = vi.fn(async () => reply({ ok: true, output: { id: "t1" } }));
    await link(f as unknown as typeof fetch).call("tasks.update", { id: "t1" }, { idempotencyKey: "k-1" });
    expect(((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers).get("Idempotency-Key")).toBe("k-1");
  });

  it("maps the error envelope and reports unauthenticated and incompatible", async () => {
    const unauth = vi.fn(), incompat = vi.fn();
    const l = link((async () => reply({ ok: false, error: { category: "unauthenticated", message: "Sign in" } }, 401)) as unknown as typeof fetch, { onUnauthenticated: unauth });
    await expect(l.call("tasks.list", {})).rejects.toMatchObject({ name: "NuahError", category: "unauthenticated", status: 401 });
    expect(unauth).toHaveBeenCalledOnce();
    const m = link((async () => reply({ ok: false, error: { category: "incompatible", message: "Reload" } }, 426)) as unknown as typeof fetch, { onIncompatible: incompat });
    await expect(m.call("tasks.list", {})).rejects.toBeInstanceOf(NuahError);
    expect(incompat).toHaveBeenCalledOnce();
  });

  it("gives up with an unavailable error after the retries", async () => {
    vi.useFakeTimers();
    const p = link((async () => { throw new TypeError("network"); }) as unknown as typeof fetch).call("tasks.list", {});
    const check = expect(p).rejects.toMatchObject({ category: "unavailable" });
    await vi.runAllTimersAsync();
    await check;
    vi.useRealTimers();
  });

  it("does not retry when the caller aborted", async () => {
    const c = new AbortController();
    const f = vi.fn(async () => { c.abort(); throw new DOMException("aborted", "AbortError"); });
    await expect(link(f as unknown as typeof fetch).call("tasks.list", {}, { signal: c.signal })).rejects.toBeDefined();
    expect(f).toHaveBeenCalledTimes(1);
  });
});
