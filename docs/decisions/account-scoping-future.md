# Decision: account / shop-scoped ownership (future direction, preserved WIP)

Internal engineering record. Documents a preserved work-in-progress direction that is
**intentionally not merged**. No secrets, tokens, or personal data are included.

## Current production behavior

Order and session ownership is presently keyed primarily by **Lensed user / store**.
Multi-store support already exists in `main`: store-scoped writes and per-store TikTok
connections landed, and the web app selects the active store via an httpOnly
`lensed_active_store` cookie.

## The gap

The browser extension cannot read the web app's httpOnly active-store cookie, so live
sessions and capture events it creates are not reliably stamped with a `store_id`. When
one login owns multiple stores, the host's membership resolves ambiguously and those
rows fall back to a backstop instead of a fail-loud store guard. Only the *display-only*
portion of TikTok account detection has shipped to `main`; the full account-scoped
session implementation has not.

## Preserved future work

A full account-scoped-live-sessions implementation exists as **preserved WIP**. It is:

- kept as a **named local branch** and captured as a verified `git bundle` in the
  external backup, and
- **not merged** — it predates a great deal of current `main` and is a direction to pick
  up deliberately, not a change to fast-forward in.

The intended direction is TikTok-account / shop-scoped canonical ownership: the
extension authenticates as the store's login and relays `store_id` (through the existing
`LENSED_AUTH` message path) so it can be included when sessions are created. Once the
extension passes `store_id`, `live_sessions` and the auction tables can be flipped from
the backstop to the fail-loud store guard.

## Why it's recorded here

So that six months from now this is a findable, deliberate thread — not a mystery branch.
When account/shop-scoped ownership is picked up, start from the preserved bundle, rebase
its intent onto the latest `main`, and re-apply as hunks; do not merge the stale branch
wholesale.
