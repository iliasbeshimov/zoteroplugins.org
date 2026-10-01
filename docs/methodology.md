# How we check plugins

zoteroplugins.org is an independent directory. It is not affiliated with Zotero or the Corporation
for Digital Scholarship.

Every plugin page has a card that says what the plugin's code does with your computer and your
data. This page explains how that card is made, what it can and can't tell you, and how a
developer can respond to it.

## What we look at

- **The file you'd install.** For each plugin we download the release file (`.xpi`) from its
  GitHub release and identify it by its SHA-256 hash. When a release ships several builds (one per
  Zotero version or operating system), the card describes the build current Zotero installs, and
  the others are listed with their own labels.
- **Every script in it.** We read all of its JavaScript and the scripts inside its HTML and XUL
  pages, without running anything. We note which parts are bundled libraries (pdf.js, React, an
  API client) and which are the plugin's own code.
- **Where updates come from.** We fetch the plugin's update address the way Zotero does, and if it
  offers a different file from the release, we analyse that file too, since that's what you'd end
  up running. When the update address gives a fingerprint (hash) for the file, we check the file
  against it as Zotero does: Zotero won't install an update that doesn't match, and the card says
  so.
- **Scripts in other languages it ships.** When a plugin runs a Python or shell script from its
  package, we read that script for the addresses it contacts.

Nothing on the card is written by an AI model. Descriptions of what a plugin does, when we add
them, are marked separately.

## The label

Each card has one of four labels:

| Label | Means |
|---|---|
| **Few concerns found** | Nothing in the code matched a medium or high concern. |
| **Review the details** | At least one thing is worth a look before you install: read the card. |
| **Serious concerns found** | The code does something that deserves real caution (see below). |
| **Not enough data** | We couldn't read enough of the code to say. |

"Few concerns found" is not a guarantee. It means our checks found nothing of concern in the file
we analysed. See [what we can't check](#what-we-cant-check).

The label comes from three parts of the card: source transparency, data sharing and capabilities.
The worst of the three decides it. Compatibility and maintenance are shown next to the label but
don't change it: a plugin can be well behaved and still not work with your Zotero.

## Source transparency: can the code be read?

| Finding | Concern |
|---|---|
| Obfuscated code: two kinds of obfuscator signal, or one backed by a second file or dense escapes | high |
| Hidden characters that change how code reads (direction overrides, long invisible runs) | high |
| Updates replace it with a newer version that has serious concerns (and this file doesn't) | high |
| Parts of the code may be obfuscated (one signal in one file) | medium |
| The release file was replaced after it was published: we saw it change, or it doesn't match the fingerprint the project's own update address gives for that version and was uploaded more than two minutes after that was written and after the release was published (not sooner, which one workflow run can do; not when the release was published from the developer's account rather than by a workflow: the file may simply have been added late) | medium |
| The update address is under a name nobody controls (a template name, or a GitHub account that doesn't exist), so anyone could serve updates; or under a repository that doesn't exist in another developer's account, so that developer could | medium |
| Uploaded by the project's GitHub Actions workflow | low |
| Source match not checked yet | shown, doesn't affect the label |

We don't yet rebuild plugins from their source code to confirm the release matches it. When a
release was uploaded by the project's own GitHub Actions workflow we say so, but that isn't the
same as checking what was built. When a workflow created the release but the file was uploaded
afterwards from a person's account, we say that instead.

## Data sharing: where does it send data?

We list every destination we can find in the plugin's own code and name who runs it. When we
traced a request to a host, the card says the plugin **contacts** it; when we only found the
address in the code, it says the code **names** it. A host the plugin contacted when we
[ran it in Zotero](#tested-in-zotero) is marked **seen when we ran it** and counts as a request we
traced, whether or not we found it in the code.

| Finding | Concern |
|---|---|
| A server we couldn't identify, or a bare IP address | medium |
| The developer's own servers, or a server on a hosting platform | medium |
| A telemetry service | medium |
| A public file drop or open proxy, unless what's sent is encrypted to the developer first | medium |
| Network code but no destination we could name | medium |
| Obfuscated code, where the rest looks clean: we couldn't fully check where it sends data | unknown (counts like medium) |
| A program or local companion it hands your data to, whose job is done online and that nothing names | medium |
| Only named services (an AI provider, a translation service, Crossref…) | low |
| Network code only in bundled libraries that don't send anything for the plugin | low |
| Only servers you set up, localhost, or the web addresses saved in your items | none |
| No network code found | none |

A plugin that runs an AI command-line tool (Claude Code, Codex, Gemini CLI) sends what it gives
that tool to the tool's provider; the card names them. The same goes for other programs it hands
your documents to (edge-tts sends text to Microsoft, wakatime-cli to WakaTime, pdf2zh to the
translator it's set up with). Hosts reached over plain `http://` are marked unencrypted. Shadow libraries (Sci-Hub, LibGen) get a
legal notice. An address the plugin only shows as an example (a settings field's placeholder or
help text) or uses as the name of an XML format isn't counted as one its code names.

## Capabilities: what can it do on your computer?

Zotero plugins run with the same rights as Zotero itself. These are the capabilities we look for.

| Capability | Concern |
|---|---|
| Downloads and runs code: loading a script from the web, or running a network response | high |
| Downloads and runs a program (or pipes a download into a shell), not checked against a fingerprint written into the plugin | high |
| Installs npm or PyPI packages without a fixed version, so whatever is newest runs | high |
| Runs code or commands its AI assistant writes without asking you first | high |
| Runs encrypted code we can't read | high |
| A zotero:// link (a web page can open one) can make it run code without asking you | high |
| Turns off a Zotero security setting | high |
| Writes to Zotero's database directly, or opens its database file | high |
| Reads your web browser's saved cookies or passwords | high |
| Any website can change your library, or use every endpoint on Zotero's built-in server, through it | high |
| Any website you visit can make its own local server change your library, run code, or send your saved API key to an address the website picks: the server doesn't check where requests come from | high |
| Installs add-ons or its own updates without asking, through mirrors or proxies, over plain http, unchecked, from a link or another program (other than zotero-plugin-toolkit's install link, below), or from a hidden address | high |
| Trusts a certificate, loosens another program's permission prompts, turns off Zotero's updates, or sets up a program to start by itself without asking | high |
| Launches programs on your computer; loads native code | medium |
| Runs a compiled program it ships, which we can't read | medium |
| Installs and runs npm or PyPI packages at a fixed version | medium |
| Keeps its own tables in Zotero's database | medium |
| Installs other add-ons or its own updates after you click, or silently from the developer's own https feed checked against a hash | medium |
| A zotero:// link can make it install add-ons, or run code if you approve a prompt | medium |
| Downloads a program checked against a fingerprint written into the plugin, and runs it | medium |
| Adds Zotero translators it downloads | medium |
| Signs in using another app's identity (for example Codex CLI's), or reuses a sign-in you saved in another program | medium |
| Changes settings that aren't its own: other programs' settings files, Word macros, MCP servers, Zotero's proxy, sync or PDF sources | medium |
| Sends your text or keys unencrypted (plain http://) to a server on the internet | medium |
| Watches Zotero's network traffic | medium |
| Runs a server other computers on the network, or any web page, can reach; websites you approve can use Zotero's built-in server through it; any website can change your library through it, but only items whose key it already knows | medium |
| Runs code other programs, its AI assistant (asking you each time), or a debugger send it; starts an AI coding agent with fewer approval prompts | medium |
| Runs code it builds at runtime, reads and writes files, stores API keys, uses the clipboard | low |
| Other programs on this computer can change your library through it | low |
| Sends only public identifiers (a DOI, an ISBN, a search) over plain http:// | low |
| Its pages ask for web scripts, which Zotero blocks | low |
| Runs its own local server that only answers, or that checks where requests come from; adds a Zotero connector endpoint (Zotero itself refuses web pages' requests to these unless the endpoint opts in) | low or none |

A server the plugin runs itself, in its own code or in a Python or Node program it ships and runs,
has none of Zotero's protections. A web page you visit can send it a simple request (a GET, or a
POST with a text or form body) without asking the browser first; the page can't read the answer,
but the server acts on it. Unless the server checks the request's Origin header, requires a secret
the page can't know, or only accepts JSON bodies, any website can trigger what it does while it
runs. Checking that the request is addressed to 127.0.0.1 doesn't help, because a page's request
to your computer is addressed that way too. Some browsers now ask before letting a site reach your
computer's local addresses, but not all do. A server that sends `Access-Control-Allow-Origin: *`
lets pages read its answers too, unless every request it serves needs a secret the page can't know.

Every item in Zotero has a key, an 8-character ID. When every change a website can make through
the plugin (an endpoint on Zotero's built-in server, or its own server) needs the key of an item
already in your library, and nothing a page can read from it hands keys out (library content, or
items it finds some other way, like the ones you have selected), a website that doesn't already
know one can't change anything, so the finding rates one step lower. Creating items from nothing,
acting on the item you have selected, or finding, trashing or deleting items by their number
(numbers count up from 1, so they can be guessed) doesn't need a key, wherever in the plugin's code
it happens.

Add-on installs, its own updates, settings it changes, endpoints on Zotero's built-in server
that change your library, and what any website can make the plugin's own server do rate one step
lower when they wait for a setting that's off by default, and the card names the setting; so does
a settings change the plugin puts back. Code its AI assistant
writes rates medium rather than high when it waits for a setting named for running code. Other
capabilities rate the same whether or not a setting turns them on. zotero-plugin-toolkit's
zotero:// links count only when the plugin actually sets them up; many plugins carry the code
without doing so.

A finding inside a bundled library still counts. The card says which library it came from, because
bundled code runs with the same rights as the plugin's own.

Text a plugin only shows you doesn't count as something it does: an install command in an error
message or next to a Copy button, or an MCP configuration it gives you to paste into another app.
A command line counts when the plugin starts a shell to run it.

Some of these come from Zotero's own guidance: Zotero has said plugins should never modify
`zotero.sqlite`, and such plugins won't be allowed in a future official directory. Keeping separate
tables is "relatively less bad". Zotero also keeps an official blocklist, which we show on the card.

## Compatibility

The line next to the label says whether current Zotero runs this version, from the version range
the plugin declares. Zotero refuses to run a plugin outside that range, and it compares the whole
version number: a plugin that says it works up to Zotero 10.0.2 doesn't run in Zotero 10.0.4
("Doesn't work with Zotero 10.0.4; it stops at Zotero 10.0.2"), while one that says `10.0.*` or
`10.*` does. A range that ends at 10.0 means 10.0.0.

Zotero also refuses some files outright, whatever range they declare. A plugin for Zotero 7 or
later (one with a manifest.json) isn't installed when its manifest has:

- an add-on ID that is missing or isn't in the form Zotero accepts: a long code in curly braces
  (a GUID), or name@domain with a single @ and only letters, digits, hyphens, dots and
  underscores;
- no update address;
- no maximum Zotero version.

The card then says "Zotero won't install this file" and why, and the plugin counts as working with
no Zotero version. We found these checks in Zotero's own code, and installing such files in a real
Zotero (9.0.6 and 10.0.3) showed the same: none of them appeared in its list of add-ons. Plugins
built for Zotero 6 (with an install.rdf) follow Zotero 6's rules.

When a release ships several files, it works with a Zotero version if one of them does; each
file's own card says whether that file does.

## Tested in Zotero

For some plugins we also run the release file in a throwaway copy of Zotero and record what it
does. A run:

1. Starts a fresh Zotero (10.0.3, or 9.0.6 for plugins that stop at Zotero 9) with a small test
   library: two articles (one with a PDF and a note), a book, a collection, tags, and an item with
   a Chinese title.
2. Uses the plugin the way a person might: it waits for Zotero to start, selects each item, opens
   the PDF in the reader, opens Zotero's settings at the plugin's own pane, and clicks every menu
   item the plugin adds, with an item selected, closing any window or dialog that opens. Then it
   waits a little longer.
3. Compares the run with a run of the same Zotero without the plugin. What's left is the
   plugin's doing: the web addresses it contacted, attempts to reach the computer it runs on or a
   local network, programs it started, servers it opened, settings it changed outside its own,
   files it wrote outside Zotero's folders, and changes to Zotero's database structure.

The plugin runs in an isolated container. It can reach the public internet, as it would for you,
but nothing on our computers or our network.

The card says which Zotero version we ran it in, when, and how much of the plugin the test reached
(items selected, the PDF reader, its settings, the menu items it added). **As described** means the
plugin started, and everything it did during the test is something its card already said before we
ran it; a host counts only if the card listed it without the test, or if the plugin only loaded
pages there from a service that serves its own pages, such as a DOI opening the publisher's page. A
page load anywhere else is still unexpected. A server we couldn't identify, the developer's own or
one on a hosting platform learns that someone is using the plugin; a code host or a CDN serves
whatever the developer put there, such as an update list or a program; a usage-tracking service
counts the visit. Otherwise the card lists what we didn't expect, or says the plugin didn't start or
the test didn't finish.

A web address counts as data sharing when the plugin sent it something during the test. We can tell
because the test library's text is our own: when its titles, DOI or ISBN, authors, abstract, note,
tags, collection name, PDF text or the PDF itself turn up in a request, the plugin sent library data
there, and we know which kind. A request that sends anything else in a query string or a body counts
too. Each of these addresses is added to the card's data sharing, marked **seen when we ran it**,
and counts like a request we traced in the code: a server we couldn't identify, or the developer's
own, raises data sharing just as it would if we'd found it in the code. The card lists what went
where: for example, that api.crossref.org received the items' titles and DOIs.

Pages the plugin only loaded, sending nothing, are listed on the card but don't count as sharing: an
address the card already lists is marked seen when we ran it, and one it doesn't list isn't added. A
usage-tracking service is the exception: loading its page is how it counts users, so it counts as
sharing. Tests run before we recorded what each address received count every address the plugin
contacted. Nothing else from a test changes the label for now: attempts to reach a local address,
programs, servers, settings, files and database changes are listed with the test's findings.

A test applies to one exact release file, identified by its SHA-256 hash. When a plugin ships a new
release, the new file is untested until we run it again.

What a test can't show:

- Features that need an API key, an account, another program, or input we don't script.
- Behaviour that waits longer than the run, depends on the date, or targets another operating
  system.
- Code that notices it's being tested. The card's analysis of the code covers every path in it; a
  test confirms what happens on the paths it reaches.

## What we can't check

- **What happens at run time.** We read code. When we've [run a plugin](#tested-in-zotero), that
  covers only what the test reached. A request that depends on a setting may never happen for you,
  and code can build addresses we can't predict.
- **What a server does with your data.** We can say where data goes, not what happens to it there.
- **Code we can't read:** compiled programs, encrypted code, heavily obfuscated code, and code
  downloaded later. We flag these rather than guess.
- **Whether the release matches the source.** Not checked yet (see source transparency).
- **Intent.** A card describes behaviour. "Launches programs" is how a plugin opens a PDF in your
  own viewer, and also how malware runs; the details on the card say which.

## If you're the developer

If something on your card is wrong or missing context, please
[open a "Respond to your plugin's card" issue](https://github.com/iliasacademia/zoteroatlas/issues/new?template=card-response.yml).
We check that you maintain the repository, re-check the finding and reply there. Your response is
shown on the page next to the card, in your words, with our reply.

We don't edit individual cards by hand. If a finding is wrong for your plugin, it's probably wrong
for others too, so we fix the analysis for everyone and the card changes with it.

## Changes to the checks

| Date | Analyzer | Rules | What changed |
|---|---|---|---|
| 2026-09-26 | 0.8.0 | 0.6.1-preview | Tested in Zotero: when we've run a plugin's release file, the card says what the test did and found, and the hosts it sent data to are added to data sharing, marked "seen when we ran it", and count as requests we traced; pages it only loaded are listed but don't count as sharing, except on a usage-tracking service. |
| 2026-09-26 | 0.7.0 | 0.5.0-preview | New findings: endpoints on Zotero's server and who can reach them, settings changed in Zotero and other programs, documents handed to other programs, browsers' and other apps' saved logins, where installs come from, data sent unencrypted. Packages rated by pinning, AI-written code by approval, the toolkit's zotero:// links only when set up. |
| 2026-09-26 | 0.6.4 | 0.4.1-preview | A second precision check (all ten labels right); keys saved in loops, download sources as requests, server sockets told apart from stream pumps. |
| 2026-09-26 | 0.6.3 | 0.4.1-preview | Addresses followed through request helpers and matched by scope; links through helpers; unused array entries and RDF namespaces aren't destinations. |
| 2026-09-26 | 0.6.2 | 0.4.1-preview | Every confirmed review finding re-checked against the new cards. A public relay counts only when a request reaches it; more ways of loading code and downloading programs are followed; a Python program that opens Zotero's database counts; webhooks into the developer's own account; Zotero's server opened to the network; turning on Zotero's local API; about 35 more hosts classified. |
| 2026-09-26 | 0.6.0 | 0.4.0-preview | A precision check of ten random cards and a review of every "Serious concerns found" card. Commands a plugin only shows no longer count; downloads pinned in shipped scripts are pinned; update checks compare versions and read update.rdf, and a newer version raises the card only when it's worse; obfuscated code can't get a clean data-sharing result. Badges name the bundled library and add a detail line; the label lists the findings that set it; "contacts" only for traced requests. |
| 2026-09-26 | 0.5.0 | 0.3.0-preview | A full review of every card against its code. New checks: link handlers, encrypted code, download-and-run through any route, compiled programs and packages it runs, AI tools it hands data to, security settings, its own updater and servers, translators. Obfuscation confidence tiers. Update addresses fetched and followed. Web scripts in plugin pages lowered to low after a test in real Zotero showed Zotero blocks them. |
| 2026-09-26 | 0.4.0 | 0.2.0-preview | Fixes from an independent review of the scoring: the build current Zotero installs, database writes through variables, bundled libraries attribute findings but never remove them, update addresses shown on their own line. |
| 2026-09-25 | 0.3.2 | 0.1.0-preview | First run over every listed plugin. |

The thresholds behind the obfuscation and coverage checks, and how they sit against every plugin
we analyse, are in [the calibration note](reports/calibration-2026-09-26.md).
