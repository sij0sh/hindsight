# Hindsight

A Pi extension that keeps ten engineering knowledge documents aligned with repository evidence and explicit user decisions. Deterministic code chooses **what to inspect**. Pi SDK agents decide **what the evidence means**. Validated, minimal patches maintain the canonical documents.

## Quick start

Requirements: Git, Node.js 22.19 or newer, and Pi 0.85.1 (`@earendil-works/pi-coding-agent`). The current package name is different from older `@mariozechner` releases; this version does not claim compatibility with those older APIs.

Unpack this project, then:

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
/knowledge auto run
```

`init` creates configuration and a versioned criterion registry, and inserts one managed routing block into `AGENTS.md`. It preserves other instructions. The ten engineering documents are created by successful investigations, not filled with generic templates.

Initial automatic mode is `scan`: completed Pi turns collect session evidence and queue inspections without model calls. `auto run` enables bounded automatic investigations. A manual `run` attempts all pending domains. No extra confirmation is required for each factual document update.

Pi authentication supplies the curator's model access. By default the extension passes Pi's selected model and creates an SDK runtime using normal Pi credentials. To select a dedicated model, set both `provider` and `model` in `.agents/curation/config.json`. Providers registered only in another extension are not copied into isolated curator sessions; configure those in Pi's persistent model configuration, or supply a `modelRuntime` through the programmatic API.

## Commands

| Command | Behavior |
| --- | --- |
| `/knowledge init` | Initialize config, registry, and the `AGENTS.md` routing block |
| `/knowledge scan [domain]` | Show deterministic routing and reasons; no model calls |
| `/knowledge run [domain]` | Inspect pending work, including candidates; apply validated updates |
| `/knowledge force [domain]` | Reconcile the complete criterion catalog regardless of freshness |
| `/knowledge auto off` | Disable automatic capture and routing |
| `/knowledge auto scan` | Capture new session entries and maintain the inspection queue |
| `/knowledge auto run` | Capture, route, and run a bounded number of curators after each Pi turn |
| `/knowledge cancel` | Abort the active curator; unfinished evidence is not acknowledged |
| `/knowledge unlock` | Remove a local lock only when its recorded process is no longer running |

Domain IDs use lowercase underscores, for example `intent_and_contracts` and `agent_policy`. `status` is an alias for `scan`.

The CLI supports the same core operations and outputs JSON:

```bash
node /absolute/path/hindsight/src/cli.mjs scan --cwd /path/to/repo
node /absolute/path/hindsight/src/cli.mjs run architecture --cwd /path/to/repo
node /absolute/path/hindsight/src/cli.mjs capture /path/to/session.jsonl --cwd /path/to/repo
```

The npm binary is `hindsight`; `pi-knowledge` remains as a deprecated alias. The `/knowledge` Pi command is unchanged.

`capture` imports a specifically selected Pi JSONL session after checking its repository header. Automatic capture covers the active branch after completed turns while the extension is enabled. It does not silently crawl old Pi sessions. CLI exit codes: `0` success, `1` configuration/runtime error, `2` at least one blocked or failed investigation.

## What is maintained

| Document | Investigation focus | Domain checks |
| --- | --- | ---: |
| `INTENT_AND_CONTRACTS.md` | Explicit intent, promises, public interfaces, compatibility, unresolved product questions | 12 |
| `ARCHITECTURE.md` | Boundaries, dependencies, state ownership, persistence, execution, accepted decisions | 12 |
| `CODE_STANDARDS.md` | Repository-specific conventions, tooling, reuse, justified exceptions | 11 |
| `TESTING.md` | Change-to-test mapping, integration/failure evidence, migrations, local/CI parity | 14 |
| `SECURITY.md` | Trust, identity, authorization, sensitive resources, failure behavior | 18 |
| `DEPENDENCIES.md` | Dependency changes, runtime/toolchain assumptions, locking, replacement | 13 |
| `DELIVERY.md` | Build, deployment, environment requirements, rollout, code and data rollback | 14 |
| `OPERATIONS.md` | Detection, observability, bounded failure, retries, recovery, existing objectives | 16 |
| `MAINTAINABILITY.md` | Churn, coupling, complexity, migration debt, guidance for safe changes | 14 |
| `AGENT_POLICY.md` | Explicit corrections, durable workflow rules, validation, repository traps | 14 |

Every investigation also includes eight common checks: contradictions, duplication, ownership, evidence, durability, actionability, currency, and ADR classification. Missing documents and forced or rule-changed reconciliations receive the whole domain catalog. Incremental investigations receive baseline criteria and trigger-specific checks. Derived checks require an existing parent and a reason.

## Routing and cost controls

The collector inventories tracked files plus non-ignored untracked files. It fingerprints working contents, index entries, committed file identities, relevant session entries, and domain-specific history signals. Modification times are not freshness signals. Content-identical metadata-only commits do not trigger work.

The router emits `missing`, `force`, `affected`, `candidate`, or `unchanged`. These are inspection statuses, never claims that a document must change. Unmatched changes within a declared input surface remain candidates. A README change does not route architecture or security by default; dependency edits route dependencies and security directly.

Automatic mode defaults to three jobs per completed user turn. Candidates wait three routing events; older jobs take priority so continuous high-priority work does not starve candidates. Failures and blocked findings wait three events before retrying unless their input changes. Manual runs bypass these scheduling delays. Deferred work remains in the queue; no background timer drains it when Pi is idle.

Each curator is limited to 90 model turns, 180 seconds, 16 derived checks, and bounded evidence reads by default. These are resource bounds, not a fixed dollar budget. Usage returned by the SDK is recorded per investigation. Source or session limits fail visibly instead of silently dropping evidence.

## Evidence and write guarantees

- Curators use the Pi SDK's `createAgentSession` with in-memory sessions, isolated resource discovery, and exactly five custom investigation tools. They have no shell, network, arbitrary file read, or file write tool.
- Evidence is captured before a curator runs. Separate `index:` and `head:` evidence exposes differing staged/committed contents. The worktree is exposed as `file:` evidence. Generated outputs are excluded from source routing.
- Findings cite receipts issued by actual evidence reads, including content hash and character range. Every criterion must finish explicitly. Every changed readable file must be inspected; differing Git layers, canonical documents, the manifest, and supplied session entries must be read in full before a successful submission. Receipts prove reads, not the correctness of an agent's interpretation.
- `insufficient_evidence`, unresolved conflicts, and proposed ADRs produce a blocked report and do not advance freshness or change canonical documents. Clear violations are not offered as architectural tradeoffs.
- Existing documents use exact, unique text replacements tied to update findings. Human edits are included as evidence. Repository and document fingerprints are checked again before commit.
- One repository lock serializes extension writes. A write-ahead journal recovers document/state updates after interruption. Recovery stops if the document or state was edited outside that transaction.

The lock coordinates this extension's processes. It is not an operating-system sandbox or a lock honored by arbitrary external editors. A very small check/write race remains possible with noncooperating external writers. Avoid simultaneous manual document editing during a curation commit.

## Files and review workflow

```text
.agents/engineering/                 Canonical Pi-facing documents
.agents/curation/config.json         Repository settings
.agents/curation/registry.json       Versioned rules and criterion catalog
.agents/curation/state.json          Independent per-domain baselines and queue
.agents/curation/sessions/           Captured user/assistant text evidence
.agents/curation/<domain>/runs/      Immutable investigation reports
.agents/curation/<domain>/last-investigation.json
.agents/curation/transaction.json    Present only while a commit needs completion
.agents/curation/last-commit.json    Last successfully committed report reference
```

Reports include findings, classification, receipts, proposed exact patches, proposed ADRs with alternatives, errors, model identity, and available usage metrics. A report's submitted result is a proposal until its report path is recorded by the committed domain state or `last-commit.json`.

Review blocked reports, resolve the actual question or violation, then rerun the domain. ADRs remain proposals in reports. Accept decisions explicitly through your normal review process and place accepted records under `.agents/decisions/` or `docs/adr/`; both paths route back into reconciliation.

Keep canonical docs, the registry, and configuration under version control. Session text and investigation findings can contain private project context; a suggested `.gitignore` fragment is in `examples/repository.gitignore`. This extension never stores provider credentials, but captured session text may contain information a user supplied. Session and report archives are not automatically deleted. Back up relevant audit records and archive old processed sessions when the configured inventory limit is reached.

## Scope and honest limits

This implementation includes path detectors, lexical import/API/execution signals, churn thresholds, file size and TODO signals, manifest fingerprints, manual-edit detection, and incremental session routing. Lexical signals are deliberately labeled as heuristics: they are not a fully resolved module graph or a language-specific AST analysis. Complexity, duplication, cycles, and coupling remain investigation criteria, not certified static-analysis results. There is no claim that deterministic routing can guarantee semantic completeness.

Git submodules are represented by index/committed pointers; their working contents need separate repository curation. Ignored files, excluded generated files, symlinks, sensitive files, binaries, and oversized contents are not given to models. Sensitive files that are in the inventory still contribute hashes and routing signals. Secret detection is based on configured paths, not a guarantee that arbitrary source text is secret-free.

The baseline retains content identities and extracted signals, not complete prior dirty file contents. Historical Git anchors aid inspection; this version does not reconstruct a textual diff against an earlier uncommitted snapshot. Current working/index/HEAD contents and deletion metadata remain available. If a missing historical fact is essential, the correct outcome is insufficient evidence.

## Validation

```bash
npm run check       # Syntax and registry validation, no dependencies required
npm test            # Deterministic engine, persistence, ledger, and mocked SDK tests
npm run test:sdk    # Actual installed Pi package: discovery and session/tool isolation

HINDSIGHT_LIVE_PROVIDER=your-provider \
HINDSIGHT_LIVE_MODEL=your-model npm run test:live
```

The live test spends model tokens on a small temporary repository, retains its evidence report for review, and checks that a completed investigation reaches `unchanged`. Review the resulting document for semantic quality. See [VALIDATION.md](docs/VALIDATION.md) for the checks actually run in the build environment and remaining integration gates.

Design details: [ARCHITECTURE.md](docs/ARCHITECTURE.md). Configuration: [CONFIGURATION.md](docs/CONFIGURATION.md).

Pi API references: [official SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [official extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), and [published 0.85.1 package metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent/0.85.1).
