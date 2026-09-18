# Changelog

## Unreleased

- Auto-purge a dead local `run.lock` on the next write with journal recovery; live, foreign-host, and corrupt locks stay blocked, with `unlock` remaining for uncertain cases.
- Run `run`/`force` curations in a detached background process: Pi triggers fire-and-forget, survives terminal close, and reports progress via `scan` plus per-run logs. `cancel` now signals the background run; `unlock` stays for stale locks.

- Normalize captured Pi sessions into user-anchored episodes with compact tool-call summaries; route, batch, and acknowledge episodes while keeping atomic messages as provenance.
- Add bounded Git commit/message/diff evidence with historical safety filtering, `history` provenance, deterministic `bundle:git` coverage, and explicit `history_diverged` handling.
- Shard all coverage bundles into deterministic parts with per-part budgets and full-read gates; `bundle:*` receipts remain rejected as durable provenance.

## 0.2.0 — 2026-09-18

- Make `.agents/curation/memory.json` canonical; render ten domain views and the AGENTS routing block deterministically.
- Add scoped memory kinds, provenance, derived confidence, lifecycle operations, shared projections, tombstones, and audit lookup.
- Persist conflicts with ADR references while leaving blocked reviews pending; add explicit conflict resolution and scar removal review.
- Add `migrate`, `init --migrate`, `context`, and `memory` commands, plus optional scoped Pi context injection.
- Preserve original Markdown during explicit migration and require review before imported candidates become active.
- Commit ledger, views, AGENTS, and state through a recoverable multi-file journal; guard concurrent evidence and configuration changes.
- Retain Pi SDK 0.85.1 as the agent SDK and preserve the deterministic router and investigation catalogs.
- Replace legacy curator Markdown submissions with memory operations. Keep legacy journal recovery.
- Expand local validation from 47 to 82 tests. Real SDK/provider validation remains pending.

## 0.1.0 — 2026-09-17

- Initial deterministic routing, ten evidence-driven Pi SDK curators, criterion manifests, guarded Markdown updates, and per-domain freshness.
