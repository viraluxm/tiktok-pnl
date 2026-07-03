'use client';

import { createContext, useContext } from 'react';

// Shift context established by the (device) shell (chunk 7). /pick & /pack consume it via
// useFulfillmentShift(); chunk 8 injects { shiftId, workerId } into the pick/pack action calls.
export interface FulfillmentShift {
  shiftId: string;
  workerId: string;
  workerName: string;
  mode: 'picker' | 'packer';
  state: 'working' | 'on_break';
  markActivity: () => void; // resets the idle timer (global listener also does this)
}

export const FulfillmentShiftContext = createContext<FulfillmentShift | null>(null);
export const useFulfillmentShift = () => useContext(FulfillmentShiftContext);
