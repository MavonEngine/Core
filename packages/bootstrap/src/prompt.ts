import { createInterface } from 'node:readline'

export function promptProjectName(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  return new Promise((resolve) => {
    rl.question('Project name: ', (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}
