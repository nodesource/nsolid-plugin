# Update lifecycle

This guide describes the fallback and native update lifecycle implemented by the
update coordinator. A check plan is read-only; a mutation plan captures verified
artifact identity, trusted ownership evidence, and (for fallback) a nonce-bound
transaction manifest before execution.

## States and transitions

1. **Planned** — inventory and version resolution produce an `UpdatePlan`. A
   mutable fallback plan also owns a private manifest staging directory. No
   live destination is changed during planning.
2. **Awaiting approval** — the coordinator may return a confirmation-required
   result. Planning resources are released only when no recovery or execution
   evidence requires preservation.
3. **Journal open / mutating** — the fallback parent snapshots authenticated
   owned paths and obtains an in-memory journal handle. The child must validate
   the manifest, nonce, result containment, and frontier evidence before it
   claims mutation authority.
4. **Command finished** — a zero exit code is not enough. The command runner
   must report `treeTerminated: true` before the parent can reclaim authority or
   roll back. An unconfirmed tree leaves recovery state unresolved.
5. **Committed** — after the parent reclaims the owner handle, journal evidence
   and postconditions prove the update. The journal commits and removes only
   authenticated backup/quarantine material.
6. **Recovered or preserved** — a confirmed failure goes through journal-owned
   restore. A failed proof, concurrent change, or incomplete durable journal
   operation preserves the journal, snapshot, quarantine, and affected live
   paths for the next recovery decision. Next-run check mode only reports this
   state; a non-check plan may restore authenticated owned paths, but the
   journal and snapshot remain and block a new mutation.

## Cleanup ownership

- The **coordinator** releases verified npm artifact downloads and directories
  recorded by the plan as planning-owned. It never derives a deletion target
  from command arguments or child-reported paths.
- The **fallback strategy** owns its execution workspace and fresh child-result
  directory. Their cleanup decision is an internal execution outcome:
  `{ result, planResources: 'release' | 'preserve' }`. Missing or malformed
  authorization preserves planning resources.
- The **journal module** owns authenticated snapshots, backups, stages,
  quarantines, recovery, and commit. Child preservation arrays are reporting
  only and never authorize deletion or overwrite.
- Native strategy modules retain ownership of their own rollback bundles and
  use their existing conservative preservation decisions.

The two fallback execution directories remain separate. Their independent
containment identities and different preservation needs are security evidence;
combining them would not provide a meaningful simplification without weakening
replay, symlink/concurrent replacement, or detached-child recovery checks.

## Public and internal results

`UpdateStrategy.execute` and `executeUpdatePlan` keep their result-only public
interfaces. The coordinator consumes the fallback strategy's internal outcome,
but publishes only `UpdateResult` values inside `UpdateSummary`; `planResources`
is never present in public JSON. Public rollback and preservation fields are
reporting projections, not cleanup authority.

## Safety invariants

- Only explicit whole-tree termination evidence authorizes journal reclaim or
  rollback; exit status and timeout absence do not.
- A trusted in-memory manifest, authenticated backup/CAS evidence, genuine
  handles, and recorded containment identities authorize filesystem operations.
  Mutable journal fields and child assertions do not create authority.
- Nonce-bound child results, result-directory identity checks, frontier proofs,
  and pre/post asynchronous checks remain mandatory.
- Concurrent edits, unconfirmed descendants, unauthenticated backups, and
  incomplete durable bookkeeping are preserved rather than overwritten or
  deleted.
- Physical restoration and durable journal finalization remain distinct facts.
  A restored path with pending journal bookkeeping is still an incomplete
  recovery and remains reportable.
