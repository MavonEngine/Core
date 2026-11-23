/**
 * Stands in for npm during the upgrade e2e test: appends what it was asked to NPM_RECORDER_LOG, one JSON array of
 * arguments per line, and changes nothing. A real install would replace the npm-linked @mavonengine/core with the
 * fake registry's version, which doesn't exist.
 */
import { appendFileSync } from 'node:fs'
import process from 'node:process'

appendFileSync(process.env.NPM_RECORDER_LOG, `${JSON.stringify(process.argv.slice(2))}\n`)
process.stdout.write(`npm-recorder: npm ${process.argv.slice(2).join(' ')}\n`)
