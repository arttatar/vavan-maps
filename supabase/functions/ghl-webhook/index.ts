// ghl-webhook Edge Function
//
// Receives webhook events from GHL sub-accounts. For each event:
//   1. Verify the request token matches the secret for that location
//   2. Look up the matching businesses row by ghl_contact_id (FK link)
//   3. UPSERT/UPDATE/DELETE based on event type
//   4. Mark last_sync_origin = 'ghl_webhook' so the outbound side knows
//      not to echo this change back to GHL
//   5. Log every event to ghl_sync_log
//
// Webhook URL pattern (per location):
//   https://<project>.supabase.co/functions/v1/ghl-webhook?token=<secret>
//
// Each branch's GHL sub-account is registered with its own token, so we
// know which location the event came from before even parsing the body.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, x-ghl-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface GhlContact {
  id?: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  website?: string;
  type?: string;
  source?: string;
  tags?: string[];
  customFields?: Array<{ id: string; value: unknown }>;
  dateAdded?: string;
  dateUpdated?: string;
  // Some webhook variants put the contact under .contact
  contact?: GhlContact;
}

interface GhlEvent {
  type?: string;             // ContactCreate, ContactUpdate, ContactDelete, etc.
  event?: string;            // some payloads use this instead of `type`
  locationId?: string;
  contactId?: string;
  contact?: GhlContact;
  // Outermost may BE the contact itself for some flows
  id?: string;
  [k: string]: unknown;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST')   return json({ error: 'POST only' }, 405);

  const t0 = Date.now();
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || req.headers.get('x-ghl-token') || '';

  let raw: unknown;
  try { raw = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const event = raw as GhlEvent;

  // --- 1. Resolve location & verify token ----------------------------------
  const locationId =
    event.locationId ||
    event.contact?.locationId ||
    (event as { location?: { id?: string } }).location?.id ||
    null;

  if (!locationId) {
    await logEvent({ direction:'inbound', status:'error', error:'missing locationId',
                     payload:event as Record<string,unknown>, processed_ms: Date.now()-t0 });
    return json({ error: 'missing locationId' }, 400);
  }

  const { data: secretRow } = await sb.from('ghl_webhook_secrets')
    .select('secret, branch_code').eq('location_id', locationId).single();
  if (!secretRow) {
    await logEvent({ direction:'inbound', location_id:locationId, status:'error',
                     error:'unknown locationId', payload:event as Record<string,unknown>,
                     processed_ms: Date.now()-t0 });
    return json({ error: 'unknown locationId' }, 403);
  }
  if (token !== secretRow.secret) {
    await logEvent({ direction:'inbound', location_id:locationId, branch_code:secretRow.branch_code,
                     status:'error', error:'bad token', processed_ms: Date.now()-t0 });
    return json({ error: 'forbidden' }, 403);
  }
  const branchCode = secretRow.branch_code;

  // --- 2. Identify event type + contact payload ----------------------------
  const eventType = (event.type || event.event || '').trim() || 'unknown';
  const contact = event.contact || (event.id ? event as unknown as GhlContact : null);
  const ghlContactId = event.contactId || contact?.id || null;

  // We support a handful of event types out of the box; other events log + ignore
  // (so we always see them in ghl_sync_log without erroring).
  const lower = eventType.toLowerCase();
  let action: 'upsert' | 'delete' | 'ignore' = 'ignore';
  if (lower.includes('contact')) {
    if (lower.includes('delete')) action = 'delete';
    else if (lower.includes('create') || lower.includes('update')
             || lower.includes('change') || lower === 'unknown')
      action = 'upsert';
  }

  // --- 3. Apply to Supabase -----------------------------------------------
  let businessId: string | null = null;
  let status: string = 'ok';
  let errMsg: string | undefined;

  try {
    if (action === 'delete' && ghlContactId) {
      // Soft-delete: clear the FK + mark abandoned so the row still exists for audit
      const { data, error } = await sb.from('businesses')
        .update({
          is_abandoned: true,
          ghl_contact_id: null,
          last_sync_at: new Date().toISOString(),
          last_sync_origin: 'ghl_webhook',
          updated_at: new Date().toISOString(),
        })
        .eq('ghl_contact_id', ghlContactId)
        .select('id').maybeSingle();
      if (error) throw error;
      businessId = data?.id || null;
    } else if (action === 'upsert' && contact && ghlContactId) {
      const update = mapContactToBusiness(contact, branchCode, locationId);
      // Try to find the existing row by ghl_contact_id first
      const { data: existing } = await sb.from('businesses')
        .select('id').eq('ghl_contact_id', ghlContactId).maybeSingle();
      if (existing) {
        const { error } = await sb.from('businesses').update(update).eq('id', existing.id);
        if (error) throw error;
        businessId = existing.id;
      } else {
        // No existing — insert. (Normally a Create event will fall here.)
        const insertRow = { ...update, ghl_contact_id: ghlContactId };
        const { data, error } = await sb.from('businesses').insert(insertRow).select('id').single();
        if (error) throw error;
        businessId = data?.id || null;
      }
    } else {
      status = 'ignored';
    }
  } catch (e) {
    status = 'error';
    errMsg = (e as Error).message?.slice(0, 500);
  }

  await logEvent({
    direction:'inbound',
    event_type:eventType,
    location_id:locationId,
    branch_code:branchCode,
    ghl_contact_id:ghlContactId,
    business_id:businessId,
    status,
    payload: event as Record<string,unknown>,
    error: errMsg,
    processed_ms: Date.now() - t0,
  });

  // Always 200 on auth-passed requests so GHL doesn't retry us into oblivion
  // for our own bugs — the log + monitoring catches errors instead.
  return json({ ok: status === 'ok' || status === 'ignored', status, business_id: businessId }, 200);
});

// ---------------------------------------------------------------------------
function mapContactToBusiness(c: GhlContact, branchCode: string, locationId: string) {
  // Pull values from the GHL contact into our businesses columns.
  // Map custom fields by name -> our schema.
  const cf: Record<string, unknown> = {};
  for (const f of c.customFields || []) {
    if (typeof f.value === 'string' || typeof f.value === 'number' || typeof f.value === 'boolean') {
      cf[String(f.id)] = f.value;
    }
  }
  const name = c.companyName || c.name ||
               [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
               '[Unknown]';

  return {
    name,
    street: c.address1 || null,
    locality: c.city || null,
    state: c.state || null,
    zip: c.postalCode || null,
    phone: c.phone || null,
    website: c.website || null,
    branch_code: branchCode,
    ghl_location_id: locationId,
    tags: c.tags || [],
    last_sync_at: new Date().toISOString(),
    last_sync_origin: 'ghl_webhook',
    updated_at: new Date().toISOString(),
  };
}

async function logEvent(row: Record<string, unknown>) {
  try { await sb.from('ghl_sync_log').insert(row); } catch (_) { /* swallow */ }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
