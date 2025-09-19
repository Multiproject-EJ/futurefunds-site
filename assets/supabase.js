// /assets/supabase.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://rhzaxqljwvaykuozxzcg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoemF4cWxqd3ZheWt1b3p4emNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc4NzMxNjIsImV4cCI6MjA3MzQ0OTE2Mn0.t2dXlzk8fuaDqMmRgLnRB0Kga3yfMeopwnkDzy275k0';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, detectSessionInUrl: true }
});

if (typeof window !== 'undefined') {
  window.supabaseClient = supabase;
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}

export async function ensureProfile(user) {
  if (!user) return null;
  const payload = { id: user.id, email: user.email ?? null };
  const { error } = await supabase.from('profiles').upsert(payload, { onConflict: 'id' });
  if (error) console.warn('profiles upsert error:', error);
  return payload;
}

export async function getProfile() {
  const user = await getUser();
  if (!user) return null;
  await ensureProfile(user).catch(() => {});
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (error) {
    console.warn('profiles error:', error);
    return null;
  }
  return data ?? null;
}

export async function getMembership() {
  const user = await getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('memberships')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    console.warn('memberships error:', error);
    return null;
  }
  return data ?? null;
}

export function isMembershipActive(record) {
  if (!record) return false;
  const status = (record.status || '').toLowerCase();
  if (status && status !== 'active') return false;
  if (record.current_period_end) {
    const expiry = new Date(record.current_period_end).getTime();
    if (!Number.isNaN(expiry) && expiry < Date.now()) return false;
  }
  return true;
}
