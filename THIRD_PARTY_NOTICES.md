# Third-party notices

The plugins in this repository are under the [Apache License 2.0](LICENSE). `nuah-emoji` ships the following material, which keeps its own license. Credit goes to the people who made it, whether or not the license asks for it.

## Emoji font (`crates/nuah-emoji/assets/twemoji.woff2`)

| What | Who | License |
|---|---|---|
| The **Twemoji** artwork | Twitter, Inc. and other contributors; the artwork since version 14 is maintained by the community at https://github.com/jdecked/twemoji | Graphics: CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Credit: "Twemoji, © Twitter, Inc. and other contributors, licensed CC-BY 4.0". |
| The **COLR/CPAL font build** of Twemoji (`twemoji.woff2`, from the npm package `twemoji-colr-font` 15.0.3) | Tilman Vatteroth (https://github.com/mrdrogdrog/twemoji-color-font), made with the `twemoji-colr` tooling from Mozilla (https://github.com/mozilla/twemoji-colr) | SIL Open Font License 1.1. The license text is in `crates/nuah-emoji/assets/LICENSE-twemoji-colr-font.txt`. |

The font file is unchanged. It is served to a person only when they choose the "Twemoji" emoji set.

## Emoji names and search words (`crates/nuah-emoji/assets/catalog.en.json`)

Built by `crates/nuah-emoji/tools/build-catalog.py` from the npm package `emojibase-data` 18.0.0.

| What | Who | License |
|---|---|---|
| **Emojibase** data | Miles Johnson (https://github.com/milesj/emojibase) | MIT. The license text is in `crates/nuah-emoji/assets/LICENSE-emojibase.txt`. |
| The Unicode emoji data and CLDR annotations that Emojibase is built from | Unicode, Inc. (https://www.unicode.org/license.txt) | Unicode License v3 |
