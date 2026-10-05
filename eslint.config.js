import neostandard from 'neostandard'

export default neostandard({
  ts: true,
  ignores: [
    '**/dist/**',
    // Built in the N|Solid Console's repository (packages/viz) and copied here as is.
    '**/nsolid-report.cjs'
  ]
})
