import type { MutationKey, QueryFunctionContext, QueryKey } from "@tanstack/query-core";
import { newKey, type Link, type OpsOf } from "./link";

/** The query key of a read: the operation and its input, so the same call is one cache entry. */
export const opKey = <Ops extends OpsOf<Ops>, K extends keyof Ops & string>(op: K, input?: Ops[K]["input"]): QueryKey => [op, input ?? {}];

/** Options for TanStack Query: a Query operation, keyed by what it is asked. The signal cancels it when it is no longer wanted. */
export function opQuery<Ops extends OpsOf<Ops>, K extends keyof Ops & string>(link: Link<Ops>, op: K, input?: Ops[K]["input"]) {
  return {
    queryKey: opKey<Ops, K>(op, input),
    queryFn: ({ signal }: QueryFunctionContext): Promise<Ops[K]["output"]> => link.call(op, input, { signal }),
  };
}

/** The variables of a Command's mutation. The idempotency key is made here, before the first attempt, so a retry reuses it. */
export interface CommandVariables<I> {
  input: I;
  key: string;
}
export const command = <I>(input: I): CommandVariables<I> => ({ input, key: newKey() });

/** Options for a mutation that calls a Command. Use with `command(input)` as the variables. */
export function opMutation<Ops extends OpsOf<Ops>, K extends keyof Ops & string>(link: Link<Ops>, op: K) {
  return {
    mutationKey: [op] as MutationKey,
    mutationFn: ({ input, key }: CommandVariables<Ops[K]["input"]>): Promise<Ops[K]["output"]> => link.call(op, input, { idempotencyKey: key }),
  };
}
