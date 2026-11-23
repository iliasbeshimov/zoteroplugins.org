# Zotero Plugins check

Run it on the `.xpi` you just built, and see what [zoteroplugins.org](https://zoteroplugins.org)'s
code checks will say about it before you release it: where its code sends data, what it can do on a
user's computer, and the grade those findings earn.

It is the catalogue's own analyzer and grading rules, run on your file. Nothing about your plugin is
sent anywhere: it reads the file on the machine it runs on and writes a Markdown report.

## In GitHub Actions

Build the plugin, then add the check:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci && npm run build   # whatever produces your .xpi
      - uses: iliasbeshimov/zoteroplugins.org@check-v1
        with:
          fail-on: C                   # optional: fail the job on a C
```

The report appears on the run's summary page.

| Input | Default | |
|---|---|---|
| `xpi` | `**/*.xpi` | The built file or files, as paths or globs, one per line. `node_modules` is skipped. |
| `fail-on` | `none` | `B` fails on a B or a C, `C` fails on a C. |
| `repo` | the workflow's repository | `owner/name`. Tells your own servers apart from third parties, and finds our reviews of your plugin if it is listed. |

The step's `grade` output is the worst grade among the files.

## On your computer

```sh
npx github:iliasbeshimov/zoteroplugins.org#check-v1 path/to/plugin.xpi
npx github:iliasbeshimov/zoteroplugins.org#check-v1 --repo you/your-plugin --fail-on B build/*.xpi
```

It needs Node 22.12 or later. The report goes to the terminal, or to `$GITHUB_STEP_SUMMARY` when
that is set. The exit code is 0 unless `--fail-on` trips (1) or the file couldn't be read (2).

## What it tells you, and what it can't

The grade is what the **code alone** earns, so it stops at A. An A+ also needs our live test in
Zotero, which CI can't run. The report lists what it did not check: who uploads your release file,
what your update address serves, the live test, and the hand reviews of a build whose code changed.
The published grade can differ for those reasons.

A grade of "–" means the code couldn't be graded yet (network code we couldn't trace, or too little
readable code); it never fails `fail-on`.

## Keeping it current

The hosts table, library index and hand reviews change nightly, and a tag doesn't. The tag
`check-v1` is rebuilt from the catalogue's data and moved forward regularly, and the report prints
the date its tables are from (and warns when they are more than 45 days old). Pin to a commit
instead of the tag if you want results that never change between runs.

## Source

The check is `pipeline/src/check/` in
[iliasbeshimov/zoteroplugins.org](https://github.com/iliasbeshimov/zoteroplugins.org), built on the
same analyzer and rules as the catalogue. Questions, wrong findings and ideas go to that repository's
issues.
