import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveOwnerIds } from '@/lib/station/guard';
import { chatLimiter } from '@/lib/rate-limit';
import { ANTHROPIC_API_KEY } from '@/lib/env';
import { TOOL_DEFS, runTool, type ToolCtx } from '@/lib/chat/tools';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/chat — the admin assistant. READ-ONLY: it answers questions from owner-scoped
// reads and cannot write anything (see lib/chat/tools.ts).
//
// ── Auth gate: role === 'admin' EXACTLY ──────────────────────────────────────
// Not "whatever middleware lets through". middleware.ts treats `role === undefined ||
// role === 'admin'` as UNCONFINED, and as of 2026-09-04 four production accounts carry a
// null role — they would all reach this route on the middleware test alone. This endpoint
// answers natural-language questions about payroll, P&L and customer orders, so it uses the
// same explicit gate as /admin/* and every /api/admin/* route: role must literally be 'admin'.
//
// ── Scope: the OWNER's data, not the caller's ────────────────────────────────
// An admin teammate is a different auth user from the owner who owns the rows. Scoping to
// `user.id` would hand that admin a confident, articulate, EMPTY answer. resolveOwnerIds()
// is the same primitive the station/member routes use.

const MODEL = 'claude-opus-5';
const MAX_TOOL_TURNS = 6;      // bounds cost + latency; 2 tools rarely need more than 2-3
const MAX_HISTORY = 20;        // client-sent turns kept, newest-last

const SYSTEM_PROMPT = `You are the Lensed assistant, embedded in the Lensed admin dashboard.
Lensed runs a warehouse-based TikTok live-selling operation: inventory, live-auction capture,
order sync, pick/pack fulfillment, employee timekeeping, and scheduling.

You are talking to an admin of this business. Be direct and concrete. Lead with the answer.

## Answering with data
- ALWAYS use a tool to get real numbers. Never estimate, extrapolate, or recall a figure from
  earlier in the conversation as if you had just looked it up.
- If a tool cannot answer the question, say so plainly and say what you would need. Never
  fill the gap with a plausible-sounding number — a wrong number stated confidently is far
  worse here than "I can't see that yet".
- If a tool returns zero rows, say the range is empty. Do not present that as a business fact
  (an empty week is not "nobody worked" — it may be a range with no data).
- Report what you actually retrieved. If you looked at one employee, don't imply team-wide.

## Business rules you must respect
- Timezone is America/Los_Angeles for every date. Shows run on Sundays; weekends are not quiet.
- Pay is biweekly and DERIVED (hours x rate), never stored.
- PUNCHES ARE TRUTH, SCHEDULE IS PLAN. Three different things, never conflate them:
  - \`worked\` (real shift rows) is the only pay input. Each row carries a \`payable\` flag and,
    when false, an \`excluded_reason\`. Use those; do not invent your own payability rule.
  - \`scheduled\` (shift_instances) is the plan / release-claim board. Not pay.
  - \`recurring_rules\` are standing weekly rules. An ACTIVE rule is projected into pay at read
    time, so an active rule means hours are owed EVEN WITH NO PUNCH — and it does not dedup
    against a real punch. If you see an active rule overlapping real punches for the same
    person and day, flag it as a possible double-pay risk.
- A time-clock punch with no \`confirmed_at\` is NOT yet payable; it is awaiting manager
  confirmation. Say that rather than describing it as unpaid work.

## Scope
- You are READ-ONLY. You cannot edit shifts, approve claims, change pay, or alter any record.
  When asked to change something, say what you would change and where in the UI to do it.
- Answer about this business only. You have no access to the capture extension or to TikTok.

Format for a terminal-width chat panel: short paragraphs, tight bullets, no heavy markdown.
Use exact figures with units. Round hours to one decimal and money to cents.`;

interface ClientMessage { role: 'user' | 'assistant'; content: string }
interface PageContext { tab?: string | null; subView?: string | null; dateFrom?: string | null; dateTo?: string | null }

/** NDJSON event frame. */
function frame(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + '\n');
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.app_metadata?.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!ANTHROPIC_API_KEY) {
    // Deliberately a 503, not a crash: the key is intentionally not requireEnv'd so a
    // missing chat key can never take the rest of the app down (see lib/env.ts).
    console.error('[chat] ANTHROPIC_API_KEY is not set — chat disabled');
    return NextResponse.json({ error: 'Chat is not configured on this deployment.' }, { status: 503 });
  }

  const limit = chatLimiter.check(user.id);
  if (!limit.success) {
    return NextResponse.json(
      { error: 'Too many messages — give it a moment.' },
      { status: 429, headers: { 'retry-after': String(Math.ceil((limit.retryAfterMs ?? 1000) / 1000)) } },
    );
  }

  let body: { messages?: ClientMessage[]; pageContext?: PageContext };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Expected JSON body' }, { status: 400 }); }

  // Rebuild history from plain text only. The client never gets to hand us tool_use /
  // tool_result blocks — those exist only server-side, inside one request — so a forged
  // payload cannot fabricate "tool output" the model would then treat as retrieved fact.
  const history: Anthropic.Beta.BetaMessageParam[] = (body.messages ?? [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  if (!history.length || history[history.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'Last message must be from the user' }, { status: 400 });
  }

  const admin = createAdminClient();
  const resolved = await resolveOwnerIds(admin);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 500 });
  if (!resolved.ownerIds.length) {
    // Fail loudly rather than answering "no data" to every question, which would look
    // like a real business answer instead of the config failure it is.
    console.error('[chat] owner scope unresolved: no store_members(role=owner) rows');
    return NextResponse.json({ error: 'owner scope unresolved' }, { status: 500 });
  }
  const ctx: ToolCtx = { admin, ownerIds: resolved.ownerIds };

  // Page context goes in as a MID-CONVERSATION system message, not appended to the system
  // prompt. Two reasons: it keeps the cached prefix (tools + system) byte-identical as the
  // admin moves between tabs, and role:"system" inside messages is the operator channel —
  // it is not user text, so it can't be mistaken for something the admin typed.
  // Placement rule: must follow a user message, and be last or followed by an assistant turn.
  // It sits after the newest user turn and the loop appends assistant turns after it. Valid throughout.
  const pc = body.pageContext ?? {};
  const bits: string[] = [];
  if (pc.tab) bits.push(`view: ${pc.tab}${pc.subView ? ` → ${pc.subView}` : ''}`);
  if (pc.dateFrom && pc.dateTo) bits.push(`date filter: ${pc.dateFrom} to ${pc.dateTo}`);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  bits.push(`today: ${today} (America/Los_Angeles)`);

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history,
    {
      role: 'system',
      content:
        `Admin's current screen — ${bits.join(' · ')}. ` +
        `Treat this as a hint for what they are likely asking about and for resolving vague ` +
        `references like "this week" or "her". It is NOT data: never quote it as a figure, and ` +
        `never use it to decide what the admin may see.`,
    },
  ];

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => { try { controller.enqueue(frame(o)); } catch { /* client gone */ } };
      try {
        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
          const s = client.beta.messages.stream({
            model: MODEL,
            max_tokens: 8000,
            betas: ['server-side-fallback-2026-07-01'],
            // A spurious safety decline on a business question would dead-end the turn;
            // this re-runs it on a fallback model inside the same call.
            fallbacks: 'default',
            output_config: { effort: 'medium' },
            // Stable prefix (tools -> system) is cached; the volatile page-context system
            // message lives in `messages`, after the breakpoint, so switching tabs never
            // invalidates it.
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            tools: TOOL_DEFS,
            messages,
          });

          s.on('text', (delta) => send({ type: 'text', text: delta }));

          const final = await s.finalMessage();

          if (final.stop_reason === 'refusal') {
            send({ type: 'error', message: 'I can’t answer that one. Try rephrasing.' });
            break;
          }

          messages.push({ role: 'assistant', content: final.content });

          const calls = final.content.filter(
            (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
          );
          if (final.stop_reason !== 'tool_use' || calls.length === 0) break;

          // Run in parallel and return EVERY result in ONE user message — splitting them
          // across messages trains the model out of parallel calls.
          const results = await Promise.all(calls.map(async (c) => {
            send({ type: 'tool', name: c.name });
            try {
              const out = await runTool(ctx, c.name, c.input);
              return {
                type: 'tool_result' as const,
                tool_use_id: c.id,
                content: JSON.stringify(out),
              };
            } catch (err) {
              // Hand the failure back as a tool_result so the model can say "I couldn't read
              // that" instead of the stream dying with a blank panel.
              console.error('[chat] tool failed:', c.name, err);
              return {
                type: 'tool_result' as const,
                tool_use_id: c.id,
                is_error: true,
                content: err instanceof Error ? err.message : 'tool failed',
              };
            }
          }));

          messages.push({ role: 'user', content: results });

          if (turn === MAX_TOOL_TURNS - 1) {
            send({ type: 'error', message: 'That needed too many lookups — try narrowing the question.' });
          }
        }
      } catch (err) {
        console.error('[chat] stream failed:', err);
        // A 400 is OUR bug — a malformed request shape — not something the admin did. Swallowing
        // its message makes it undebuggable in prod, and this endpoint is admin-only, so surface
        // the provider's own detail. Everything else stays a short human message.
        const msg =
          err instanceof Anthropic.RateLimitError ? 'The model is rate limited right now — try again shortly.'
          : err instanceof Anthropic.AuthenticationError ? 'Chat credentials are invalid.'
          : err instanceof Anthropic.BadRequestError ? `Request rejected (400): ${String(err.message).slice(0, 600)}`
          : err instanceof Anthropic.APIError ? `Model error (${err.status}): ${String(err.message).slice(0, 300)}`
          : 'Something went wrong answering that.';
        send({ type: 'error', message: msg });
      } finally {
        send({ type: 'done' });
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}
