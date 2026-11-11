/** The Link's error envelope (`specs/errors.md`): what kind of failure, why in the plugin's words, which message key, with parameters. */
export type ErrorCategory =
  | "invalid" | "unauthenticated" | "forbidden" | "not_found" | "conflict" | "incompatible" | "rate_limited" | "unavailable" | "internal"
  | (string & {});

export interface ErrorBody {
  category: ErrorCategory;
  message: string;
  reason?: string | null;
  key?: string | null;
  params?: Record<string, unknown> | null;
}

/** A refused or failed call. `retryable` says whether trying again with the same input can help. */
export class NuahError extends Error {
  readonly category: ErrorCategory;
  readonly reason: string | null;
  readonly key: string | null;
  readonly params: Record<string, unknown> | null;
  readonly status: number;

  constructor(body: ErrorBody, status = 0) {
    super(body.message);
    this.name = "NuahError";
    this.category = body.category;
    this.reason = body.reason ?? null;
    this.key = body.key ?? null;
    this.params = body.params ?? null;
    this.status = status;
  }

  get retryable(): boolean {
    return this.category === "unavailable" || this.category === "rate_limited" || this.status === 0;
  }
}
