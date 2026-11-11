import { NuahError, type ErrorBody } from "./errors";
import type { Describe, OperationTypes } from "./types";

/** What any operation map must satisfy: every key has input, output and kind (the generated `Ops` interface does). */
export type OpsOf<Ops> = { [K in keyof Ops]: OperationTypes };

export interface LinkOptions {
  /** Where the Core is. Empty means the page's own origin (the Face is served by the Core). */
  baseUrl?: string;
  /** The Face's name, sent as `X-Nuah-Face`. It must match what the Face declares. */
  face: string;
  /** The contract hash this Face was built for, sent as `X-Nuah-Contract`. */
  contract?: () => string | undefined;
  fetch?: typeof fetch;
  /** Retries after a network failure; each retry reuses the idempotency key. */
  retries?: number;
  /** Per call, in milliseconds. 0 means none. */
  timeoutMs?: number;
  onUnauthenticated?: () => void;
  onIncompatible?: () => void;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** A Command's key. Make it before the first attempt and keep it (a retry must reuse it); one is made if absent. */
  idempotencyKey?: string;
  /** Called with 0 to 1 while the request body is sent (uploads). Uses XMLHttpRequest, because `fetch` cannot report this. */
  onProgress?: (fraction: number) => void;
  /** Extra headers, for example `X-Nuah-Session: cookie` on sign-in. */
  headers?: Record<string, string>;
}

export type PulseState = "connecting" | "live" | "down" | "closed";

export interface PulseHandlers {
  onEvent: (kind: string, data: unknown) => void;
  onState?: (state: PulseState) => void;
  /** The Core lost its place for this watcher: reload what you show. */
  onReset?: () => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

/** A fresh idempotency key. `crypto.randomUUID` exists only in secure contexts (https, localhost); a Core on a plain-http address still needs keys. */
export const newKey = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** The Link over HTTP: `call`, `describe` and `watch` (Pulse). Typed by the operation map the generator writes. */
export class Link<Ops extends OpsOf<Ops> = Record<string, OperationTypes>> {
  readonly #o: Required<Pick<LinkOptions, "baseUrl" | "face" | "retries" | "timeoutMs">> & LinkOptions;
  #desc: Describe | null = null;

  constructor(options: LinkOptions) {
    this.#o = { baseUrl: "", retries: 2, timeoutMs: 60_000, ...options };
  }

  get description(): Describe | null { return this.#desc; }

  /** Whether the Core offers an operation to this person (a Face shows no control for one it may not use). */
  has(op: string): boolean {
    const d = this.#desc?.operations[op];
    return !!d && d.allowed !== false;
  }

  #headers(command: boolean, key: string | undefined, extra?: Record<string, string>): Headers {
    const h = new Headers({ "Content-Type": "application/json", "X-Nuah-Face": this.#o.face });
    const hash = this.#o.contract?.() ?? this.#desc?.contract;
    if (hash) h.set("X-Nuah-Contract", hash);
    if (command && key) h.set("Idempotency-Key", key);
    for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
    return h;
  }

  async describe(): Promise<Describe> {
    const f = this.#o.fetch ?? fetch;
    const res = await f(`${this.#o.baseUrl}/link/describe`, { credentials: "same-origin", headers: { "X-Nuah-Face": this.#o.face } });
    if (!res.ok) throw new NuahError({ category: "internal", message: "describe failed" }, res.status);
    this.#desc = (await res.json()) as Describe;
    return this.#desc;
  }

  async call<K extends keyof Ops & string>(op: K, input?: Ops[K]["input"], options: CallOptions = {}): Promise<Ops[K]["output"]> {
    const command = (this.#desc?.operations[op]?.kind ?? "command") === "command";
    const key = command ? options.idempotencyKey ?? newKey() : undefined;
    const body = JSON.stringify(input ?? {});
    const url = `${this.#o.baseUrl}/link/call/${op}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const reply = options.onProgress ? await this.#xhr(url, body, key, options) : await this.#fetch(url, body, command, key, options);
        return this.#unwrap(reply.status, reply.body);
      } catch (e) {
        if (options.signal?.aborted) throw e;
        const network = !(e instanceof NuahError);
        if (network && attempt < this.#o.retries) { await sleep(400 * (attempt + 1), options.signal); continue; }
        if (network) throw new NuahError({ category: "unavailable", message: "The server cannot be reached." });
        throw e;
      }
    }
  }

  async #fetch(url: string, body: string, command: boolean, key: string | undefined, o: CallOptions) {
    const f = this.#o.fetch ?? fetch;
    const signals = [o.signal, this.#o.timeoutMs ? AbortSignal.timeout(this.#o.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
    const res = await f(url, { method: "POST", headers: this.#headers(command, key, o.headers), credentials: "same-origin", body, signal: signals.length ? AbortSignal.any(signals) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  #xhr(url: string, body: string, key: string | undefined, o: CallOptions): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("POST", url);
      x.withCredentials = true;
      this.#headers(true, key, o.headers).forEach((v, k) => x.setRequestHeader(k, v));
      x.upload.onprogress = (e) => { if (e.lengthComputable) o.onProgress?.(e.loaded / e.total); };
      x.onerror = x.ontimeout = () => reject(new TypeError("network"));
      o.signal?.addEventListener("abort", () => { x.abort(); reject(o.signal?.reason); }, { once: true });
      x.onload = () => { let b: unknown = null; try { b = JSON.parse(x.responseText); } catch { /* not json */ } resolve({ status: x.status, body: b }); };
      x.send(body);
    });
  }

  #unwrap(status: number, body: unknown): never | Ops[keyof Ops]["output"] {
    const b = body as { ok?: boolean; output?: unknown; error?: ErrorBody } | null;
    if (b?.ok) return b.output as Ops[keyof Ops]["output"];
    const err = new NuahError(b?.error ?? { category: "internal", message: "Unreadable answer" }, status);
    if (err.category === "unauthenticated") this.#o.onUnauthenticated?.();
    if (err.category === "incompatible" || status === 426) this.#o.onIncompatible?.();
    throw err;
  }

  /** Watches Pulse. Returns a function that stops it. The browser reconnects by itself after a drop. */
  watch(handlers: PulseHandlers): () => void {
    const es = new EventSource(`${this.#o.baseUrl}/pulse`, { withCredentials: true });
    handlers.onState?.("connecting");
    es.addEventListener("ready", () => handlers.onState?.("live"));
    es.addEventListener("reset", () => handlers.onReset?.());
    es.addEventListener("closed", () => { handlers.onState?.("closed"); es.close(); });
    es.onerror = () => handlers.onState?.(es.readyState === EventSource.CLOSED ? "closed" : "down");
    for (const kind of Object.keys(this.#desc?.events ?? {})) {
      es.addEventListener(kind, (ev) => {
        handlers.onState?.("live");
        try { handlers.onEvent(kind, JSON.parse((ev as MessageEvent<string>).data)); } catch { /* a malformed event is ignored */ }
      });
    }
    return () => es.close();
  }
}
