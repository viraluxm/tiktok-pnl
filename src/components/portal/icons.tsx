// Inline SVG icons for the portal. Lensed has no icon package (every icon in the app is inline
// SVG), so these follow the same 24-box, 1.75-stroke, round-cap style. Decorative by default
// (aria-hidden); a parent supplies the label.

import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 22, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" {...rest}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(p: P) {
  return <Base {...p}><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10.5V20h13v-9.5" /><path d="M10 20v-5h4v5" /></Base>;
}
export function CalendarIcon(p: P) {
  return <Base {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17" /><path d="M8 3v4M16 3v4" /></Base>;
}
export function InboxIcon(p: P) {
  return <Base {...p}><path d="M4 4.5h16v11l-2.2 4H6.2L4 15.5z" /><path d="M4 15.5h5l1.2 2.2h3.6L15 15.5h5" /></Base>;
}
export function ClockIcon(p: P) {
  return <Base {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Base>;
}
export function ChevronLeft(p: P) {
  return <Base {...p}><path d="m14.5 6-6 6 6 6" /></Base>;
}
export function ChevronRight(p: P) {
  return <Base {...p}><path d="m9.5 6 6 6-6 6" /></Base>;
}
export function XIcon(p: P) {
  return <Base {...p}><path d="M6 6l12 12M18 6 6 18" /></Base>;
}
export function SwapIcon(p: P) {
  return <Base {...p}><path d="M7 7h11l-3-3" /><path d="M17 17H6l3 3" /></Base>;
}
export function SwapVerticalIcon(p: P) {
  return <Base {...p}><path d="M8 4v16" /><path d="m4.5 16.5 3.5 3.5 3.5-3.5" /><path d="M16 20V4" /><path d="m12.5 7.5 3.5-3.5 3.5 3.5" /></Base>;
}
export function MoonIcon(p: P) {
  return <Base {...p}><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" /></Base>;
}
export function ArrowRightIcon(p: P) {
  return <Base {...p}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></Base>;
}
export function CheckIcon(p: P) {
  return <Base {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Base>;
}
