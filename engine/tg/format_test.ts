import { assert, assertEquals } from "@std/assert";
import { escapeHtml, markdownToTelegramHTML } from "./format.ts";

Deno.test("escapeHtml escapes only <, >, & (TG-minimal)", () => {
  assertEquals(escapeHtml("<b>&\"'</b>"), "&lt;b&gt;&amp;\"'&lt;/b&gt;");
});

Deno.test("markdownToTelegramHTML returns empty string for null/undefined/empty", () => {
  assertEquals(markdownToTelegramHTML(null), "");
  assertEquals(markdownToTelegramHTML(undefined), "");
  assertEquals(markdownToTelegramHTML(""), "");
});

Deno.test("markdownToTelegramHTML leaves plain text unchanged", () => {
  assertEquals(markdownToTelegramHTML("Hello world!"), "Hello world!");
  assertEquals(markdownToTelegramHTML("   "), "   ");
  assertEquals(markdownToTelegramHTML("\t\n  \t"), "\t\n  \t");
});

Deno.test("markdownToTelegramHTML converts bold and italic", () => {
  assertEquals(
    markdownToTelegramHTML("**bold** and *italic* _more_"),
    "<b>bold</b> and <i>italic</i> <i>more</i>",
  );
});

Deno.test("markdownToTelegramHTML converts inline code", () => {
  assertEquals(
    markdownToTelegramHTML("Text with `code` inline"),
    "Text with <code>code</code> inline",
  );
});

Deno.test("markdownToTelegramHTML converts fenced code blocks without language", () => {
  assertEquals(
    markdownToTelegramHTML("```\nline1\nline2\n```"),
    "<pre><code>line1\nline2</code></pre>",
  );
});

Deno.test("markdownToTelegramHTML converts fenced code blocks with language", () => {
  assertEquals(
    markdownToTelegramHTML("```python\nprint(1)\n```"),
    '<pre><code class="language-python">print(1)</code></pre>',
  );
});

Deno.test("markdownToTelegramHTML converts links", () => {
  assertEquals(
    markdownToTelegramHTML("See [example](https://example.com?q=a_b#c) please"),
    'See <a href="https://example.com?q=a_b#c">example</a> please',
  );
});

Deno.test("markdownToTelegramHTML converts blockquotes", () => {
  assertEquals(
    markdownToTelegramHTML("> quoted _text_\n> second"),
    "<blockquote>quoted _text_\nsecond</blockquote>",
  );
});

Deno.test("markdownToTelegramHTML converts headers of all levels to bold", () => {
  const input =
    "# Header 1\n## Header 2\n### Header 3\n#### Header 4\n##### Header 5\n###### Header 6";
  const out = markdownToTelegramHTML(input);
  assertEquals(
    out,
    "<b>Header 1</b>\n<b>Header 2</b>\n<b>Header 3</b>\n<b>Header 4</b>\n<b>Header 5</b>\n<b>Header 6</b>",
  );
});

Deno.test("markdownToTelegramHTML leaves unclosed underscore italic as literal", () => {
  // Symmetric with `**unclosed bold`: an unclosed marker stays literal,
  // matching Markdown semantics. Auto-closing was the source of false
  // italic on names like `_internal` / paths like `_priv` at line end.
  assertEquals(
    markdownToTelegramHTML("Text with _unclosed italic"),
    "Text with _unclosed italic",
  );
});

Deno.test("markdownToTelegramHTML preserves markdown inside fenced code blocks", () => {
  const input = `\`\`\`bash
# List running Docker containers
docker ps --filter name=ha

**If found, fetch recent logs**
docker logs --tail 50 <container_name>
\`\`\``;
  const out = markdownToTelegramHTML(input);
  assert(out.startsWith('<pre><code class="language-bash">'));
  assert(out.endsWith("</code></pre>"));
  assert(out.includes("# List running Docker containers"));
  assert(out.includes("**If found, fetch recent logs**"));
  assert(out.includes("&lt;container_name&gt;"));
});

Deno.test("markdownToTelegramHTML escapes <, >, & in plain text", () => {
  assertEquals(
    markdownToTelegramHTML("a & <b> > c"),
    "a &amp; &lt;b&gt; &gt; c",
  );
});

Deno.test("markdownToTelegramHTML preserves unicode and emoji", () => {
  assertEquals(
    markdownToTelegramHTML("Hello 🌟 **bold** with *italic* 🎉"),
    "Hello 🌟 <b>bold</b> with <i>italic</i> 🎉",
  );
  assertEquals(
    markdownToTelegramHTML("Привет **мир** и *hello* κόσμος"),
    "Привет <b>мир</b> и <i>hello</i> κόσμος",
  );
});

Deno.test("markdownToTelegramHTML handles multiple fenced blocks", () => {
  const input = "```js\nconsole.log(1);\n```\n\n```python\nprint(2)\n```";
  const out = markdownToTelegramHTML(input);
  assert(
    out.includes('<pre><code class="language-js">console.log(1);</code></pre>'),
  );
  assert(
    out.includes('<pre><code class="language-python">print(2)</code></pre>'),
  );
});

Deno.test("markdownToTelegramHTML leaves unclosed bold as-is", () => {
  assertEquals(markdownToTelegramHTML("**unclosed bold"), "**unclosed bold");
});

Deno.test("markdownToTelegramHTML handles empty fenced block", () => {
  assertEquals(markdownToTelegramHTML("```\n```"), "<pre><code></code></pre>");
});

Deno.test("markdownToTelegramHTML keeps unclosed fence as literal text", () => {
  assertEquals(markdownToTelegramHTML("```python\n"), "```python\n");
});

Deno.test("markdownToTelegramHTML protects inline code body from italic passes", () => {
  // Regression: italic-end-of-line regex used to sweep `_func` plus the
  // trailing `</code>` into <i>, producing `<code><i>func</code></i>` and
  // tripping TG with "Unmatched end tag, expected </i>, found </code>".
  assertEquals(
    markdownToTelegramHTML("call `_func` here"),
    "call <code>_func</code> here",
  );
  assertEquals(
    markdownToTelegramHTML("- reserved: `BOT_COMMAND_LIST`"),
    "- reserved: <code>BOT_COMMAND_LIST</code>",
  );
  // Trailing inline code that ends the line must not get auto-closed italic.
  assertEquals(
    markdownToTelegramHTML("see `path/to/_priv`"),
    "see <code>path/to/_priv</code>",
  );
});

Deno.test("markdownToTelegramHTML protects link label and url from italic passes", () => {
  // Same nesting class of bug as inline code: a `_` inside the label or a
  // `_` in the URL must not pull `</a>` into `<i>`.
  assertEquals(
    markdownToTelegramHTML("see [_label](https://x.com/path)"),
    'see <a href="https://x.com/path">_label</a>',
  );
  assertEquals(
    markdownToTelegramHTML("see [link](https://x.com/_dir)"),
    'see <a href="https://x.com/_dir">link</a>',
  );
  assertEquals(
    markdownToTelegramHTML("[trailing_](https://x.com)"),
    '<a href="https://x.com">trailing_</a>',
  );
});

Deno.test("markdownToTelegramHTML emits well-formed nesting for mixed markers", () => {
  // No `<i>...</code>` or `<code>...</i>` cross-tag matches anywhere in the
  // output. This catches the class of bugs where inline-pass regexes reach
  // into already-emitted HTML.
  const inputs = [
    "before `_x` after",
    "x `a_b` y _italic_ z",
    "_pre `code_inside` post_",
    "`_just_underscores_`",
    "line1 `code_one`\nline2 `_code_two`",
    "see [_label](https://x.com/path)",
    "see [link](https://x.com/_dir)",
    "[trailing_](https://x.com)",
    "line ends with `_x`",
  ];
  for (const input of inputs) {
    const out = markdownToTelegramHTML(input);
    // Every <code> opens before any </code>; each <i> / <b> closes before
    // the surrounding <code> closes.
    const openCode = (out.match(/<code>/g) ?? []).length;
    const closeCode = (out.match(/<\/code>/g) ?? []).length;
    assertEquals(
      openCode,
      closeCode,
      `unbalanced <code> in: ${input} → ${out}`,
    );
    // No <i> / <b> may appear inside <code> or <a> bodies.
    const tagBodyRe = /<(code|a)\b[^>]*>([\s\S]*?)<\/\1>/g;
    for (const m of out.matchAll(tagBodyRe)) {
      const body = m[2] ?? "";
      assert(
        !/<\/?[ib]>/.test(body),
        `markdown leaked into <${m[1]}>: ${input} → ${out}`,
      );
    }
  }
});
