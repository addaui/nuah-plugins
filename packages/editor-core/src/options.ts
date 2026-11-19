/** An option of a block (ADR 0073): a named, typed, labelled attribute with a default; `inherit` lets a page set it for every element of the type. */
export interface OptionDecl {
  id: string; type: "choice" | "toggle" | "number" | "text" | "color"; label: { en: string; ar?: string }; default?: unknown;
  choices?: { value: string | number; label: { en: string; ar?: string } }[]; min?: number; max?: number; step?: number; unit?: string; attr?: string; inherit?: boolean;
  /** Shown in the Element tab itself; the others are buttons that open a popover (ADR 0094). */
  pinned?: boolean;
}
export type Source = "element" | "page" | "person" | "admin" | "default";
export type PageDefaults = Record<string, Record<string, string | number | boolean>>;
const unset = (v: unknown) => v === undefined || v === null;

/** Defaults beyond the page's: the person's (their preferences) and the admin's (a setting), by element type, like the page's. */
export interface MoreDefaults { person?: PageDefaults; admin?: PageDefaults }

/**
 * The value an element shows and where it comes from: its own attribute, else the page's default for the type, else the person's,
 * else the admin's, else the declared default (ADR 0073, extended by ADR 0094). Only an option that `inherit`s takes defaults.
 */
export function resolveOption(o: OptionDecl, node: string, attrs: Record<string, unknown>, page?: PageDefaults, more?: MoreDefaults): { value: unknown; source: Source } {
  const own = attrs[o.attr ?? o.id];
  if (o.inherit ? !unset(own) : !unset(own) && own !== "" && own !== o.default) return { value: own, source: "element" };
  if (o.inherit) {
    for (const [layer, source] of [[page, "page"], [more?.person, "person"], [more?.admin, "admin"]] as const) {
      const v = layer?.[node]?.[o.id];
      if (!unset(v)) return { value: v, source };
    }
  }
  return { value: !unset(own) ? own : o.default, source: "default" };
}
