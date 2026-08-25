import type { UpdateContext, UpdateInstallation, UpdatePlanItem, UpdateResult, UpdateStrategy } from '../types.js'
import { buildGlobalUpdateCommand, formatRollbackCommand, managerArgsForIdentity, verifyGlobalPackage, verifyLocalArtifact } from '../package-manager.js'
import { isCommandSuccessful } from '../command-runner.js'
import { commandFailure, failedResult, isMutableVersion, noMutationStatus, planItem, resultFromPlan } from './common.js'
import { cleanupNpmArtifact } from '../version-source.js'

export const cliPackageStrategy: UpdateStrategy = {
  target: 'cli',
  ownership: 'global-package',

  async plan (installation: UpdateInstallation): Promise<UpdatePlanItem> {
    if (installation.source.kind !== 'global-package' || !installation.metadata?.packagePath) {
      const item = planItem(installation)
      const version = installation.version.latest ?? '<resolved-version>'
      return {
        ...item,
        manualCommands: [
          `npm install --global nsolid-plugin@${version}`,
          `pnpm add --global nsolid-plugin@${version}`,
          `npx -y nsolid-plugin@${version} <command>`,
        ],
      }
    }
    if (!isMutableVersion(installation)) return planItem(installation)
    if (!installation.metadata.packageManagerExecutable || installation.metadata.packageManagerExecutable.kind === 'unsupported') {
      return planItem(installation, [], [], undefined, { code: 'UNSAFE_PACKAGE_MANAGER', message: 'CLI update requires a verified absolute package-manager executable identity' })
    }
    if (installation.version.latest && (installation.artifact?.kind !== 'npm' || !installation.artifact.tarballPath)) {
      return planItem(installation, [], [], undefined, { code: 'ARTIFACT_IDENTITY_REQUIRED', message: 'CLI update requires a verified registry tarball identity' })
    }
    const ownership = {
      manager: installation.source.packageManager,
      packageRoot: installation.metadata.packageRoot ?? '',
      packagePath: installation.metadata.packagePath,
      executable: installation.metadata.packageManagerExecutable,
      rollbackCommand: installation.metadata.rollbackCommand ?? formatRollbackCommand(installation.source.packageManager, installation.version.current),
    }
    const command = buildGlobalUpdateCommand(ownership, installation.version.latest!, installation.artifact?.kind === 'npm' ? installation.artifact : undefined)
    const rollbackArgs = installation.version.current
      ? managerArgsForIdentity(ownership.executable, installation.source.packageManager === 'npm'
        ? ['install', '--global', `nsolid-plugin@${installation.version.current}`]
        : ['add', '--global', `nsolid-plugin@${installation.version.current}`])
      : undefined
    return planItem(
      installation,
      [
        { kind: 'command', description: 'Update the globally owned CLI package at the resolved version', command },
        {
          kind: 'validation',
          description: 'Verify the positively identified global package root',
          checks: [`${installation.metadata.packagePath}/package.json has name nsolid-plugin and version ${installation.version.latest}`],
        },
      ],
      rollbackArgs
        ? [{
            kind: 'command',
            description: 'Restore the previously installed CLI version',
            command: {
              executable: rollbackArgs.executable,
              args: rollbackArgs.args,
              timeoutMs: 120_000,
            },
          }]
        : [],
      'Invoke nsolid-plugin again (or start a new shell) to use the new CLI code'
    )
  },

  async execute (item: UpdatePlanItem, context: UpdateContext): Promise<UpdateResult> {
    if (item.planningError) return failedResult(item, item.planningError)
    if (item.steps.length === 0) {
      if (item.source.kind === 'unsupported') return resultFromPlan(item, 'unsupported')
      return resultFromPlan(item, noMutationStatus(item.version))
    }
    const commandStep = item.steps.find((step) => step.kind === 'command')
    if (!commandStep || commandStep.kind !== 'command') return failedResult(item, { code: 'INVALID_PLAN', message: 'CLI update plan has no command' })
    if (item.artifact?.kind === 'npm' && !verifyLocalArtifact(item.artifact)) {
      await cleanupNpmArtifact(item.artifact)
      return failedResult(item, { code: 'ARTIFACT_INTEGRITY_FAILED', message: 'The planned CLI tarball no longer matches its registry integrity' })
    }
    const result = await context.commandRunner.run(commandStep.command)
    if (!isCommandSuccessful(result)) {
      if (result.timedOut && result.treeTerminated !== true) {
        return failedResult(item, { code: 'CLI_TREE_TERMINATION_UNCONFIRMED', message: 'CLI update timed out and descendant termination could not be confirmed; the package artifact was preserved' })
      }
      await cleanupNpmArtifact(item.artifact?.kind === 'npm' ? item.artifact : undefined)
      return failedResult(item, commandFailure(commandStep.command.executable, result.timedOut, result.spawnErrorCode))
    }
    const packagePath = item.metadata?.packagePath
    if (!packagePath || !item.version.latest || !verifyGlobalPackage({
      manager: item.source.kind === 'global-package' ? item.source.packageManager : 'npm',
      packageRoot: item.metadata?.packageRoot ?? '',
      packagePath,
      executable: item.metadata?.packageManagerExecutable ?? { kind: 'unsupported', reason: 'not-found' },
      rollbackCommand: '',
    }, item.version.latest, item.artifact?.kind === 'npm' ? item.artifact : undefined)) {
      await cleanupNpmArtifact(item.artifact?.kind === 'npm' ? item.artifact : undefined)
      return failedResult(item, {
        code: 'CLI_VERSION_MISMATCH',
        message: 'Package manager completed but the identified global package has the wrong version',
      })
    }
    await cleanupNpmArtifact(item.artifact?.kind === 'npm' ? item.artifact : undefined)
    return resultFromPlan(item, 'updated', { resultingVersion: item.version.latest })
  },
}
