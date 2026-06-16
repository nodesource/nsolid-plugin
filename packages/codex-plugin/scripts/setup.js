import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

process.env.NSOLID_HARNESS = 'codex'

async function resolveSetupScript () {
  // Prefer Node's module resolution so this works both in the pnpm workspace
  // and when the plugin is installed in a harness cache with its own node_modules.
  try {
    return fileURLToPath(await import.meta.resolve('@nodesource/plugin-core/scripts/setup.mjs'))
  } catch {
    // Fallback for unusual layouts: look next to this file's node_modules.
    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    return path.resolve(__dirname, '../node_modules/@nodesource/plugin-core/scripts/setup.mjs')
  }
}

const setupScript = await resolveSetupScript()

const child = spawn(process.execPath, [setupScript], {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})

child.on('error', (err) => {
  console.error(`Failed to start setup script: ${err.message}`)
  process.exit(1)
})
