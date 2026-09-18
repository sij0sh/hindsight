# Hindsight · v0.2.0

Durable engineering memory for Pi.

Coding agents are good at solving the problem in front of them. The harder problem is carrying the reasoning behind those solutions into the next session.

A repository can tell you what the code does today. It is often much worse at telling you why a strange-looking branch must remain, which service owns a piece of state, what compatibility promise cannot be broken, which approach already failed, or whether an old constraint still applies.

Some of that knowledge lives in documentation. Some lives in ADRs, tests, commits, and conversations. Some never makes it out of the session where it was discovered.

Hindsight keeps that engineering knowledge as structured memory tied to evidence. It records small, scoped claims with provenance and lifecycle, then generates Markdown views for Pi and retrieves the memories relevant to the code being worked on.

```text
repository state       Pi sessions       accepted decisions
       \                   |                    /
        \                  |                   /
                    evidence
                       |
                       v
               scoped memory ledger
                       |
             +---------+---------+
             |                   |
             v                   v
      generated views      contextual retrieval
             |                   |
             +---------+---------+
                       |
                       v
                      Pi
```

The Markdown files are useful interfaces to the memory. They are not the canonical memory themselves.

## Why Hindsight exists

Consider a webhook handler that suppresses duplicate events because an upstream provider retries delivery.

An agent discovers the issue, fixes it, and moves on. Months later, another agent is asked to simplify the same code. The original conversation is gone. The duplicate suppression looks redundant. Removing it may be a perfectly reasonable local change and still reintroduce the old bug.

Writing a note in `ARCHITECTURE.md` helps, but plain documentation has its own lifecycle problem. A rule can be copied into several files, lose the evidence that justified it, remain after the underlying condition changes, or conflict with a newer decision.

Hindsight is meant to preserve facts such as:

```text
Webhook processing must be idempotent.
```

along with the information needed to use that fact responsibly:

```text
where it applies
where it came from
how strongly the evidence supports it
whether newer evidence contradicts it
whether it replaced an older rule
whether it is still active
which Pi-facing views should expose it
```

If the requirement later changes, Hindsight does not have to rewrite the old statement and pretend it was always true. It can retain the old record, create a replacement, or record an unresolved conflict until the evidence supports a resolution.

That is the distinction between keeping documentation and maintaining engineering memory.

## What Hindsight covers

Hindsight organizes engineering knowledge across ten domains:

| Generated view            | Focus                                                | Domain criteria |
| ------------------------- | ---------------------------------------------------- | --------------: |
| `INTENT_AND_CONTRACTS.md` | Intent, promises, interfaces, compatibility          |              12 |
| `ARCHITECTURE.md`         | Boundaries, ownership, execution, accepted decisions |              12 |
| `CODE_STANDARDS.md`       | Repository conventions, tooling, exceptions          |              11 |
| `TESTING.md`              | Test mapping, failures, migrations, CI parity        |              14 |
| `SECURITY.md`             | Trust, identity, authorization, sensitive resources  |              18 |
| `DEPENDENCIES.md`         | Dependencies, runtimes, locking, replacement         |              13 |
| `DELIVERY.md`             | Build, deployment, environments, rollback            |              14 |
| `OPERATIONS.md`           | Detection, observability, retries, recovery          |              16 |
| `MAINTAINABILITY.md`      | Scars, churn, complexity, coupling, migrations       |              14 |
| `AGENT_POLICY.md`         | Corrections, workflow rules, repository traps        |              14 |

These files are generated from the ledger. One memory can appear in several views without becoming several independently maintained copies.

Hindsight addresses the knowledge-continuity side of engineering. It does not establish that an architecture is good, prove that a system is secure, replace tests or CI, or turn repository evidence into truth automatically. Those judgments still depend on evidence and review.

## How it works

Hindsight separates detection, interpretation, and persistence.

```text
repository or session changes
            |
            v
    deterministic routing
            |
            v
      pending domains
            |
            v
   isolated Pi curator
            |
            v
 proposed memory operations
            |
            v
   host-side validation
            |
            v
     canonical ledger
            |
       +----+----+
       |         |
       v         v
   Markdown    context
    views      retrieval
```

The router decides what needs investigation using deterministic signals such as content fingerprints, paths, lexical signals, Git churn, and existing memory scope and provenance.

The curator interprets the evidence. Curators run in isolated Pi SDK sessions with a restricted tool set. They cannot run arbitrary shell commands, browse, or write directly into the repository.

Their output is a proposal.

The host validates the proposal, checks its evidence and current repository state, applies memory lifecycle rules, and commits the resulting ledger and generated views through a recoverable transaction.

This keeps model judgment where interpretation is necessary while leaving routing, validation, IDs, persistence, rendering, and transaction handling to code.

## Memory records

A memory is a small engineering claim with enough metadata for Hindsight to reason about where it belongs and whether it is still usable.

Conceptually, a record looks like this:

```json
{
  "id": "mem_...",
  "kind": "invariant",
  "domains": ["architecture", "operations"],
  "statement": "Webhook processing must be idempotent.",
  "scope": {
    "paths": ["src/billing/**"],
    "symbols": [],
    "concepts": ["webhooks"]
  },
  "status": "active",
  "confidence": "strong",
  "provenance": ["..."],
  "supersedes": [],
  "contradicts": []
}
```

Pi normally does not need this representation. It sees the resulting engineering guidance:

```markdown
## Applicable Hindsight

- Webhook processing must be idempotent.
```

Keeping the metadata in the ledger allows the Pi-facing text to stay small.

### Atomic memories

Hindsight stores independently changeable claims separately.

Instead of:

```text
Billing uses Stripe, PostgreSQL owns entitlements, webhooks are
idempotent, and signatures must be verified before processing.
```

the ledger can contain:

```text
Stripe owns payment settlement.

PostgreSQL owns entitlement state.

Webhook processing must be idempotent.

Webhook signatures must be verified before processing.
```

If one fact changes, the others do not need to be rewritten or revalidated as a unit.

### Scope

Memories can apply repository-wide or to specific paths, symbols, and concepts.

```json
{
  "scope": {
    "paths": ["src/billing/**"],
    "symbols": ["SubscriptionService"],
    "concepts": ["billing", "entitlements"]
  }
}
```

Path scopes use repository-relative globs. Symbol matching is exact. Concept matching is exact and case-insensitive.

This scope is also used for contextual retrieval, so work in `src/billing/` does not require loading every engineering rule in the repository.

## Memory lifecycle

Engineering knowledge changes. Hindsight keeps the history rather than treating every update as an overwrite.

| Operation        | Effect                                                               |
| ---------------- | -------------------------------------------------------------------- |
| `create`         | Record a supported claim                                             |
| `reinforce`      | Keep the same record and add supporting evidence                     |
| `supersede`      | Create a linked replacement while retaining the previous record      |
| `invalidate`     | Mark a claim obsolete, resolved, or unverified                       |
| `conflict`       | Record an unresolved contradiction and mark affected claims disputed |
| `resolve`        | Close a conflict after its targets have been validated or retired    |
| `scarCandidates` | Create a scar with its reason, constraint, and removal condition     |

Equivalent records are merged only when claim, scope, kind, and basis match the required equivalence rules.

A typical lifecycle might look like:

```text
session establishes rule A
          |
          v
      create A
          |
repository continues to support A
          |
          v
     reinforce A
          |
new explicit decision establishes B
          |
          v
   supersede A with B
          |
code still behaves according to A
          |
          v
     record conflict
```

The old record remains available for audit even after it stops participating in ordinary retrieval.

## Evidence and confidence

Hindsight distinguishes evidence from conclusions.

The host derives record confidence from the type of evidence supplied:

```text
authoritative
    explicit user decisions, constraints, reversals,
    or accepted ADRs

strong
    directly observed source evidence

supported
    independent indirect evidence

inferred
    synthesis that does not meet the higher evidence levels
```

`inferred` claims remain unverified.

Assistant messages are not treated as user authority. A code change by itself cannot retire or supersede an authoritative policy decision.

Read receipts establish that evidence was read. They do not prove that the conclusion drawn from it is correct.

## Conflicts

Repositories do not always contain one clean version of the truth.

An existing memory may say:

```text
Stripe owns payment settlement.
```

while a later session introduces manually settled enterprise invoices.

Hindsight can record that disagreement instead of silently replacing the old claim.

Disputed memories are withheld from normal retrieval. Conflicts remain visible in generated views, `/knowledge scan`, and contextual retrieval until later evidence supports a resolution.

A blocked investigation can persist newly discovered conflicts and disputed projections, but it cannot mark the relevant source or session state as successfully reviewed.

ADR candidates created during an investigation remain proposals. Accepted ADRs under `.agents/decisions/` or `docs/adr/` can provide evidence for a later resolution; a filename alone does not establish acceptance.

## Scars

Some awkward code exists for a reason.

Hindsight represents these cases as scars with an explicit reason, constraint, and removal condition rather than leaving permanent warnings in prose.

For example:

```text
Legacy authentication middleware remains because mobile clients
still depend on v1 token semantics.

Constraint:
Do not add new authentication behavior here.

Removal condition:
Remove after v1 clients are no longer supported.
```

Scars can use `paths_absent` and `path_present` removal signals. Meeting one of those conditions creates an inspection candidate. It does not automatically retire the scar.

Retired records remain in the ledger and audit history but disappear from normal retrieval.

## Contextual retrieval

Use `/knowledge context` to ask Hindsight which memories apply to the work at hand.

```text
/knowledge context --paths src/billing/webhooks.ts
```

You can also query explicit symbols or concepts:

```text
/knowledge context \
  --symbols SubscriptionService \
  --concepts billing entitlements
```

Selectors use OR semantics. Repository-wide memories always apply.

Normal retrieval excludes unverified, disputed, and retired records. Conflicts and scars receive priority, and Hindsight warns when relevant reviews remain pending.

Context accepts `--max-chars N`. If the result must be truncated, JSON output names the omitted record IDs and the Pi display warns that material was omitted.

Optional automatic injection is available:

```json
{
  "contextInjection": true
}
```

When enabled, Hindsight can inject scoped memories before a Pi turn whose prompt explicitly mentions a known repository-relative path. Unknown task paths fall back to the domain index.

Hindsight does not infer relevance from every dirty file, extract symbols from source code, or perform semantic search.

## Install

Requirements:

* Node.js 22.19 or newer
* a compatible Pi version

Compatibility with older `@mariozechner` APIs is not claimed.

Install from GitHub:

```bash
pi install git:github.com/sij0sh/hindsight
```

Version tags are not published yet, so install without a version suffix.

To pin to a tagged release once tags are published:

```bash
pi install git:github.com/sij0sh/hindsight@vX.Y.Z
pi update --extensions
```

Update or remove the GitHub installation:

```bash
pi update git:github.com/sij0sh/hindsight
pi remove git:github.com/sij0sh/hindsight
```

The npm package name `hindsight` belongs to an unrelated package, so Hindsight is not published under that name. A future scoped release would use `@sij0sh/hindsight`.

## First run

From the repository you want Hindsight to manage:

```text
/knowledge init
/knowledge scan
/knowledge run
```

Then try a contextual lookup:

```text
/knowledge context --paths src/billing/webhooks.ts
```

`init` creates the configuration, versioned criterion registry, empty memory ledger, and a managed routing block in `AGENTS.md`. Existing AGENTS instructions are preserved.

The first successful investigations render the engineering views. A domain with no supported claims remains explicitly empty until it has been reviewed.

By default, automatic behavior is `scan`. Completed Pi turns capture session evidence and queue relevant work without making curator model calls.

To allow automatic investigations:

```text
/knowledge auto run
```

Automatic `run` performs up to three investigations after a completed turn. There is no background timer that drains pending work while Pi is idle.

Pi authentication provides model access. Curators default to Meta Muse Spark 1.3:

```text
meta/muse-spark-1.3-contributor
```

Set both `provider` and `model` to use another dedicated curator model.

Providers registered only by another extension are not copied into curator sessions. Configure the provider persistently in Pi or supply `modelRuntime` through the programmatic API.

## Commands

| Command                                               | Behavior                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `/knowledge init [--migrate]`                         | Initialize Hindsight; optionally migrate existing engineering views         |
| `/knowledge migrate`                                  | Archive changed originals and import their content as unverified candidates |
| `/knowledge scan [domain]`                            | Show routing, open conflicts, and migration or view drift                   |
| `/knowledge run [domain]`                             | Investigate pending work and commit validated memory operations             |
| `/knowledge force [domain]`                           | Reconcile the complete criterion catalog for a domain                       |
| `/knowledge context --paths PATH…`                    | Retrieve applicable active memories and conflicts                           |
| `/knowledge context --symbols NAME… --concepts TERM…` | Query explicit symbols or concepts; may be combined with paths              |
| `/knowledge memory [ID]`                              | List records or inspect one record and its audit history                    |
| `/knowledge auto off\|scan\|run`                      | Set automatic behavior                                                      |
| `/knowledge cancel`                                   | Abort the active curator                                                    |
| `/knowledge unlock`                                   | Remove a lock after confirming its local process has stopped                |

`status` is an alias for `scan`.

Domain IDs use lowercase underscores, for example:

```text
intent_and_contracts
```

Quote selectors that contain spaces.

The CLI exposes the same core operations and returns JSON:

```bash
node ~/.pi/agent/git/github.com/sij0sh/hindsight/src/cli.mjs \
  init --migrate --cwd /path/to/repo

node ~/.pi/agent/git/github.com/sij0sh/hindsight/src/cli.mjs \
  context --paths src/billing.ts --cwd /path/to/repo

node ~/.pi/agent/git/github.com/sij0sh/hindsight/src/cli.mjs \
  capture /path/to/session.jsonl --cwd /path/to/repo
```

`capture` imports a selected Pi JSONL session after checking its repository header. Hindsight does not silently crawl old sessions.

CLI exit codes are:

```text
0  success
1  runtime or configuration error
2  blocked or failed investigation
```

The paths above assume Pi's default global Git-package location. Adjust them for project installs under `.pi/git/...` or for a development checkout.

The binary is `hindsight`. `pi-knowledge` remains as a deprecated alias. The `/knowledge` command is unchanged.

## Investigation and generated views

Every investigation includes eight common checks plus a memory-reconciliation check.

A full reconciliation runs the entire criterion set for the selected domain. Incremental work uses the baseline criteria plus checks associated with the signals that triggered the investigation. Derived checks must name their parent criterion and explain why they were added.

Curators submit memory operations rather than editing the Markdown views directly.

The host reconciles those operations against a cloned ledger and renders the engineering documents deterministically after validation.

This allows the same record to appear in several views while retaining one identity and one lifecycle in the ledger.

## Persistence and transactions

The canonical state lives under `.agents/`.

| Path                                | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `.agents/curation/memory.json`      | Canonical records, audit events, projection hashes, and import manifest |
| `.agents/engineering/*.md`          | Generated Pi-facing engineering views                                   |
| `.agents/curation/config.json`      | Hindsight configuration                                                 |
| `.agents/curation/registry.json`    | Versioned criterion catalog                                             |
| `.agents/curation/state.json`       | Per-domain baselines and pending queue                                  |
| `.agents/curation/migration/*.md`   | Archived originals used during migration                                |
| `.agents/curation/sessions/`        | Captured session evidence                                               |
| `.agents/curation/<domain>/runs/`   | Investigation reports                                                   |
| `.agents/curation/transaction.json` | Present while a transaction needs completion                            |

Curators use Pi SDK `createAgentSession`, in-memory sessions, isolated resource discovery, and exactly five tools.

The host captures working-tree, index, and HEAD evidence along with actual session roles. Evidence reads receive hashed receipts. Findings and proposed memory operations are validated before anything is committed.

Immediately before commit, Hindsight checks for drift in:

```text
source
session evidence
ledger
generated views
state
configuration
criterion registry
```

The transaction journal covers the ledger, views, managed `AGENTS.md` block, state, and migration backups.

Recovery preflights every affected target before replaying any write. If files were edited externally, recovery stops rather than overwriting those edits. Ledger readers also reject a ledger while a transaction remains pending.

These transactions are recoverable multi-file commits. They do not provide simultaneous filesystem visibility to unrelated readers. A noncooperating editor can still race the final validation and write interval. The local lock is not a distributed lock, and directory metadata is not explicitly fsynced.

Investigation reports retain findings, evidence receipts, proposed operations, resulting record IDs, ADR proposals, and any available usage metrics.

A curator submission is only a proposal until its transaction commits.

## Upgrade from v0.1.0

v0.2 changes the storage model from curated documents to a canonical memory ledger with generated document views.

Existing engineering documents are never silently overwritten.

After loading v0.2.0:

```text
/knowledge init --migrate
/knowledge scan
/knowledge run
```

Migration archives each changed original under:

```text
.agents/curation/migration/
```

Paragraphs and list items are imported as unverified memory candidates. Hindsight then renders the generated views and queues every domain for revalidation.

Existing configuration and registry settings are preserved. Repeating migration when the views have not changed is a no-op.

Imported text is evidence that somebody wrote the statement. It is not proof that the statement is still valid policy.

Before an imported candidate can be promoted, a curator must inspect its archived source, review whether the memory is sufficiently atomic, establish its scope, and supply current supporting evidence. Long passages retain their complete archived original.

Generated views should not be edited as though they were the canonical store. If a generated view is manually corrected, use the explicit migration flow before regeneration so the change can be captured as evidence rather than silently overwritten.

The v0.2 submission contract accepts `memoryOps` only. Legacy `patches` and `newDocument` submissions are rejected.

Old interrupted transaction journals can still be recovered.

Back up the ledger, migration originals, and reports before downgrading. v0.1.0 cannot maintain v0.2.0 ledger consistency.

## Bounds and limitations

Hindsight is an evidence-backed memory system, not a proof system.

The router uses fingerprints, paths, lexical signals, Git churn, and memory metadata. It is not an AST analyzer and cannot establish semantic completeness.

Receipts establish that a curator read supplied evidence. They do not establish that its interpretation was correct.

Judgments about atomicity, equivalent meaning, relevance of evidence, and whether a decision is still current depend on curator reasoning and representative human review.

Some repository material is deliberately excluded from curator evidence. Ignored or excluded files, sensitive contents, binaries, oversized text, and symlink targets are withheld. Submodules are represented by pointers.

A statement that a path is absent therefore means absent from Hindsight's bounded evidence inventory, not necessarily absent from every possible source.

Prior dirty-file bytes are not retained. When a necessary historical fact cannot be reconstructed, the appropriate result is `insufficient_evidence`.

Hindsight enforces limits on turns, deadlines, evidence, views, record count, and total ledger size, including tombstones and audit history. When those limits are reached, operations fail visibly. Hindsight does not silently archive old records to make room.

Usage budgets are execution limits, not guaranteed dollar caps.

See [CONFIGURATION.md](docs/CONFIGURATION.md) for configuration and limit details.

## Development

Clone the repository and install dependencies:

```bash
npm install
npm test
npm run test:sdk
```

Run the checkout for one Pi session:

```bash
cd /path/to/your/git-repository
pi -e /absolute/path/hindsight
```

Or install the local checkout:

```bash
pi install /absolute/path/hindsight
```

## Validation

Run the deterministic and SDK checks with:

```bash
npm run check
npm test
npm run test:sdk
```

A live-model smoke test is also available:

```bash
HINDSIGHT_LIVE_PROVIDER=your-provider \
HINDSIGHT_LIVE_MODEL=your-model \
npm run test:live
```

The live test incurs model usage and retains its fixture for inspection.

Local deterministic tests pass. Real SDK validation remains blocked by the unavailable dependency in the build environment, so no live-model compatibility or semantic-quality claim is made on that basis.

See [VALIDATION.md](docs/VALIDATION.md) and [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the current validation record and implementation details.

Pi references:

* [SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
* [Extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
* [Pinned package metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent/0.85.1)
