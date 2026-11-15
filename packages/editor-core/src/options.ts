/** An option of a block (ADR 0073): a named, typed, labelled attribute with a default; `inherit` lets a page set it for every element of the type. */
export interface OptionDecl {
  id: string; type: "choice" | "toggle" | "number" | "text" | "color"; label: { en: string; ar?: string }; default?: unknown;
  choices?: { value: string | number; label: { en: string; ar?: string } }[]; min?: number; max?: number; step?: number; unit?: string; attr?: string; inherit?: boolean;
}
export type Source = "element" | "page" | "default";
export type PageDefaults = Record<string, Record<string, string | number | boolean>>;
const unset = (v: unknown) => v === undefined || v === null;

/** The value an element shows and where it comes from: its own attribute, else the page's default for the type, else the declared default. */
export function resolveOption(o: OptionDecl, node: string, attrs: Record<string, unknown>, page?: PageDefaults): { value: unknown; source: Source } {
  const own = attrs[o.attr ?? o.id];
  if (o.inherit ? !unset(own) : !unset(own) && own !== "" && own !== o.default) return { value: own, source: "element" };
  const fromPage = o.inherit ? page?.[node]?.[o.id] : undefined;
  if (!unset(fromPage)) return { value: fromPage, source: "page" };
  return { value: !unset(own) ? own : o.default, source: "default" };
}
