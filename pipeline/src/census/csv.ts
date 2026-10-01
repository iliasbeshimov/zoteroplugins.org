/** RFC 4180 CSV: quoted fields, doubled quotes, embedded newlines, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Array of objects to CSV. Columns follow `columns` order. */
export function toCsv(records: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v) ? v.join(";") : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const r of records) lines.push(columns.map((c) => cell(r[c])).join(","));
  return `${lines.join("\n")}\n`;
}
