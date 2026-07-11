# Decision: Git worktree consolidation (July 2026)

Internal engineering record. This documents why the repository's many extension
worktrees were consolidated, and the rules that keep the layout clean going forward.
No secrets, tokens, or personal data are included here.

## Why this was necessary

Extension development had fanned out into ~9 parallel worktrees and a large set of
local branches, many of which had already merged into `origin/main` while others held
only experimental spikes or byte-identical duplicates of the same unmerged work. The
result was ambiguity about where the newest correct extension code lived, and real
production incidents downstream of it: duplicate order numbering, stale-session
restoration, orders captured without SKU binding, and overlapping migrations. Two
read-only audits established the true state before any change was made.

## Canonical baseline

- **`origin/main` is the single canonical extension baseline.** Its extension version
  is the source of truth; higher version strings in stray worktrees are not evidence of
  newer code (one worktree carried a higher version on strictly older code).
- Everything already merged to `main` — account detection/display, live host selector,
  macro-pad hotkeys, the screenshot pipeline (table + private bucket + upload-first
  capture + storage-delete fix), order idempotency, the diagnostics flight recorder,
  overlay UI polish, barcode staging reliability, and the freeze/session guardrails — is
  confirmed present in `main` and must never be regressed by a naive whole-file merge
  from an older branch.

## Rules going forward

- **One active extension feature worktree at a time.** It is branched from the latest
  `origin/main` and retired once its feature lands. Feature worktrees are temporary.
- **Merged feature worktrees are retired.** A worktree whose branch is an ancestor of
  `origin/main` carries no unique code; its history lives on the remote. It is removed.
- **Local-only WIP is bundled before removal.** Any branch or dirty tree that exists
  only on this machine (not on any remote) is captured as a verified `git bundle` (and,
  for uncommitted changes, a binary-safe patch) before its worktree is removed. Nothing
  local-only is deleted without a verified backup first.
- **The one remaining unmerged production feature is live-session end tracking**
  (heartbeat, `last_seen_at`, `end_source`, room-title relay, stale-session sweeper). It
  is ported onto the latest `main` **hunk-by-hunk** — never as a whole-file take, which
  would revert merged extension work — and its migration is renumbered to the next free
  slot (its original `052` now collides with a shifts migration already in `main`).
- **The future account/shop-scoping direction is preserved separately.** See
  [account-scoping-future.md](account-scoping-future.md). It is archived as a bundle and
  kept as a named branch; it is not merged as part of this consolidation.

## Operational data belongs outside Git

Point-in-time operational artifacts — recovery reconciliation worksheets (CSV/XLSX),
export dumps, and similar analysis output — are archived **outside the repository**.
The repository tracks the durable *reasoning and methods*; the operational data that one
run produced is kept in an external backup, not committed.

## Target end state

- One primary repo tracking `origin/main`.
- At most one active extension feature worktree.
- One unrelated feature worktree (returns) kept separate.
- Backups (bundles + patches + archived operational data) stored outside any repo.
