// Pi owns N|Solid skills through package metadata (`pi.skills`).
// side-effect free: authentication and MCP config writes happen only
// through explicit `nsolid-plugin setup --harness pi`.

export default async function nodesourcePiPlugin () {
  return {
    name: 'nsolid-plugin',
    skills: 'package-owned',
    setup: 'nsolid-plugin setup --harness pi',
  }
}
