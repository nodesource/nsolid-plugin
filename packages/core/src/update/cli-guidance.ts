import { isStableVersion } from './version.js'

/**
 * Complete exact-version recovery commands for an unowned CLI launch.
 * Guidance is emitted only after registry resolution produced a concrete
 * stable version; placeholders and unversioned package-manager commands are
 * intentionally never returned.
 */
export function cliExactVersionManualCommands (latestVersion: string | undefined, launcherSource?: string): string[] {
  if (!isStableVersion(latestVersion)) return []
  const commands = [
    `npm install --global nsolid-plugin@${latestVersion}`,
    `pnpm add --global nsolid-plugin@${latestVersion}`,
    `npx -y nsolid-plugin@${latestVersion} <command>`,
  ]
  const launcherSegments = launcherSource?.replaceAll('\\', '/').split('/') ?? []
  if (launcherSegments.includes('.volta')) {
    commands.push(`volta install nsolid-plugin@${latestVersion}`)
  }
  return commands
}
