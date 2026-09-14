'use client';

import { useMemo, useState } from 'react';
import { useCapacity, type CapacityPayload } from '@/hooks/useCapacity';
import { fmtCalendarDate, fmtTimeRangeLA, isOvernight } from '@/lib/schedule/format';
import { SUGGESTED_TEAM_CAPACITY, staffedOfLabel, staffingLabel, type BlockStaffing, type CapacityBlock } from '@/lib/schedule/capacity';
import { daysLabel, inputCls, Field } from './shared';

// STAFFING CAPACITY — the manager half of automatic Available Shifts (migration 156).
//
// Lives INSIDE the Shifts tab, above the month calendar, rather than in a new admin section: the
// question it answers ("how staffed is Wednesday night?") is a scheduling question, and splitting
// it off would mean leaving the schedule to answer it. Collapsed by default, with the answer in
// the summary line so the common case costs no clicks.
//
// MANAGER VOCABULARY vs EMPLOYEE VOCABULARY. Here the physical meaning is explicit — "live setups",
// "8 / 10 scheduled", "Over capacity by 2", "Custom capacity". None of that reaches an employee:
// their portal says only "2 shifts available".
//
// NOTHING HERE MUTATES AN ASSIGNMENT. Lowering capacity below current staffing reports "Over
// capacity by N" and stops advertising; it never cancels anybody. Closing availability stops new
// requests and nothing else.

const TEAM_LABEL: Record<string, string> = { host: 'Live Host', fulfillment: 'Fulfillment' };
// The unit sits AFTER the input, not in the label: "LIVE HOST · LIVE SETUPS" said "Live" twice and
// wrapped to two lines, and once it scrolled out of view the bare number had no unit at all.
const TEAM_UNIT: Record<string, string> = { host: 'live setups', fulfillment: 'stations' };
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const OUTLOOK_DAYS = 14;

type Mutate =
  | { op: 'saveBlock'; block: Record<string, unknown> }
  | { op: 'blockActive'; blockId: string; active: boolean }
  | { op: 'teamCapacity'; team: string; capacity: number | null }
  | { op: 'dateCapacity'; blockId: string; date: string; capacity?: number | null; closed?: boolean };

// THE ORDINARY CASE IS NOT AN ACCENT. Most rows in a two-week outlook read "N shifts available";
// painting all of them cyan spends the one accent on the least interesting fact and leaves
// "Over capacity by 2" and "Availability closed" no louder than their neighbours. Cyan is reserved
// for what to tap. Exceptions keep their functional colour, and every one of them carries words.
function toneOf(s: BlockStaffing): string {
  if (!s.configured) return 'text-tt-yellow';
  if (s.over > 0) return 'text-tt-yellow';
  if (s.closed) return 'text-tt-yellow';
  if (s.available === 0) return 'text-tt-green';
  return 'text-tt-text';
}

// ── Block editor ──────────────────────────────────────────────────────────────────────────────

function BlockEditor({ block, onSave, onCancel }: {
  block: Partial<CapacityBlock> | null;
  onSave: (b: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [team, setTeam] = useState(block?.team ?? 'host');
  const [label, setLabel] = useState(block?.label ?? '');
  const [days, setDays] = useState<number[]>(block?.days_of_week ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState((block?.start_time ?? '18:00').slice(0, 5));
  const [end, setEnd] = useState((block?.end_time ?? '02:00').slice(0, 5));
  const [capacity, setCapacity] = useState(block?.capacity == null ? '' : String(block.capacity));
  const problem = days.length === 0 ? 'Pick at least one day.'
    : start === end ? 'End time must be different from the start time.'
      : null;

  return (
    // NOT a card: this panel is already a card, and a card inside a card is always wrong. A rule
    // plus its own padding separates the form without boxing it again.
    <div className="border-y border-tt-border py-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Team">
          <select value={team} onChange={(e) => setTeam(e.target.value as CapacityBlock['team'])} className={inputCls}>
            <option value="host">Live Host</option>
            <option value="fulfillment">Fulfillment</option>
          </select>
        </Field>
        <Field label="Name (optional)">
          <input value={label ?? ''} onChange={(e) => setLabel(e.target.value)} placeholder="Night" className={inputCls} />
        </Field>
        <Field label="Start"><input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} /></Field>
        <Field label="End"><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} /></Field>
      </div>
      <div className="mt-3">
        <label className="mb-2 block text-[11px] uppercase tracking-wide text-tt-muted">Days</label>
        <div className="flex flex-wrap gap-1.5">
          {DAY_LETTERS.map((letter, n) => {
            const on = days.includes(n);
            return (
              <button
                key={n} type="button"
                onClick={() => setDays((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort()))}
                aria-pressed={on}
                aria-label={DAY_NAMES[n]}
                className={`h-11 w-11 rounded-lg text-xs font-semibold transition-colors ${on ? 'bg-tt-cyan/20 text-tt-cyan' : 'bg-white/5 text-tt-muted hover:bg-white/10'}`}
              >{letter}</button>
            );
          })}
        </div>
      </div>
      <div className="mt-3 max-w-[220px]">
        <Field label="Capacity">
          <input
            type="number" min={0} inputMode="numeric" value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            placeholder="Uses team capacity"
            className={inputCls}
          />
        </Field>
        <p className="mt-1.5 text-[11px] text-tt-muted">Leave blank to use the team default.</p>
      </div>
      {/* Client-side guards for the two shapes the DB also refuses, so the manager gets a sentence
          instead of a round trip. A zero-length block would read as overnight; a block with no
          days occurs on no date. */}
      {problem && <p className="mt-3 text-xs text-tt-red">{problem}</p>}
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onCancel} className="min-h-[44px] flex-1 rounded-xl bg-white/5 px-4 text-sm font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text">Cancel</button>
        <button
          type="button"
          disabled={problem != null}
          onClick={() => onSave({
            id: block?.id, team, label: label || null, days_of_week: days,
            start_time: start, end_time: end,
            capacity: capacity === '' ? null : Number(capacity),
            active: block?.active ?? true,
          })}
          className="min-h-[44px] flex-1 rounded-xl bg-tt-cyan px-4 text-sm font-semibold text-black transition-colors hover:bg-tt-cyan/90 disabled:cursor-not-allowed disabled:opacity-40"
        >Save block</button>
      </div>
    </div>
  );
}

// ── Team capacity card ────────────────────────────────────────────────────────────────────────
//
// Two states, and the difference is the whole point of this change:
//   NOT CONFIGURED  no number exists. Nothing is advertised to anyone. Says so, and offers the
//                   one action that fixes it.
//   CONFIGURED      "10 live setups", editable in place.
// The editor PREFILLS a suggestion so the manager is not typing into a blank box, but automatic
// availability starts only when they save — a suggestion on screen is not a configured number.

function TeamCapacityCard({ team, capacity, busy, onSave }: {
  team: string;
  capacity: number | null;
  busy: boolean;
  onSave: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const label = TEAM_LABEL[team] ?? team;
  const unit = TEAM_UNIT[team] ?? 'stations';

  if (capacity == null && !editing) {
    return (
      <div className="rounded-xl border border-tt-border bg-black/20 px-4 py-3">
        <p className="text-[11px] uppercase tracking-wide text-tt-muted">{label}</p>
        <p className="mt-1 text-sm font-medium text-tt-yellow">Not configured</p>
        <p className="mt-1 max-w-[280px] text-xs text-tt-muted">
          {/* The team is already named above; repeating it here produced "Live Host live setups". */}
          Set the number of {unit} to automatically calculate available shifts.
        </p>
        <button
          type="button" disabled={busy}
          onClick={() => { setValue(String(SUGGESTED_TEAM_CAPACITY[team as 'host' | 'fulfillment'] ?? '')); setEditing(true); }}
          className="mt-3 rounded-lg bg-tt-cyan/15 px-3 py-1.5 text-xs font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/25 disabled:opacity-50"
        >Set capacity</button>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="rounded-xl border border-tt-border bg-black/20 px-4 py-3">
        <label htmlFor={`team-capacity-${team}`} className="mb-2 block text-[11px] uppercase tracking-wide text-tt-muted">{label}</label>
        <div className="flex items-center gap-2">
          <input
            id={`team-capacity-${team}`}
            type="number" min={0} inputMode="numeric" value={value} autoFocus
            aria-label={`${label} ${unit}`}
            onChange={(e) => setValue(e.target.value)}
            className={`${inputCls} w-[110px]`}
          />
          <span className="text-[12px] text-tt-muted">{unit}</span>
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => setEditing(false)}
            className="min-h-[44px] rounded-xl bg-white/5 px-4 text-sm font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text">Cancel</button>
          <button
            type="button" disabled={busy || value === ''}
            onClick={() => { onSave(Number(value)); setEditing(false); }}
            className="min-h-[44px] rounded-xl bg-tt-cyan px-4 text-sm font-semibold text-black transition-colors hover:bg-tt-cyan/90 disabled:cursor-not-allowed disabled:opacity-40"
          >Save capacity</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-tt-border bg-black/20 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-tt-muted">{label}</p>
      <p className="mt-1 text-sm font-medium text-tt-text"><span className="tabular-nums">{capacity}</span> {unit}</p>
      <button
        type="button" disabled={busy}
        onClick={() => { setValue(String(capacity)); setEditing(true); }}
        className="mt-2 rounded-lg bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50"
      >Change</button>
    </div>
  );
}

// ── Per-date capacity control ─────────────────────────────────────────────────────────────────

// No `onCancel`: the row's own control toggles to "Cancel" and closes this, so a second cancel
// inside the editor would be the same action twice.
function DateCapacityEditor({ s, onApply }: {
  s: BlockStaffing;
  onApply: (v: { capacity?: number | null; closed?: boolean }) => void;
}) {
  const [value, setValue] = useState(s.custom ? String(s.capacity) : '');
  // TWO ACTIONS, NOT FOUR. "Restore automatic" was "clear the field, then Save" wearing a button,
  // and a separate Cancel duplicated the row's own toggle. Blank means automatic, and the helper
  // text says so, which is one fewer thing to read and one fewer thing to get wrong.
  return (
    <div className="mt-2 border-t border-tt-border pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-[150px]">
          <Field label="Capacity this day">
            <input
              type="number" min={0} inputMode="numeric" value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Automatic"
              aria-label="Capacity for this day"
              className={inputCls}
            />
          </Field>
        </div>
        <button type="button" onClick={() => onApply({ capacity: value === '' ? null : Number(value), closed: false })}
          className="min-h-[44px] rounded-xl bg-tt-cyan px-4 text-sm font-semibold text-black transition-colors hover:bg-tt-cyan/90">
          {s.closed ? 'Save and reopen' : 'Save'}
        </button>
        {/* The most consequential control in the panel; it must not look like Cancel. Yellow is
            the tone this panel already uses for "needs your attention", and the word carries it. */}
        {!s.closed && (
          <button type="button" onClick={() => onApply({ capacity: value === '' ? null : Number(value), closed: true })}
            className="min-h-[44px] rounded-xl bg-tt-yellow/15 px-4 text-sm font-semibold text-tt-yellow transition-colors hover:bg-tt-yellow/25">Close availability</button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-tt-muted">
        Leave the number blank to go back to automatic capacity. Closing availability stops new
        shift requests for this day. It never cancels a scheduled shift or removes anyone.
      </p>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────────────────────

export default function StaffingCapacityPanel({
  previewData, onPreviewMutate,
}: {
  previewData?: CapacityPayload;
  onPreviewMutate?: (m: Mutate) => void;
} = {}) {
  // PREVIEW SEAM, the same shape PickupRequestsPanel uses: fixture data instead of a fetch, and a
  // local reducer instead of the write. The hook is still called (rules of hooks) but its query is
  // never read in preview mode.
  const live = useCapacity({ days: OUTLOOK_DAYS, enabled: !previewData });
  const data = previewData ?? live.data;
  const [editingBlock, setEditingBlock] = useState<Partial<CapacityBlock> | null>(null);
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // One busy flag for the whole panel. Every write here invalidates the same outlook, so a second
  // click while one is in flight can only produce a confusing double-apply.
  const [busy, setBusy] = useState(false);

  const run = async (m: Mutate) => {
    setErr(null);
    if (onPreviewMutate) { onPreviewMutate(m); return; }
    setBusy(true);
    try {
      if (m.op === 'saveBlock') await live.saveBlock.mutateAsync(m.block);
      else if (m.op === 'blockActive') await live.setBlockActive.mutateAsync({ blockId: m.blockId, active: m.active });
      else if (m.op === 'teamCapacity') await live.setTeamCapacity.mutateAsync({ team: m.team, capacity: m.capacity });
      else await live.setDateCapacity.mutateAsync({ blockId: m.blockId, date: m.date, capacity: m.capacity, closed: m.closed });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  // THE SUMMARY IS THE WHOLE POINT OF THE DISCLOSURE: it answers "how staffed are we?" without
  // expanding. So it reports the soonest EXCEPTION first — over capacity, then a closed day, then
  // the next day with room — and only falls back to the first row when nothing stands out.
  // Picking the first row with availability skipped today's "Over capacity by 2" to announce a
  // quiet Monday, which is the opposite of useful.
  const summary = useMemo(() => {
    if (!data) return null;
    const all = data.days.flatMap((d) => d.blocks);
    if (all.length === 0) return null;
    const next = all.find((s) => !s.configured)
      ?? all.find((s) => s.over > 0) ?? all.find((s) => s.closed) ?? all.find((s) => s.available > 0) ?? all[0];
    return `${fmtCalendarDate(next.date)} · ${staffedOfLabel(next)} · ${staffingLabel(next)}`;
  }, [data]);

  const teamsInUse = useMemo(
    () => [...new Set((data?.blocks ?? []).map((b) => b.team))],
    [data],
  );

  return (
    <details className="rounded-[14px] border border-tt-border bg-tt-card/60">
      <summary className="flex cursor-pointer select-none flex-wrap items-center gap-x-2 gap-y-1 px-5 py-3 text-sm font-semibold text-tt-text">
        {/* A real heading, so the three section headings below are not orphaned h3s under the
            page's h1. Inline, so it looks exactly like the summary text it replaces. */}
        <h2 className="text-sm font-semibold text-tt-text">Staffing capacity</h2>
        {summary
          ? <span className="font-normal text-tt-muted">{summary}</span>
          : <span className="font-normal text-tt-muted">Not set up yet</span>}
      </summary>

      <div className="space-y-6 border-t border-tt-border p-5">
        {err && <p className="text-xs text-tt-red">{err}</p>}
        {!data && !previewData && (
          <p className="text-sm text-tt-muted">{live.error ? live.error.message : 'Loading…'}</p>
        )}

        {data && (
          <>
            {/* ── Team capacity ─────────────────────────────────────────────────────────
                NOT CONFIGURED IS A REAL STATE, not a zero and not a hidden ten. Until the
                business says how many setups it runs, nothing is advertised and this says so. */}
            <section>
              <h3 className="text-sm font-semibold text-tt-text">Team capacity</h3>
              <p className="mt-1 text-xs text-tt-muted">
                How many people this team can run at the same time. Used to work out how many shifts are available.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {data.teamDefaults
                  .filter((t) => teamsInUse.length === 0 || teamsInUse.includes(t.team))
                  .map((t) => (
                    <TeamCapacityCard
                      key={t.team} team={t.team} capacity={t.capacity} busy={busy}
                      onSave={(v) => void run({ op: 'teamCapacity', team: t.team, capacity: v })}
                    />
                  ))}
              </div>
            </section>

            {/* ── Blocks ────────────────────────────────────────────────────────────────── */}
            <section>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-tt-text">Shift blocks</h3>
                <button
                  type="button" onClick={() => setEditingBlock({})} disabled={busy}
                  className="rounded-lg bg-tt-cyan/15 px-3 py-1.5 text-xs font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/25 disabled:opacity-50"
                >Add block</button>
              </div>
              <p className="mt-1 text-xs text-tt-muted">
                The recurring time ranges that can take extra people. A block with no one scheduled still offers shifts.
              </p>

              {editingBlock && (
                <div className="mt-3">
                  <BlockEditor
                    block={editingBlock}
                    onSave={(b) => { void run({ op: 'saveBlock', block: b }); setEditingBlock(null); }}
                    onCancel={() => setEditingBlock(null)}
                  />
                </div>
              )}

              {data.blocks.length === 0 && !editingBlock ? (
                <p className="mt-3 text-sm text-tt-muted">No shift blocks yet. Add one and Lensed will work out how many shifts are available.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {data.blocks.map((b) => (
                    <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-tt-border bg-tt-card/60 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-tt-text">
                          {b.label || TEAM_LABEL[b.team] || b.team}
                          <span className="ml-2 tabular-nums text-tt-muted">{b.start_time.slice(0, 5)}–{b.end_time.slice(0, 5)}</span>
                        </p>
                        <p className="text-xs text-tt-muted">
                          {TEAM_LABEL[b.team] ?? b.team} · {daysLabel(b.days_of_week)} · {(() => {
                            if (b.capacity != null) return `Capacity ${b.capacity}`;
                            const team = data.teamDefaults.find((t) => t.team === b.team)?.capacity ?? null;
                            return team == null ? 'Capacity not configured' : `Uses team capacity ${team}`;
                          })()}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {!b.active && <span className="rounded-md bg-tt-muted/15 px-2 py-1 text-[10px] font-semibold text-tt-muted">Paused</span>}
                        <button type="button" onClick={() => setEditingBlock(b)} disabled={busy}
                          className="rounded-lg bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50">Edit</button>
                        <button type="button" onClick={() => void run({ op: 'blockActive', blockId: b.id, active: !b.active })} disabled={busy}
                          className="rounded-lg bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50">
                          {b.active ? 'Pause' : 'Resume'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── Outlook ───────────────────────────────────────────────────────────────── */}
            {data.days.some((d) => d.blocks.length > 0) && (
              <section>
                <h3 className="text-sm font-semibold text-tt-text">Next {OUTLOOK_DAYS} days</h3>
                <ul className="mt-3 divide-y divide-white/[0.05]">
                  {data.days.filter((d) => d.blocks.length > 0).map((d) => (
                    <li key={d.date} className="py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-tt-muted">{fmtCalendarDate(d.date)}</p>
                      <ul className="mt-1.5 space-y-1.5">
                        {d.blocks.map((s) => {
                          const key = `${s.block_id}|${s.date}`;
                          return (
                            <li key={key}>
                              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                <div className="min-w-0">
                                  <p className="text-sm text-tt-text">
                                    <span className="tabular-nums">{fmtTimeRangeLA(s.starts_at, s.ends_at)}</span>
                                    {isOvernight(s.starts_at, s.ends_at) && <span className="ml-1.5 text-tt-muted">🌙 +1d</span>}
                                    {s.label && <span className="ml-2 text-tt-muted">{s.label}</span>}
                                  </p>
                                  <p className="text-xs">
                                    <span className="tabular-nums text-tt-muted">{staffedOfLabel(s)}</span>
                                    <span className={`ml-2 font-medium ${toneOf(s)}`}>{staffingLabel(s)}</span>
                                    {s.custom && <span className="ml-2 text-tt-muted">Custom capacity</span>}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setEditingDate(editingDate === key ? null : key)}
                                  disabled={busy}
                                  className="shrink-0 rounded-lg bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-tt-muted transition-colors hover:bg-white/10 hover:text-tt-text disabled:opacity-50"
                                >{editingDate === key ? 'Cancel' : 'Edit capacity'}</button>
                              </div>
                              {editingDate === key && (
                                <DateCapacityEditor
                                  s={s}
                                  onApply={(v) => { void run({ op: 'dateCapacity', blockId: s.block_id, date: s.date, ...v }); setEditingDate(null); }}
                                />
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </details>
  );
}
