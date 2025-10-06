// /assets/supabase.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const SUPABASE_URL = 'https://rhzaxqljwvaykuozxzcg.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoemF4cWxqd3ZheWt1b3p4emNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc4NzMxNjIsImV4cCI6MjA3MzQ0OTE2Mn0.t2dXlzk8fuaDqMmRgLnRB0Kga3yfMeopwnkDzy275k0';

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

function normalizeRole(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeRole(entry));
  }
  if (typeof value === 'object') {
    return Object.values(value).flatMap((entry) => normalizeRole(entry));
  }
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function hasAdminMarker(source = {}) {
  const flagKeys = [
    'is_admin',
    'admin',
    'isAdmin',
    'is_superadmin',
    'superuser',
    'staff',
    'is_staff',
    'claims_admin',
    'admin_claims',
    'is_operator',
    'operator',
    'operator_access',
    'ops',
    'ops_admin',
    'is_ops',
    'staff_access'
  ];
  return flagKeys.some((key) => Boolean(source?.[key]));
}

function hasAdminRole(context = {}) {
  const profile = context.profile || {};
  const membership = context.membership || {};
  const user = context.user || {};
  const appMeta = user.app_metadata || {};
  const userMeta = user.user_metadata || {};

  const buckets = new Set();
  const collect = (value) => {
    normalizeRole(value).forEach((role) => buckets.add(role));
  };

  collect(profile.role);
  collect(profile.role_name);
  collect(profile.user_role);
  collect(profile.access_level);
  collect(profile.roles);
  collect(profile.role_tags);
  collect(profile.plan);
  collect(profile.tier);
  collect(profile.team);
  collect(profile.department);
  collect(profile.groups);
  collect(profile.labels);
  collect(profile.tags);

  collect(appMeta.role);
  collect(appMeta.roles);
  collect(appMeta.access_level);
  collect(appMeta.permissions);
  collect(appMeta.team);
  collect(appMeta.groups);
  collect(appMeta.labels);

  collect(userMeta.role);
  collect(userMeta.roles);
  collect(userMeta.access_level);
  collect(userMeta.team);
  collect(userMeta.groups);

  collect(membership.role);
  collect(membership.roles);
  collect(membership.access_level);
  collect(membership.plan);
  collect(membership.plan_name);
  collect(membership.tier);
  collect(membership.labels);
  collect(membership.tags);

  if (hasAdminMarker(profile) || hasAdminMarker(appMeta) || hasAdminMarker(userMeta) || hasAdminMarker(membership)) {
    return true;
  }

  const elevated = new Set([
    'admin',
    'administrator',
    'superadmin',
    'owner',
    'editor',
    'staff',
    'operator',
    'operations',
    'ops',
    'internal',
    'maintainer',
    'automation',
    'builder'
  ]);
  for (const role of buckets) {
    if (role === 'admin' || elevated.has(role)) {
      return true;
    }
  }
  return false;
}

export function isMembershipActive(record, context = {}) {
  if (record) {
    const status = (record.status || '').toLowerCase();
    if (status && status !== 'active') {
      return hasAdminRole({ ...context, membership: record });
    }
    if (record.current_period_end) {
      const expiry = new Date(record.current_period_end).getTime();
      if (!Number.isNaN(expiry) && expiry < Date.now()) {
        return hasAdminRole({ ...context, membership: record });
      }
    }
    return true;
  }
  return hasAdminRole(context);
}

export { hasAdminRole };
