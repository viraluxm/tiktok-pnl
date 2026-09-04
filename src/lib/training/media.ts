// Practice Mode media policy — one place, so the host publisher and the trainer
// subscriber can never drift apart.
//
// Deliberately dependency-free (no React, no livekit-client import) so it stays
// unit-testable in plain Node and safe to import from anywhere. The LiveKit
// options are a structural literal rather than a typed RoomOptions so this file
// never pulls in the browser-only SDK.

// Portrait-safe 720p-equivalent capture ceiling.
//
// We cap BOTH axes at 1280 instead of requesting a landscape 1280x720, because
// practice hosts hold PHONES IN PORTRAIT: a portrait sensor delivers 720x1280,
// which satisfies max<=1280 on both axes and keeps its natural orientation and
// aspect ratio. Asking for an exact or ideal 1280x720 would push the browser to
// crop, letterbox or rotate a portrait stream, so we pin NEITHER axis and set no
// aspectRatio. `max` is a hard upper bound, so a 1080p/4K-capable sensor is
// downscaled to <=1280 on its long edge — the single biggest upload saving
// available when ~20 cameras share one Wi-Fi — while 720p-equivalent detail is
// still plenty to evaluate a host.
export const PRACTICE_VIDEO_CAPTURE: MediaTrackConstraints = {
  facingMode: 'user',
  width: { max: 1280 },
  height: { max: 1280 },
  frameRate: { max: 30 },
};

// LiveKit Room options shared by BOTH the host publisher and the trainer
// subscriber. livekit-client defaults both of these to false, which meant every
// host uploaded its whole simulcast ladder regardless of demand and every
// trainer pulled the full-resolution top layer into a ~260px preview.
//   - adaptiveStream (subscriber): request a layer sized to the actual element.
//   - dynacast (publisher): let the SFU pause layers nobody is watching.
// They only pay off as a pair, which is why they live in one constant.
export const PRACTICE_ROOM_OPTIONS: { adaptiveStream: boolean; dynacast: boolean } = {
  adaptiveStream: true,
  dynacast: true,
};

// The long-edge ceiling the capture constraints are meant to enforce. Exported
// so tests assert the intent rather than a magic number.
export const PRACTICE_MAX_CAPTURE_EDGE = 1280;
