import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extractZipRootFolder, downloadZip } from '../src/downloader.ts'

describe('extractZipRootFolder', () => {
  it('returns the root folder name from a list of zip entries', () => {
    const entries = ['Core-0.0.6-alpha/', 'Core-0.0.6-alpha/README.md', 'Core-0.0.6-alpha/src/']
    expect(extractZipRootFolder(entries)).toBe('Core-0.0.6-alpha')
  })

  it('throws if no entry contains a slash', () => {
    expect(() => extractZipRootFolder(['README.md'])).toThrow(
      'Could not determine root folder in zip archive',
    )
  })

  it('throws on empty entry list', () => {
    expect(() => extractZipRootFolder([])).toThrow(
      'Could not determine root folder in zip archive',
    )
  })
})

describe('downloadZip', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws when the server returns a non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response)

    await expect(downloadZip('https://example.com/fake.zip')).rejects.toThrow('404')
  })

  it('throws when the server returns a 500 error', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response)

    await expect(downloadZip('https://example.com/fake.zip')).rejects.toThrow('500')
  })
})
