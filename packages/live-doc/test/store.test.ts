import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { idbStore } from "../src/index";

describe("idbStore", () => {
  it("keeps a document between opens and forgets it on remove", async () => {
    const f = new IDBFactory();
    const a = idbStore("t", f);
    await a.save("p1", { snapshot: new Uint8Array([1, 2, 3]), server: null });
    const b = idbStore("t", f);
    const got = await b.load("p1");
    expect([...got!.snapshot]).toEqual([1, 2, 3]);
    await b.remove("p1");
    expect(await b.load("p1")).toBeNull();
  });

  it("works in memory when there is no IndexedDB", async () => {
    const s = idbStore("t", undefined);
    await s.save("p1", { snapshot: new Uint8Array([7]), server: null });
    expect([...(await s.load("p1"))!.snapshot]).toEqual([7]);
  });
});
