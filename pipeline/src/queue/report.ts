import { KINDS, type Queue, type QueueItem } from "./build.ts";

/** The queue as a page a person works through: one table per kind, then the two accuracy tables. */

const cell = (s: unknown) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** One unmatched entry: a file:line string, or an object that names a file and maybe a line. */
function place(u: unknown): string {
  if (typeof u === "string") return u;
  if (u && typeof u === "object") {
    const o = u as { file?: unknown; line?: unknown };
    if (typeof o.file === "string")
      return typeof o.line === "number" ? `${o.file}:${o.line}` : o.file;
  }
  return JSON.stringify(u);
}

function detailsText(item: QueueItem): string {
  const d = item.details;
  switch (item.kind) {
    case "possible-miss":
      return (d.hosts as { host: string; usage: string | null }[])
        .map((h) => `${h.host} (${h.usage ?? "unknown"})`)
        .join(", ");
    case "new-release-concern":
      return (d.reasons as string[]).join("; ");
    case "modified-library": {
      const unmatched = ((d.unmatched as unknown[] | undefined) ?? []).map(place);
      return `${d.library}${unmatched.length ? `: ${unmatched.join(", ")}` : ""}`;
    }
    case "sandbox-unexpected":
      return (d.unexpected as string[]).join("; ");
    case "grade-change":
      return `${d.from} to ${d.to}`;
    case "unknown-host":
    case "uncatalogued-library":
      return (d.plugins as string[]).join(", ");
    default:
      return (d.drivers as string[] | undefined)?.join(", ") ?? "";
  }
}

export function queueMarkdown(q: Queue): string {
  const out: string[] = ["# Investigation queue", "", `Generated ${q.generatedAt}`, ""];
  out.push(`Counts: ${KINDS.map((k) => `${k} ${q.counts[k]}`).join(", ")}`, "");

  for (const kind of KINDS) {
    const items = q.items.filter((i) => i.kind === kind);
    if (items.length === 0) continue;
    out.push(`## ${kind} (${items.length})`, "");
    out.push("| Plugin | Version | Label | Downloads | Summary | Details |");
    out.push("| --- | --- | --- | --- | --- | --- |");
    for (const i of items) {
      const plugin = i.slug ? `${i.name ?? i.slug} (${i.slug})` : "";
      out.push(
        `| ${cell(plugin)} | ${cell(i.version ?? "")} | ${cell(i.label ?? "")} | ${i.downloads ?? ""} | ${cell(i.summary)} | ${cell(detailsText(i))} |`,
      );
    }
    out.push("");
  }

  out.push("## Scanner vs sandbox", "");
  out.push("| Data sharing | Tested | Contacted nothing | Contacted unlisted hosts |");
  out.push("| --- | --- | --- | --- |");
  for (const r of q.agreement)
    out.push(`| ${r.value} | ${r.tested} | ${r.contactedNothing} | ${r.contactedUnlisted} |`);
  out.push("");

  out.push("## Rule accuracy", "");
  out.push("| Rule | Reviewed | Overturned | Changed level | Examples |");
  out.push("| --- | --- | --- | --- | --- |");
  for (const r of q.ruleAccuracy)
    out.push(
      `| ${cell(r.rule)} | ${r.reviewed} | ${r.overturned} | ${r.changedLevel} | ${cell(r.examples.join(", "))} |`,
    );
  out.push("");
  return out.join("\n");
}
