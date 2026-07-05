import type { SupabaseClient } from '@supabase/supabase-js';

// Is the current login allowlisted for the worker-KPI dashboard? current_store() ∈
// org_settings.kpi_dashboard_store_ids. Used to show/hide the link (the route re-enforces).
export async function kpiAllowlisted(supabase: SupabaseClient): Promise<boolean> {
  const [{ data: cs }, { data: os }] = await Promise.all([
    supabase.rpc('current_store'),
    supabase.from('org_settings').select('kpi_dashboard_store_ids').maybeSingle(),
  ]);
  const ids = (os?.kpi_dashboard_store_ids as string[] | undefined) ?? [];
  return !!cs && ids.includes(cs as string);
}
