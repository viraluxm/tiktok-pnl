'use client';

import { useParams } from 'next/navigation';
import HostTrackingShell from '@/components/live/HostTrackingShell';

export default function LiveSessionPage() {
  const params = useParams();
  const id = typeof params.id === 'string' ? params.id : Array.isArray(params.id) ? params.id[0] : '';
  return <HostTrackingShell sessionId={id} />;
}
