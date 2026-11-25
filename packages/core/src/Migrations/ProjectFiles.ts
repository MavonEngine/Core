import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/**
 * Node only. The files of a project as a migration sees them: reads come from disk, writes are kept until
 * `commit()`, so `mavonengine upgrade` can show what would change before anything does.
 *
 * Paths are relative to the project root, with `/`.
 */
export interface FileChange {
  path: string
  /** Undefined for a new file */
  before?: string
  after: string
}

const INDENT_RE = /^[ \t]+(?=")/m

export class ProjectFiles {
  readonly root: string
  private readonly staged = new Map<string, string>()

  constructor(root: string) {
    this.root = resolve(root)
  }

  private full(path: string): string {
    const full = resolve(this.root, path)
    if (full !== this.root && !full.startsWith(this.root + sep))
      throw new Error(`${path} is outside the project`)
    return full
  }

  private onDisk(path: string): string | undefined {
    const full = this.full(path)
    return existsSync(full)
      ? readFileSync(full, 'utf8')
      : undefined
  }

  exists(path: string): boolean {
    return this.staged.has(path) || existsSync(this.full(path))
  }

  /** The file with the changes made so far, or undefined when it doesn't exist */
  read(path: string): string | undefined {
    return this.staged.get(path) ?? this.onDisk(path)
  }

  write(path: string, content: string): void {
    this.full(path)
    if (this.onDisk(path) === content)
      this.staged.delete(path)
    else
      this.staged.set(path, content)
  }

  /** The parsed file, or undefined when it doesn't exist. Throws when it isn't JSON */
  readJson<T = Record<string, any>>(path: string): T | undefined {
    const text = this.read(path)
    if (text === undefined)
      return undefined

    try {
      return JSON.parse(text) as T
    }
    catch (err) {
      throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
    }
  }

  /** Write JSON indented like the file already is (two spaces for a new one), with a newline at the end */
  writeJson(path: string, value: unknown): void {
    const indent = INDENT_RE.exec(this.read(path) ?? '')?.[0] ?? '  '
    this.write(path, `${JSON.stringify(value, null, indent)}\n`)
  }

  /** What `commit()` would write, in the order the files were first changed */
  changes(): FileChange[] {
    return Array.from(this.staged, ([path, after]) => ({
      path,
      before: this.onDisk(path),
      after,
    }))
  }

  /** Write every change to disk */
  commit(): FileChange[] {
    const changes = this.changes()
    for (const { path, after } of changes) {
      const full = this.full(path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, after)
    }
    this.staged.clear()
    return changes
  }
}
