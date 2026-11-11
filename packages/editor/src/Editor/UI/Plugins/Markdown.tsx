import type { ReactNode } from 'react'
import styles from './Markdown.module.css'

/**
 * A small Markdown renderer for plugin readmes: headings, paragraphs, lists, quotes, tables, code and the
 * usual inline marks. It builds React elements and never inserts HTML, so a readme can't run anything in the editor:
 * HTML tags in it are dropped and only http(s) links become links.
 */

const FENCE_RE = /^\s*(`{3,}|~{3,})/
const HEADING_RE = /^(#{1,6})\s(.*)$/
/** `## Title ##` closes a heading with hashes */
const CLOSING_HASHES_RE = /\s#+$/
const RULE_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const BULLET_RE = /^\s*[-*+]\s(.*)$/
const NUMBERED_RE = /^\s*\d+[.)]\s(.*)$/
const QUOTE_RE = /^\s*>\s?(.*)$/
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const TABLE_DIVIDER_CELL_RE = /^:?-+:?$/
const LEADING_PIPE_RE = /^\|/
const TRAILING_PIPE_RE = /\|$/
const NEWLINE_RE = /\r?\n/
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const CODE_SPAN_RE = /(`[^`]+`)/
const SAFE_URL_RE = /^https?:\/\//i
/** Code, images, links, bold, italic: whichever comes first in the text */
const INLINE_RE = /`([^`]+)`|!\[([^\]]*)\]\(([^)\s]+)(?:\s[^)]*)?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s[^)]*)?\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\b_([^_\s][^_]*)_\b/g

function link(text: ReactNode, url: string, key: number): ReactNode {
  return SAFE_URL_RE.test(url)
    ? <a key={key} href={url} target="_blank" rel="noreferrer">{text}</a>
    : <span key={key}>{text}</span>
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0

  for (const match of text.matchAll(INLINE_RE)) {
    if (match.index > last)
      nodes.push(text.slice(last, match.index))
    last = match.index + match[0].length

    const [, code, imageAlt, imageUrl, linkText, linkUrl, bold, boldAlt, italic, italicAlt] = match
    if (code !== undefined)
      nodes.push(<code key={key++}>{code}</code>)
    else if (imageUrl !== undefined)
      // Images are not loaded: a readme shouldn't make the editor call out
      nodes.push(link(imageAlt || 'image', imageUrl, key++))
    else if (linkUrl !== undefined)
      nodes.push(link(inline(linkText), linkUrl, key++))
    else if (bold !== undefined || boldAlt !== undefined)
      nodes.push(<strong key={key++}>{inline(bold ?? boldAlt)}</strong>)
    else
      nodes.push(<em key={key++}>{inline(italic ?? italicAlt)}</em>)
  }

  if (last < text.length)
    nodes.push(text.slice(last))
  return nodes
}

/** Drop HTML tags, but not what looks like one inside `code`, such as `http://<host>/` */
function stripHtml(text: string): string {
  return text.split(CODE_SPAN_RE).map((part, i) => i % 2 ? part : part.replace(HTML_TAG_RE, '')).join('')
}

function cells(row: string): string[] {
  return row.trim().replace(LEADING_PIPE_RE, '').replace(TRAILING_PIPE_RE, '').split('|').map(cell => cell.trim())
}

/** The `| --- | :-: |` line under a table's header */
function isTableDivider(line: string): boolean {
  return line.includes('-') && cells(line).every(cell => TABLE_DIVIDER_CELL_RE.test(cell))
}

function isBlockStart(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || RULE_RE.test(line) || BULLET_RE.test(line)
    || NUMBERED_RE.test(line) || QUOTE_RE.test(line) || TABLE_ROW_RE.test(line)
}

export default function Markdown({ source }: { source: string }) {
  // Tags are dropped before anything else, the text between them stays
  const lines = source.replace(HTML_COMMENT_RE, '').split(NEWLINE_RE)
  const blocks: ReactNode[] = []
  let i = 0

  /** Lines from `i` on while `matches`, each mapped to its content */
  const take = (re: RegExp) => {
    const taken: string[] = []
    while (i < lines.length && re.test(lines[i]))
      taken.push(re.exec(lines[i++])![1] ?? '')
    return taken
  }

  while (i < lines.length) {
    const line = lines[i]
    const key = blocks.length

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1]))
        code.push(lines[i++])
      i++
      blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>)
      continue
    }

    const text = stripHtml(line)
    if (text.trim() === '') {
      i++
      continue
    }

    const heading = HEADING_RE.exec(text)
    if (heading) {
      i++
      // One level down: the plugin's name is the heading of the page
      const Tag = `h${Math.min(6, heading[1].length + 1)}` as 'h2'
      blocks.push(<Tag key={key}>{inline(heading[2].trim().replace(CLOSING_HASHES_RE, '').trim())}</Tag>)
      continue
    }

    if (RULE_RE.test(text)) {
      i++
      blocks.push(<hr key={key} />)
      continue
    }

    if (TABLE_ROW_RE.test(text) && isTableDivider(lines[i + 1] ?? '')) {
      const head = cells(text)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]))
        rows.push(cells(stripHtml(lines[i++])))
      blocks.push(
        <div key={key} className={styles.tableWrap}>
          <table>
            <thead><tr>{head.map((cell, c) => <th key={c}>{inline(cell)}</th>)}</tr></thead>
            <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }

    if (BULLET_RE.test(text)) {
      blocks.push(<ul key={key}>{take(BULLET_RE).map((item, n) => <li key={n}>{inline(stripHtml(item).trim())}</li>)}</ul>)
      continue
    }

    if (NUMBERED_RE.test(text)) {
      blocks.push(<ol key={key}>{take(NUMBERED_RE).map((item, n) => <li key={n}>{inline(stripHtml(item).trim())}</li>)}</ol>)
      continue
    }

    if (QUOTE_RE.test(text)) {
      blocks.push(<blockquote key={key}>{inline(stripHtml(take(QUOTE_RE).join(' ')))}</blockquote>)
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && (paragraph.length === 0 || !isBlockStart(lines[i])))
      paragraph.push(stripHtml(lines[i++]).trim())
    const joined = paragraph.join(' ').trim()
    if (joined)
      blocks.push(<p key={key}>{inline(joined)}</p>)
  }

  return <div className={styles.markdown}>{blocks}</div>
}
