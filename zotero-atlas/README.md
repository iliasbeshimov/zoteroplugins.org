<p align="center"><img src="src/icon.svg" width="96" height="96" alt=""></p>

# Zotero Atlas

[![Zotero Plugins grade](https://zoteroplugins.org/badge/zotero-atlas.svg)](https://zoteroplugins.org/p/zotero-atlas)
[![Release](https://img.shields.io/github/v/release/iliasbeshimov/zotero-atlas?label=release&color=2f6fdb)](https://github.com/iliasbeshimov/zotero-atlas/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/iliasbeshimov/zotero-atlas/total?label=downloads&color=3a9e4a)](https://github.com/iliasbeshimov/zotero-atlas/releases)
[![Works with Zotero 7 to 11](https://img.shields.io/badge/Zotero-7%20to%2011-cc2936)](https://www.zotero.org/download/)
[![Reproducible build, attested](https://img.shields.io/badge/build-reproducible%2C%20attested-5b3fc4)](#check-what-you-install)
[![MIT](https://img.shields.io/github/license/iliasbeshimov/zotero-atlas?color=777)](LICENSE)

A Zotero plugin that finds and installs plugins from [zoteroplugins.org](https://zoteroplugins.org)
inside Zotero, and keeps an eye on the ones you have. Home: [zoteroatlas.com](https://zoteroatlas.com).

## What it does

- **Find.** Tools → Zotero Atlas lists every plugin in the directory, filtered to your Zotero
  version by default, with each plugin's grade and the one line that explains it. Search, or
  pick a job (reading, citing, AI, translation, organising, metadata, interface, files).
- **Install the file we checked.** Install hands the release file to Zotero's own installer with
  the SHA-256 of the file we analysed. Zotero refuses the file if it doesn't match, so what you
  get is exactly what the card describes. A file we haven't analysed can't be installed from here.
- **Watch what you have.** Once a day it compares your installed plugins with the directory and
  tells you when one drops a grade, when the update Zotero would apply is graded worse than what
  you have, when Zotero's blocklist blocks it, or when Zotero has disabled it because it doesn't
  work with your version. Where a version that works, or a cleaner one, is listed, it offers it.
  "Your plugins" shows all of this in one place.
- **Rate what you use.** Stars, and a review if you want to write one, for any plugin you have or
  removed in the last 30 days. No account. Ratings show next to each plugin's grade, but never
  change it: the grade is what the code does, the rating is what people who use it say.

Every grade comes from the directory's published checks: see
[how plugins are graded](https://zoteroplugins.org/how-we-grade). The plugin itself is listed and
graded there like any other.

## What it sends, and what it never sends

**It never sends your library, notes, files, Zotero account, email or anything that identifies
you.**

The first time it runs it asks one question, with **Send my plugin list** as the default answer
and **Don't send** one click away. With **Send my plugin list**, it sends one thing: the list of
plugins installed in this Zotero, with
their versions and whether each is enabled, under a random ID created on this computer, together
with your Zotero version, operating system and this plugin's version. That goes to zoteroatlas.com
when you turn it on, when the list changes, and once a week. We publish the totals so everyone can
see which plugins people actually use. Choose **Don't send** later, in Zotero's settings under
Zotero Atlas, and the plugin asks the server to delete the record. "Show what would be sent" in
the settings shows the exact message. The server's code is in [server/](server/); it stores
nothing from the request but those fields, no IP address.

**When you post a rating**, and only then, it sends to zoteroatlas.com: the plugin and version you
rate, your stars and review, your Zotero version and operating system, this plugin's version, and
a scrambled ID for this Zotero, so rating again replaces your rating. The ID is a slow hash of a
random key Zotero makes for its database; the key itself is never sent, and nothing is stored on
your computer for it. While **Send my plugin list** is chosen, the rating also carries that list's
random ID, so the rating can say how long you had the plugin. Reviews are public, shown as
"Zotero Atlas user" with your Zotero version; links are removed. We never store your IP address:
for ratings, the server keeps a scrambled code made from it for 30 days to catch fake reviews,
after which even we can't match it to anything. Every rating is checked before it's published, and
how fake ones are spotted isn't published, so it can't be gamed.

Whatever you choose, the plugin fetches the directory's catalogue once a day from GitHub
(raw.githubusercontent.com, the directory's public repository) and, when you click Install,
Zotero downloads the plugin file from GitHub. Nothing else is contacted, except zoteroatlas.com
when you post a rating.

It stores three settings (`extensions.zotero-atlas.usage`, `.id`, `.state`) and the catalogue in
`zotero-atlas/catalog.json` in your Zotero data directory. Uninstalling removes all of it.

## Its own grade

On zoteroplugins.org this plugin is graded **B**, because sending usage data to a developer's
server rates "medium" under the directory's rules, whether or not it's opt-in, and because it
installs other add-ons. That's the same rule every plugin gets. The grade is set by the same
pipeline as every other plugin's and nothing on its card is edited by hand.

## Check what you install

All the plugin's code is in [src/](src/): `bootstrap.js` (what it does), `content/` (the window),
`settings.xhtml` and `settings.js` (the settings pane), `prefs.js` (the defaults), `manifest.json`
and `icon.svg`. The plugin file is those files zipped as they are, with nothing compiled or bundled:

- **Unzip it and compare** (rename the `.xpi` to `.zip` if your computer won't open it): the files
  are exactly the ones in `src/` at that release's tag.
- **Rebuild it:** `python3 build.py` on the tagged commit makes a byte-identical file on any
  system. Compare its SHA-256 with the downloaded file's (`shasum -a 256 <file>` on a Mac or
  Linux, `Get-FileHash <file>` in Windows PowerShell).
- **Check where it was built:** each release's files are built by [the release
  workflow](.github/workflows/release.yml) from the tagged commit and come with GitHub's build
  attestation: `gh attestation verify <file> --repo iliasbeshimov/zotero-atlas`.

## Updates

Zotero checks this project's releases for updates, as it does for other plugins, and installs an
update only if it matches the SHA-256 in that release's `updates.json`. Turn automatic updates
off for this plugin in Tools → Plugins if you'd rather update by hand.

## Development

```sh
node test.cjs          # offline checks of the plugin's behaviour, with Zotero mocked
python3 build.py       # dist/zotero-atlas-<version>.xpi and dist/updates.json
```

Needs Zotero 7.0 or later. The catalogue it reads is written by the directory's pipeline
(`atlas catalog`); its shape is published as `catalog.schema.json` in the directory's repository.
