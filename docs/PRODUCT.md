# Lensed

register: product

## Product purpose

Lensed runs a warehouse-based TikTok live-selling operation: inventory, live-auction capture,
order sync, pick/pack fulfillment, employee timekeeping, and scheduling. It is an operational tool
people use during their shift, not a marketing surface. Design serves the task.

Two audiences use it:

- **Owners / managers** on a laptop in the office or on a phone on the warehouse floor. They build
  the schedule, approve transfers, confirm punches, and read P&L.
- **Employees** (live hosts and fulfillment staff, ~50 active) who open one permanent link,
  `/s/<token>`, on their phone. No login. They want to know when they work next, how many hours
  they have, whether their punches landed, and what is waiting on them.

## Users, in their own context

- A live host checking her phone in the parking lot at 5:40 PM before a 6 PM–2 AM show. Bright
  evening light, one hand, thirty seconds.
- A fulfillment picker on break at 10 AM under warehouse fluorescents, asking whether his Friday
  pickup was approved and whether last night's 8-hour punch shows 8 hours.
- A manager at a desk deciding a pickup, a trade, or a time-off request, who needs both sides of
  the change and any conflict spelled out.

## Tone and voice

Plain, direct, warm without being cute. Sentences say what happened and what happens next.
Employee-facing copy never uses internal vocabulary ("instance", "materialize", "release",
"claim"); a dropped shift is *offered*, and the worker is told in as many words that it is still
theirs until a manager approves someone else. Numbers are stated once. Status is stated in words,
never only by colour.

## Brand and visual identity

Dark, quiet, precise. Near-black ground (#0f0f0f), soft translucent surfaces, hairline borders, a
single cyan accent (#69C9D0) for the current selection and primary actions, magenta reserved for
brand moments and destructive emphasis. System font stack. Restrained colour strategy: tinted
neutrals plus one accent well under 10% of the surface. Green / yellow / red carry functional
state only and are always paired with text.

## Strategic principles

1. **Scheduled and worked are different numbers.** Planned hours come from `shift_instances`;
   worked/paid hours come from real `shifts` punches through `isPayableShift()`. The UI must never
   blur them.
2. **Responsibility is explicit.** Offering a shift does not hand it back. Nothing changes hands
   without a manager. The interface repeats this where it matters, not in a tooltip.
3. **Token identity is the boundary.** Every employee read and write resolves the employee from the
   permanent token server-side; the browser never chooses an employee or an owner.
4. **Familiar patterns, no invention.** Bottom navigation, a Monday–Sunday week strip, segmented
   controls, bottom sheets. The tool should disappear into the task.
5. **Truthful edge states.** An open punch says "in progress"; an anomalous punch is shown, not
   hidden or capped. Empty states say what is true and what to do next.

## Anti-references

- Generic SaaS admin dashboards: KPI tiles, gradients, glass, a card around every fact.
- Corporate HR suites: dense tables, jargon, five-tab navigation.
- Consumer fintech neon-on-black. The dark ground here is quiet, not glowing.
- Anything that needs two hands or a desktop to read.
