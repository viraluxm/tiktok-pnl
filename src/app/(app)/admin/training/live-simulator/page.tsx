import type { Viewport } from 'next';
import LiveSimulator from '@/components/training/LiveSimulator';

// Route-scoped viewport so the full-bleed camera UI can extend into the iPhone
// safe areas (the root layout has no viewport export).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#000000',
};

export default function LiveSimulatorPage() {
  return <LiveSimulator />;
}
