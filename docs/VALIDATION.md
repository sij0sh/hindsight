# Validation record · v0.2.0

Build date: 2026-09-18. Environment: Linux, Node.js v24.19.0, npm 12.0.2, Git 2.55.0.

## Results

| Check | Result |
| --- | --- |
| `npm run check` | Module/entrypoint syntax and registry validation passed |
| `node --test --test-reporter=spec test/*.test.mjs` | **112 passed, 0 failed, 0 skipped** |
| `npm pack --dry-run --json` | Release contents inspected; source, catalog, tests, scripts, and docs included |
| `npm run test:sdk` | Failed: `ERR_MODULE_NOT_FOUND` for the pinned Pi SDK |
| `npm run test:live` | Not run; real SDK/provider execution remains unvalidated |

Captured local test output: [TEST-RESULTS.txt](TEST-RESULTS.txt). The historical v0.1.0 record and its 47-test output are retained separately.

The tests create real temporary Git repositories and exercise actual filesystem persistence. Model-facing tests inject a fake SDK or deterministic curator; they do not establish compatibility with the real installed package or the semantic quality of model output.

## Added coverage

- Record validation, explicit scopes, evidence-derived confidence, actual user versus assistant authority, and accepted versus proposed ADRs.
- Multiline rejection without incorrectly rejecting valid conjunctions; exact deduplication across domains while preserving different scopes and near matches.
- Reinforcement and semantic fingerprint stability; supersession/tombstones; deliberate retirement; immutable input on batch failure.
- Conflicts, duplicate retry handling, restoration, inherited applicability, and authority requirements for open-question resolution.
- Scars, inventory-based removal review, and absence of automatic retirement.
- Deterministic shared projections, lifecycle filtering, contextual path/symbol/concept matching, and explicit truncation.
- Original-byte migration backups including CRLF, individual bullet candidates, same wording in different domains, idempotency, and explicit archive/scope/atomicity review.
- Manual view drift blocks curation until explicit migration; unchanged rendered claims are not duplicated during import.
- Persisted conflicts leave source/session/semantic freshness unchanged; explicit resolution permits later success.
- Shared view updates retain sibling source baselines. Scope/provenance expand routing; already-read expansions do not cause repeat work, while unread expansions remain pending.
- Ledger/config/registry/state changes during investigation cannot be overwritten by proposal or failure bookkeeping.
- Partial multi-file recovery, pending-journal read refusal, and preflight of every target before any replay write.
- Context argument parsing, opt-in injection with natural apostrophes, pending-review warnings, and fallback when no task path is known.
- Session episode normalization (user anchors, compact tool summaries, raw-body exclusion, pre-user exclusion, policy-versioned hashes), version-1 archive upgrades, episode routing/batching/acknowledgement, and `bundle:sessions` coverage with per-entry fallback.
- Bounded Git history evidence with independent historical safety filtering, `history` provenance that stays inferred, `bundle:git` coverage for full and incremental ranges, explicit `history_diverged` handling, and snapshot/fingerprint drift coverage.
- Deterministic bundle sharding into numbered parts with per-part budgets, full-read gates per part, and honest unavailable reporting instead of truncation.
- Fresh installs default to automatic run mode with matching setup messaging, lifecycle hooks, documentation, and tests.

Existing coverage still includes the ten-domain catalog, unchanged zero-model-call runs, Git working/index/HEAD changes and unborn repositories, incremental session episode batching, sensitive-input withholding, symlink refusal, bounded scheduling, evidence receipt/completion checks, legacy journal recovery, and mocked SDK tool isolation/cancellation/deadlines.

## Iterations prompted by validation

1. Corrected post-reconciliation freshness when memory provenance expands a domain's source surface. Newly relevant unread evidence is never acknowledged implicitly.
2. Separated migration list items and skipped unchanged generated entries; preserved cross-domain import applicability and exact original text.
3. Added archive evidence and mandatory original reading before imported claims can be approved.
4. Required current authority for targetless open questions and prevented conflict scope from hiding a disputed global rule.
5. Counted different Git layers of the same source as one indirect confidence source.
6. Bounded the actual serialized ledger, including projection hashes and audit history, before persistence.
7. Replaced command-style tokenization of ordinary user prompts so natural apostrophes do not disable context injection.

## Remaining integration gates

The pinned dependency is `@earendil-works/pi-coding-agent@0.85.1`. The original install attempt encountered HTTP 403 for npm access; the v0.2.0 SDK smoke attempt still fails because the package is unavailable. No dependency lockfile is fabricated. Pi SDK API use was checked against upstream documentation/source in the original implementation; the same adapter is retained with the new memory schemas.

On a machine with npm access and configured Pi authentication:

```bash
npm install
npm run test:sdk
PI_KNOWLEDGE_LIVE_PROVIDER=your-provider \
PI_KNOWLEDGE_LIVE_MODEL=your-model npm run test:live
```

Then load the extension in an interactive Pi session. Exercise `init --migrate` on a backed-up small repository, review imported candidates, run a domain investigation, and inspect the ledger, generated views, provenance, and scoped context before enabling automatic curation broadly.

Actual SDK loading, provider-specific schema behavior, authentication, interactive Pi integration, custom provider behavior, semantic completeness, power-loss durability, Windows behavior, and shared-network-filesystem locking have not been established by these local tests.
