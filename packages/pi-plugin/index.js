// Pi owns N|Solid skills through package metadata (`pi.skills`).
// Keep this extension entrypoint intentionally side-effect free: authentication
// and MCP config writes happen only through explicit `nsolid-plugin setup --harness pi`.

process.env.NSOLID_HARNESS = 'pi'

export default async function nodesourcePiPlugin () {
  return {
    name: 'nsolid-plugin',
    skills: 'package-owned',
    setup: 'nsolid-plugin setup --harness pi',
  }
}
