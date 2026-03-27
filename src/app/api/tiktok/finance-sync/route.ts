import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchStatements } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: connection, error: connError } = await admin
    .from('tiktok_connections')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (connError || !connection) {
    return NextResponse.json({ error: 'No TikTok connection found' }, { status: 404 });
  }

  if (!connection.shop_cipher) {
    return NextResponse.json({ error: 'No shop_cipher' }, { status: 400 });
  }

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');

  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);

  const startTs = Math.floor(thirtyDaysAgo.getTime() / 1000);
  const endTs = Math.floor(now.getTime() / 1000);

  try {
    const { statements, rawResponse } = await fetchStatements(
      accessToken,
      connection.shop_cipher,
      startTs,
      endTs,
    );

    return NextResponse.json({
      success: true,
      dateRange: {
        start: thirtyDaysAgo.toISOString(),
        end: now.toISOString(),
        startTs,
        endTs,
      },
      statementCount: statements.length,
      statements,
      rawResponse,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: String(error),
      dateRange: { startTs, endTs },
    }, { status: 500 });
  }
}
