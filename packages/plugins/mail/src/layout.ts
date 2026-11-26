import { readFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** The layout file, in the plugin's `publish` directory and in a project's `resources/@mavonengine/mail/` */
export const LAYOUT_FILE = 'layout.html'

/** The plugin's own layout, used until the project published one */
export const DEFAULT_LAYOUT_PATH = fileURLToPath(new URL(`../publish/${LAYOUT_FILE}`, import.meta.url))

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
}
const HTML_SPECIAL_RE = /[&<>"']/g
/** `{{{ name }}}` first, so it isn't read as `{{ name }}` with braces around */
const PLACEHOLDER_RE = /\{\{\{\s*([\w.-]+)\s*\}\}\}|\{\{\s*([\w.-]+)\s*\}\}/g
/** Comments, apart from Outlook's conditional ones (`<!--[if mso]>`), which hold markup */
const COMMENT_RE = /<!--(?!\[if)[\s\S]*?-->/g
const PARAGRAPHS_RE = /\n\s*\n/
const LINE_BREAK_RE = /\r?\n/g

/** Text made safe to put in HTML: what players wrote, like their names, before it goes into a mail's html */
export function escapeHtml(text: string): string {
  return text.replace(HTML_SPECIAL_RE, char => HTML_ESCAPES[char])
}

/**
 * Fill in a layout: `{{ name }}` with the value escaped, `{{{ name }}}` with it as it is. A name without a value is
 * left empty, so a layout can use names a mail doesn't have. Comments are left out, so a layout can explain its names
 * in one without that, or the mail, ending up in every mail. Outlook's conditional comments stay, filled in
 */
export function renderLayout(layout: string, values: Record<string, string | undefined>): string {
  const fill = (part: string) => part.replace(PLACEHOLDER_RE, (_match, raw: string | undefined, escaped: string | undefined) => {
    const value = values[raw ?? escaped!] ?? ''
    return raw !== undefined
      ? value
      : escapeHtml(value)
  })

  let html = ''
  let last = 0
  for (const comment of layout.matchAll(COMMENT_RE)) {
    html += fill(layout.slice(last, comment.index))
    last = comment.index + comment[0].length
  }
  return html + fill(layout.slice(last))
}

/** A text mail as html: paragraphs at blank lines, line breaks kept */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(PARAGRAPHS_RE)
    .map(paragraph => `<p style="margin: 0 0 16px;">${escapeHtml(paragraph.trim()).replace(LINE_BREAK_RE, '<br>')}</p>`)
    .join('\n')
}

/**
 * Reads the layout: the project's published one when it has it, else the plugin's. Kept once read in production; read
 * again for every mail otherwise, so a changed layout shows in the next mail without restarting
 */
export class LayoutFile {
  private cached?: { path: string, layout: string }

  constructor(private find: () => string | undefined) {}

  /** The path of the layout in use */
  get path(): string {
    return this.find() ?? DEFAULT_LAYOUT_PATH
  }

  read(): string {
    const path = this.path
    if (this.cached?.path === path && process.env.NODE_ENV === 'production')
      return this.cached.layout
    const layout = readFileSync(path, 'utf8')
    this.cached = { path, layout }
    return layout
  }
}
