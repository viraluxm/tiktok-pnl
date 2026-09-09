// Type re-exports for the preview fixtures. Type-only — nothing here can reach a database.
export type {
  AvailableItem, PortalShift, PortalSnapshot, PortalTeamShift, PortalWeek, TimecardPayload, TradeOptionsPayload, TradeView, TimeOffView, PickupRequestView,
} from '@/lib/schedule/portalTypes';
export type { PortalClient } from '@/components/portal/client';
