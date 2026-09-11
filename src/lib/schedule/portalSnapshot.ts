import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { payPeriodStartFor } from '@/lib/employees';
import type { Employee, ShiftInstance } from '@/types';
import { laTodayISO, addDaysISO } from './timezone';
import { instanceHours, weekBoundsMonSun } from './hours';
import { getBoard, getMyPendingClaims, getCurrentPeriodDrops } from './board';
import { getAvailableShifts } from './offer';
import { PICKUP_REFUSAL_MESSAGES } from './offerPlan';
import { getWeekSchedule } from './mySchedule';
import { getTeamSchedule } from './teamSchedule';
import { earliestRequestableDate } from './timeOff';
import { getTimecard, getOpenPunch, clockStateOf } from './timecard';
import { listMyTrades } from './trade';
import type {
  AvailableItem, PickupRequestView, PortalShift, PortalSnapshot, PortalWeek, TimeOffView, TradeView,
} from './portalTypes';

// ONE payload for the employee portal's Home / Schedule / Requests, built server-side from the
// token-resolved employee. The client fetches this once and caches it (React Query keyed by token),
// so the three tabs never fetch the same schedule independently.
//
// SECURITY. Service-role client from a public token route: RLS is not the boundary. `employee`
// comes from resolveEmployeeByToken; every query below carries `user_id = employee.user_id` and,
// where it is the employee's own data, `employee_id = employee.id`. The projection functions at the
// bottom are the field allow-list — a `shift_instances` row never reaches the client whole.
//
// SCHEDULED vs WORKED. `upcoming` and `thisWeek.scheduledHours` come from shift_instances (the plan).
// `thisWeek.workedHours` / `payPeriod.workedHours` come from getTimecard, i.e. real `shifts`
// punches through isPayableShift/paidShiftHours. They are separate fields with separate sources,
// and nothing in this file adds one to the other.

const INSTANCE_COLS = 'id, shift_date, starts_at, ends_at, status, role, offer_state, offer_id';
const PICKUP_HISTORY_DAYS = 30;
const TIME_OFF_HISTORY_DAYS = 60;

type Admin = ReturnType<typeof createAdminClient>;

function toPortalShift(row: Pick<ShiftInstance, 'id' | 'shift_date' | 'starts_at' | 'ends_at' | 'status' | 'role' | 'offer_state' | 'offer_id'>, employeeRole: string | null, tradeByInstance: Map<string, PortalShift['trade']>): PortalShift {
  return {
    id: row.id,
    shift_date: row.shift_date,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    status: row.status === 'claimed' ? 'claimed' : 'scheduled',
    role: row.role ?? employeeRole,
    hours: instanceHours(row.starts_at, row.ends_at),
    offer_state: row.offer_state ?? null,
    offer_id: row.offer_id ?? null,
    trade: tradeByInstance.get(row.id) ?? null,
  };
}

/** The live trade touching each of MY instances, keyed by instance id. */
function activeTradesByInstance(trades: TradeView[]): Map<string, PortalShift['trade']> {
  const m = new Map<string, PortalShift['trade']>();
  for (const t of trades) {
    if (t.status !== 'pending_coworker' && t.status !== 'pending_manager') continue;
    m.set(t.my_shift.instance_id, { id: t.id, status: t.status, with_name: t.other_name, i_am: t.direction === 'outgoing' ? 'requester' : 'target' });
  }
  return m;
}

async function getMyPickups(admin: Admin, employee: Employee, now: Date): Promise<PickupRequestView[]> {
  const since = new Date(now.getTime() - PICKUP_HISTORY_DAYS * 86_400_000).toISOString();
  const { data: claims, error } = await admin
    .from('shift_claims')
    .select('id, shift_instance_id, status, claimed_at, approved_at')
    .eq('user_id', employee.user_id)
    .eq('claimed_by', employee.id)
    .eq('kind', 'pickup_request')
    .or(`status.eq.pending,approved_at.gte.${since}`)
    .order('claimed_at', { ascending: false });
  if (error) throw new Error(`getMyPickups: ${error.message}`);
  const rows = claims ?? [];
  if (rows.length === 0) return [];
  const { data: insts } = await admin
    .from('shift_instances')
    .select('id, shift_date, starts_at, ends_at')
    .eq('user_id', employee.user_id)
    .in('id', rows.map((r) => r.shift_instance_id as string));
  const byId = new Map((insts ?? []).map((i) => [i.id as string, i]));
  return rows.flatMap((r) => {
    const i = byId.get(r.shift_instance_id as string);
    if (!i) return [];
    return [{
      claim_id: r.id as string,
      shift_instance_id: i.id as string,
      shift_date: i.shift_date as string,
      starts_at: i.starts_at as string,
      ends_at: i.ends_at as string,
      status: r.status as PickupRequestView['status'],
      requested_at: r.claimed_at as string,
      decided_at: (r.approved_at as string | null) ?? null,
    }];
  });
}

async function getMyTimeOff(admin: Admin, employee: Employee, todayISO: string): Promise<TimeOffView[]> {
  const { data, error } = await admin
    .from('time_off_requests')
    .select('id, start_date, end_date, reason, status, decision_note, created_at, decided_at')
    .eq('employee_id', employee.id)
    .eq('user_id', employee.user_id)
    .neq('status', 'withdrawn')
    .gte('end_date', addDaysISO(todayISO, -TIME_OFF_HISTORY_DAYS))
    .order('start_date', { ascending: true });
  if (error) throw new Error(`getMyTimeOff: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    start_date: r.start_date as string,
    end_date: r.end_date as string,
    reason: (r.reason as string | null) ?? null,
    status: r.status as TimeOffView['status'],
    decision_note: (r.decision_note as string | null) ?? null,
    created_at: r.created_at as string,
    decided_at: (r.decided_at as string | null) ?? null,
  }));
}

export async function getPortalSnapshot(employee: Employee, now: Date = new Date()): Promise<PortalSnapshot> {
  const admin = createAdminClient();
  const owner = employee.user_id;
  if (!owner) throw new Error('portal: employee has no user_id — refusing an unscoped query');
  const todayISO = laTodayISO(now);
  const week = weekBoundsMonSun(todayISO);

  const [mine, released, trades, offers, board, pickups, otClaims, timeOff, { drops }, timecard, open] = await Promise.all([
    // My plan from this week's Monday forward (the week total needs the days already behind us).
    admin.from('shift_instances').select(INSTANCE_COLS)
      .eq('user_id', owner).eq('employee_id', employee.id)
      .in('status', ['scheduled', 'claimed']).gte('shift_date', week.start)
      .order('starts_at', { ascending: true }),
    admin.from('shift_instances').select('id, shift_date, starts_at, ends_at')
      .eq('user_id', owner).eq('released_by', employee.id).eq('status', 'released').gte('shift_date', todayISO)
      .order('starts_at', { ascending: true }),
    listMyTrades(employee, now),
    getAvailableShifts(employee, now),
    getBoard(employee, now),
    getMyPickups(admin, employee, now),
    getMyPendingClaims(employee),
    getMyTimeOff(admin, employee, todayISO),
    getCurrentPeriodDrops(employee),
    getTimecard(employee, now),
    getOpenPunch(admin, employee),
  ]);
  if (mine.error) throw new Error(`portal mine: ${mine.error.message}`);
  if (released.error) throw new Error(`portal released: ${released.error.message}`);

  const tradeByInstance = activeTradesByInstance(trades);
  const myRows = (mine.data ?? []) as Pick<ShiftInstance, 'id' | 'shift_date' | 'starts_at' | 'ends_at' | 'status' | 'role' | 'offer_state' | 'offer_id'>[];
  const shifts = myRows.map((r) => toPortalShift(r, employee.role ?? null, tradeByInstance));

  const available: AvailableItem[] = [
    ...offers.map((a): AvailableItem => ({
      kind: 'offer',
      id: a.id,
      offer_id: a.offer_id,
      shift_date: a.shift_date,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      role: a.role,
      hours: instanceHours(a.starts_at, a.ends_at),
      offered_by_name: a.offered_by_name,
      requested: a.refusal === 'ALREADY_REQUESTED',
      refusal: a.refusal && a.refusal !== 'ALREADY_REQUESTED' ? PICKUP_REFUSAL_MESSAGES[a.refusal] : null,
    })),
    ...board.map((b): AvailableItem => ({
      kind: 'open',
      id: b.id,
      offer_id: null,
      shift_date: b.shift_date,
      starts_at: b.starts_at,
      ends_at: b.ends_at,
      role: b.releaser_role,
      hours: instanceHours(b.starts_at, b.ends_at),
      offered_by_name: b.releaser_name,
      requested: false,
      refusal: null,
    })),
  ].sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));

  return {
    employee: {
      name: employee.name,
      role: employee.role ?? null,
      shortId: employee.id.slice(0, 8),
      status: employee.status,
    },
    todayISO,
    generatedAt: now.toISOString(),
    upcoming: shifts.filter((s) => s.shift_date >= todayISO),
    releasedByMe: ((released.data ?? []) as { id: string; shift_date: string; starts_at: string; ends_at: string }[]).map((r) => ({
      id: r.id, shift_date: r.shift_date, starts_at: r.starts_at, ends_at: r.ends_at,
    })),
    thisWeek: {
      start: week.start,
      end: week.end,
      scheduledHours: Math.round(shifts.filter((s) => s.shift_date >= week.start && s.shift_date <= week.end).reduce((sum, s) => sum + s.hours, 0) * 100) / 100,
      workedHours: timecard.week.workedHours,
      pendingHours: timecard.week.pendingHours,
    },
    payPeriod: {
      start: timecard.period.start,
      end: timecard.period.end,
      // The SCHEDULED Pay Day for this period (employees.paydayForPeriod, via getTimecard). Lensed
      // records no evidence that a payment happened, so this is a due date and is labelled as one.
      payday: timecard.payday,
      workedHours: timecard.period.workedHours,
      pendingHours: timecard.period.pendingHours,
    },
    clock: clockStateOf(open),
    available,
    pickups,
    otClaims: otClaims.map((c) => ({
      claim_id: c.claim_id, shift_date: c.shift_date, starts_at: c.starts_at, ends_at: c.ends_at, projected_week_hours: c.projected_week_hours,
    })),
    timeOff,
    timeOffEarliest: earliestRequestableDate(todayISO, payPeriodStartFor),
    trades,
    drops: { used: drops.drops, cap: 2, excused: drops.excused },
  };
}

/** One Mon→Sun week: my planned shift per day + the team's coverage. Reuses the Phase 2 readers. */
export async function getPortalWeek(employee: Employee, weekStartISO: string): Promise<PortalWeek> {
  const [mine, team] = await Promise.all([getWeekSchedule(employee, weekStartISO), getTeamSchedule(employee, weekStartISO)]);
  const none = new Map<string, PortalShift['trade']>();
  return {
    start: mine.start,
    end: mine.end,
    days: mine.days.map((d) => ({
      date: d.date,
      shift: d.instance
        ? toPortalShift(
          { id: d.instance.id, shift_date: d.instance.shift_date, starts_at: d.instance.starts_at, ends_at: d.instance.ends_at, status: d.instance.status, role: d.instance.role ?? null, offer_state: d.instance.offer_state ?? null, offer_id: d.instance.offer_id ?? null },
          employee.role ?? null,
          none, // trade annotations come from the snapshot on the client (one source, no second read)
        )
        : null,
    })),
    team: team.days.map((d) => ({
      date: d.date,
      shifts: d.shifts.map((s) => ({
        instance_id: s.instance_id,
        name: s.name,
        role: s.role,
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        hours: instanceHours(s.starts_at, s.ends_at),
        offered: s.offered,
        offer_id: null, // resolved on the client via the snapshot's available list (carries the offer_id)
        is_me: s.is_me,
      })),
    })),
  };
}
