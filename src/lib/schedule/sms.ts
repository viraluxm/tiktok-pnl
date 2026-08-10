import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { BUSINESS_TZ } from './timezone';

// SMS (Part 6) — Twilio via REST (no SDK dependency; dormant while disabled).
//
// GATE: SMS_SEND_ENABLED must be exactly "true" to actually send. Default (unset/anything else) is
// LOG-ONLY: we console.log the exact recipient + message that WOULD have gone out, and send nothing.
// This gives a day of log-only review before any real traffic. Missing Twilio env in send mode is
// logged and skipped (never throws into a user path).
export function smsEnabled(): boolean {
  return process.env.SMS_SEND_ENABLED === 'true';
}

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://lensed.io').replace(/\/$/, '');
}

export function tokenLink(token: string): string {
  return `${appBaseUrl()}/s/${token}`;
}

// One low-level send. Returns whether it actually dispatched (false in log-only / misconfig).
export async function sendSms(to: string, body: string, tag: string): Promise<boolean> {
  if (!smsEnabled()) {
    console.log(`[sms] LOG_ONLY tag=${tag} to=${to} body=${JSON.stringify(body)}`);
    return false;
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    console.error(`[sms] SEND_ENABLED but Twilio env missing — skipping tag=${tag} to=${to}`);
    return false;
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    if (!res.ok) {
      console.error(`[sms] Twilio ${res.status} tag=${tag} to=${to}: ${await res.text()}`);
      return false;
    }
    console.log(`[sms] SENT tag=${tag} to=${to}`);
    return true;
  } catch (e) {
    console.error(`[sms] send error tag=${tag} to=${to}: ${(e as Error).message}`);
    return false;
  }
}

// ── Message builders ────────────────────────────────────────────────────────
function fmtDate(startsAtISO: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, weekday: 'short', month: 'short', day: 'numeric',
  }).format(new Date(startsAtISO));
}
function fmtTimeRange(startsAtISO: string, endsAtISO: string): string {
  const f = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  return `${f(startsAtISO)}–${f(endsAtISO)}`;
}

export interface ShiftMsgInfo {
  starts_at: string;
  ends_at: string;
  storeName?: string | null;
}

export function onboardingMessage(link: string): string {
  return (
    `Welcome to the team schedule. Open your permanent link and tap Share → "Add to Home Screen" ` +
    `so it's always one tap away: ${link}`
  );
}
export function shiftReleasedMessage(s: ShiftMsgInfo, link: string): string {
  const where = s.storeName ? `, ${s.storeName}` : '';
  return `A shift opened: ${fmtDate(s.starts_at)}, ${fmtTimeRange(s.starts_at, s.ends_at)}${where}. Claim it: ${link}`;
}
export function shiftReminderMessage(s: ShiftMsgInfo, link: string): string {
  return `Reminder: you work tomorrow ${fmtDate(s.starts_at)}, ${fmtTimeRange(s.starts_at, s.ends_at)}. ${link}`;
}
export function claimApprovedMessage(s: ShiftMsgInfo, link: string): string {
  return `Approved: you've picked up ${fmtDate(s.starts_at)}, ${fmtTimeRange(s.starts_at, s.ends_at)}. ${link}`;
}

// ── Released-shift broadcast (ONE per release, deduplicated by employee) ──────
// Recipients = eligible employees per the board rule: same role as the slot, active, has a phone
// and an active token, NOT the releaser, and no active instance that day. Called exactly once from
// the release path, so it is one broadcast per release (never per page load).
export async function broadcastShiftReleased(args: {
  instanceId: string;
  role: string; // the released shift's role = the releaser's employees.role (migration 086)
  storeId: string | null;
  shiftDate: string;
  startsAt: string;
  endsAt: string;
  releaserId: string;
  ownerUserId: string;
}): Promise<{ recipients: number; sent: number }> {
  const admin = createAdminClient();

  let storeName: string | null = null;
  if (args.storeId) {
    const { data: store } = await admin.from('stores').select('name').eq('id', args.storeId).maybeSingle();
    storeName = store?.name ?? null;
  }

  // Eligible employees: same owning user, active, matching role, with a phone.
  const { data: emps } = await admin
    .from('employees')
    .select('id, phone, role, status')
    .eq('user_id', args.ownerUserId)
    .eq('status', 'active')
    .eq('role', args.role);
  let eligible = (emps ?? []).filter((e) => e.id !== args.releaserId && !!e.phone);
  if (eligible.length === 0) return { recipients: 0, sent: 0 };

  // Drop anyone already working that day.
  const ids = eligible.map((e) => e.id);
  const { data: busy } = await admin
    .from('shift_instances')
    .select('employee_id')
    .in('employee_id', ids)
    .eq('shift_date', args.shiftDate)
    .in('status', ['scheduled', 'claimed']);
  const busyIds = new Set((busy ?? []).map((b) => b.employee_id));
  eligible = eligible.filter((e) => !busyIds.has(e.id));

  // Each recipient's active token → their personal link.
  const { data: tokens } = await admin
    .from('employee_access_tokens')
    .select('employee_id, token')
    .in('employee_id', eligible.map((e) => e.id))
    .eq('active', true);
  const tokenByEmp = new Map<string, string>();
  for (const t of tokens ?? []) if (!tokenByEmp.has(t.employee_id)) tokenByEmp.set(t.employee_id, t.token);

  const info: ShiftMsgInfo = { starts_at: args.startsAt, ends_at: args.endsAt, storeName };
  const recipients = eligible.filter((e) => tokenByEmp.has(e.id));
  console.log(
    `[sms] broadcast shift_released instance=${args.instanceId} recipients=${recipients.length} ` +
      `(${recipients.map((e) => e.id).join(',')})`,
  );
  let sent = 0;
  for (const e of recipients) {
    const ok = await sendSms(e.phone as string, shiftReleasedMessage(info, tokenLink(tokenByEmp.get(e.id)!)), 'shift_released');
    if (ok) sent++;
  }
  return { recipients: recipients.length, sent };
}
