import { describe, expect, it } from "vitest";
import { blocks, folded, inline } from "../src/lib/response-text.ts";

describe("developer response text", () => {
  it("escapes HTML before adding any tag", () => {
    expect(inline(`<script>alert("x")</script> **bold**`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; <strong>bold</strong>",
    );
    expect(inline("`<b>` and **`x`**")).toBe("<code>&lt;b&gt;</code> and **<code>x</code>**");
  });

  it("links only http and https addresses", () => {
    expect(inline("[docs](https://example.com/a) and javascript:alert(1)")).toBe(
      '<a href="https://example.com/a" rel="nofollow ugc noopener">docs</a> and javascript:alert(1)',
    );
    expect(inline("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
    expect(inline("See https://aka.ms/vs/17/release/vc_redist.x64.exe.")).toBe(
      'See <a href="https://aka.ms/vs/17/release/vc_redist.x64.exe" rel="nofollow ugc noopener">https://aka.ms/vs/17/release/vc_redist.x64.exe</a>.',
    );
  });

  it("renders headings, lists with continuation lines, and indented code", () => {
    const md = [
      "# Conditional download",
      "",
      " During initialization on Windows:",
      " 1. Zocrates provisions a local Python",
      "    environment.",
      " 2. It checks the runtime first.",
      "",
      " - wheelInstallTarget is a local file:",
      "   ```javascript",
      '     const res = await fetch(rootURI + "backend/zocrates.whl");',
      "   ```",
      "",
      " ---",
      "plain text",
    ].join("\n");
    expect(blocks(md)).toEqual([
      '<p class="rh"><strong>Conditional download</strong></p>',
      "<p>During initialization on Windows:</p>",
      "<ol><li>Zocrates provisions a local Python environment.</li><li>It checks the runtime first.</li></ol>",
      "<ul><li>wheelInstallTarget is a local file:</li></ul>",
      "<pre><code>const res = await fetch(rootURI + &quot;backend/zocrates.whl&quot;);</code></pre>",
      "<p>plain text</p>",
    ]);
  });

  it("folds a long response after its opening and keeps a short one whole", () => {
    const long = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ${"word ".repeat(30)}`).join(
      "\n\n",
    );
    const f = folded(long);
    expect(f.shown.length).toBeGreaterThan(0);
    expect(f.more.length).toBeGreaterThan(0);
    expect(f.shown.length + f.more.length).toBe(8);
    expect(folded("One paragraph.\n\nAnother one.").more).toEqual([]);
  });
});
