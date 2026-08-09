// The weekly-overtime approval boundary for claims. Pure (no imports) so it is directly
// unit-testable and shared by the claim path.
//
// 40h is the TOP of straight time, NOT overtime — federal OT begins strictly ABOVE 40 (Nevada
// daily-OT does not apply at these rates). So a claim auto-approves at <= 40 and needs manager
// approval only at > 40. This matters for the primary flow: fulfillment 8h×5 and host 10h×4 both
// land at exactly 40, and a same-week exchange (release one, claim another) also lands at 40 — all
// of which must auto-approve, not sit in the (UI-less until Phase 7) pending queue.
export const OT_THRESHOLD_HOURS = 40;

export function claimAutoApproves(projectedWeekHours: number): boolean {
  return projectedWeekHours <= OT_THRESHOLD_HOURS;
}
