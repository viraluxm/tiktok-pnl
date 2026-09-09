// Practice Mode media policy — one place, so the host publisher and the trainer
// subscriber can never drift apart.
//
// Deliberately dependency-free (no React, no livekit-client import) so it stays
// unit-testable in plain Node and safe to import from anywhere. The LiveKit
// options are a structural literal rather than a typed RoomOptions so this file
// never pulls in the browser-only SDK.

// Capture constraints: facingMode ONLY.
//
// REVERTED to the pre-#208 form on 2026-09-09 because the `{ max: 1280 }` ranges
// #208 introduced BROKE VIDEO PUBLISHING OUTRIGHT, in every browser, for five
// days. livekit-client's publishTrack does
//     opts.degradationPreference ??= getDefaultDegradationPreference(track)
// and that default reads
//     track.constraints.height && unwrapConstraint(track.constraints.height) >= 1080
// where unwrapConstraint() understands only a bare number, an array, `{exact}` or
// `{ideal}`. A `{max}`-only range reaches `throw Error('could not unwrap
// constraint')`, publishTrack aborts, and the host is disconnected. With no
// width/height here at all, `track.constraints.height` is undefined and that
// expression short-circuits before ever calling unwrapConstraint — which is
// precisely why this worked before #208 and not after.
//
// THE BANDWIDTH GOAL IS NOT LOST — IT MOVED TO WHERE IT BELONGS. Capping the
// CAPTURE was always the wrong lever: what costs Wi-Fi is what gets UPLOADED, and
// that is set by the publish encoding. PRACTICE_VIDEO_ENCODING below caps the
// upload directly, independent of what the sensor produces, and involves no
// constraint parsing at all. #208's other two measures (dynacast + adaptiveStream)
// are untouched and still doing the heavier lifting.
//
// Do NOT reintroduce width/height/frameRate here without checking
// unwrapConstraint's accepted shapes first. recording.test.mjs guards this.
export const PRACTICE_VIDEO_CAPTURE: MediaTrackConstraints = {
  facingMode: 'user',
};

// Upload ceiling for a published practice camera, applied at publish time.
//
// ~1.2 Mbps is comfortably enough to judge a host's delivery and is roughly half
// what LiveKit would choose by default for a 720p+ camera — which is the saving
// #208 was after when ~10-20 hosts publish over one warehouse connection. Capping
// here rather than at capture also means it holds regardless of the sensor: a 4K
// phone still uploads ~1.2 Mbps.
export const PRACTICE_VIDEO_ENCODING = {
  maxBitrate: 1_200_000,
  maxFramerate: 30,
} as const;

export const PRACTICE_ROOM_OPTIONS: { adaptiveStream: boolean; dynacast: boolean } = {
  adaptiveStream: true,
  dynacast: true,
};

// RETIRED with the capture ceiling it described (see above). Kept only so any
// remaining import fails loudly at the type level rather than silently reading
// undefined — delete once nothing references it.
/** @deprecated capture is no longer size-capped; the cap is PRACTICE_VIDEO_ENCODING. */
export const PRACTICE_MAX_CAPTURE_EDGE = 1280;
