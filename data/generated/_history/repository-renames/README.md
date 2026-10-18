# Repository rename snapshots

These profiles are preserved exactly as previously generated. They describe earlier observations,
not separate current plugins. Keeping them outside `data/generated/*/profile.json` prevents the
site and the profile index from treating a renamed repository as additional plugins.

`Noahxie83/zotero-local-mdx-click` and `Noahxie83/zotero-local-dictionary` both resolve through
GitHub to `Noahxie83/zotero-lexibridge` (repository ID `1397312412`). The current census already
lists that canonical repository. The two retired slugs now resolve to `zotero-lexibridge` in
`data/slugs.json`, and the site's old page, comparison JSON, badge and developer URLs redirect
to their canonical equivalents.

The per-release analysis JSON files stay under their original `data/generated/<slug>/`
directories, and the dated census history is unchanged. Their old manifest URLs, asset names
and code excerpts are historical evidence and must not be replaced with newer values.
