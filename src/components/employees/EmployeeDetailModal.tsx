'use client';

import type { Employee } from '@/types';
import type { HostAgg } from '@/hooks/useHostPerformance';
import type { ScheduleLink } from '@/hooks/useScheduleLinks';
import type { ActiveBadge } from '@/hooks/useBadges';
import { AspHitBadge, BelowBreakEvenBadge } from './HostPerformanceBadges';
import { StatusBadge, titleCase } from './shared';
import { ScheduleLinkButton } from './ScheduleLinkButton';
import { BadgeButton } from './BadgeButton';
import PersonAvatar from './weekly/PersonAvatar';

// Everything about one team member, opened from their roster tile. The roster grid answers
// "who is on the team"; this answers "tell me about this person" — so the nine columns that used
// to be crammed across the table live here, where there is room for them.

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[rgba(255,255,255,0.04)] py-2 last:border-0">
      <span className="text-[11px] uppercase tracking-wide text-tt-muted">{label}</span>
      <span className="text-right text-[13px] text-tt-text">{children}</span>
    </div>
  );
}

export default function EmployeeDetailModal({
  employee, hostAgg, link, badge, hourlyRate,
  onClose, onMintLink, onLinkCreated, onIssueBadge, onReissueBadge, onEdit, onDelete,
}: {
  employee: Employee;
  hostAgg: HostAgg | undefined;
  link: ScheduleLink | undefined;
  badge: ActiveBadge | null;
  hourlyRate: string;
  onClose: () => void;
  onMintLink: (employeeId: string) => Promise<{ url: string }>;
  onLinkCreated: () => void;
  onIssueBadge: (employeeId: string) => Promise<void>;
  onReissueBadge: (employeeId: string, badgeId: string) => Promise<void>;
  onEdit: (e: Employee) => void;
  onDelete: (e: Employee) => void;
}) {
  const isHost = (employee.role ?? '').toLowerCase() === 'host';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose} role="dialog" aria-modal="true" aria-label={employee.name}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-[16px] border border-tt-border bg-tt-card p-5 shadow-2xl backdrop-blur-xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <PersonAvatar name={employee.name} state="confirmed" size="lg" />
            <div>
              <h3 className="text-base font-semibold text-tt-text">{employee.name}</h3>
              <p className="text-xs text-tt-muted">
                {titleCase(employee.role)}
                {employee.fulfillment_track && (
                  <span className="text-tt-cyan"> · {titleCase(employee.fulfillment_track)}</span>
                )}
              </p>
            </div>
          </div>
          <button
            type="button" onClick={onClose} aria-label="Close"
            className="h-8 w-8 shrink-0 rounded-lg border border-tt-border text-tt-muted transition-colors hover:bg-tt-card-hover hover:text-tt-text"
          >✕</button>
        </div>

        <div className="mb-4">
          <Row label="Status"><StatusBadge status={employee.status} /></Row>
          <Row label="Hourly rate"><span className="tabular-nums">{hourlyRate}</span></Row>
          <Row label="Hire date">{employee.hire_date || '—'}</Row>
          <Row label="Probation ends">{employee.probation_end_date || '—'}</Row>
          {/* Host-only metrics — they measure selling, so they are meaningless for fulfillment. */}
          {isHost && <Row label="ASP hit (7d)"><AspHitBadge agg={hostAgg} /></Row>}
          {isHost && <Row label="Below break-even (14d)"><BelowBreakEvenBadge agg={hostAgg} /></Row>}
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-tt-muted">Clock-in credentials</div>
          <div className="flex flex-wrap items-center gap-2">
            <ScheduleLinkButton
              employeeId={employee.id}
              token={link?.token ?? null}
              onMint={onMintLink}
              onCreated={onLinkCreated}
            />
            <BadgeButton
              employeeId={employee.id}
              badge={badge}
              onIssue={onIssueBadge}
              onReissue={onReissueBadge}
            />
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            type="button" onClick={() => { onClose(); onEdit(employee); }}
            className="flex-1 rounded-xl bg-tt-cyan/15 py-2.5 text-sm font-semibold text-tt-cyan transition-colors hover:bg-tt-cyan/25"
          >Edit</button>
          <button
            type="button" onClick={() => { onClose(); onDelete(employee); }}
            className="flex-1 rounded-xl bg-tt-red/15 py-2.5 text-sm font-semibold text-tt-red transition-colors hover:bg-tt-red/25"
          >Remove</button>
        </div>
      </div>
    </div>
  );
}
