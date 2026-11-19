// SPDX-License-Identifier: Apache-2.0
//! Live documents kept in the owning plugin's own Collections: a snapshot per document, the updates since it (folded into a new
//! snapshot when they grow), and [Versions](https://docs.addaui.com/nuah/references/glossary/#version) as marked points in the history.
//! The owning plugin keeps its own permissions and passes its own check of the document's JSON.

use crate::{b64, configure, to_json, unb64, write_json, Expand, TextStyles};
use loro::{ExportMode, Frontiers, LoroDoc, VersionVector};
use nuah_kernel::{Category, Cmp, Cond, Doc, Error, Expect, Query, Result, Tx};
use serde_json::{json, Value};

/// Fold the updates into a new snapshot once there are this many, or once they hold this many bytes.
pub const COMPACT_COUNT: u64 = 200;
pub const COMPACT_BYTES: u64 = 256 * 1024;
/// The server writes as one Loro peer, so its own changes do not add a peer to the version per write. Writes to one document are
/// serialized by the database, and a browser's peer is random, so this never collides.
pub const SERVER_PEER: u64 = 0x6e75_6168_0000_0001;

/// Where an owning plugin keeps its Live documents, and the reason code (in its namespace) a refused update fails with.
pub struct LiveStore {
    pub bodies: &'static str,
    pub updates: &'static str,
    pub versions: &'static str,
    pub rejected: &'static str,
    pub styles: &'static [(&'static str, Expand)],
}

/// What a change did: the document's JSON afterwards, the update that others need (empty when nothing was new), and the version.
pub struct Written {
    pub json: Value,
    pub update: Vec<u8>,
    pub version: Vec<u8>,
}

/// The Collection schemas a [`LiveStore`] needs, for the owning plugin's schema file.
pub fn collections(bodies: &str, updates: &str, versions: &str) -> Value {
    json!({
        bodies: {"type": "object", "description": "A Live document's snapshot (ADR 0093)", "properties": {
            "key": {"type": "string", "index": true}, "snapshot": {"type": "string"}, "version": {"type": "string"},
            "pending": {"type": "integer"}, "size": {"type": "integer"}}, "required": ["key", "snapshot", "version"]},
        updates: {"type": "object", "description": "A Live document's updates since its snapshot", "properties": {
            "key": {"type": "string", "index": true}, "seq": {"type": "integer"}, "update": {"type": "string"},
            "by": {"type": "string"}, "at": {"type": "integer"}}, "required": ["key", "seq", "update"]},
        versions: {"type": "object", "description": "A Version: a marked point in a Live document's history", "properties": {
            "key": {"type": "string", "index": true}, "frontiers": {"type": "string"}, "at": {"type": "integer"},
            "by": {"type": "string"}, "name": {"type": ["string", "null"]}, "title": {"type": "string"}}, "required": ["key", "frontiers", "at"]}
    })
}

fn lerr(e: impl std::fmt::Display) -> Error {
    Error::internal(format!("live document: {e}"))
}

impl LiveStore {
    fn styles(&self) -> TextStyles {
        TextStyles(self.styles.iter().map(|(k, e)| (k.to_string(), *e)).collect())
    }

    fn reject(&self, why: &str) -> Error {
        Error::reason(Category::Invalid, self.rejected, &format!("The change to the document was refused: {why}"))
    }

    fn fresh(&self) -> Result<LoroDoc> {
        let d = LoroDoc::new();
        configure(&d, &self.styles());
        d.set_peer_id(SERVER_PEER).map_err(lerr)?;
        Ok(d)
    }

    fn update_rows(&self, tx: &Tx, key: &str) -> Result<Vec<Doc>> {
        Ok(tx.query(self.updates, &Query::new().eq("key", key).asc("seq").limit(10_000))?.items)
    }

    /// The document as stored: its snapshot and the updates since.
    pub fn load(&self, tx: &Tx, key: &str) -> Result<LoroDoc> {
        let d = self.fresh()?;
        let snap = tx.get(self.bodies, key)?.filter(|b| !b.deleted).ok_or_else(|| Error::not_found("document"))?;
        d.import(&unb64("snapshot", snap.body["snapshot"].as_str().unwrap_or(""))?).map_err(lerr)?;
        for u in self.update_rows(tx, key)? {
            d.import(&unb64("update", u.body["update"].as_str().unwrap_or(""))?).map_err(lerr)?;
        }
        Ok(d)
    }

    fn put_snapshot(&self, tx: &mut Tx, key: &str, d: &LoroDoc) -> Result<()> {
        let snap = d.export(ExportMode::Snapshot).map_err(lerr)?;
        tx.put(self.bodies, key, json!({"key": key, "snapshot": b64(&snap), "version": b64(&d.oplog_vv().encode()), "pending": 0, "size": 0}), Expect::Any)?;
        Ok(())
    }

    /// Keep what `d` has beyond `before`, fold into a snapshot when the log has grown, and say what changed.
    fn keep(&self, tx: &mut Tx, key: &str, d: &LoroDoc, before: &VersionVector) -> Result<Written> {
        let update = d.export(ExportMode::updates(before)).map_err(lerr)?;
        let snap = tx.get(self.bodies, key)?.ok_or_else(|| Error::not_found("document"))?;
        let (pending, size) = (snap.body["pending"].as_u64().unwrap_or(0) + 1, snap.body["size"].as_u64().unwrap_or(0) + update.len() as u64);
        if pending >= COMPACT_COUNT || size >= COMPACT_BYTES {
            for u in self.update_rows(tx, key)? {
                tx.delete(self.updates, &u.id)?;
            }
            self.put_snapshot(tx, key, d)?;
        } else {
            let seq = tx.query(self.updates, &Query::new().eq("key", key).desc("seq").limit(1))?.items.first().and_then(|u| u.body["seq"].as_u64()).unwrap_or(0) + 1;
            let (by, at) = (tx.who().subject.clone(), tx.now());
            tx.create(self.updates, json!({"key": key, "seq": seq, "update": b64(&update), "by": by, "at": at}))?;
            let mut b = snap.body.clone();
            b["pending"] = json!(pending);
            b["size"] = json!(size);
            b["version"] = json!(b64(&d.oplog_vv().encode()));
            tx.put(self.bodies, key, b, Expect::Rev(snap.rev))?;
        }
        Ok(Written { json: to_json(d), update, version: d.oplog_vv().encode() })
    }

    /// A new document holding `json`.
    pub fn create(&self, tx: &mut Tx, key: &str, json: &Value) -> Result<Written> {
        let d = self.fresh()?;
        write_json(&d, json)?;
        self.put_snapshot(tx, key, &d)?;
        let update = d.export(ExportMode::Snapshot).map_err(lerr)?;
        Ok(Written { json: to_json(&d), update, version: d.oplog_vv().encode() })
    }

    /// Take an update from a browser. Refused (with the store's reason code, nothing written) when it cannot be imported, when it
    /// depends on changes the server does not have, or when `check` refuses the resulting JSON. Pushing the same update again writes
    /// nothing and gives an empty update.
    pub fn push(&self, tx: &mut Tx, key: &str, update: &[u8], check: &dyn Fn(&Value) -> Result<()>) -> Result<Written> {
        let d = self.load(tx, key)?;
        let before = d.oplog_vv();
        let status = d.import(update).map_err(|_| self.reject("it is not a Loro update"))?;
        if status.pending.is_some() {
            return Err(self.reject("it builds on changes the server does not have; pull first"));
        }
        if d.oplog_vv() == before {
            return Ok(Written { json: to_json(&d), update: vec![], version: before.encode() });
        }
        let json = to_json(&d);
        check(&json).map_err(|e| self.reject(&e.message))?;
        self.keep(tx, key, &d, &before)
    }

    /// Make the document hold `json` as a change of its own (an API write, a ticked task block, an import). None when it already does.
    pub fn write(&self, tx: &mut Tx, key: &str, json: &Value) -> Result<Option<Written>> {
        let d = self.load(tx, key)?;
        let before = d.oplog_vv();
        write_json(&d, json)?;
        if d.oplog_vv() == before {
            return Ok(None);
        }
        self.keep(tx, key, &d, &before).map(Some)
    }

    /// What a browser at `since` lacks (everything, as a snapshot, without `since`), and the server's version.
    pub fn pull(&self, tx: &Tx, key: &str, since: Option<&[u8]>) -> Result<(Vec<u8>, Vec<u8>)> {
        let d = self.load(tx, key)?;
        let bytes = match since {
            Some(v) => {
                let vv = VersionVector::decode(v).map_err(|_| Error::invalid("since", "is not a version"))?;
                d.export(ExportMode::updates(&vv)).map_err(lerr)?
            }
            None => d.export(ExportMode::Snapshot).map_err(lerr)?,
        };
        Ok((bytes, d.oplog_vv().encode()))
    }

    /// Mark the document's present state as a Version (named or not).
    pub fn mark(&self, tx: &mut Tx, key: &str, name: Option<&str>, title: &str) -> Result<Doc> {
        let d = self.load(tx, key)?;
        let (by, at) = (tx.who().subject.clone(), tx.now());
        tx.create(self.versions, json!({"key": key, "frontiers": b64(&d.state_frontiers().encode()), "at": at, "by": by, "name": name, "title": title}))
    }

    /// The Versions of a document, newest first.
    pub fn versions(&self, tx: &Tx, key: &str, limit: usize) -> Result<Vec<Doc>> {
        Ok(tx.query(self.versions, &Query::new().eq("key", key).desc("at").limit(limit))?.items)
    }

    /// The newest Version, if any.
    pub fn latest(&self, tx: &Tx, key: &str) -> Result<Option<Doc>> {
        Ok(self.versions(tx, key, 1)?.into_iter().next())
    }

    fn version(&self, tx: &Tx, key: &str, id: &str) -> Result<Doc> {
        tx.get(self.versions, id)?.filter(|v| !v.deleted && v.body["key"] == key).ok_or_else(|| Error::not_found("version"))
    }

    /// The document as it was at a Version.
    pub fn at(&self, tx: &Tx, key: &str, version_id: &str) -> Result<Value> {
        let v = self.version(tx, key, version_id)?;
        let f = Frontiers::decode(&unb64("frontiers", v.body["frontiers"].as_str().unwrap_or(""))?).map_err(lerr)?;
        let d = self.load(tx, key)?;
        Ok(to_json(&d.fork_at(&f).map_err(lerr)?))
    }

    /// Bring a Version's content back as a new change; the history after it is kept.
    pub fn restore(&self, tx: &mut Tx, key: &str, version_id: &str) -> Result<Option<Written>> {
        let old = self.at(tx, key, version_id)?;
        self.write(tx, key, &old)
    }

    /// Forget a document, its updates and its Versions.
    pub fn remove(&self, tx: &mut Tx, key: &str) -> Result<()> {
        for u in self.update_rows(tx, key)? {
            tx.delete(self.updates, &u.id)?;
        }
        for v in self.versions(tx, key, 100_000)? {
            tx.delete(self.versions, &v.id)?;
        }
        tx.delete(self.bodies, key)?;
        Ok(())
    }

    /// How many updates wait for the next snapshot (for tests and the console).
    pub fn pending(&self, tx: &Tx, key: &str) -> Result<u64> {
        tx.count(self.updates, &[Cond { field: "key".into(), op: Cmp::Eq, value: json!(key) }])
    }
}
