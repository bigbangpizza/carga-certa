// Edge Function "push": recebe o Database Webhook (INSERT em public.notifications)
// e envia o Web Push. profile_id nulo = todos os moradores aprovados.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:contato@example.com';
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET')!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  const payload = await req.json().catch(() => null);
  const rec = payload?.record;
  if (!rec?.body) return new Response('ignored', { status: 200 });

  let q = db.from('push_subscriptions').select('id, endpoint, p256dh, auth, profile_id');
  if (rec.profile_id) {
    q = q.eq('profile_id', rec.profile_id);
  } else {
    const { data: ok } = await db.from('profiles').select('id').eq('status', 'approved');
    q = q.in('profile_id', (ok ?? []).map((p: { id: string }) => p.id));
  }
  const { data: subs, error } = await q;
  if (error) return new Response(error.message, { status: 500 });

  const msg = JSON.stringify({
    title: rec.title ?? 'Carga Certa',
    body: rec.body,
    tag: rec.tag ?? 'carga-certa',
    url: './',
  });
  const dead: string[] = [];
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s: { id: string; endpoint: string; p256dh: string; auth: string }) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, msg, { TTL: 600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.id);
    }
  }));
  if (dead.length) await db.from('push_subscriptions').delete().in('id', dead);
  return new Response(JSON.stringify({ sent, removed: dead.length }), { headers: { 'content-type': 'application/json' } });
});
