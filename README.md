# Zotero Plugin Atlas

A reviewed, trust-first web catalog of Zotero plugins. For every released version of every plugin:
what it does, what it needs from you, and what it does with your data, with the evidence one
click away.

Live at [zoteroplugins.org](https://zoteroplugins.org). How plugins are checked and graded:
[docs/methodology.md](docs/methodology.md).

## Layout

```
schema/     zod schemas + generated JSON Schema (schema/json/) shared by pipeline and site
pipeline/   the `atlas` CLI: ingest → fetch → analyze → provenance → enrich → score → build-data
site/       Astro + Tailwind static site
data/
  plugins/     <slug>.yaml: curated, human-edited listing and review data
  generated/   <slug>/plugin.json and <slug>/<version>.json: machine output, committed for audit
docs/       methodology: how plugins are checked and graded
```

`.cache/` (git-ignored) holds downloaded `.xpi` files, API responses and READMEs, content-addressed
by SHA-256.

## Development

Requires Node ≥ 22.12 (CI uses 24) and pnpm 10.

```sh
pnpm install
cp .env.example .env        # add GITHUB_TOKEN (read-only); ANTHROPIC_API_KEY only for enrichment

pnpm atlas --help           # pipeline CLI
pnpm atlas census           # find every Zotero plugin on GitHub (no LLM)
pnpm atlas profile          # profile + scorecard for every listed plugin (no LLM)
pnpm atlas profile -p zotero-pdf-translate   # one plugin
pnpm atlas regress          # before changing the analyzer or rules: every label change, offline
pnpm site:dev               # local site
pnpm verify                 # lint, type check, tests, schema check, site build (same as CI)
pnpm schema:generate        # after editing schema/src/*
```

## Docs

- [docs/methodology.md](docs/methodology.md): what each check looks at and how the grade is set
- [pipeline/src/profile/score.ts](pipeline/src/profile/score.ts): the rule table, in code
- [sandbox/README.md](sandbox/README.md): the live test in a throwaway Zotero

## License

Code: [MIT](LICENSE). Data in `data/`: [CC BY 4.0](data/LICENSE).
