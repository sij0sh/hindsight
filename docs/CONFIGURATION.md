# Repository configuration

`/knowledge init` writes `.agents/curation/config.json` and copies the distributed registry into `.agents/curation/registry.json`. Configuration is JSON, with unknown keys rejected. Registry edits are treated as code-reviewable routing policy.

## Main settings

| Key | Default | Meaning |
| --- | --- | --- |
| `auto` | `scan` | `off`, deterministic `scan`, or curator `run` after completed Pi turns |
| `maxAutoJobs` | 3 | Maximum attempted jobs per automatic event |
| `candidateDelayEvents` | 3 | Event age before weak candidates are eligible |
| `retryDelayEvents` | 3 | Cooldown for unchanged failed or blocked work |
| `maxTurns` | 90 | Maximum model turns per curator attempt |
| `timeoutMs` | 180000 | Wall-time deadline for an active curator prompt |
| `maxDerivedChecks` | 16 | Additional criteria beyond required catalog checks |
| `maxFileBytes` | 500000 | Maximum text file/Git-layer size exposed as evidence |
| `maxSnapshotBytes` | 30000000 | Bound for repository/layer inventory bytes and separately session text inventory |
| `maxFiles` | 20000 | Maximum inventory file count |
| `maxReadChars` | 18000 | Evidence characters returned per tool call |
| `maxDocumentChars` | 40000 | Maximum original/generated Markdown view length |
| `maxSessionBatchChars` | 80000 | New session text processed per domain attempt |
| `historyWindow` | 30 | Git commits examined for churn |
| `churnThreshold` | 10 | Minimum appearances in that history window to flag a hotspot |
| `maxRecords` | 2000 | All ledger records, including tombstones and conflicts |
| `maxMemoryStatementChars` | 1200 | Maximum one-paragraph claim length |
| `maxLedgerBytes` | 8000000 | Serialized ledger bytes, including audit events and projection hashes |
| `maxContextChars` | 12000 | Selected record payload budget; wrappers and omission metadata are additional |
| `contextInjection` | `false` | Inject scoped context for known paths explicitly mentioned in a Pi prompt |
| `provider`, `model` | `null`, `null` | Set both to use a dedicated curator model |

All numeric settings must be positive integers. An oversized single session entry is not split or silently dropped: raise `maxSessionBatchChars` to process it. A repository exceeding collection bounds stops before making model calls. Raising limits also increases potential model work.

`exclude`, `sensitive`, and `sensitiveAllow` are glob arrays. The supported glob syntax is `*`, `**`, and `?`. There are no braces, regexes, negation, or extglobs. `**/package.json` matches both the root and nested manifests.

Default generated exclusions include build, coverage, dist, vendor, node_modules, snapshots, and minified JavaScript. `.agents/engineering/**` and `.agents/curation/**` are always excluded from source routing. Ledger semantics and view edits have separate fingerprint checks. Registry/config changes use their own fingerprint. Import archives needed for review are exposed separately and count against repository snapshot bytes.

Record, ledger, and view limits are checked before a transaction. History is not silently pruned. Keep an audit backup and deliberately archive/migrate before raising capacity on a large repository. `maxContextChars` limits serialized selected records, not the whole response or model tokens. `--max-chars` overrides it for a query; omitted matching IDs remain visible.

`contextInjection` uses explicitly mentioned known relative paths, with the full domain index as fallback. It does not infer task paths from Git dirtiness. For paths containing spaces, use `/knowledge context --paths "path with spaces.ts"`. Symbols match exactly; concepts match exactly ignoring case. Queries combine selectors with OR and include global records.

Sensitive defaults include `.env`, `.env.*`, PEM/key files, and conventional credential/auth JSON files; `.env.example`, `.env.sample`, and `.env.template` are explicitly allowed. Customize these before first curation if your repository stores confidential material elsewhere. Models also receive ordinary user/assistant session text captured for intent and policy investigations.

## Registry structure

Each of the fixed ten domain IDs declares:

- Canonical path and positive criterion version.
- `inputPaths`: the file surface contributing to freshness.
- `sessions`: whether incremental user/assistant text is relevant.
- `baseline`: mandatory domain checks in every incremental investigation.
- `criteria`: stable IDs and concrete investigation questions.
- `rules`: trigger ID, `affected` or `candidate` confidence, path patterns and/or signal, and mandatory criterion IDs.

The common catalog and `MEMORY-RECONCILE-001` are applied to every ledger-backed domain. Built-in registry signals are `session`, `imports`, `execution`, `security`, `maintenance`, and `churn`. Memory changes, open conflicts, and scar removal review are additional host triggers. Memory scope and provenance paths supplement `inputPaths`. Session-backed memories also make sessions relevant to that domain. Rules do not execute arbitrary commands.

Scar `removalSignals` are `{type: "paths_absent" | "path_present", path: "relative/glob"}` entries. All signals must be satisfied to produce a removal-review candidate. They evaluate the bounded Git inventory; absence of an ignored/excluded path is not proof that a business condition is met. The curator must verify the free-text `removalCondition` before retiring a scar.

Any registry or configuration change triggers a complete domain reconciliation because the stored rule fingerprint changes. This includes scheduling changes, a conservative simplification that favors explicit reconciliation over silently retaining a baseline under changed settings.

## Recovery and review

If a run is interrupted, retry. A remaining transaction is recovered after acquiring the repository lock. If the dead process left `run.lock`, use `/knowledge unlock` or the CLI equivalent. The command refuses live processes and foreign host locks. Never delete an active process's lock.

If recovery reports external edits, preserve a backup and compare every journal target with its expected and proposed hashes and the referenced investigation. There is no force-overwrite command. Resolve the external edit deliberately so each target matches either its expected old contents or desired new contents, then retry recovery. Do not simply discard a partially applied journal: the ledger, views, and state could disagree. Readers refuse pending journals.

For manual edits to generated views outside an interrupted transaction, run `/knowledge migrate` to preserve originals and import unverified candidates before regeneration. Migration invalidates all old domain inspection baselines. Accepted decision files need `status: accepted` in initial YAML frontmatter or `Status: Accepted` within the first 12 lines; an ordinary mention in prose is insufficient.

To review a blocked domain, open its `last-investigation.json`. Find criteria with `conflict`, `adr_candidate`, or `insufficient_evidence`; inspect their receipt references and proposed alternatives. The extension does not accept decisions or fix production code on behalf of a curator.
