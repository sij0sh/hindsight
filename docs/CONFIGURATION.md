# Repository configuration

`/hindsight init` writes `.agents/curation/config.json` and copies the distributed registry into `.agents/curation/registry.json`. Configuration is JSON, with unknown keys rejected. Registry edits are treated as code-reviewable routing policy.

## Main settings

| Key | Default | Meaning |
| --- | --- | --- |
| `auto` | `run` | `off`, deterministic `scan`, or curator `run` after completed Pi turns. New repos default to automatic curation; existing repos keep their stored value |
| `maxAutoJobs` | 3 | Maximum attempted jobs per automatic event |
| `candidateDelayEvents` | 3 | Event age before weak candidates are eligible |
| `retryDelayEvents` | 3 | Cooldown for unchanged failed or blocked work |
| `maxTurns` | 90 | Maximum model turns per curator attempt |
| `timeoutMs` | 1800000 | Wall-time deadline for an active curator prompt |
| `maxDerivedChecks` | 16 | Additional criteria beyond required catalog checks |
| `maxFileBytes` | 500000 | Maximum text file/Git-layer size exposed as evidence |
| `maxSnapshotBytes` | 30000000 | Bound for repository/layer inventory bytes and separately session text inventory |
| `maxFiles` | 20000 | Maximum inventory file count |
| `maxReadChars` | 18000 | Evidence characters returned per tool call |
| `maxCoverageBundleChars` | 600000 | Maximum serialized characters per coverage bundle part; oversized bundles are reported as unavailable rather than truncated |
| `maxCoverageBundleParts` | 8 | Maximum evidence parts per logical coverage bundle before it reports unavailable |
| `maxGitHistoryCommits` | 100 | Bounded commit window captured as curator history evidence |
| `maxGitPatchChars` | 60000 | Maximum per-file historical patch characters; larger patches are omitted with their size reported |
| `maxDocumentChars` | 40000 | Maximum original/generated Markdown view length |
| `maxSessionBatchChars` | 80000 | New session episode text processed per domain attempt |
| `historyWindow` | 30 | Git commits examined for churn signals |
| `churnThreshold` | 10 | Minimum appearances in that history window to flag a hotspot |
| `maxRecords` | 2000 | All ledger records, including tombstones and conflicts |
| `maxMemoryStatementChars` | 1200 | Maximum one-paragraph claim length |
| `maxLedgerBytes` | 8000000 | Serialized ledger bytes, including audit events and projection hashes |
| `maxContextChars` | 12000 | Selected record payload budget; wrappers and omission metadata are additional |
| `museAutoImport` | `true` | Pull new Muse Code sessions for the repository on every `run`/`force`, including `scanOnly` runs; `false` keeps Pi-only behavior |
| `maxMuseImportChars` | 500000 | New Muse record characters imported per run; the backlog drains across runs via per-session sequence cursors |
| `contextInjection` | `false` | Inject scoped context for known paths explicitly mentioned in a Pi prompt |
| `provider`, `model` | `azure-gateway-responses`, `gpt-6-luna` | Dedicated curator model resolved from Pi's model registry; set both to override |

All numeric settings must be positive integers. Complete-survey investigations (initial, forced, missing-view, or rule/config-changed reconciliation) derive virtual `bundle:code` and `bundle:prose` evidence from the immutable working-tree snapshot. Jobs with pending session episodes derive `bundle:sessions` from normalized user-anchored episodes, and jobs with selected history derive `bundle:git` from the bounded commit window (full window for complete surveys, baseline-to-HEAD deltas touching the domain surface otherwise; a rewritten baseline reports `history_diverged` with a bounded fallback survey). Each available required bundle part must be read completely before success. `maxCoverageBundleChars` is a per-part character cap and `maxCoverageBundleParts` caps the part count; a bundle over either is marked `unavailable_too_large` in the manifest and is never silently truncated or described as complete. An oversized single session episode is not split or silently dropped: raise `maxSessionBatchChars` to process it. A repository exceeding collection bounds stops before making model calls. Raising limits also increases potential model work.

`exclude`, `sensitive`, and `sensitiveAllow` are glob arrays. The supported glob syntax is `*`, `**`, and `?`. There are no braces, regexes, negation, or extglobs. `**/package.json` matches both the root and nested manifests.

Default generated exclusions include build, coverage, dist, vendor, node_modules, snapshots, and minified JavaScript. `.agents/engineering/**` and `.agents/curation/**` are always excluded from source routing. Ledger semantics and view edits have separate fingerprint checks. Registry/config changes use their own fingerprint. Import archives needed for review are exposed separately and count against repository snapshot bytes.

Record, ledger, and view limits are checked before a transaction. History is not silently pruned. Keep an audit backup and deliberately archive/migrate before raising capacity on a large repository. `maxContextChars` limits serialized selected records, not the whole response or model tokens. `--max-chars` overrides it for a query; omitted matching IDs remain visible.

`contextInjection` uses explicitly mentioned known relative paths, with the full domain index as fallback. It does not infer task paths from Git dirtiness. For paths containing spaces, use `/hindsight context --paths "path with spaces.ts"`. Symbols match exactly; concepts match exactly ignoring case. Queries combine selectors with OR and include global records. Index injection only runs when `auto` is not `off`.

Sensitive defaults include `.env`, `.env.*`, PEM/key files, and conventional credential/auth JSON files; `.env.example`, `.env.sample`, and `.env.template` are explicitly allowed. Customize these before first curation if your repository stores confidential material elsewhere. The same exclusion, sensitivity, generated-path, binary, and size filtering applies independently to historical Git material. Models receive normalized session episodes for intent and policy investigations: exact user/assistant text plus compact tool-call summaries with structured outcomes. Muse Code episodes count toward `maxSnapshotBytes` and `maxSessionBatchChars` identically; only sessions recorded for the repository are imported, subagent transcripts are excluded, and raw tool-result bodies, shell output, file contents, diffs, and reasoning blocks are never indexed.

## Registry structure

Each of the fixed ten domain IDs declares:

- Canonical path and positive criterion version.
- `inputPaths`: the file surface contributing to freshness.
- `sessions`: whether incremental normalized session episodes are relevant.
- `baseline`: mandatory domain checks in every incremental investigation.
- `criteria`: stable IDs and concrete investigation questions.
- `rules`: trigger ID, `affected` or `candidate` confidence, path patterns and/or signal, and mandatory criterion IDs.

The common catalog and `MEMORY-RECONCILE-001` are applied to every ledger-backed domain. Built-in registry signals are `session`, `imports`, `execution`, `security`, `maintenance`, and `churn`. Memory changes, open conflicts, and scar removal review are additional host triggers. Memory scope and provenance paths supplement `inputPaths`. Session-backed memories also make sessions relevant to that domain. Rules do not execute arbitrary commands.

Scar `removalSignals` are `{type: "paths_absent" | "path_present", path: "relative/glob"}` entries. All signals must be satisfied to produce a removal-review candidate. They evaluate the bounded Git inventory; absence of an ignored/excluded path is not proof that a business condition is met. The curator must verify the free-text `removalCondition` before retiring a scar.

Any registry or configuration change triggers a complete domain reconciliation because the stored rule fingerprint changes. This includes scheduling changes, a conservative simplification that favors explicit reconciliation over silently retaining a baseline under changed settings.

## Recovery and review

Pi-triggered `run` and `force` execute in a detached background process that survives the Pi terminal closing; `/hindsight scan` reports its pid and per-run logs land under `.agents/curation/logs/`. Use `/hindsight cancel` (or `cancel --cwd`) to signal a live run to stop.

If a run is interrupted, retry. A remaining transaction is recovered after acquiring the repository lock. A dead local process's `run.lock` is purged automatically by the next write, which then recovers the journal. Live, foreign-host, and corrupt locks stay blocked for manual review; use `/hindsight unlock` or the CLI equivalent for those uncertain cases. Never delete an active process's lock.

If recovery reports external edits, preserve a backup and compare every journal target with its expected and proposed hashes and the referenced investigation. There is no force-overwrite command. Resolve the external edit deliberately so each target matches either its expected old contents or desired new contents, then retry recovery. Do not simply discard a partially applied journal: the ledger, views, and state could disagree. Readers refuse pending journals.

For manual edits to generated views outside an interrupted transaction, run `/hindsight migrate` to preserve originals and import unverified candidates before regeneration. Migration invalidates all old domain inspection baselines. Accepted decision files need `status: accepted` in initial YAML frontmatter or `Status: Accepted` within the first 12 lines; an ordinary mention in prose is insufficient.

To review a blocked domain, open its `last-investigation.json`. Find criteria with `conflict`, `adr_candidate`, or `insufficient_evidence`; inspect their receipt references and proposed alternatives. The extension does not accept decisions or fix production code on behalf of a curator.
