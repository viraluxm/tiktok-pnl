import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { approveReturn, rejectReturn, approveCancellation, rejectCancellation } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { returnId, action, rejectReason, sellerComments, returnType } = body as {
    returnId: string;
    action: 'approve' | 'reject';
    rejectReason?: string;
    sellerComments?: string;
    returnType?: string;
  };

  if (!returnId || !action) {
    return NextResponse.json({ error: 'Missing returnId or action' }, { status: 400 });
  }
  if (action === 'reject' && !rejectReason) {
    return NextResponse.json({ error: 'Rejection reason is required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: connection } = await admin.from('tiktok_connections').select('*').eq('user_id', data.user.id).single();
  if (!connection?.access_token || !connection?.shop_cipher) {
    return NextResponse.json({ error: 'No TikTok connection' }, { status: 404 });
  }

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');
  const isCancellation = returnType === 'CANCELLATION';

  try {
    if (action === 'approve') {
      if (isCancellation) {
        await approveCancellation(accessToken, connection.shop_cipher, returnId);
      } else {
        await approveReturn(accessToken, connection.shop_cipher, returnId);
      }
    } else {
      if (isCancellation) {
        await rejectCancellation(accessToken, connection.shop_cipher, returnId, rejectReason!, sellerComments);
      } else {
        await rejectReturn(accessToken, connection.shop_cipher, returnId, rejectReason!, sellerComments);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[Returns] Respond error:', (err as Error).message);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
