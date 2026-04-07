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
import { getSupabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return NextResponse.json(
      { error: 'Supabase not configured' },
      { status: 500 },
    );
  }

  const acknowledgedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('system_alerts')
    .update({ acknowledged_at: acknowledgedAt })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json(
      { error: `Failed to acknowledge: ${error.message}` },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({ error: 'Alert not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id, acknowledged_at: acknowledgedAt });
}
