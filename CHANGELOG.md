# Changelog

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
