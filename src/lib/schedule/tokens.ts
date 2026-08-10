import 'server-only';
import { randomBytes } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Employee } from '@/types';

// PUBLIC-TOKEN identity resolution for the /s/[token] routes. These routes NEVER establish a
// Supabase auth session (see CLAUDE.md). We resolve an employee from an opaque access token via
// the SERVICE-ROLE client and then scope EVERY downstream query explicitly by that employee_id —
// RLS is bypassed by service-role, so it is never the security boundary here; the token + explicit
// employee_id filter is.

// 32 random bytes, base64url (43 chars, no padding). Generated in app code, never in the DB.
export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface ResolvedEmployee {
  employee: Employee;
  tokenId: string;
}

// Resolve an ACTIVE token to its employee. Returns null for any miss (unknown/revoked/inactive
// token, or a missing/former employee) — the caller renders a bare 404 and leaks no detail.
export async function resolveEmployeeByToken(token: string): Promise<ResolvedEmployee | null> {
  if (!token || token.length < 20) return null; // cheap reject of obviously-bad tokens
  const admin = createAdminClient();

  const { data: tok, error } = await admin
    .from('employee_access_tokens')
    .select('id, employee_id, active')
    .eq('token', token)
    .eq('active', true)
    .maybeSingle();
  if (error || !tok) return null;

  const { data: emp, error: eErr } = await admin
    .from('employees')
    .select('*')
    .eq('id', tok.employee_id)
    .maybeSingle();
  if (eErr || !emp) return null;

  return { employee: emp as Employee, tokenId: tok.id };
}
