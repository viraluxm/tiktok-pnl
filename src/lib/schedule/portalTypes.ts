// Wire types for the employee portal (/s/[token]). Shared by the server builders
// (portalSnapshot.ts, timecard.ts, trade.ts), the JSON routes under /s/[token]/portal/*, and the
// client app under src/components/portal. NO value imports and NO 'server-only' — this file is
// imported by client components, so it must stay pure types.
//
// FIELD DISCIPLINE. Everything here is what an EMPLOYEE may see. Nothing carries hourly_rate, phone,
// pin hashes, payroll amounts, manager notes or another employee's worked time. Coworker rows carry
// a name, a role label, a time span and an instance id — the minimum the schedule needs.

export type PortalRole = 'host' | 'fulfillment' | string;

export interface PortalEmployee {
  name: string;
  role: PortalRole | null;
  /** First 8 chars of the employee id — the ID the QR clock sheet prints under the code. */
  shortId: string;
  status: 'active' | 'probation' | 'former';
}

export type PortalOfferState = 'offered' | 'transferred' | 'closed' | null;

/** One of MY planned shifts (a scheduled/claimed shift_instances row). */
export interface PortalShift {
  id: string;
  shift_date: string; // LA calendar date 'YYYY-MM-DD'
  starts_at: string; // ISO instant
  ends_at: string; // ISO instant
  status: 'scheduled' | 'claimed';
  role: PortalRole | null;
  /** Planned span in hours (instanceHours). Never a pay figure. */
  hours: number;
  offer_state: PortalOfferState;
  offer_id: string | null;
  /** The live trade this shift is part of, if any. */
  trade: { id: string; status: TradeStatus; with_name: string; i_am: 'requester' | 'target' } | null;
}

/** A coworker's shift as shown on Team. */
export interface PortalTeamShift {
  instance_id: string;
  name: string;
  role: PortalRole | null;
  starts_at: string;
  ends_at: string;
  hours: number;
  /** on the pickup board — STILL that person's shift */
  offered: boolean;
  offer_id: string | null;
  is_me: boolean;
}

export interface PortalTeamDay {
  date: string;
  shifts: PortalTeamShift[];
}

/** One Mon→Sun week: my planned shift per day plus the team's coverage. */
export interface PortalWeek {
  start: string;
  end: string;
  days: { date: string; shift: PortalShift | null }[];
  team: PortalTeamDay[];
}

/**
 * Something the viewer could pick up. Two kinds exist in Lensed and both are "available":
 *   'offer' — Phase 2 Drop Shift: still owned by someone; a request goes to a manager.
 *   'open'  — the legacy board: a released or admin-posted open shift; claiming assigns it right
 *             away (or files an OT approval when it would push the week over 40h).
 */
export interface AvailableItem {
  kind: 'offer' | 'open';
  id: string;
  offer_id: string | null;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  role: PortalRole | null;
  hours: number;
  offered_by_name: string | null;
  /** Employee-facing reason the viewer cannot take it (renders as a label). null = can request. */
  refusal: string | null;
  /** The viewer already has a pending pickup request on this shift. */
  requested: boolean;
}

export interface PickupRequestView {
  claim_id: string;
  shift_instance_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  requested_at: string;
  decided_at: string | null;
}

export interface OtClaimView {
  claim_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  projected_week_hours: number | null;
}

export type TimeOffStatus = 'pending' | 'approved' | 'denied';

export interface TimeOffView {
  id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: TimeOffStatus;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
}

export type TradeStatus = 'pending_coworker' | 'pending_manager' | 'approved' | 'declined' | 'cancelled';

export interface TradeShiftFacts {
  instance_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
  hours: number;
}

export interface TradeView {
  id: string;
  status: TradeStatus;
  /** 'outgoing' = I proposed it; 'incoming' = a coworker proposed it to me. */
  direction: 'outgoing' | 'incoming';
  other_name: string;
  my_shift: TradeShiftFacts;
  their_shift: TradeShiftFacts;
  created_at: string;
  coworker_response: 'accepted' | 'declined' | null;
  coworker_responded_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  cancelled_at: string | null;
}

export type ClockState = 'clocked_out' | 'working' | 'on_break';

export interface PortalSnapshot {
  employee: PortalEmployee;
  todayISO: string;
  /** Server time the snapshot was built, ISO. */
  generatedAt: string;
  /** My planned shifts from today forward, in order. Offered shifts stay here — they are still mine. */
  upcoming: PortalShift[];
  /** Shifts I released the LEGACY way (status 'released', released_by me) — still waiting for pickup. */
  releasedByMe: { id: string; shift_date: string; starts_at: string; ends_at: string }[];
  thisWeek: {
    start: string;
    end: string;
    /** planned hours from shift_instances */
    scheduledHours: number;
    /**
     * PAYABLE hours from real punches (isPayableShift + paidShiftHours) — i.e. the manager-approved
     * duration wherever one exists (migration 137), else the legacy clocked calculation. Surfaced
     * to the employee as "Approved". Kept named workedHours because it is the same canonical figure
     * the rest of the app calls worked/paid hours; the label changed, the source did not.
     */
    workedHours: number;
    /** completed time-clock hours a manager has not approved yet — excluded from workedHours */
    pendingHours: number;
  };
  payPeriod: { start: string; end: string; workedHours: number; pendingHours: number };
  clock: { state: ClockState; clockedInAt: string | null };
  available: AvailableItem[];
  pickups: PickupRequestView[];
  otClaims: OtClaimView[];
  timeOff: TimeOffView[];
  /** earliest date a new time-off request may cover */
  timeOffEarliest: string;
  trades: TradeView[];
  drops: { used: number; cap: number; excused: number };
}

// ── Timecard ──────────────────────────────────────────────────────────────────────────────────

export type TimecardEntryState = 'complete' | 'awaiting_confirmation' | 'auto_closed' | 'in_progress';

export interface TimecardEntry {
  id: string;
  /** LA business date the punch books to (clock-in date). */
  date: string;
  clock_in: string; // ISO instant
  clock_out: string | null; // null only for an in-progress manual open shift
  /**
   * The PAYABLE duration (paidShiftHours): the manager-approved minutes when they exist, else the
   * legacy clocked calculation. 0 when the punch is still open. Never a pay AMOUNT — no rate or
   * money ever reaches this payload.
   */
  hours: number;
  /**
   * The ATTENDANCE duration: what the punch itself spans, net of unpaid break. Shown beside
   * `hours` so a live host can see that their 8h32m on the clock was approved as 7h58m of live
   * time — and that the difference is not a lost punch.
   */
  clocked_hours: number;
  /**
   * migration 137 — the manager-approved payable minutes, or null when no explicit approval exists
   * (a legacy confirmed shift, or one still awaiting confirmation).
   */
  approved_minutes: number | null;
  break_minutes: number;
  payable: boolean;
  state: TimecardEntryState;
  source: 'time_clock' | 'manual';
}

export interface TimecardDay {
  date: string;
  entries: TimecardEntry[];
  /** payable hours only */
  hours: number;
}

export interface TimecardWindow {
  start: string;
  end: string;
  workedHours: number;
  pendingHours: number;
  days: TimecardDay[];
}

export interface TimecardOpenPunch {
  clockedInAt: string;
  onBreak: boolean;
  needsManualClose: boolean;
}

export interface TimecardPayload {
  todayISO: string;
  week: TimecardWindow;
  period: TimecardWindow;
  open: TimecardOpenPunch | null;
}

// ── Trade options (step 2 + 3 of Request Trade) ───────────────────────────────────────────────

export interface TradeCoworkerOption {
  employee_id: string;
  name: string;
  role: PortalRole | null;
  shifts: TradeShiftFacts[];
}

export interface TradeOptionsPayload {
  my_shift: TradeShiftFacts;
  coworkers: TradeCoworkerOption[];
}
