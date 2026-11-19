// SPDX-License-Identifier: Apache-2.0
//! [Live documents](https://docs.addaui.com/nuah/specs/live-documents/) ([ADR 0093]): a rich text kept as a Loro CRDT, in the layout the
//! browser's `loro-prosemirror` 0.4 binding writes, so the server reads and writes the same document the editor holds.
//!
//! The layout: a root map `doc` whose node maps hold `nodeName` (a string), `attributes` (a map) and `children` (a list). Each run of
//! adjacent text nodes is one Loro text in `children`; a mark is a text style keyed by the mark's name whose value is the mark's attributes.
//!
//! [ADR 0093]: https://docs.addaui.com/nuah/adr/0093-page-bodies-are-live-documents-on-loro-in-the-browser-and-on-the-server-edits-travel-as-operations-and-pulse-presence-as-signals-versions-are-points-in-the-history/

mod diff;
mod json;
pub mod store;

pub use diff::write_json;
pub use json::to_json;
pub use loro;
pub use store::{LiveStore, Written};


use loro::{ExpandType, LoroDoc, StyleConfig, StyleConfigMap};
use std::collections::BTreeMap;

pub(crate) const ROOT: &str = "doc";
pub(crate) const NODE_NAME: &str = "nodeName";
pub(crate) const ATTRIBUTES: &str = "attributes";
pub(crate) const CHILDREN: &str = "children";

/// Whether text typed at the edge of a mark takes the mark (ProseMirror's `inclusive`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expand {
    After,
    None,
}

/// How each mark grows when text is typed at its edge. A mark that is not named grows after (ProseMirror's default).
#[derive(Debug, Clone, Default)]
pub struct TextStyles(pub BTreeMap<String, Expand>);

impl<const N: usize> From<[(&str, Expand); N]> for TextStyles {
    fn from(v: [(&str, Expand); N]) -> Self {
        TextStyles(v.into_iter().map(|(k, e)| (k.to_string(), e)).collect())
    }
}

/// An empty Live document with these text styles.
pub fn new_doc(styles: &TextStyles) -> LoroDoc {
    let d = LoroDoc::new();
    configure(&d, styles);
    d
}

pub(crate) fn configure(d: &LoroDoc, styles: &TextStyles) {
    let mut m = StyleConfigMap::new();
    for (k, e) in &styles.0 {
        m.insert(k.as_str().into(), StyleConfig { expand: if *e == Expand::None { ExpandType::None } else { ExpandType::After } });
    }
    d.config_text_style(m);
    d.config_default_text_style(Some(StyleConfig { expand: ExpandType::After }));
}

/// Base64 (standard alphabet), as updates and versions travel in operations.
pub fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The bytes of a base64 field, or an `invalid` error naming it.
pub fn unb64(field: &str, s: &str) -> nuah_kernel::Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| nuah_kernel::Error::invalid(field, "is not base64"))
}
