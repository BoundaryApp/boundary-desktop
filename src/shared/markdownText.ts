/**
 * Plain-text and quote helpers for reply extras (message-actions spec, Phase 4).
 */

/**
 * Reply markdown → plain text: keeps words, code and link targets, drops the syntax.
 * Line-based, so it handles what assistants write (headings, lists, emphasis, code,
 * links, quotes, tables); it is not a full CommonMark renderer.
 */
export function markdownToPlainText(markdown: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    // Horizontal rules and table separator rows carry no words.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    if (raw.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(raw)) continue;

    let line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(>\s?)+/, '')
      .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, '$1• ')
      .replace(/^(\s*)[-*+]\s+/, '$1• ');
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim())
        .join('\t');
    }
    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text: string, url: string) =>
        text === url ? text : `${text} (${url})`
      )
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1$2')
      .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1');
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Tags the reply renderer keeps (hast-util-sanitize's default schema, which Streamdown
 * uses). Anything else is stripped silently, keeping only its text.
 */
const RENDERED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'ol',
  'p', 'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'source', 'span',
  'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'tt', 'ul', 'var',
]);

const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9-]*)[^<>]*>/g;

/**
 * Show tags the renderer would strip as literal text. A model that writes
 * `<action>…</action><result>…</result>` instead of calling a tool should look like
 * what it is, not like real tool output. Tags that render today, autolinks, and
 * anything inside code are left as they are.
 */
export function escapeUnknownTags(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part.replace(TAG_RE, (match: string, name: string) => {
                const after = match.charAt(name.length + (match.startsWith('</') ? 2 : 1));
                if (after === ':' || after === '@' || after === '.') return match;
                return RENDERED_TAGS.has(name.toLowerCase()) ? match : `\\${match}`;
              })
        )
        .join('');
    })
    .join('\n');
}

/** Text as a markdown blockquote, one `> ` per line (blank lines kept inside the quote). */
export function toBlockquote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

/** A prompt that starts with a blockquote (a sent quote) → the quote and the rest. */
export function splitLeadingQuote(text: string): { quote: string | null; body: string } {
  const lines = text.split('\n');
  const quoted: string[] = [];
  let i = 0;
  while (i < lines.length && /^>( |$)/.test(lines[i])) {
    quoted.push(lines[i].replace(/^> ?/, ''));
    i += 1;
  }
  if (quoted.length === 0) return { quote: null, body: text };
  while (i < lines.length && !lines[i].trim()) i += 1;
  return { quote: quoted.join('\n').trim(), body: lines.slice(i).join('\n') };
}

/** The message a quote is sent as: the blockquote, a blank line, then what was typed. */
export function withQuote(quote: string, text: string): string {
  const body = text.trim();
  return body ? `${toBlockquote(quote)}\n\n${body}` : toBlockquote(quote);
}
