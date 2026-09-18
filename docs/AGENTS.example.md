## Objective

Use Hindsight as the repository's engineering memory. `AGENTS.md` defines how to work and when to consult that memory; `.agents/engineering/*.md` contains generated, domain-specific guidance.

## Before changing code

1. Read the relevant implementation and tests.
2. Search for existing behavior before creating new behavior.
3. Identify the current source of truth for the behavior or state being changed.
4. Identify the repository paths, symbols, and concepts affected by the task.
5. Retrieve applicable Hindsight context for known paths before designing the change.
6. Review only the engineering views whose routing conditions below apply.
7. If Hindsight reports a conflict, scar, disputed claim, or pending review that affects the change, do not silently choose a side. Inspect the relevant evidence or ask for clarification.

For known paths, prefer scoped retrieval:

```text
/hindsight context --paths <repository-relative-path> [...]
```

When path scope is insufficient, query the relevant symbol or concept:

```text
/hindsight context --symbols <name> --concepts <term> [...]
```

Do not load every engineering document by default. Use the smallest relevant context.

## Engineering memory router

The files under `.agents/engineering/` are generated views of Hindsight's canonical memory. Use this table to decide when a full view should be reviewed in addition to scoped context.

| View | Review when the task changes, depends on, or questions... |
| --- | --- |
| `AGENT_POLICY.md` | Repository-specific commands, required validation, protected/generated files, search-before-create rules, clarification rules, task decomposition, tooling/environment quirks, dependency approval rules, ADR handling, or known agent traps. Review at the start of repository-modifying work when scoped Hindsight context is unavailable or incomplete. |
| `INTENT_AND_CONTRACTS.md` | User-visible behavior, explicit purpose, API or protocol semantics, CLI behavior, configuration contracts, persisted/external formats, canonical domain terms, compatibility promises, non-goals, or an unresolved product decision. |
| `ARCHITECTURE.md` | Component or service boundaries, dependency direction, state ownership, persistence, external systems, workers/queues/schedules, transaction or data-flow boundaries, trust boundaries, cross-cutting concerns, migrations between architectures, or accepted ADRs. |
| `CODE_STANDARDS.md` | Repository construction patterns, dependency injection, error conventions, naming, layer-specific rules, interface/function conventions, generated/vendor code, reusable helpers/types/components, or intentional legacy exceptions. |
| `TESTING.md` | Any meaningful behavior change, bug fix, boundary change, critical user journey, schema/data migration, concurrency/retry behavior, test infrastructure, contract verification, CI parity, flaky tests, or a suspected verification gap. |
| `SECURITY.md` | Untrusted input, authentication, authorization, ownership/tenancy, validation, injection risk, filesystem/process/network access, webhooks, secrets, sensitive data, logging of sensitive values, cryptography, tokens, security-sensitive dependencies/defaults, or fail-open behavior. |
| `DEPENDENCIES.md` | Adding/removing/upgrading packages, runtimes, compilers, package managers, build tools, lockfiles, transitive graph changes, native/platform requirements, dependency replacement, provenance/SBOM policy, license policy, or deprecation claims. |
| `DELIVERY.md` | Build/artifact generation, CI gates, deployment mechanisms, environments, runtime configuration, secret injection, migrations during rollout, version coexistence, rollback, irreversible operations, feature flags, provenance, deployment order, or staging/production parity. |
| `OPERATIONS.md` | Health detection, logs, metrics, traces, error surfacing, timeouts, retries, idempotency, queues/background work, partial failure, recovery, alerts, runbooks, capacity, release correlation, or established SLOs. |
| `MAINTAINABILITY.md` | Repeated churn, coupling, duplicated domain knowledge, growing complexity, unusually large modules, dependency cycles, partially completed architecture transitions/refactors, deprecated/dead paths, repeated defects, accumulating TODOs, terminology drift, or historical knowledge required for safe modification. |

Routing is additive. A change may require several views. Route by the behavior and risk being changed, not by file extension alone.

## Hindsight document rules

`.agents/curation/memory.json` is canonical Hindsight state. Files under `.agents/engineering/` are generated views and must not be treated as independently maintained source documents.

Do not edit generated engineering views directly as the normal way to change policy. Use Hindsight investigation/migration workflows so corrections retain evidence and lifecycle.

Treat active accepted constraints and decisions as repository guidance. Do not treat unverified imports, disputed knowledge, unresolved conflicts, or proposed ADRs as settled policy.

A scar is a constraint with history. Preserve it until its removal condition has been reviewed; do not remove awkward-looking code merely because a local simplification appears cleaner.

## Implementation defaults

Prefer existing patterns over new patterns, small changes over broad rewrites, composition over unnecessary frameworks, explicit code over clever code, and one authoritative source for business rules and configuration.

Do not refactor unrelated code while implementing a feature. Do not create speculative extensibility. Do not duplicate domain knowledge; search before adding equivalent behavior. Prefer temporary duplication over a premature or incorrect abstraction when the shared concept is not yet stable.

Do not add a production dependency when the existing runtime or an existing dependency reasonably solves the problem. Review `DEPENDENCIES.md` before adding or materially changing a dependency, and explain the need when the repository does not already establish it.

Handle expected failure modes at system boundaries. Do not silently swallow errors. Do not add retries unless the operation is safe to retry and the applicable operational guidance permits it.

New behavior requires verification proportional to its risk. Bug fixes should include a regression test when practical. Test behavior rather than implementation details. Review `TESTING.md` whenever the change can alter observable behavior or a failure path.

## Completion

Before declaring repository work complete:

1. Run the repository's canonical validation workflow recorded in `AGENT_POLICY.md` or `TESTING.md`. If this repository defines `./scripts/verify`, use it as the single local verification entry point.
2. Inspect `git diff` for unintended changes, duplicated logic, debug artifacts, generated-file edits, and scope creep.
3. Resolve failures caused by the change.
4. Do not claim completion when required verification failed or was not run.
5. State what changed, what was verified, and any known remaining limitation or unverified assumption.
