import { createProject } from './create.js'
import { promptProjectName } from './prompt.js'

async function main(): Promise<void> {
  let projectName = process.argv[2]?.trim()

  if (!projectName) {
    projectName = await promptProjectName()
  }

  if (!projectName) {
    console.error('Error: project name is required')
    process.exit(1)
  }

  if (!/^[\w@./-][\w@./\- ]*$/.test(projectName)) {
    console.error('Error: invalid project name')
    process.exit(1)
  }

  try {
    const dir = await createProject({ projectName })
    console.log(`\nDone! Your project is ready at ${dir}`)
  }
  catch (err) {
    console.error(`\nError: ${(err as Error).message}`)
    process.exit(1)
  }
}

main()
