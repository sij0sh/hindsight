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
| `maxDocumentChars` | 40000 | Maximum canonical document length |
| `maxSessionBatchChars` | 80000 | New session text processed per domain attempt |
| `historyWindow` | 30 | Git commits examined for churn |
| `churnThreshold` | 10 | Minimum appearances in that history window to flag a hotspot |
| `provider`, `model` | `null`, `null` | Set both to use a dedicated curator model |

All numeric settings must be positive integers. An oversized single session entry is not split or silently dropped: raise `maxSessionBatchChars` to process it. A repository exceeding collection bounds stops before making model calls. Raising limits also increases potential model work.

`exclude`, `sensitive`, and `sensitiveAllow` are glob arrays. The supported glob syntax is `*`, `**`, and `?`. There are no braces, regexes, negation, or extglobs. `**/package.json` matches both the root and nested manifests.

Default generated exclusions include build, coverage, dist, vendor, node_modules, snapshots, and minified JavaScript. `.agents/engineering/**` and `.agents/curation/**` are always excluded from source routing. The canonical documents have a separate manual-change fingerprint check. Registry/config changes use their own fingerprint, so excluding curation output does not suppress policy updates.

Sensitive defaults include `.env`, `.env.*`, PEM/key files, and conventional credential/auth JSON files; `.env.example`, `.env.sample`, and `.env.template` are explicitly allowed. Customize these before first curation if your repository stores confidential material elsewhere. Models also receive ordinary user/assistant session text captured for intent and policy investigations.

## Registry structure

Each of the fixed ten domain IDs declares:

- Canonical path and positive criterion version.
- `inputPaths`: the file surface contributing to freshness.
- `sessions`: whether incremental user/assistant text is relevant.
- `baseline`: mandatory domain checks in every incremental investigation.
- `criteria`: stable IDs and concrete investigation questions.
- `rules`: trigger ID, `affected` or `candidate` confidence, path patterns and/or signal, and mandatory criterion IDs.

The common catalog is applied to every domain. The built-in signals are `session`, `imports`, `execution`, `security`, `maintenance`, and `churn`. They are deterministic heuristics except for exact inventory/history changes. Rules do not execute arbitrary commands.

Any registry or configuration change triggers a complete domain reconciliation because the stored rule fingerprint changes. This includes scheduling changes, a conservative simplification that favors explicit reconciliation over silently retaining a baseline under changed settings.

## Recovery and review

If a run is interrupted, retry. A remaining transaction is recovered after acquiring the repository lock. If the dead process left `run.lock`, use `/knowledge unlock` or the CLI equivalent. The command refuses live processes and foreign host locks. Never delete an active process's lock.

If recovery reports manual edits, compare the canonical document, `transaction.json`, and the referenced investigation before resolving the conflict. There is intentionally no force-overwrite command. Keep the authoritative manual document, move the disputed journal/state aside as an audit backup under your normal repository workflow, and force reconciliation only after the conflict is understood.

To review a blocked domain, open its `last-investigation.json`. Find criteria with `conflict`, `adr_candidate`, or `insufficient_evidence`; inspect their receipt references and proposed alternatives. The extension does not accept decisions or fix production code on behalf of a curator.
