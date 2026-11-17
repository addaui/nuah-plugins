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

# how often each lowercase letter is used in English: a font's width is the average advance of the letters weighted by it
FREQ = {"e": 12.7, "t": 9.1, "a": 8.2, "o": 7.5, "i": 7.0, "n": 6.7, "s": 6.3, "h": 6.1, "r": 6.0, "d": 4.3, "l": 4.0, "c": 2.8, "u": 2.8, "m": 2.4, "w": 2.4,
        "f": 2.2, "g": 2.0, "y": 2.0, "p": 1.9, "b": 1.5, "v": 1.0, "k": 0.8, "j": 0.15, "x": 0.15, "q": 0.1, "z": 0.07}
# Arial's advances of those letters in a 2048-unit em, the face every fallback is matched against
ARIAL = {"a": 1139, "b": 1139, "c": 1024, "d": 1139, "e": 1139, "f": 569, "g": 1139, "h": 1139, "i": 455, "j": 455, "k": 1024, "l": 455, "m": 1706, "n": 1139, "o": 1139,
         "p": 1139, "q": 1139, "r": 682, "s": 1024, "t": 569, "u": 1139, "v": 1024, "w": 1479, "x": 1024, "y": 1024, "z": 1024}
ARIAL_UPM = 2048
def weighted(widths, upm):
    tot = sum(FREQ.values())
    return sum(FREQ[c] * widths[c] for c in FREQ) / tot / upm
TIMES = {"a": 909, "b": 1024, "c": 909, "d": 1024, "e": 909, "f": 682, "g": 1024, "h": 1024, "i": 569, "j": 569, "k": 1024, "l": 569, "m": 1593, "n": 1024, "o": 1024,
         "p": 1024, "q": 1024, "r": 682, "s": 797, "t": 569, "u": 1024, "v": 1024, "w": 1479, "x": 1024, "y": 1024, "z": 909}
BASES = {"Arial": weighted(ARIAL, ARIAL_UPM), "Times New Roman": weighted(TIMES, 2048)}

def lower_advances(ttf, tab):
    """Advance widths of a-z, read from cmap (format 4) and hmtx."""
    cm = tab[b"cmap"][0]
    n = struct.unpack(">H", ttf[cm + 2: cm + 4])[0]
    sub = None
    for i in range(n):
        plat, enc, off = struct.unpack(">HHI", ttf[cm + 4 + 8 * i: cm + 12 + 8 * i])
        if (plat, enc) in ((3, 1), (0, 3), (0, 4)) and struct.unpack(">H", ttf[cm + off: cm + off + 2])[0] == 4: sub = cm + off
    if sub is None: return None
    segx2 = struct.unpack(">H", ttf[sub + 6: sub + 8])[0]; seg = segx2 // 2
    ends = struct.unpack(f">{seg}H", ttf[sub + 14: sub + 14 + segx2])
    starts = struct.unpack(f">{seg}H", ttf[sub + 16 + segx2: sub + 16 + 2 * segx2])
    deltas = struct.unpack(f">{seg}h", ttf[sub + 16 + 2 * segx2: sub + 16 + 3 * segx2])
    ro_at = sub + 16 + 3 * segx2
    ranges = struct.unpack(f">{seg}H", ttf[ro_at: ro_at + segx2])
    def gid(cp):
        for i in range(seg):
            if starts[i] <= cp <= ends[i]:
                if ranges[i] == 0: return (cp + deltas[i]) & 0xFFFF
                g = struct.unpack(">H", ttf[ro_at + 2 * i + ranges[i] + 2 * (cp - starts[i]): ro_at + 2 * i + ranges[i] + 2 * (cp - starts[i]) + 2])[0]
                return (g + deltas[i]) & 0xFFFF if g else 0
        return 0
    h = tab[b"hhea"][0]
    nm = struct.unpack(">H", ttf[h + 34: h + 36])[0]
    hm = tab[b"hmtx"][0]
    out = {}
    for c in FREQ:
        g = gid(ord(c))
        k = min(g, nm - 1)
        out[c] = struct.unpack(">H", ttf[hm + 4 * k: hm + 4 * k + 2])[0]
    return out

def vertical_metrics(ttf, base="Arial"):
    """unitsPerEm, hhea ascender/descender/lineGap and OS/2 xAvgCharWidth of a TrueType file: what a fallback font needs to be matched to it."""
    try:
        n = struct.unpack(">H", ttf[4:6])[0]
        tab = {}
        for i in range(n):
            tag, _, off, ln = struct.unpack(">4sIII", ttf[12 + 16 * i: 28 + 16 * i])
            tab[tag] = (off, ln)
        upm = struct.unpack(">H", ttf[tab[b"head"][0] + 18: tab[b"head"][0] + 20])[0]
        h = tab[b"hhea"][0]
        asc, desc, gap = struct.unpack(">hhh", ttf[h + 4: h + 10])
        adv = lower_advances(ttf, tab)
        if not adv: return None
        # how wide this font sets English text, as a share of Arial's: the size a fallback face must take to take the same room
        return {"upm": upm, "ascent": asc, "descent": -desc, "line_gap": gap, "width_ratio": round(weighted(adv, upm) / BASES[base], 4), "fallback": base}
    except Exception:
        return None

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
    # metrics for a fallback face that takes the place while the font loads (Latin only; Arial is the fallback)
    metrics = None
    if "latin" in subsets:
        lu = ((d["variants"].get("400") or {}).get("normal") or {}).get("latin", {}).get("url", {}).get("ttf")
        cat = CATEGORY.get(d["category"], "sans")
        metrics = vertical_metrics(get(lu, binary=True) or b"", "Times New Roman" if cat == "serif" else "Arial") if lu and cat != "mono" else None
    ws = sorted({w for f in faces for w in f["weight"]})
    return {
        "id": fid, "name": d["family"], "category": CATEGORY.get(d["category"], "sans"), "scripts": scripts, "weights": [ws[0], ws[-1]], "variable": bool(wght and faces[0]["weight"][0] != faces[0]["weight"][1]),
        "italic": italic, "features": [{"tag": t, "label": FEATURES[t], "default": t in ON_BY_DEFAULT} for t in feats],
        "licence": {"spdx": d["license"], "url": "https://openfontlicense.org/", "credit": False},
        "source": {"name": "Google Fonts", "url": f"https://fonts.google.com/specimen/{d['family'].replace(' ', '+')}"},
        "popular": rank, "rehost": True, **({"ui": UI[fid]} if fid in UI else {}), **({"metrics": metrics} if metrics else {}), "faces": faces,
    }

def satoshi():
    d = get("https://api.fontshare.com/v2/fonts?q=satoshi")["fonts"][0]
    var = next(s for s in d["styles"] if s.get("is_variable") and not s.get("is_italic"))
    vit = next((s for s in d["styles"] if s.get("is_variable") and s.get("is_italic")), None)
    ax = next(a for a in d["axes"] if a["property"] == "wght") if d.get("axes") else {"min": 300, "max": 900}
    rng = "U+0000-00FF,U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2000-206F,U+20A0-20C0,U+2113,U+2122,U+2191,U+2193,U+2212,U+2215,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD"
    wt = [int(ax.get("min", 300)), int(ax.get("max", 900))]
    metrics = vertical_metrics(get("https:" + var["file"] + ".ttf", binary=True) or b"")
    faces = [{"script": "latin", "subset": "latin", "style": "normal", "weight": wt, "range": rng, "url": "https:" + var["file"] + ".woff2"}]
    if vit: faces.append({"script": "latin", "subset": "latin", "style": "italic", "weight": wt, "range": rng, "url": "https:" + vit["file"] + ".woff2"})
    feats = [{"tag": f["tag"], "label": FEATURES.get(f["tag"], f["tag"]), "default": bool(f["on_by_default"])} for f in d["features"] if f["tag"] in FEATURES]
    return {"id": "satoshi", "name": "Satoshi", "category": "sans", "scripts": ["latin"], "weights": wt, "variable": True, "italic": bool(vit), "features": feats,
            "licence": {"spdx": "ITF-FFL", "url": "https://www.fontshare.com/licenses/itf-ffl", "credit": False},
            "source": {"name": "Fontshare, Indian Type Foundry", "url": "https://www.fontshare.com/fonts/satoshi"},
            "popular": 1, "rehost": True, "bundle": False, "ui": "en", **({"metrics": metrics} if metrics else {}), "faces": faces}

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
