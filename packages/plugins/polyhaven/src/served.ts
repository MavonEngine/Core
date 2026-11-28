export const SERVED_TIMEOUT_MS = 15_000
const SERVED_POLL_MS = 150

/**
 * Wait until the dev server serves the files an import just wrote into the public directory. Vite keeps a list of the
 * public files and only adds new ones when its file watcher reports them: until then it answers with the game's page.
 */
export async function waitUntilServed(urls: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  const deadline = Date.now() + SERVED_TIMEOUT_MS
  const served = async (url: string) => {
    const res = await fetchImpl(url, { method: 'HEAD', cache: 'no-store' }).catch(() => undefined)
    return !!res?.ok && !res.headers.get('content-type')?.includes('text/html')
  }
  let waiting = urls
  while (waiting.length) {
    const results = await Promise.all(waiting.map(served))
    waiting = waiting.filter((_, i) => !results[i])
    if (!waiting.length)
      return
    if (Date.now() > deadline)
      throw new Error(`The dev server doesn't serve ${waiting.join(', ')} yet. Reload the page to load them`)
    await new Promise(resolve => setTimeout(resolve, SERVED_POLL_MS))
  }
}
