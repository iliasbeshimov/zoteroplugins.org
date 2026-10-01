"""Write a small one-page PDF with real text, for plugins that read or index PDFs."""

import sys

text = [
    "Deep learning: a sandbox test document",
    "This page belongs to the zoteroplugins.org test library.",
    "Deep learning allows computational models composed of multiple processing layers",
    "to learn representations of data with multiple levels of abstraction.",
]
lines = "".join(
    f"BT /F1 12 Tf 72 {720 - 24 * i} Td ({t}) Tj ET\n" for i, t in enumerate(text)
)
objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
    "/Resources << /Font << /F1 5 0 R >> >> >>",
    f"<< /Length {len(lines)} >>\nstream\n{lines}endstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Title (Deep learning sandbox test) >>",
]
out = "%PDF-1.4\n"
offsets = []
for n, body in enumerate(objects, 1):
    offsets.append(len(out.encode("latin-1")))
    out += f"{n} 0 obj\n{body}\nendobj\n"
xref = len(out.encode("latin-1"))
out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
out += "".join(f"{o:010d} 00000 n \n" for o in offsets)
out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n{xref}\n%%EOF\n"
with open(sys.argv[1], "wb") as f:
    f.write(out.encode("latin-1"))
