#!/usr/bin/env python3
"""Builds assets/catalog.en.json from the `emojibase-data` npm package (MIT, Miles Johnson; derived from Unicode CLDR data).

    npm pack emojibase-data@18.0.0 && tar -xzf emojibase-data-18.0.0.tgz
    python3 tools/build-catalog.py package/en > assets/catalog.en.json

Only emoji up to Emoji 15.0 are kept: that is what the shipped Twemoji font (15.0.3) can draw, and an emoji newer than a device's own font would
show as an empty box. One entry per emoji, without skin-tone variants and without the component characters (skin-tone swatches, hair pieces) and the lone regional
letters. An item is [emoji, name, search words, group index].
"""
import json, sys

src = sys.argv[1]
data = json.load(open(f"{src}/data.json"))
msgs = json.load(open(f"{src}/messages.json"))
skip_groups = {g["order"] for g in msgs["groups"] if g["key"] == "component"}
groups = [g for g in sorted(msgs["groups"], key=lambda g: g["order"]) if g["order"] not in skip_groups]
index = {g["order"]: i for i, g in enumerate(groups)}
items = []
MAX_VERSION = 15.0
for e in sorted((e for e in data if e.get("group") is not None and e["group"] not in skip_groups and e.get("version", 0) <= MAX_VERSION), key=lambda e: e.get("order", 1 << 30)):
    items.append([e["emoji"], e["label"], " ".join(e.get("tags", [])), index[e["group"]]])
out = {"lang": "en", "groups": [{"key": g["key"], "name": g["message"]} for g in groups], "items": items}
print(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
