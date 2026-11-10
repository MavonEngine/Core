// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Markdown from '../../../src/Editor/UI/Plugins/Markdown'

vi.mock('../../../src/Editor/UI/Plugins/Markdown.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

afterEach(cleanup)

function html(source: string) {
  return render(<Markdown source={source} />).container.firstElementChild!.innerHTML
}

describe('markdown', () => {
  it('renders headings one level down, paragraphs and inline marks', () => {
    expect(html('# Forest ##\n\nPlants **trees** and _rocks_ with `plant()`.\nSecond line.')).toBe(
      '<h2>Forest</h2><p>Plants <strong>trees</strong> and <em>rocks</em> with <code>plant()</code>. Second line.</p>',
    )
  })

  it('renders lists, quotes and rules', () => {
    expect(html('- one\n- two\n\n1. first\n2) second\n\n> quoted\n> text\n\n---')).toBe(
      '<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol><blockquote>quoted text</blockquote><hr>',
    )
  })

  it('keeps code blocks as they are', () => {
    expect(html('```ts\nconst a = **1**\n<b>x</b>\n```\nafter')).toBe(
      '<pre><code>const a = **1**\n&lt;b&gt;x&lt;/b&gt;</code></pre><p>after</p>',
    )
  })

  it('renders tables', () => {
    const table = render(<Markdown source={'| Option | Default |\n| --- | :-: |\n| `path` | /monitoring |\n\ntext'} />).container.querySelector('table')!

    expect(Array.from(table.querySelectorAll('th'), cell => cell.textContent)).toEqual(['Option', 'Default'])
    expect(Array.from(table.querySelectorAll('td'), cell => cell.innerHTML)).toEqual(['<code>path</code>', '/monitoring'])
  })

  it('links only to http(s), and opens them outside the editor', () => {
    const { container } = render(<Markdown source={'[docs](https://example.com/docs "Docs") and [bad](javascript:alert(1)) and ![shot](https://example.com/a.png)'} />)
    const links = [...container.querySelectorAll('a')]

    expect(links.map(a => [a.textContent, a.getAttribute('href'), a.target, a.rel])).toEqual([
      ['docs', 'https://example.com/docs', '_blank', 'noreferrer'],
      ['shot', 'https://example.com/a.png', '_blank', 'noreferrer'],
    ])
    expect(container.textContent).toContain('bad')
    // Images are not loaded
    expect(container.querySelector('img')).toBeNull()
  })

  it('drops html instead of running it', () => {
    const { container } = render(<Markdown source={'<p align="center"><img src=x onerror="alert(1)">Hello</p>\n<!-- hidden -->\n<script>alert(1)</script>'} />)

    expect(container.querySelector('script, img')).toBeNull()
    expect(container.textContent).toBe('Helloalert(1)')
  })

  it('keeps what looks like a tag inside code', () => {
    expect(html('Open `http://<host>:8050/` in <b>a browser</b>.')).toBe('<p>Open <code>http://&lt;host&gt;:8050/</code> in a browser.</p>')
  })

  it('renders nothing for an empty readme', () => {
    expect(html('\n\n')).toBe('')
  })
})
