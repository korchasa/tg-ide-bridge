/**
 * @module
 * Minimal Markdown → Telegram HTML converter for FR-EVENT-STREAM final
 * assistant text. Targets Telegram Bot API `parse_mode: "HTML"` rules
 * (core.telegram.org/bots/api#html-style).
 *
 * Supports: headers `#..######` → `<b>`, `**bold**` → `<b>`, `*it*` / `_it_`
 * → `<i>`, `` `code` `` → `<code>`, fenced blocks → `<pre><code class=…>`,
 * `[text](url)` → `<a>`, `> quote` → `<blockquote>`.
 *
 * `<pre>` cannot be nested inside `<blockquote>` per TG rules; callers must
 * keep this converter on the final-result buffer only, not inside the
 * streamer's `<blockquote expandable>` wrapper.
 */

/** Minimal HTML escape for TG parse_mode: only `<`, `>`, `&`. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const FENCE_PLACEHOLDER = "\uE000CODE";
const BQ_PLACEHOLDER = "\uE000BQ";
const PLACEHOLDER_END = "\uE000";

/**
 * Convert a subset of Markdown to Telegram-flavoured HTML. Safe for `null` /
 * `undefined` inputs. Fenced code blocks and `> `-prefixed blockquotes are
 * protected via Private-Use-Area placeholders so inline passes do not
 * rewrite their contents. Plain-text segments are HTML-escaped so stray
 * `<`/`>`/`&` cannot confuse TG's HTML parser.
 */
// FR-EVENT-STREAM
export function markdownToTelegramHTML(
  input: string | null | undefined,
): string {
  if (!input) return "";
  let text = input;

  // Phase 1: extract fenced code blocks. Content is escaped once and the
  // resulting HTML is stored; the placeholder short-circuits later passes.
  const codeStore: string[] = [];
  text = text.replace(
    /```([a-zA-Z0-9_+\-]+)?\n([\s\S]*?)```/g,
    (_m, lang, code) => {
      const trimmed = String(code).replace(/\n$/, "");
      const body = escapeHtml(trimmed);
      const html = lang && String(lang).trim()
        ? `<pre><code class="language-${
          escapeHtml(String(lang).trim())
        }">${body}</code></pre>`
        : `<pre><code>${body}</code></pre>`;
      const idx = codeStore.push(html) - 1;
      return `${FENCE_PLACEHOLDER}${idx}${PLACEHOLDER_END}`;
    },
  );

  // Phase 2: extract contiguous `> `-prefixed blockquote blocks.
  const bqStore: string[] = [];
  text = text.replace(/(^> .*(?:\n> .*)*)/gm, (block) => {
    const lines = block.split("\n").map((l) => l.replace(/^> ?/, ""));
    const html = `<blockquote>${escapeHtml(lines.join("\n"))}</blockquote>`;
    const idx = bqStore.push(html) - 1;
    return `${BQ_PLACEHOLDER}${idx}${PLACEHOLDER_END}`;
  });

  // Phase 3: escape remaining plain text. Placeholders use NUL bytes and
  // survive the escape unchanged.
  text = escapeHtml(text);

  // Phase 4: inline transforms on pre-escaped text (no inner escape needed).
  text = text.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, url) => `<a href="${url}">${label}</a>`,
  );
  text = text.replace(/^#{1,6}\s+(.*)$/gm, (_m, h) => `<b>${h}</b>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, (_m, b) => `<b>${b}</b>`);
  text = text.replace(
    /(^|\W)\*([^*]+)\*(?=\W|$)/g,
    (_m, pre, it) => `${pre}<i>${it}</i>`,
  );
  text = text.replace(
    /(^|\W)_([^_]+)_(?=\W|$)/g,
    (_m, pre, it) => `${pre}<i>${it}</i>`,
  );
  text = text.replace(
    /(^|\W)_([^_\n]+)$/gm,
    (_m, pre, it) => `${pre}<i>${it}</i>`,
  );

  // Phase 5: restore placeholders.
  text = text.replace(
    /\uE000CODE(\d+)\uE000/g,
    (_m, sidx) => codeStore[Number(sidx)] ?? "",
  );
  text = text.replace(
    /\uE000BQ(\d+)\uE000/g,
    (_m, sidx) => bqStore[Number(sidx)] ?? "",
  );

  return text;
}
