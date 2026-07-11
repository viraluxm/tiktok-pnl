# Lensed (`tiktok-pnl`) — documentation

Durable project documentation. Operational data and point-in-time exports do **not**
live here (see below).

## What's in `docs/`

- **`architecture/`** — durable system reference.
  - [project-overview.md](architecture/project-overview.md) — what Lensed is.
  - [tech-stack-and-structure.md](architecture/tech-stack-and-structure.md) — stack and repo layout.
  - [data-model-and-nuances.md](architecture/data-model-and-nuances.md) — Supabase tables and data-model nuances.
- **`operations/`** — runbooks and recovery methods.
  - [live-unbound-order-recovery.md](operations/live-unbound-order-recovery.md) — recovering unbound live orders into correct COGS / inventory / P&L.
- **`returns/`** — returns/refunds/claims capability.
  - [returns-detail-capability.md](returns/returns-detail-capability.md)
  - [returns-refunds-audit.md](returns/returns-refunds-audit.md)
- **`decisions/`** — engineering decision records.
  - [worktree-consolidation.md](decisions/worktree-consolidation.md) — why the extension worktrees were consolidated and the rules that keep them clean.
  - [account-scoping-future.md](decisions/account-scoping-future.md) — the preserved account/shop-scoping direction.
- Top-level notes already tracked here: `consolidation-2026-07.md` (account/login
  consolidation), `session-end-signal.md` (live-session end-signal spec),
  `viewtrack-integration.md`.

## Where extension architecture is documented

The Chrome extension lives in [`extension/`](../extension/); its own
[`extension/README.md`](../extension/README.md) documents build/load and behavior. The
live-session end-of-live design is specified in
[`session-end-signal.md`](session-end-signal.md).

## Canonical source & worktrees

**`origin/main` is canonical.** Extension feature worktrees are **temporary** — branched
from the latest `main`, then retired once merged. See
[decisions/worktree-consolidation.md](decisions/worktree-consolidation.md).

## Operational data is archived outside Git

Recovery reconciliation worksheets and other point-in-time exports (CSV/XLSX) are
**archived outside the repository**, not committed. This directory tracks durable
reasoning and methods; the data one run produced is kept in an external backup.
