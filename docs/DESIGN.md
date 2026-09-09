---
name: Lensed
colors:
  surface: '#0f0f0f'
  surface-container-low: 'rgba(255,255,255,0.03)'
  surface-container: 'rgba(30,30,30,0.7)'
  surface-container-high: 'rgba(40,40,40,0.8)'
  surface-container-highest: 'rgba(255,255,255,0.10)'
  on-surface: '#e8e8e8'
  on-surface-variant: '#888888'
  outline: 'rgba(255,255,255,0.08)'
  outline-variant: 'rgba(255,255,255,0.15)'
  primary: '#69C9D0'
  on-primary: '#000000'
  primary-container: 'rgba(105,201,208,0.15)'
  on-primary-container: '#69C9D0'
  secondary: '#EE1D52'
  secondary-container: 'rgba(238,29,82,0.10)'
  on-secondary-container: '#ff3a6e'
  success: '#00c853'
  warning: '#ffd600'
  error: '#ff1744'
  input-bg: 'rgba(255,255,255,0.05)'
  input-border: 'rgba(255,255,255,0.10)'
  input-focus: 'rgba(105,201,208,0.4)'
---

# Design System: Lensed

Extracted from source (Tailwind v4 `@theme inline` tokens in `src/app/globals.css`, the app shell in
`src/components/layout/Header.tsx`, the Team/scheduling components under `src/components/employees`,
and the employee portal under `src/app/s/[token]`). Values below are what ships, not aspirations.

## 1. Visual Theme & Atmosphere

Lensed is a dark, quiet operations tool. The ground is a flat near-black (#0f0f0f) with no gradient,
no vignette, and no glow; surfaces are translucent charcoal (`rgba(30,30,30,0.7)`) separated from the
ground by hairline white borders at 8% opacity rather than by shadow. Text is soft white (#e8e8e8),
secondary text a mid grey (#888888). The one accent is a cool TikTok cyan (#69C9D0), used for the
current selection, the primary action, and "this is you" highlights. Magenta (#EE1D52) is the brand
counterpart and appears only for brand moments and destructive emphasis. Functional colours (green,
yellow, red) are bright and pure but always tinted to 10–15% as backgrounds and paired with words.

The feel is precise and calm: system font, small type (11–14px for most UI, 16px+ only for headings
and for inputs on mobile so iOS never zooms), tight letter-spaced uppercase labels for section
headings, tabular numerals for times and money. Density is moderate: rows are 40–48px tall, page
padding is 16px on phones and 24px on desktop. Nothing animates except a 0.4s fade-in on page
sections and 150–200ms colour transitions on hover. Existing components lean on cards; the better
Lensed surfaces (the month calendar, the kiosk) use spacing and hairline dividers instead, and the
employee portal redesign follows that quieter lane.

## 2. Color Palette & Roles

### Primary Foundation
- **Ink Black** `#0f0f0f` — page and body background; also the sticky header at 95% with blur.
- **Charcoal Glass** `rgba(30,30,30,0.7)` (`tt-card`) — cards, sheets, list containers.
- **Charcoal Glass Hover** `rgba(40,40,40,0.8)` (`tt-card-hover`) — hover fill on interactive rows.
- **Hairline** `rgba(255,255,255,0.08)` (`tt-border`) — every border; `0.15` on hover.
- **Whisper Fills** `bg-white/5`, `bg-white/10` — secondary buttons, segmented-control tracks,
  disabled-looking chips. `bg-white/[0.02]` for an inset fact box inside a sheet.

### Accent & Interactive
- **Signal Cyan** `#69C9D0` (`tt-cyan`) — primary buttons (cyan fill, black text), links, the
  selected tab, "today", "(you)". Tints: `/10` banner backgrounds, `/15`–`/25` chip fills, `/20`
  count badges, `/40` borders.
- **Brand Magenta** `#EE1D52` (`tt-magenta`) — legacy Claim button, brand marks; `#ff3a6e`
  (`tt-magenta-soft`) for form error text.

### Typography & Text Hierarchy
- **Soft White** `#e8e8e8` (`tt-text`) — primary text.
- **Mid Grey** `#888888` (`tt-muted`) — secondary text, section labels, disabled labels; also
  `text-tt-muted/60` for placeholders and `/25` for locked calendar days.

### Functional States
- **Go Green** `#00c853` — approved, picked up, confirmed. Ring/text; `/15` fill.
- **Hold Yellow** `#ffd600` — pending, offered, awaiting approval. Text and `/15` fills,
  `/30`–`/50` borders; solid yellow with black text for a count pill.
- **Stop Red** `#ff1744` — errors, destructive confirm, at-cap warnings; `/10` fill for error boxes.

## 3. Typography Rules

Family: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`. One family for
everything; weight and size carry hierarchy.

### Hierarchy & Weights
- Page title: 20px / 600 (`text-xl font-semibold`).
- Card/sheet title: 16px / 600 (`text-base font-semibold`).
- Section label: 14px / 600 uppercase, `tracking-wide`, muted (`text-sm font-semibold uppercase`).
- Micro label: 10–11px / 700 uppercase, `tracking-wider`, muted (role group headings, field labels).
- Row primary: 13–14px / 500.
- Row secondary and helper copy: 11–12px / 400, muted.
- Numbers and times: `tabular-nums`; day-of-week abbreviations in 11px bold uppercase.
- Buttons: 12–13px / 600 for inline controls; 16px / 600 for full-width sheet actions.

### Spacing Principles
- 4px base grid (Tailwind scale). Vertical rhythm inside a section is `space-y-2` (8px) between
  rows and `mb-6`/`mb-8` (24/32px) between sections.
- Text blocks are short; line-height 1.5 body. Helper copy sits directly under the fact it
  qualifies with a 2–6px gap, never as a separate paragraph.

## 4. Component Stylings

### Buttons
- **Primary**: cyan fill, black text, `rounded-lg` (8px) inline or `rounded-xl` (12px) in sheets,
  `font-semibold`, `hover:bg-tt-cyan/90` or `hover:opacity-90`, `disabled:opacity-40/50`. Sheet
  actions are full-width with `min-h-12` (48px).
- **Secondary / quiet**: `bg-white/5` text-soft-white, `hover:bg-white/10`, same radius.
- **Tinted**: `bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25` for lighter primary actions
  (Pick Up Shift, Approve).
- **Outline**: `border border-tt-border`, muted text, `hover:bg-tt-card-hover`.
- **Destructive**: red fill, white text, or red outline text for Deny/Decline.
- 32px square icon buttons (`h-8 w-8 rounded-lg border border-tt-border`) for prev/next and close.
- Transitions: `transition-colors` (150ms default). No scale or bounce except the 1.1 hover scale
  on avatars.

### Cards & Sheets
- Card: `rounded-lg` (8px) or `rounded-[14px]`, `border border-tt-border bg-tt-card`, `px-4 py-3`.
  Lists inside a card use `divide-y divide-white/5`.
- Sheet / dialog: `fixed inset-0 bg-black/70` (sometimes `backdrop-blur-sm`), content
  `max-w-sm/md rounded-2xl` or `rounded-[16px]`, `border-tt-border bg-tt-card p-4/5 shadow-2xl`,
  `max-h-[85dvh] overflow-y-auto overscroll-contain`.
- Empty state: `border border-dashed border-tt-border px-4 py-6 text-center text-sm text-tt-muted`.
- Banner: `rounded-lg border border-tt-cyan/40 bg-tt-cyan/10 px-4 py-3`, title in cyan 600.

### Navigation
- App header: sticky, `bg-[rgba(15,15,15,0.95)] backdrop-blur-xl border-b border-tt-border`,
  36px logo with 10px radius, 18px bold wordmark, top safe-area padding.
- Segmented tabs: track `rounded-lg bg-white/5 p-0.5`, segments `rounded-md px-3 py-2 text-xs
  font-semibold`, selected `bg-white/10 text-tt-text`, unselected muted; count badge
  `rounded-full bg-tt-cyan/20 px-1.5 text-[10px] font-bold text-tt-cyan`.
- Mobile horizontal strips scroll with `no-scrollbar snap-x` and negative page margins.
- No bottom navigation exists yet; the portal redesign introduces one using the same track/segment
  vocabulary at 44px+ touch height with `pb-safe`.

### Inputs & Forms
- Field: `rounded-lg` or `rounded-xl`, `border border-tt-input-border bg-tt-input-bg px-3 py-2.5`,
  16px text on mobile (forced globally under 768px), `min-h-11` (44px), focus
  `ring-1 ring-tt-cyan/50` or `outline-none`. Placeholder `text-tt-muted/60`.
- Labels: 10–11px uppercase tracking-wide muted, 8px above the field.
- Date ranges use the custom `TimeOffCalendar` grid (7 columns, 40px cells, cyan selected edge,
  `bg-tt-cyan/20` in-range fill) rather than native date inputs.

### Domain Components
- **Avatar**: circular initials, deterministic HSL hue from the name (45% saturation, 42%
  lightness), white bold initials, sizes 24/28/36px; state carried by a 1–2px ring (cyan open,
  yellow pending, red no-show, white/20 confirmed), never by the fill.
- **Shift row**: left column day/date in 11px bold uppercase, right column time range in
  tabular 14px with a "🌙 +1d" overnight marker; status words in 11–12px coloured text.
- **Status chips**: small `rounded`/`rounded-full` 10px bold text on a 15% tint; used sparingly.

## 5. Layout Principles

### Grid & Structure
- Employee portal: single column, `max-w-md` (448px) centred, `px-4 py-8`.
- Admin: full width with `px-4 md:px-6`, cards `rounded-[14px]`, occasional two-column at `md`.
- Breakpoints: Tailwind defaults; `md` (768px) is the phone/desktop line used in CSS.

### Whitespace Strategy
- 16px page gutter on phones, 24px from `md`. 24–32px between sections, 8px between rows,
  12px vertical padding inside rows.

### Alignment & Visual Balance
- Left-aligned text everywhere; right-aligned times and controls in rows (`justify-between`).
- Facts read top-down: date, then time, then qualifier.

### Responsive Behavior & Touch
- Mobile-first. Controls in sheets are 44–48px tall and full-width; inline controls are 32px.
- `overflow-x: clip` on html/body; horizontally scrolling strips are explicit and hide scrollbars.
- `viewport-fit=cover` with `.pt-safe/.pb-safe` helpers for notched phones.
- Wrap (`flex-wrap`) rather than truncate when a row's right slot may be a sentence.

## 6. Design System Notes for Stitch Generation

### Language to Use
"Dark, matte, near-black operations app; hairline borders instead of shadows; one cyan accent for
selection and primary actions; system sans; small uppercase tracked labels; tabular times;
status in words with a soft tinted background; calm, no gradients, no glass."

### Color References
Ink Black #0f0f0f · Charcoal Glass rgba(30,30,30,.7) · Hairline rgba(255,255,255,.08) · Soft White
#e8e8e8 · Mid Grey #888888 · Signal Cyan #69C9D0 · Brand Magenta #EE1D52 · Go Green #00c853 ·
Hold Yellow #ffd600 · Stop Red #ff1744.

### Component Prompts
- "A mobile shift row: uppercase 11px day and date on the left, 14px tabular time range on the
  right, a 12px yellow 'Offered · still yours' status line beneath, hairline divider, dark matte."
- "A Monday-to-Sunday week strip, seven equal cells, 11px uppercase weekday over a 15px date,
  today outlined in cyan, selected day filled cyan with black text, a 4px dot under scheduled days."
- "A bottom sheet on a dark app: 16px semibold title, an inset fact box with date and time, one
  sentence of consequence in soft white, two 48px buttons: quiet cancel and cyan confirm."

### Incremental Iteration
Start from the tokens above; adjust density before colour. When a screen looks busy, remove a
container or a chip rather than adding a heading.
