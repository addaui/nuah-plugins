# nuah-plugins

First-party plugins for [Nuah](https://github.com/addaui/nuah): one crate per plugin, each pinned to a tagged
Nuah release. Nuah never depends on this repository; a product adds the crates it wants.

| Crate | Plugin | What it is |
|---|---|---|
| `nuah-prefs` | `prefs` | per-person preferences; other plugins declare theirs |
| `nuah-appearance` | `appearance`, `theme-*` | token schema, personal overrides, theme presets |
| `nuah-metric-prometheus` | `metric-prometheus` | Prometheus scrape endpoint on its own port |
| `registry` | | generates `registry.json`, the index of the above |

```toml
[workspace.dependencies]
nuah-appearance = { git = "https://github.com/addaui/nuah-plugins", tag = "v0.1.0" }
```

```bash
cargo test --workspace
cargo run -p registry > registry.json
```

## License

[Apache License 2.0](LICENSE), the same as Nuah. To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## TODO

- [ ] Publish the documentation
- [ ] `nuah-ui`: the framework-free package that turns tokens into CSS and draws the customizer panel
- [ ] OTLP adapter for logs, traces, metrics and heartbeats
- [ ] Postgres database adapter
- [ ] Backup targets
- [ ] Publish the conformance suite for third-party adapters
- [ ] CI matrix against the oldest and newest supported Nuah tags
