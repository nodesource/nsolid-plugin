import { createServer } from 'node:http'

/**
 * Picks a random free TCP port inside [minPort, maxPort]. The OAuth server
 * only accepts ports at or below its hard ceiling (src MAX_PORT = 8770), so
 * OS-assigned ephemeral ports cannot be used; callers must pass a window
 * below 8765 disjoint from every other test file's window, keeping parallel
 * `node --test` files from contending for the same ports.
 */
export async function getFreePort (minPort: number, maxPort: number): Promise<number> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = minPort + Math.floor(Math.random() * (maxPort - minPort + 1))
    if (await isFree(candidate)) return candidate
  }
  throw new Error(`no free port found in range ${minPort}-${maxPort}`)
}

function isFree (port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}
