// SPDX-License-Identifier: Apache-2.0
/** The few words the host itself shows, in the app's two languages. */
const M = {
  en: {
    needs: "Needs {plugin}", enable: "Enable", ask: "Ask an admin", unknown: "This element needs a plugin to be viewed", viewRaw: "View raw data",
    rawTitle: "Raw data", failed: "Could not load {plugin}", newer: "This element is newer than its plugin ({plugin})", loading: "Loading {plugin}…",
    noRunner: "Running {language} needs a runner, and none is switched on.", notAllowed: "Only people who can edit this page can run it.", openWith: "Open with", turnInto: "Turn into",
  },
  ar: {
    needs: "يحتاج {plugin}", enable: "تفعيل", ask: "اطلب من المسؤول", unknown: "يحتاج هذا العنصر إلى إضافة لعرضه", viewRaw: "عرض البيانات الخام",
    rawTitle: "البيانات الخام", failed: "تعذّر تحميل {plugin}", newer: "هذا العنصر أحدث من إضافته ({plugin})", loading: "جارٍ تحميل {plugin}…",
    noRunner: "يحتاج تشغيل {language} إلى مُشغّل، ولا يوجد مُشغّل مفعّل.", notAllowed: "يشغّله فقط من يستطيع تعديل هذه الصفحة.", openWith: "فتح باستخدام", turnInto: "تحويل إلى",
  },
} as const;
export type MsgKey = keyof typeof M.en;

/** The slash menu's groups that Nuah's own plugins use; any other group shows as the plugin wrote it. */
const GROUPS: Record<string, Record<string, string>> = {
  en: { text: "Text", list: "Lists", layout: "Layout", media: "Media", embed: "Embeds", reference: "Links", code: "Code" },
  ar: { text: "نص", list: "قوائم", layout: "تخطيط", media: "وسائط", embed: "تضمين", reference: "روابط", code: "شيفرة" },
};
export const groupLabel = (lang: string, g: string) => GROUPS[lang]?.[g] ?? GROUPS.en![g] ?? g;
export function msg(lang: string, key: MsgKey, vars: Record<string, string> = {}): string {
  const t: string = (M as Record<string, Record<MsgKey, string>>)[lang]?.[key] ?? M.en[key];
  return t.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
