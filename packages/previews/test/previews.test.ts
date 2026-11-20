import { describe, expect, it } from "vitest";
import { runElementCompliance, openPage, BASIC, tick } from "@nuah/editor/testing";
import previews from "../src/index";
import { KINDS } from "../src/decl";

const P = { plugin: "@nuah/previews", module: { default: previews }, kinds: KINDS };
const card = (attrs: Record<string, unknown>) => ({ type: "linkPreview", attrs: { url: "https://example.com/a", title: "Example", description: "", site: "example.com", image: "", icon: "", mode: "card", ...attrs } });
runElementCompliance({ ...P, samples: { "@nuah/previews/link-card": { node: card({}) }, "@nuah/previews/youtube": { node: { type: "youtube", attrs: { src: "https://youtu.be/dQw4w9WgXcQ", start: 30 } } } } }, { describe, it, expect });

describe("link cards and videos", () => {
  it("a_card_refuses_an_unsafe_address_and_draws_pictures_only_from_files", async () => {
    const m = await openPage([BASIC, P]);
    m.handle.insert(card({ url: "javascript:alert(1)", image: "https://site.example/p.png", icon: "/files/i1" }));
    await tick();
    const a = m.place.querySelector("a.link-card") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("#");
    expect([...a.querySelectorAll("img")].map((i) => i.getAttribute("src"))).not.toContain("https://site.example/p.png");
    m.handle.destroy();
  });

  it("a_video_plays_from_youtube_nocookie_only", async () => {
    const m = await openPage([BASIC, P]);
    m.handle.insert({ type: "youtube", attrs: { src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", start: 30 } });
    m.handle.insert({ type: "youtube", attrs: { src: "https://evil.example/embed" } });
    await tick();
    const srcs = [...m.place.querySelectorAll("iframe")].map((f) => f.getAttribute("src"));
    expect(srcs.sort()).toEqual(["", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30"]);
    m.handle.destroy();
  });
});

describe("a card's picture", () => {
  it("is_drawn_from_a_path_on_this_server_and_never_from_another_host", async () => {
    const m = await openPage([BASIC, P]);
    m.handle.insert(card({ image: "/stored/pic-1.png" }));
    m.handle.insert(card({ url: "https://example.com/b", image: "//tracker.example/p.png" }));
    await tick();
    const srcs = [...m.place.querySelectorAll("img.lc-img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["/stored/pic-1.png"]);
    m.handle.destroy();
  });
});
