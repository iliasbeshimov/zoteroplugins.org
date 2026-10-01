# Plugin sandbox

Runs one Zotero plugin in a throwaway Zotero and records what it does, so a card's findings can be
checked against real behaviour. This is the test behind the A+ grade: the plugin loaded, and
everything it did during the test is something its card already says.

## What a run does

1. A fresh Zotero (10.0.3, or 9.0.6 for plugins that stop at Zotero 9) starts with a small test
   library: two articles (one with a PDF and a note), a book, a collection, tags, and one item
   with a Chinese title.
2. Our harness add-on walks through ordinary use: 25 seconds of startup, selecting each item,
   opening the PDF in the reader, opening Zotero's settings at the plugin's pane, then clicking
   every menu item the plugin added (to the item and collection context menus and the menu bar)
   with an item selected, closing any window or dialog that opens. Then 20 seconds idle.
3. The run is compared with a baseline run of the same Zotero without the plugin
   (`sandbox/report.py`). What's left is the plugin's doing: web requests (with their full
   addresses and the first 2 KB of what they send), attempts to reach this computer or a private
   network, other connection attempts, programs started, servers opened, settings changed outside
   its own, files written outside Zotero's folders, changes to Zotero's database structure, and
   new errors.
4. The verdict is `as-described` when every one of those is something its card says, and
   `unexpected` otherwise, with the reasons.

## Isolation

- A dedicated podman machine, `atlas-sandbox` (a Linux VM). It shares one folder with the Mac,
  `.cache/sandbox-io/`, instead of podman's default of the whole home folder.
- Rootless containers with every capability dropped, no privilege escalation, and limits on memory,
  CPUs and processes.
- The Zotero container is on an internal network of its own with no route out and no DNS. Its only
  neighbour is the proxy.
- The proxy (mitmproxy, pinned by digest) is the only way out. It logs every request and refuses
  any destination on this computer or a private network (the Mac, the local network, the VM's
  gateway), so a plugin can reach only the public internet. It decrypts HTTPS with its own CA,
  which only the throwaway profile trusts.
- A monitor container shares the Zotero container's process and network namespaces with only the
  capabilities to capture packets. It records processes, listening sockets and every connection
  attempt that bypasses the proxy.
- Each run gets new containers and a new network, all removed afterwards; the raw logs stay in
  `.cache/sandbox-io/runs/`.

A plugin under test can still use the public internet through the proxy, as it would for a user.
It can't reach your files, your Zotero, or anything on your network.

## What a test can't show

- Features that need an API key, an account, another program, or input we don't script.
- Behaviour that waits longer than the run, depends on the date, or targets another operating
  system.
- Code that notices it's being tested. The card's static analysis covers every path in the code;
  the sandbox confirms what happens on the paths a test reaches.

## Commands

```sh
sandbox/run.sh setup                         # build the images, seed the test libraries
sandbox/run.sh baseline 10.0.3               # Zotero with no plugin
sandbox/run.sh test 10.0.3 path/to/plugin.xpi name
python3 sandbox/report.py <run> <baseline> data/generated/<slug>/profile.json
python3 sandbox/batch.py --jobs 4 <slug> ...  # current release of each, one report per plugin
EXTRA=install-link-blocker/dist/install-link-blocker-1.0.0.xpi \
  sandbox/run.sh links 10.0.3 path/to/plugin.xpi name  # the link check, with the blocker
sandbox/run.sh clicks 10.0.3 path/to/plugin.xpi name   # clicking those links in a note and a PDF
```

`sandbox/run.sh clicks` puts the toolkit's two links in a note (shown in the item pane's note editor)
and on a PDF page beside an ordinary https link, then clicks each with real mouse events: a plain
click, the address in the editor's link popup, and Ctrl+click. Per click, `harness.json`
(`clickTrials`) records installs started (cancelled at once, address on `.invalid`), whether the
debug link's test code ran, and every prompt, window and popup.

## The link check (Install Link Blocker)

`sandbox/run.sh links` runs a plugin built on zotero-plugin-toolkit, optionally with
[Install Link Blocker](../install-link-blocker/) beside it (`EXTRA=`), and instead of the usual walk
through it tries the toolkit's two zotero:// links by both routes Zotero hands an address to its
handlers: the window's link handling and loading the address. With the blocker it repeats the
tries with the blocker on, off, on again, disabled and enabled again. `harness.json` records, per
try, which handler was in place, how many add-on installs started, the notices shown, whether the
debug link's test code ran and whether it asked first. An install is cancelled the moment it
starts, before anything downloads, and its address is on `.invalid`, which never resolves; the
debug link's test code only sets a setting.

Needs podman with the `atlas-sandbox` machine
(`podman machine init atlas-sandbox --cpus 6 --memory 12288 --volume "$PWD/.cache/sandbox-io:/io"`)
and the Zotero Linux ARM64 tarballs in `.cache/sandbox/zotero/`.
