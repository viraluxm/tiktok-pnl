import 'server-only';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

// Consume a rotating-QR clock code (LNS1…) at the station and punch it through the SAME model as the
// badge kiosk (lensed_kiosk_manual_punch_as, punch_method='qr') — never a parallel time record. The
// consume is atomic and single-use: the UPDATE only touches a row that is unconsumed AND unexpired,
// so a screenshot / double-scan / expired code can never punch. Every attempt is written to
// clock_audit (payroll record). unknown / already_used / expired are distinguished for the station.
const PURPOSE_TO_ACTION: Record<string, string> = {
  clock_in: 'clock_in',
  clock_out: 'clock_out',
  break_start: 'start_break',
  break_end: 'end_break',
};

async function audit(admin: SupabaseClient, row: Record<string, unknown>) {
  const { error } = await admin.from('clock_audit').insert({ event: 'scan', ...row });
  if (error) console.error('[qr/scan] audit insert failed:', error.message);
}

export async function consumeQrClockCode(admin: SupabaseClient, ownerId: string, code: string): Promise<NextResponse> {
  const nowIso = new Date().toISOString();
  const { data: tok } = await admin
    .from('kiosk_tokens').select('id').eq('user_id', ownerId).eq('active', true).limit(1).maybeSingle();
  const stationId = (tok?.id as string | undefined) ?? null;

  // Atomic single-use consume: only an UNCONSUMED, UNEXPIRED code for THIS owner flips.
  const { data: consumed, error } = await admin
    .from('clock_codes')
    .update({ consumed_at: nowIso, consumed_station_id: stationId })
    .eq('code', code)
    .eq('user_id', ownerId)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .select('employee_id, shift_instance_id, purpose')
    .maybeSingle();
  if (error) {
    console.error('[qr/scan] consume failed:', error.message);
    return NextResponse.json({ code: 'UNKNOWN', error: 'Something went wrong. Try again.' }, { status: 500 });
  }

  if (!consumed) {
    // Distinguish for the station display: "expired" → hand back and refresh; "already used" → wrong.
    const { data: ex } = await admin
      .from('clock_codes')
      .select('consumed_at, employee_id, shift_instance_id, purpose')
      .eq('code', code).eq('user_id', ownerId).maybeSingle();
    let reason = 'unknown', message = 'Code not recognized', status = 404;
    if (ex) {
      if (ex.consumed_at) { reason = 'already_used'; message = 'Code already used'; status = 409; }
      else { reason = 'expired'; message = 'Code expired — hand the phone back to refresh'; status = 409; }
    }
    await audit(admin, {
      user_id: ownerId, employee_id: ex?.employee_id ?? null, shift_instance_id: ex?.shift_instance_id ?? null,
      purpose: ex?.purpose ?? null, code, station_id: stationId, outcome: 'rejected', reason,
    });
    return NextResponse.json({ code: reason.toUpperCase(), error: message }, { status });
  }

  const action = PURPOSE_TO_ACTION[String(consumed.purpose)];
  const { data: punch, error: pErr } = await admin.rpc('lensed_kiosk_manual_punch_as', {
    p_owner: ownerId, p_employee_id: consumed.employee_id, p_action: action, p_punch_method: 'qr',
  });
  if (pErr) {
    // Rare: state changed between issue and scan. The code is already consumed (single-use); the
    // worker requests a fresh one. Recorded either way.
    await audit(admin, {
      user_id: ownerId, employee_id: consumed.employee_id, shift_instance_id: consumed.shift_instance_id,
      purpose: consumed.purpose, code, station_id: stationId, outcome: 'rejected', reason: 'punch_error',
    });
    return NextResponse.json({ code: 'PUNCH_FAILED', error: 'That action is no longer valid — request a new code.' }, { status: 409 });
  }

  await audit(admin, {
    user_id: ownerId, employee_id: consumed.employee_id, shift_instance_id: consumed.shift_instance_id,
    purpose: consumed.purpose, code, station_id: stationId, outcome: 'ok',
  });
  const r = (punch ?? {}) as { employee_name?: string; result?: string; at?: string };
  return NextResponse.json({ ok: true, worker_name: r.employee_name ?? '', purpose: consumed.purpose, result: r.result, at: r.at });
}
