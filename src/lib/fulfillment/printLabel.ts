// Label printing for the packer's Confirm & Print action.
//
// There is NO reusable label/printer pipeline in this repo yet (no Whatnot webhook,
// no TikTok Shop Shipping label code). So this is a STUB + manual fallback so the
// pack flow works end-to-end before the printer pipeline is wired.
//
// TODO: wire TikTok Shop Shipping Solutions (approved scope) — fetch the shipping
// document for the box's order(s) and POST to the label printer. Replace `mode:'stub'`
// with the real label URL/print dispatch. Keep the return shape stable so the UI
// (auto-print on 'printed', manual "Open label PDF" on 'fallback') doesn't change.

export interface PrintLabelResult {
  ok: boolean;
  mode: 'printed' | 'fallback' | 'stub';
  labelUrl: string | null;
  message: string;
}

export async function printLabel(box: { group_key: string; order_ids: string[] }): Promise<PrintLabelResult> {
  // No printer pipeline yet — succeed in stub mode so the cubicle still frees and
  // the order ships in our system; the packer gets a manual-label fallback in the UI.
  return {
    ok: true,
    mode: 'stub',
    labelUrl: null,
    message: `Label pipeline not wired yet — ship recorded for box ${box.group_key} (${box.order_ids.length} order(s)). Use "Open label PDF" fallback.`,
  };
}
