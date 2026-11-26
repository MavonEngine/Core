const NEWLINE_RE = /\r?\n/

/**
 * A line diff for showing what a migration changes: `-` for removed lines, `+` for added ones, with `context`
 * unchanged lines around each change and `…` where unchanged lines are left out.
 */
export function lineDiff(before: string | undefined, after: string, context = 2): string[] {
  const a = before === undefined
    ? []
    : splitLines(before)
  const b = splitLines(after)

  // Longest common subsequence, from the end
  const lcs = Array.from({ length: a.length + 1 }, () => Array.from<number>({ length: b.length + 1 }).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const ops: { kind: ' ' | '-' | '+', line: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i++] })
      j++
    }
    // Removed lines before the added ones that replace them
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ kind: '-', line: a[i++] })
    }
    else {
      ops.push({ kind: '+', line: b[j++] })
    }
  }

  const near = ops.map((_, index) => ops.slice(Math.max(0, index - context), index + context + 1).some(op => op.kind !== ' '))
  const lines: string[] = []
  ops.forEach((op, index) => {
    if (near[index])
      lines.push(`${op.kind} ${op.line}`.trimEnd())
    else if (near[index - 1] || (index === 0 && ops.length > 1))
      lines.push('  …')
  })
  return lines
}

function splitLines(text: string): string[] {
  const lines = text.split(NEWLINE_RE)
  if (lines.at(-1) === '')
    lines.pop()
  return lines
}
