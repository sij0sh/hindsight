# Validation record

Build date: 2026-09-17. Environment: Linux, Node.js v24.19.0, npm 11.9.0, Git 2.51.1.

## Executed successfully

| Check | Result |
| --- | --- |
| `npm run check` | All module/entrypoint syntax checks and registry validation passed |
| `node --test --test-reporter=spec test/*.test.mjs` | **47 passed, 0 failed, 0 skipped** |
| `npm pack --dry-run --json` | Package manifest, source, catalog, tests, and documentation included; no installed dependencies bundled |

This is the historical v0.1.0 record. Its captured test output is in `TEST-RESULTS-v0.1.0.txt` next to this file.

The tests use real temporary Git repositories and filesystem writes. The model-facing adapter tests inject a fake SDK; they are not a substitute for tests against the installed Pi package.

## Covered behavior

- All ten missing documents are investigated; a subsequent unchanged run makes zero curator calls.
- Dependency changes route the appropriate domains; README-only edits do not trigger architecture/security.
- Metadata-only commits, deterministic glob matching, rule changes, manual document edits, generated exclusions, and criterion mappings.
- Working-tree, staged-only, untracked, renamed, deleted, committed-deletion evidence, and unborn Git states.
- Lexical import signals, real Git churn counts, sensitive-input withholding, and symlink exclusion.
- Entry-level session updates, branch retention, oversized entries, incremental batching, and unread-entry rejection.
- Required and derived checks, evidence receipt validation, partial reads, cross-document reads, exact patches, ambiguous targets, unsupported policy promotion, blocked conflicts, and proposed ADRs.
- Failed/blocked jobs do not advance freshness; `no_change` jobs do advance verified baselines.
- Source and canonical document changes during investigation invalidate proposals.
- Process serialization, lock cleanup, interrupted transaction recovery, post-crash human edits, malformed state, and unsafe paths.
- Mocked Pi session isolation, expected tool allowlist, termination/submission behavior, missing submission, turn budgets, deadlines, and disposal.
- Extension command/lifecycle registration and deterministic automatic scan mode.

## Iterations prompted by review

1. Added explicit staged/committed evidence. Fingerprinting the index without exposing differing index bytes was insufficient for informed investigation.
2. Required reading those differing layers and all supplied session entries before successful submission.
3. Added a deadline race so the host stops waiting even if a provider fails to settle its prompt after cancellation.
4. Preserved pending queue entries across partial session batches and reported the full pending queue in scan mode.
5. Added environment/configuration triggers without exposing sensitive configuration values.
6. Tightened registry and persisted-state validation to reject malformed policy or freshness records.

## Not validated in this environment

The published Pi SDK package could not be installed: the environment returned HTTP 403 for npm registry access. `npm run test:sdk` was attempted and failed with `ERR_MODULE_NOT_FOUND` for `@earendil-works/pi-coding-agent`. No dependency lockfile is fabricated or supplied.

No live LLM invocation or interactive Pi session was run. SDK loading, provider-specific tool schema handling, authentication, custom provider configuration, and semantic quality of real curator output remain integration gates.

The implementation targets the published Pi 0.85.1 package and uses APIs checked against the official SDK/extension documentation and available upstream source. Pinning this version and including a real SDK smoke test makes the remaining compatibility check concrete; it does not imply that check has passed.

On a machine with npm access and configured Pi authentication:

```bash
npm install
npm run test:sdk
PI_KNOWLEDGE_LIVE_PROVIDER=your-provider \
PI_KNOWLEDGE_LIVE_MODEL=your-model npm run test:live
```

Then load the extension in Pi, run `/knowledge init`, `/knowledge scan`, and `/knowledge run dependencies` in a small repository. Inspect its generated document and evidence report before enabling `/knowledge auto run` across a larger project.

Semantic completeness, static-analysis completeness, power-loss durability, Windows behavior, shared-network-filesystem locking, and custom providers registered only by another extension have not been established by these tests. The README describes the implemented scope and the behavior on uncertainty.
