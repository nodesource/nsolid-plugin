import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

let installed = false

async function resolveSetupScript () {
  // Prefer Node's module resolution so this works both in the pnpm workspace
  // and when the plugin is installed as an npm package.
  try {
    return fileURLToPath(await import.meta.resolve('@nodesource/plugin-core/scripts/setup.mjs'))
  } catch {
    // Fallback for unusual layouts.
    const __dirname = path.dirname(fileURLToPath(import.meta.url))
    return path.resolve(__dirname, 'node_modules/@nodesource/plugin-core/scripts/setup.mjs')
  }
}

async function ensureInstalled () {
  if (installed) return
  installed = true
  try {
    process.env.NSOLID_HARNESS = 'opencode'
    const setupScript = await resolveSetupScript()

    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [setupScript], {
        stdio: 'inherit',
        env: process.env,
      })
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Setup exited with code ${code}`)))
      child.on('error', reject)
    })
  } catch (e) {
    console.error('NodeSource setup failed:', e.message)
  }
}

export const NsolidPlugin = async (ctx) => {
  await ensureInstalled()
  return {
    'session.created': async () => ensureInstalled(),
  }
}
