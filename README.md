# Hindsight · v0.2.0

A Pi extension for durable engineering memory. Deterministic code decides **what needs investigation**; isolated Pi SDK agents interpret evidence; the host maintains **atomic, scoped, provenance-backed records**. Ten Markdown documents are generated views of one canonical memory ledger.

v0.2.0 adds lifecycle operations, shared domain projections, durable conflicts, scar removal review, contextual retrieval, and migration from v0.1.0. See the [critical review of the supplied design](docs/V0.2-REVIEW.md).

## Install and start

Requirements: Git, Node.js ≥22.19, and Pi 0.85.1 (`@earendil-works/pi-coding-agent`). Compatibility with older `@mariozechner` APIs is not claimed.

```bash
cd /absolute/path/hindsight
npm install
npm test
npm run test:sdk

cd /path/to/your/git-repository
pi -e /absolute/path/hindsight/extension.ts
```

In Pi:

```text
/knowledge init
/knowledge scan
/knowledge run
/knowledge context --paths src/billing/webhooks.ts
```

`init` creates configuration, a versioned criterion registry, an empty ledger in a fresh repository, and a managed routing block in `AGENTS.md`. Other AGENTS instructions are preserved. The first successful investigation renders the ten views; domains with no supported claims remain explicitly empty and pending their own review.

Automatic mode initially uses `scan`: completed Pi turns capture session evidence and queue work without model calls. `/knowledge auto run` enables up to three automatic investigations per completed turn. Manual `run` attempts all pending domains. No background timer drains the queue while Pi is idle.

Pi authentication supplies model access. Curators default to Meta Muse Spark 1.3 (`meta/muse-spark-1.3-contributor` from Pi's global models); set both `provider` and `model` to use a different dedicated model. Providers registered only by another extension are not copied into curator sessions; use persistent Pi model configuration or supply `modelRuntime` through the programmatic API.

## Upgrade from v0.1.0

Existing engineering documents are never silently overwritten. After loading v0.2.0:

```text
/knowledge init --migrate
/knowledge scan
/knowledge run
```

Migration archives each changed original under `.agents/curation/migration/`, imports paragraphs and list items as **unverified candidates**, renders the views, and queues every domain for revalidation. It preserves existing config/registry settings. Repeating migration with unchanged views does nothing.

Original text is evidence, not proof of accepted policy. Before promoting an import, a curator must inspect its archive, review atomicity and scope, and supply current evidence. Long passages retain a full archive. Manual corrections to a generated view require the same explicit `/knowledge migrate` flow before regeneration.

The submission contract now accepts `memoryOps` only. Legacy `patches` and `newDocument` are rejected; old interrupted transaction journals can still be recovered. Back up the ledger, migration originals, and reports before a downgrade. v0.1.0 cannot maintain v0.2.0 ledger consistency.

## Commands

| Command | Behavior |
| --- | --- |
| `/knowledge init [--migrate]` | Initialize; optionally migrate existing views |
| `/knowledge migrate` | Archive changed originals and import unverified candidates |
| `/knowledge scan [domain]` | Show routing, open conflicts, and migration/view drift |
| `/knowledge run [domain]` | Investigate pending work and commit validated memory operations |
| `/knowledge force [domain]` | Reconcile the complete domain catalog |
| `/knowledge context --paths PATH…` | Retrieve applicable active memories and conflicts |
| `/knowledge context --symbols NAME… --concepts TERM…` | Query explicit symbols or concepts; combine with paths |
| `/knowledge memory [ID]` | List records, or inspect one record and its audit history |
| `/knowledge auto off\|scan\|run` | Set automatic behavior |
| `/knowledge cancel` | Abort the active curator |
| `/knowledge unlock` | Remove a lock only when its local process is stopped |

`status` aliases `scan`. Domain IDs use lowercase underscores, such as `intent_and_contracts`. Quote selectors containing spaces. Context accepts `--max-chars N`; truncation names omitted IDs in JSON and warns in the Pi display.

The CLI exposes the same core operations and returns JSON:

```bash
node /absolute/path/hindsight/src/cli.mjs init --migrate --cwd /path/to/repo
node /absolute/path/hindsight/src/cli.mjs context --paths src/billing.ts --cwd /path/to/repo
node /absolute/path/hindsight/src/cli.mjs capture /path/to/session.jsonl --cwd /path/to/repo
```

`capture` imports a selected Pi JSONL session after checking its repository header. Old sessions are not silently crawled. CLI exit codes are `0` success, `1` runtime/configuration error, and `2` a blocked or failed investigation.

The binary is `hindsight`; `pi-knowledge` remains as a deprecated alias. The `/knowledge` Pi command is unchanged.

## Memory and lifecycle

Records have a stable host-generated ID, kind, domains, statement, explicit scope, status, evidence-derived confidence, provenance receipts, and lifecycle links. One record can appear in several views. IDs are `mem_` plus 32 hexadecimal UUID characters; migration IDs are deterministic hashes.

| Operation | Effect |
| --- | --- |
| `create` | Record a supported claim; merge only exact equivalent claim/scope/kind/basis matches |
| `reinforce` | Retain identity and add evidence; imported claims require scope and atomicity review |
| `supersede` | Create a linked replacement and retain the superseded record |
| `invalidate` | Deliberately mark a claim obsolete, resolved, or unverified |
| `conflict` | Record an unresolved contradiction and mark target claims disputed |
| `resolve` | Close a conflict after validating or retiring its targets |
| `scarCandidates` | Create a scar with reason, constraint, and removal condition |

The host derives confidence: explicit user decisions/constraints/reversals or accepted ADRs can be `authoritative`; observed source evidence is `strong`; independent indirect evidence can be `supported`; other synthesis remains `inferred` and unverified. Assistant messages are not user authority. Code changes cannot supersede or retire authoritative policy alone.

Scars support `paths_absent` and `path_present` removal signals. These produce inspection candidates, never automatic retirement. `MAINTAINABILITY.md` also includes other maintainability memories. Retirement hides a claim from normal retrieval while preserving its record and audit events.

Conflicts appear in views, scan output, and contextual retrieval. Disputed target claims are withheld from normal retrieval. A blocked attempt may persist conflicts and disputed projections but cannot advance source/session freshness. ADR candidates remain proposed in reports and reference conflict IDs. Accepted ADRs under `.agents/decisions/` or `docs/adr/` supply evidence for later explicit resolution; filenames alone do not establish acceptance.

## Context and domain coverage

Path scopes use repository-relative globs. Symbols match exactly; concepts match exactly ignoring case. Selectors use OR; repository-wide records always apply. Normal retrieval excludes unverified, disputed, and retired claims, prioritizes conflicts and scars, and warns when reviews remain pending.

Set `contextInjection: true` to inject scoped memories before a Pi turn when its prompt explicitly mentions a known repository-relative path. Unknown task paths use the domain index fallback. The extension does not infer task relevance from every dirty file, parse symbols out of code, or perform semantic search.

| Generated view | Focus | Domain criteria |
| --- | --- | ---: |
| `INTENT_AND_CONTRACTS.md` | Intent, promises, interfaces, compatibility | 12 |
| `ARCHITECTURE.md` | Boundaries, ownership, execution, accepted decisions | 12 |
| `CODE_STANDARDS.md` | Repository conventions, tooling, exceptions | 11 |
| `TESTING.md` | Test mapping, failures, migrations, CI parity | 14 |
| `SECURITY.md` | Trust, identity, authorization, sensitive resources | 18 |
| `DEPENDENCIES.md` | Dependencies, runtimes, locking, replacement | 13 |
| `DELIVERY.md` | Build, deployment, environments, rollback | 14 |
| `OPERATIONS.md` | Detection, observability, retries, recovery | 16 |
| `MAINTAINABILITY.md` | Scars, churn, complexity, coupling, migrations | 14 |
| `AGENT_POLICY.md` | Corrections, workflow rules, repository traps | 14 |

Every investigation includes eight common checks and a memory reconciliation check. Full reconciliations use all domain criteria; incremental work uses baseline and trigger-specific criteria. Derived checks need a parent and reason.

## Evidence and persistence

Curators use Pi SDK `createAgentSession`, in-memory sessions, isolated resource discovery, and exactly five tools. They cannot run a shell, browse, or arbitrarily write files. The host captures working/index/HEAD evidence and actual session roles, issues hashed read receipts, validates findings, reconciles a cloned ledger, and renders deterministic Markdown.

Before committing, the host checks source, session, ledger, view, state, configuration, and registry drift. A journal covers the ledger, views, AGENTS block, state, and migration backups. Recovery preflights **every target before any replay write** and stops on external edits. Ledger readers reject pending transactions. Updating a shared projection does not certify a sibling domain's source review.

This provides recoverable multi-file commits, not simultaneous filesystem visibility to unrelated readers. Noncooperating editors can race the final check/write interval. The local lock is not distributed locking; directory metadata is not explicitly fsynced.

| Path | Purpose |
| --- | --- |
| `.agents/curation/memory.json` | Canonical records, audit events, projection hashes, import manifest |
| `.agents/engineering/*.md` | Generated Pi-facing views |
| `.agents/curation/config.json`, `registry.json` | Settings and criterion catalog |
| `.agents/curation/state.json` | Per-domain baselines and queue |
| `.agents/curation/migration/*.md` | Archived originals |
| `.agents/curation/sessions/` | Captured session evidence |
| `.agents/curation/<domain>/runs/` | Investigation reports |
| `.agents/curation/transaction.json` | Present while a transaction needs completion |

Reports retain findings, receipts, memory operations, resulting IDs, ADR proposals, and available usage metrics. A submission is a proposal until its transaction commits. Audit events retain provenance, before hashes, and resulting record snapshots. Keep the ledger and required migration originals together when sharing or restoring a repository; review them for private context. The example ignore fragment excludes local runtime state and sessions, not the canonical ledger.

## Bounds and limitations

The router uses content fingerprints, paths, lexical signals, Git churn, and memory scope/provenance. It is not an AST analyzer or proof of semantic completeness. Receipts prove reads, not conclusions. Atomicity, equivalent meaning, evidence relevance, and whether a decision is current require curator judgment and representative human review.

Ignored/excluded files, sensitive contents, binaries, oversized text, and symlink targets are withheld. Submodules are represented by pointers. Path absence is relative to this bounded inventory. Prior dirty file bytes are not retained; essential missing historical facts should produce `insufficient_evidence`.

Limits cover turns, deadlines, evidence, views, record count, and the entire ledger including tombstones and audit events. Limits fail visibly; no automatic archival silently deletes history. Budgets are not fixed dollar limits. See [CONFIGURATION.md](docs/CONFIGURATION.md).

## Validation

```bash
npm run check
npm test
npm run test:sdk
HINDSIGHT_LIVE_PROVIDER=your-provider \
HINDSIGHT_LIVE_MODEL=your-model npm run test:live
```

The live test incurs model usage and retains its fixture for review. Local deterministic tests pass; real SDK validation remains blocked by the unavailable dependency in the build environment. No live-model compatibility or semantic-quality claim is made. See [VALIDATION.md](docs/VALIDATION.md) and [ARCHITECTURE.md](docs/ARCHITECTURE.md).

Pi references: [SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [pinned package metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent/0.85.1).
