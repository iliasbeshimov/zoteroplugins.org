# Install Link Blocker

A very small Zotero plugin with one job: it blocks two zotero:// links that can install plugins or
run code. It has one switch, On or Off, in Zotero's settings.

## Why

Many Zotero plugins are built with a library called zotero-plugin-toolkit. Most plugins built with
it add two zotero:// links to Zotero. The links belong to Zotero as a whole, so if even one of
your plugins adds them, they work in your Zotero:

- **zotero://plugin** installs a plugin from any address in the link, without Zotero asking you
  first.
- **zotero://ztoolkit-debug** runs code from the link. Current versions ask you first; some older
  versions don't, and a plugin built for testing can turn the question off for all of them.

Web pages and documents can open zotero:// links (your browser usually asks "Open Zotero?" first,
unless you've told it to always allow). A plugin can do anything Zotero can, including reading and
changing your files. So a web page could get Zotero to install a plugin of its choosing. We
haven't seen this used against anyone. It doesn't mean the plugins that add these links are
harmful: the links come from the shared toolkit, whose authors describe the install link as a
temporary debugging aid.

## What each setting does

- **On** (the default): both links are blocked, and a short notice appears if one is used.
  One-click "install" links on websites won't work while it's on; install plugins from Tools →
  Plugins instead.
- **Off**: this plugin does nothing. The links work as your other plugins set them up, exactly as
  if this plugin weren't installed. Disabling or removing the plugin is the same as Off.

The switch takes effect at once, with no restart. Find it in Zotero's settings (Edit → Settings on
Windows and Linux, Zotero → Settings on a Mac), under Install Link Blocker.

## What it doesn't do

- Its code never connects to the internet and collects nothing. It stores one setting,
  `extensions.install-link-blocker.state` ("on" or "off"), which is removed when you uninstall; a
  new install always starts On. (Zotero itself checks this project's releases for updates; see
  [Updates](#updates).)
- It only covers these two links. It doesn't check what plugins do in other ways, and it doesn't
  remove plugins already installed. If you think a link may have installed something, look in
  Tools → Plugins for anything you don't recognise.
- It doesn't change your other plugins. Everything else they do works as before.
- It starts along with your other plugins, so while Zotero is opening, until it has started, the
  links can still work for a few seconds.

## Check what you install

All the plugin's code is in [src/bootstrap.js](src/bootstrap.js), about 120 lines. The other three
files in [src/](src/) are the settings page, the default setting and the plugin's name and
version. The plugin file is those four files zipped as they are, with nothing compiled or bundled:

- **Unzip it and compare** (rename the `.xpi` to `.zip` if your computer won't open it): the files
  are exactly the ones in `src/` at that release's tag.
- **Rebuild it:** `python3 build.py` on the tagged commit makes a byte-identical file on any
  system. Compare its SHA-256 with the downloaded file's (`shasum -a 256 <file>` on a Mac or
  Linux, `Get-FileHash <file>` in Windows PowerShell).
- **Check where it was built:** each release's files are built by [the release
  workflow](.github/workflows/release.yml) from the tagged commit and come with GitHub's build
  attestation, a signed statement of which workflow built them from which commit. Check it with
  `gh attestation verify <file> --repo iliasbeshimov/zotero-install-link-blocker --signer-workflow
  iliasbeshimov/zotero-install-link-blocker/.github/workflows/release.yml --source-ref refs/tags/v<version>`.

## Updates

About once a day Zotero checks the latest release here and installs a newer version of this plugin
automatically, as it does for every plugin that offers updates. The new file installs only if it
matches the SHA-256 in that release's `updates.json`. That check catches a damaged download; it
doesn't show that a release is good, because the same release publishes both files. To check each
version before it runs, open Tools → Plugins, click Install Link Blocker and set "Allow automatic
updates" to Off, then install new releases by hand after checking them.

When a new major version of Zotero comes out, Zotero turns this plugin off until a release says it
supports that version.

## Install

Download `install-link-blocker-<version>.xpi` from the latest release. (In Firefox, right-click
the link and choose Save Link As…, or Firefox will try to install it itself.) In Zotero, open
Tools → Plugins, then drag the file onto the window, or use the gear menu → Install Plugin From
File….

Works with Zotero 7 to 10.

## About

Made by Ilias Beshimov for zoteroplugins.org, an independent directory of Zotero plugins, not
affiliated with Zotero. MIT licence.
