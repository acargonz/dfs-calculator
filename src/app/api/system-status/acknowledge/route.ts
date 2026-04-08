/**
 * /api/system-status/acknowledge — mark a system alert as acknowledged.
 *
 * Used by the SystemStatusCard's "Ack" button. Setting acknowledged_at on a
 * row removes it from the active-alerts query (which filters on
 * `acknowledged_at IS NULL`), so the user clears the banner without losing
 * the audit history.
 *
 *   POST /api/system-status/acknowledge?id=<alert_uuid>
 *
 * Returns 400 if id is missing, 404 if the alert doesn't exist, 500 on DB
 * errors. Otherwise returns { ok: true, id, acknowledged_at }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { AcknowledgeQuery } from '@/lib/schemas';
import { badRequest, internalError, misconfigured, errorResponse } from '@/lib/apiErrors';
import { isAllowedOrigin } from '@/lib/originCheck';

export async function POST(request: NextRequest) {
  // Origin check — acknowledge is a mutating action, reject cross-origin
  // browser requests (CSRF shield). Same-origin or matching Referer passes.
  if (!isAllowedOrigin(request)) {
    return errorResponse('forbidden', 'Cross-origin request blocked');
  }

  // Zod-validate the `id` query param (must be a uuid). Using safeParse
  // so a bad value yields 400 instead of 500.
  const parsed = AcknowledgeQuery.safeParse({
    id: request.nextUrl.searchParams.get('id') ?? '',
  });
  if (!parsed.success) {
    return badRequest(parsed.error.issues[0]?.message ?? 'Invalid id');
  }
  const { id } = parsed.data;

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return misconfigured('Supabase admin client not configured');
  }

  const acknowledgedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('system_alerts')
    .update({ acknowledged_at: acknowledgedAt })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return internalError(error, 'acknowledge');
  }
  if (!data) {
    return errorResponse('not_found', 'Alert not found');
  }

  return NextResponse.json({ ok: true, id, acknowledged_at: acknowledgedAt });
}
