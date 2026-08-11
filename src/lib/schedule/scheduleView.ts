// Pure render-plan for the PUBLIC /s employee schedule page. No imports, so the test can transpile
// it standalone (same pattern as eligibility.ts). This is the whole of the "no gate — render what
// actually exists" rule: the page must NEVER short-circuit on hasActiveRules(), because an employee
// with no recurring rules can still have a one-time shift assigned to them or a claimable board
// shift and must see it. What renders is decided purely from the COUNT of each section.

export interface ScheduleCounts {
  myShifts: number; // assigned/released-by-me instances in the next 14 days ("Your shifts")
  board: number; // claimable released instances ("Open shifts")
  pending: number; // this viewer's pending OT claims ("Pending approval")
}

export type SectionKey = 'pending' | 'open' | 'yours';

export interface SchedulePlan {
  // true → show ONLY the single empty state ("Nothing scheduled right now."). false → render the
  // sections below (each already known non-empty).
  isEmpty: boolean;
  // Non-empty sections in render order. An empty section is OMITTED entirely (no placeholder card).
  sections: SectionKey[];
}

export function planSchedulePage(c: ScheduleCounts): SchedulePlan {
  // Genuinely nothing pending, assigned, or claimable → the sole empty state.
  if (c.myShifts <= 0 && c.board <= 0 && c.pending <= 0) {
    return { isEmpty: true, sections: [] };
  }

  const sections: SectionKey[] = [];
  // An in-flight OT claim leads — the viewer just filed it and wants to see it landed.
  if (c.pending > 0) sections.push('pending');

  // A non-empty board leads over the schedule (time-sensitive, usually arrived from an SMS); an
  // absent board simply drops out and the schedule leads. Empty sections are never emitted.
  if (c.board > 0) {
    sections.push('open');
    if (c.myShifts > 0) sections.push('yours');
  } else if (c.myShifts > 0) {
    sections.push('yours');
  }

  return { isEmpty: false, sections };
}
