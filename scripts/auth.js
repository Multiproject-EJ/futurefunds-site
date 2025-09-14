<!-- Include on every protected page: -->
<script src="https://unpkg.com/@supabase/supabase-js@2"></script>
<script>
/**
 * FutureFunds — Auth helper
 * - sb: Supabase client
 * - ensureSession(): waits for auth state; returns {user, session}
 * - requireMember(): shows lock screen if not logged in
 * - requireAdmin(): redirects non-admins away
 *
 * Setup:
 *  - Create a Supabase project
 *  - Get anon URL + anon key, paste below
 *  - In Supabase, create table 'profiles' with columns:
 *      id uuid primary key references auth.users,
 *      role text default 'member'
 *    and enable RLS; add policy:
 *      SELECT: authenticated true
 *      INSERT/UPDATE: user_id = auth.uid()
 *  - In your sign-up webhook or first login, insert { id: user.id, role: 'admin' } for your account.
 */
window.sb = window.sb || supabase.createClient(
  "https://YOUR-PROJECT.supabase.co",         // ← replace
  "YOUR_SUPABASE_ANON_KEY"                    // ← replace
);

// Small UI helper for lock overlays
function mountLock(message, showLoginLink=true){
  const el = document.createElement('div');
  el.id = 'lock-overlay';
  el.style.cssText = "position:fixed;inset:0;background:linear-gradient(0deg,rgba(0,0,0,.05),rgba(0,0,0,.08));display:flex;align-items:center;justify-content:center;padding:24px;z-index:9999";
  el.innerHTML = `
    <div style="max-width:520px;background:var(--panel,#fff);border:1px solid var(--border,#e5e7eb);border-radius:16px;box-shadow:var(--shadow,0 12px 34px rgba(0,0,0,.06));padding:22px">
      <h2 style="margin:0 0 8px">Sign in required</h2>
      <p style="margin:0 0 16px;color:var(--muted,#64748b)">${message}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${showLoginLink ? '<a class="btn small" href="/login.html">Go to login</a>' : ''}
        <button id="lock-refresh" class="btn small" type="button">I’m signed in — refresh</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.getElementById('lock-refresh').onclick = ()=> location.reload();
}

async function ensureSession(){
  const { data: { session } } = await sb.auth.getSession();
  if (session) return { session, user: session.user };
  // wait once for auth event
  return new Promise(resolve=>{
    const { data: sub } = sb.auth.onAuthStateChange((_evt, s)=>{
      sub.subscription.unsubscribe();
      resolve({ session: s || null, user: s?.user || null });
    });
    // timeout fallback
    setTimeout(()=> resolve({ session: null, user: null }), 1200);
  });
}

async function currentRole(){
  const { user } = await ensureSession();
  if (!user) return null;
  const { data, error } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (error) return null;
  return data?.role || 'member';
}

// Gate: members
async function requireMember(){
  const { user } = await ensureSession();
  if (!user){
    mountLock("Members only. Please sign in to view this page.");
    throw new Error("Not signed in");
  }
  return user;
}

// Gate: admin
async function requireAdmin(){
  const user = await requireMember();
  const role = await currentRole();
  if (role !== 'admin'){
    mountLock("Admin only. Your account doesn’t have access.", false);
    throw new Error("Not admin");
  }
  return user;
}

window.ffAuth = { ensureSession, requireMember, requireAdmin, currentRole };
</script>
