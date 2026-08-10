import 'server-only';

// Minimal Twilio REST sender for operational alerts (the capture-health dead-man's-switch).
// Self-contained on `main`: the shift-scheduling SMS stack (src/lib/schedule/sms.ts) lives only on
// the unmerged feat/scheduling-v1 branch, so this branch cannot reuse it. Modeled on that sender.
//
// This helper does NOT read any enable flag — the CALLER decides whether to send (the capture-health
// cron gates on CAPTURE_ALERT_ENABLED). It only fails safe when Twilio env is absent: logs and
// returns false rather than throwing. Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
export async function sendAlertSms(to: string, body: string, tag: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    console.error(`[alert-sms] Twilio env missing — skipping tag=${tag} to=${to}`);
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
      console.error(`[alert-sms] Twilio ${res.status} tag=${tag} to=${to}: ${await res.text()}`);
      return false;
    }
    console.log(`[alert-sms] SENT tag=${tag} to=${to}`);
    return true;
  } catch (e) {
    console.error(`[alert-sms] send error tag=${tag} to=${to}: ${(e as Error).message}`);
    return false;
  }
}
