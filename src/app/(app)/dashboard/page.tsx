'use client';

import { useDemo } from '@/lib/demo/context';
import RealDashboard from './RealDashboard';
import DemoDashboard from './DemoDashboard';

export default function DashboardPage() {
  const { isDemo } = useDemo();

  if (isDemo) {
    return <DemoDashboard />;
  }

  return <RealDashboard />;
}
