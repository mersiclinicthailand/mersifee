import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) console.error('ไม่พบ VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'mersi-fee-auth',
  },
  db: { schema: 'fee' },
  global: { headers: { 'x-application-name': 'mersi-fee' } },
});

/** ล็อกอินด้วยชื่อผู้ใช้ ไม่ต้องมีอีเมลจริง (ใช้ร่วมกับ Mersi CRM) */
export const toEmail = (username: string) => `${username.trim().toLowerCase()}@mersi.local`;

export const APP_VERSION = 'v2.0 · Supabase + Cloudflare';
