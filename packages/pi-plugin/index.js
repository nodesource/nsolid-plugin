import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { install } from '@nodesource/plugin-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let corePkgRoot
try {
  corePkgRoot = path.dirname(fileURLToPath(await import.meta.resolve('@nodesource/plugin-core/package.json')))
} catch {
  corePkgRoot = path.resolve(__dirname, 'node_modules', '@nodesource/plugin-core')
}
const bundlePath = path.join(corePkgRoot, 'bundle.json')
const skillsSource = corePkgRoot

process.env.NSOLID_HARNESS = 'pi'

export default async function nodesourcePiPlugin () {
  const result = await install({ harness: 'pi', bundlePath, skillsSource })
  if (!result.success) {
    console.error('NodeSource setup failed:')
    for (const err of result.errors) {
      console.error(`  - ${err}`)
    }
  } else {
    console.log(`NodeSource skills installed for Pi: ${result.skillsInstalled}`)
  }
  return result
}
