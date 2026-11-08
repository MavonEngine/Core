import process from 'node:process'
import { DEPRECATION_NOTICE, isSupportedNode, MIN_NODE_MAJOR, runCreate } from './wrapper.js'

// Deprecated: everything happens in `mavonengine create` now, this only forwards to it
process.stderr.write(DEPRECATION_NOTICE)

if (!isSupportedNode(process.version)) {
  process.stderr.write(`@mavonengine/cli needs Node ${MIN_NODE_MAJOR} or newer, this is ${process.version}\n`)
  process.exit(1)
}

runCreate(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch((err: Error) => {
    process.stderr.write(`create-bootstrap: could not start @mavonengine/cli: ${err.message}\n`)
    process.exit(1)
  })
