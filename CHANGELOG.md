# Changelog

## Unreleased

- Ingest Claude Code transcripts (`~/.claude/projects/<encoded-cwd>/<session>.jsonl`) alongside Pi and Muse Code sessions: human-typed prompts only, default-deny tool-argument projection, tool outcomes without bodies, and `claudeAutoImport`/`maxClaudeImportChars` controls. Explicit `capture` also accepts Claude Code JSONL.
- Pull Pi sessions from Pi's on-disk session store on every `run`/`force` (`piAutoImport`/`maxPiImportChars`), recovering sessions the live hook skipped; forked sessions keep only their own entries.
- Add `hindsight import` to pull all three session sources without curating.
- Attach Pi tool outcomes (exit codes, test counts, timeouts, failures) by call id, strip injected context from stored prompts, label episodes with their `source`, and store repository-relative tool paths.
- Fix Muse cursors keyed by session id instead of directory, which re-imported every session on every run.
- The session normalization policy moves to `pi-session-episode-v2`, so every existing session episode re-queues once. With `auto run`, the next Pi turn may curate up to `maxAutoJobs` domains; switch to `auto scan` first to review the queue.
- Session archives in `.agents/curation/sessions/` now also hold Claude Code prompt and assistant text. Keep `.agents/curation/` out of version control unless that is intended.

- Pull Muse Code sessions for the repository on every `run`/`force` (Pi is the hook): same user-anchored episodes and curation pipeline as Pi sessions, with `museAutoImport`/`maxMuseImportChars` controls, sequence cursors, and subagent exclusion. Explicit `capture` accepts Pi or Muse JSONL.
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
