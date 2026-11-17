#!/usr/bin/env python3
"""Builds crates/nuah-fonts/catalogue.json (ADR 0090): the short, curated list of the most used fonts, Latin and Arabic.

Sources: the Fontsource API (metadata, per-subset unicode ranges, files on jsDelivr) for Google Fonts, and the Fontshare API for
Satoshi. OpenType features are read from the font's own GSUB/GPOS tables (a .ttf of the family), so the picker shows what the file
really has. Nothing here is fetched at run time: run it at release, review the diff, commit the result.

    python3 tools/fonts/generate.py            # writes crates/nuah-fonts/catalogue.json
"""
import json, struct, sys, urllib.request, urllib.error, pathlib

OUT = pathlib.Path(__file__).resolve().parents[2] / "crates/nuah-fonts/catalogue.json"
FS = "https://api.fontsource.org/v1"
JSD = "https://cdn.jsdelivr.net/fontsource/fonts"

# id, rank (1 = most used). Order inside a script is the popularity order of Google Fonts, then the owner's review.
LATIN = ["inter", "roboto", "open-sans", "lato", "montserrat", "poppins", "source-sans-3", "nunito", "dm-sans", "manrope", "plus-jakarta-sans", "work-sans",
         "space-grotesk", "lexend", "ibm-plex-sans", "playfair-display", "merriweather", "lora", "fraunces", "eb-garamond", "source-serif-4",
         "jetbrains-mono", "ibm-plex-mono", "fira-code", "caveat"]
ARABIC = ["readex-pro", "noto-sans-arabic", "cairo", "tajawal", "almarai", "ibm-plex-sans-arabic", "noto-kufi-arabic", "vazirmatn", "mada", "changa",
          "el-messiri", "noto-naskh-arabic", "amiri", "scheherazade-new", "markazi-text", "lateef", "aref-ruqaa", "reem-kufi", "lalezar", "harmattan"]
UI = {"readex-pro": "ar"}  # the interface font of a language

CATEGORY = {"sans-serif": "sans", "serif": "serif", "monospace": "mono", "display": "display", "handwriting": "handwriting"}
# the features a person may sensibly switch for a page, and what to call them
FEATURES = {
    "liga": "Ligatures", "dlig": "Discretionary ligatures", "calt": "Contextual alternates", "clig": "Contextual ligatures", "onum": "Old-style numerals", "lnum": "Lining numerals",
    "pnum": "Proportional numerals", "tnum": "Tabular numerals", "smcp": "Small capitals", "c2sc": "Capitals to small capitals", "frac": "Fractions", "zero": "Slashed zero", "case": "Case-sensitive forms",
    "sups": "Superscript", "subs": "Subscript", "ordn": "Ordinals", "swsh": "Swashes", "salt": "Stylistic alternates", "hist": "Historical forms",
    **{f"ss{n:02d}": f"Stylistic set {n}" for n in range(1, 21)}, **{f"cv{n:02d}": f"Character variant {n}" for n in range(1, 100)},
}
ON_BY_DEFAULT = {"liga", "calt", "clig", "kern"}

def get(url, binary=False, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "nuah-fonts-generator"}), timeout=60) as r:
                b = r.read()
                return b if binary else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
        except Exception:
            pass
    return None

def exists(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD", headers={"User-Agent": "nuah-fonts-generator"}), timeout=30) as r:
            return r.status == 200
    except Exception:
        return False

def feature_tags(ttf):
    """Feature tags of a TrueType file's GSUB and GPOS tables (a few lines of struct reading, no dependency)."""
    tags = set()
    try:
        n = struct.unpack(">H", ttf[4:6])[0]
        for i in range(n):
            tag, _, off, ln = struct.unpack(">4sIII", ttf[12 + 16 * i: 28 + 16 * i])
            if tag in (b"GSUB", b"GPOS"):
                t = ttf[off: off + ln]
                fl = struct.unpack(">H", t[6:8])[0]
                c = struct.unpack(">H", t[fl: fl + 2])[0]
                for j in range(c):
                    tags.add(t[fl + 2 + 6 * j: fl + 6 + 6 * j].decode("ascii"))
    except Exception:
        pass
    return tags

def family(fid, rank):
    d = get(f"{FS}/fonts/{fid}")
    if not d or d.get("type") != "google" and d.get("license") is None:
        print("skip", fid, file=sys.stderr); return None
    v = get(f"{FS}/variable/{fid}") or {}
    ver = d["npmVersion"]
    subsets = [s for s in d["subsets"] if s in ("latin", "latin-ext", "arabic")]
    scripts = ["arabic"] if "arabic" in subsets else ["latin"]
    if "arabic" in subsets and "latin" in subsets: scripts = ["arabic", "latin"]
    wght = (v.get("axes") or {}).get("wght")
    faces, italic = [], "italic" in d["styles"]
    for style in [s for s in d["styles"] if s in ("normal", "italic")]:
        for sub in subsets:
            rng = d["unicodeRange"].get(sub)
            if not rng: continue
            script = "arabic" if sub == "arabic" else "latin"
            if wght and exists(f"{JSD}/{fid}:vf@{ver}/{sub}-wght-{style}.woff2"):
                faces.append({"script": script, "subset": sub, "style": style, "weight": [int(float(wght["min"])), int(float(wght["max"]))], "range": rng, "url": f"{JSD}/{fid}:vf@{ver}/{sub}-wght-{style}.woff2"})
            else:
                for w in d["weights"]:
                    if w not in (400, 700): continue
                    u = ((d["variants"].get(str(w)) or {}).get(style) or {}).get(sub, {}).get("url", {}).get("woff2")
                    if u: faces.append({"script": script, "subset": sub, "style": style, "weight": [w, w], "range": rng, "url": u})
    if not faces: print("no faces", fid, file=sys.stderr); return None
    # features: from the regular .ttf of the script that matters most
    sub = "arabic" if "arabic" in subsets else "latin"
    u = ((d["variants"].get("400") or {}).get("normal") or {}).get(sub, {}).get("url", {}).get("ttf")
    tags = feature_tags(get(u, binary=True) or b"") if u else set()
    feats = sorted((t for t in tags if t in FEATURES), key=lambda t: (t[:2] in ("ss", "cv"), t))
    ws = sorted({w for f in faces for w in f["weight"]})
    return {
        "id": fid, "name": d["family"], "category": CATEGORY.get(d["category"], "sans"), "scripts": scripts, "weights": [ws[0], ws[-1]], "variable": bool(wght and faces[0]["weight"][0] != faces[0]["weight"][1]),
        "italic": italic, "features": [{"tag": t, "label": FEATURES[t], "default": t in ON_BY_DEFAULT} for t in feats],
        "licence": {"spdx": d["license"], "url": "https://openfontlicense.org/", "credit": False},
        "source": {"name": "Google Fonts", "url": f"https://fonts.google.com/specimen/{d['family'].replace(' ', '+')}"},
        "popular": rank, "rehost": True, **({"ui": UI[fid]} if fid in UI else {}), "faces": faces,
    }

def satoshi():
    d = get("https://api.fontshare.com/v2/fonts?q=satoshi")["fonts"][0]
    var = next(s for s in d["styles"] if s.get("is_variable") and not s.get("is_italic"))
    vit = next((s for s in d["styles"] if s.get("is_variable") and s.get("is_italic")), None)
    ax = next(a for a in d["axes"] if a["property"] == "wght") if d.get("axes") else {"min": 300, "max": 900}
    rng = "U+0000-00FF,U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2000-206F,U+20A0-20C0,U+2113,U+2122,U+2191,U+2193,U+2212,U+2215,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD"
    wt = [int(ax.get("min", 300)), int(ax.get("max", 900))]
    faces = [{"script": "latin", "subset": "latin", "style": "normal", "weight": wt, "range": rng, "url": "https:" + var["file"] + ".woff2"}]
    if vit: faces.append({"script": "latin", "subset": "latin", "style": "italic", "weight": wt, "range": rng, "url": "https:" + vit["file"] + ".woff2"})
    feats = [{"tag": f["tag"], "label": FEATURES.get(f["tag"], f["tag"]), "default": bool(f["on_by_default"])} for f in d["features"] if f["tag"] in FEATURES]
    return {"id": "satoshi", "name": "Satoshi", "category": "sans", "scripts": ["latin"], "weights": wt, "variable": True, "italic": bool(vit), "features": feats,
            "licence": {"spdx": "ITF-FFL", "url": "https://www.fontshare.com/licenses/itf-ffl", "credit": False},
            "source": {"name": "Fontshare, Indian Type Foundry", "url": "https://www.fontshare.com/fonts/satoshi"},
            "popular": 1, "rehost": True, "bundle": False, "ui": "en", "faces": faces}

def main():
    out = [satoshi()]
    for ids in (LATIN, ARABIC):
        for i, fid in enumerate(ids, 1):
            f = family(fid, i + (1 if ids is LATIN else 0))
            if f: out.append(f); print("ok", fid, len(f["faces"]), "faces", len(f["features"]), "features", file=sys.stderr)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"schema": "fonts/1", "families": out}, ensure_ascii=False, indent=1) + "\n")
    print(len(out), "families ->", OUT)

main()
