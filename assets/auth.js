// /assets/auth.js
import { supabase, getUser, getProfile, getMembership, ensureProfile, isMembershipActive } from './supabase.js';

const state = {
  user: null,
  profile: null,
  membership: null,
  readyResolve: null,
  readyPromise: null,
};

state.readyPromise = new Promise((resolve) => { state.readyResolve = resolve; });

const els = {
  modal: null,
  title: null,
  subtitle: null,
  msg: null,
  views: null,
  headerMembershipBtn: null,
  signInForm: null,
  signInEmail: null,
  signInPassword: null,
  signUpForm: null,
  signUpEmail: null,
  signUpPassword: null,
  resetForm: null,
  resetEmail: null,
  magicLinkBtn: null,
  logoutBtn: null,
  profileEmail: null,
  membershipSummary: null,
  gateBlocks: [],
};

const viewCopy = {
  signin: {
    title: 'Welcome back',
    subtitle: 'Sign in to access member-only research and tools.'
  },
  signup: {
    title: 'Create your account',
    subtitle: 'Set up a profile to unlock the FutureFunds.ai membership area.'
  },
  forgot: {
    title: 'Reset your password',
    subtitle: 'We\'ll email you a secure link to choose a new password.'
  },
  profile: {
    title: 'Your account',
    subtitle: 'Manage membership access or sign out from here.'
  }
};

function ensureModalMounted() {
  if (document.getElementById('authModal')) return;
  const markup = `
    <div id="authModal" class="auth-modal" aria-hidden="true">
      <div class="auth-backdrop" data-close-auth></div>
      <div class="auth-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">
        <button class="auth-close" data-close-auth aria-label="Close">×</button>
        <header class="auth-head">
          <h3 id="authTitle">Welcome back</h3>
          <p id="authSubtitle" class="auth-sub muted">Sign in to access member-only research and tools.</p>
        </header>
        <div class="auth-views" id="authViews">
          <section class="auth-view" data-view="signin" aria-labelledby="authTitle">
            <form id="authSignInForm" class="auth-form">
              <label class="auth-label">
                <span>Email</span>
                <input id="authSignInEmail" type="email" autocomplete="email" required />
              </label>
              <label class="auth-label">
                <span>Password</span>
                <input id="authSignInPassword" type="password" autocomplete="current-password" required />
              </label>
              <button class="btn primary auth-submit" type="submit">Sign in</button>
            </form>
            <button id="authMagicLink" class="btn ghost auth-secondary" type="button">Email me a magic link</button>
            <p class="auth-switch">New here? <a href="#" data-auth-switch="signup">Create an account</a></p>
            <p class="auth-switch"><a href="#" data-auth-switch="forgot">Forgot password</a></p>
          </section>
          <section class="auth-view" data-view="signup">
            <form id="authSignUpForm" class="auth-form">
              <label class="auth-label">
                <span>Email</span>
                <input id="authSignUpEmail" type="email" autocomplete="email" required />
              </label>
              <label class="auth-label">
                <span>Password</span>
                <input id="authSignUpPassword" type="password" autocomplete="new-password" minlength="6" required />
              </label>
              <button class="btn primary auth-submit" type="submit">Create account</button>
            </form>
            <p class="auth-switch">Already have an account? <a href="#" data-auth-switch="signin">Sign in</a></p>
          </section>
          <section class="auth-view" data-view="forgot">
            <form id="authResetForm" class="auth-form">
              <label class="auth-label">
                <span>Email</span>
                <input id="authResetEmail" type="email" autocomplete="email" required />
              </label>
              <button class="btn primary auth-submit" type="submit">Send reset link</button>
            </form>
            <p class="auth-switch"><a href="#" data-auth-switch="signin">Back to sign in</a></p>
          </section>
          <section class="auth-view" data-view="profile">
            <div class="auth-profile">
              <p id="authWelcome" class="auth-welcome"></p>
              <div class="auth-membership" id="authMembership"></div>
              <div class="auth-profile-actions">
                <a class="btn primary" href="/universe.html">Universe</a>
                <a class="btn" href="/portfolio.html">Portfolios</a>
              </div>
              <button id="authLogout" class="btn ghost" type="button">Sign out</button>
            </div>
          </section>
        </div>
        <aside class="auth-benefits">
          <h4 class="auth-benefits__title" data-i18n="membership.perks.title">Member perks &amp; pricing</h4>
          <p class="auth-benefits__intro muted" data-i18n="membership.perks.subhead">Support the experiment and unlock every research drop.</p>
          <ul class="perks-list">
            <li data-i18n="membership.perks.list.analysis">Full Universe AI analysis library (deep research).</li>
            <li data-i18n="membership.perks.list.portfolios">See every live portfolio and rebalance log.</li>
            <li data-i18n="membership.perks.list.updates">Receive detailed quarterly strategy updates.</li>
            <li data-i18n="membership.perks.list.tools">Use the Smart Watchlist and other investor tools for free.</li>
            <li data-i18n="membership.perks.list.discount">50% off future investor tool bundles.</li>
            <li data-i18n="membership.perks.list.feedback">Shape the roadmap via the member Strategy Document.</li>
          </ul>
          <p class="auth-benefits__price" data-i18n="membership.perks.price">Membership starts at $5/mo.</p>
          <div class="auth-benefits__actions">
            <button class="btn primary" type="button" data-open-auth="signup" data-i18n="membership.perks.ctaJoin">Join now</button>
            <button class="btn ghost" type="button" data-open-auth="signin" data-i18n="membership.perks.ctaSignIn">Already a member? Sign in</button>
          </div>
        </aside>
        <p id="authMsg" class="auth-msg" role="status"></p>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', markup);
}

function queryElements() {
  ensureModalMounted();
  els.modal = document.getElementById('authModal');
  els.title = document.getElementById('authTitle');
  els.subtitle = document.getElementById('authSubtitle');
  els.msg = document.getElementById('authMsg');
  els.views = document.getElementById('authViews');
  els.headerMembershipBtn = document.getElementById('membershipLogin') || document.getElementById('membershipBtn');
  if (els.headerMembershipBtn && !els.headerMembershipBtn.hasAttribute('data-open-auth')) {
    els.headerMembershipBtn.setAttribute('data-open-auth', 'signin');
  }
  els.signInForm = document.getElementById('authSignInForm');
  els.signInEmail = document.getElementById('authSignInEmail');
  els.signInPassword = document.getElementById('authSignInPassword');
  els.signUpForm = document.getElementById('authSignUpForm');
  els.signUpEmail = document.getElementById('authSignUpEmail');
  els.signUpPassword = document.getElementById('authSignUpPassword');
  els.resetForm = document.getElementById('authResetForm');
  els.resetEmail = document.getElementById('authResetEmail');
  els.magicLinkBtn = document.getElementById('authMagicLink');
  els.logoutBtn = document.getElementById('authLogout');
  els.profileEmail = document.getElementById('authWelcome');
  els.membershipSummary = document.getElementById('authMembership');
  els.gateBlocks = Array.from(document.querySelectorAll('[data-gated]'));
}

function showView(view) {
  const target = viewCopy[view] ? view : (state.user ? 'profile' : 'signin');
  Array.from(els.views?.querySelectorAll('.auth-view') || []).forEach(section => {
    section.classList.toggle('active', section.dataset.view === target);
  });
  const copy = viewCopy[target] || viewCopy.signin;
  if (els.title) els.title.textContent = copy.title;
  if (els.subtitle) els.subtitle.textContent = copy.subtitle;
  els.modal?.setAttribute('data-view', target);
  setMessage('');
  let focusEl = null;
  if (target === 'signin') focusEl = els.signInEmail;
  else if (target === 'signup') focusEl = els.signUpEmail;
  else if (target === 'forgot') focusEl = els.resetEmail;
  if (focusEl) setTimeout(() => focusEl.focus(), 80);
}

function setMessage(msg, tone = 'info') {
  if (!els.msg) return;
  els.msg.textContent = msg || '';
  els.msg.dataset.tone = msg ? tone : '';
}

function openAuth(view = null) {
  queryElements();
  const desired = view || (state.user ? 'profile' : 'signin');
  if (desired === 'profile' && !state.user) {
    showView('signin');
  } else {
    showView(desired);
  }
  if (els.modal) {
    els.modal.classList.add('open');
    els.modal.setAttribute('aria-hidden', 'false');
  }
}

function closeAuth() {
  if (els.modal) {
    els.modal.classList.remove('open');
    els.modal.setAttribute('aria-hidden', 'true');
  }
}

async function refreshAccount() {
  const user = await getUser();
  state.user = user;
  if (user) {
    await ensureProfile(user).catch(() => {});
    const [profile, membership] = await Promise.all([getProfile(), getMembership()]);
    state.profile = profile;
    state.membership = membership;
  } else {
    state.profile = null;
    state.membership = null;
  }
  applyStateToUI();
  if (state.readyResolve) {
    state.readyResolve();
    state.readyResolve = null;
  }
  document.dispatchEvent(new CustomEvent('ffauth:change', { detail: { ...state } }));
}

function applyStateToUI() {
  queryElements();
  updateHeaderButton();
  updateGatedElements();
  updateProfileView();
  document.body?.classList.toggle('is-authed', !!state.user);
  document.body?.classList.toggle(
    'is-member',
    isMembershipActive(state.membership, { profile: state.profile, user: state.user })
  );
  if (els.modal?.classList.contains('open')) {
    const currentView = els.modal.getAttribute('data-view');
    if (currentView === 'signin' && state.user) showView('profile');
  }
}

function updateHeaderButton() {
  if (!els.headerMembershipBtn) return;
  const btn = els.headerMembershipBtn;
  if (!btn.dataset.originalLabel) {
    btn.dataset.originalLabel = btn.textContent?.trim() || 'Membership';
  }
  if (!state.user) {
    btn.textContent = btn.dataset.originalLabel;
    btn.setAttribute('data-open-auth', 'signin');
  } else {
    const membershipActive = isMembershipActive(state.membership, { profile: state.profile, user: state.user });
    btn.textContent = membershipActive ? 'Members Area' : 'Account';
    btn.setAttribute('data-open-auth', 'profile');
  }
}

function updateGatedElements() {
  if (!els.gateBlocks?.length) return;
  els.gateBlocks.forEach((block) => {
    const requirement = (block.dataset.gated || 'auth').toLowerCase();
    let locked = false;
    if (requirement === 'member') {
      locked = !isMembershipActive(state.membership, { profile: state.profile, user: state.user });
    } else {
      locked = !state.user;
    }
    block.classList.toggle('is-gated', locked);
  });
}

function updateProfileView() {
  if (!els.profileEmail || !els.membershipSummary) return;
  if (!state.user) {
    els.profileEmail.textContent = 'Sign in to view your account.';
    els.membershipSummary.innerHTML = '';
    return;
  }
  const email = state.user.email || '';
  els.profileEmail.innerHTML = `Signed in as <strong>${escapeHtml(email)}</strong>`;
  const membershipActive = isMembershipActive(state.membership, { profile: state.profile, user: state.user });
  if (membershipActive) {
    const until = state.membership?.current_period_end
      ? new Date(state.membership.current_period_end).toLocaleString()
      : null;
    els.membershipSummary.innerHTML = `
      <div class="auth-membership-card success">
        <strong>Membership active</strong>
        <p>${until ? `Access through <span>${escapeHtml(until)}</span>.` : 'Your membership is currently active.'}</p>
      </div>`;
  } else {
    const statusLabel = state.membership?.status ? state.membership.status : 'inactive';
    els.membershipSummary.innerHTML = `
      <div class="auth-membership-card muted">
        <strong>No active membership</strong>
        <p>Status: <span>${escapeHtml(statusLabel)}</span>. Join to unlock member research.</p>
        <button class="btn primary" type="button" data-open-auth="signup">Join now</button>
      </div>`;
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

async function handleSignIn(event) {
  event.preventDefault();
  if (!els.signInEmail || !els.signInPassword) return;
  setMessage('Signing in…');
  const email = els.signInEmail.value.trim();
  const password = els.signInPassword.value;
  if (!email || !password) {
    setMessage('Enter your email and password.', 'error');
    return;
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    setMessage(`Error: ${error.message}`, 'error');
    return;
  }
  setMessage('Signed in.', 'success');
  await refreshAccount();
  showView('profile');
}

async function handleMagicLink(event) {
  event.preventDefault();
  if (!els.signInEmail) return;
  const email = els.signInEmail.value.trim();
  if (!email) {
    setMessage('Enter your email first.', 'error');
    return;
  }
  setMessage('Sending magic link…');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + '/login.html' }
  });
  if (error) {
    setMessage(`Error: ${error.message}`, 'error');
    return;
  }
  setMessage('Magic link sent — check your inbox.', 'success');
}

async function handleSignUp(event) {
  event.preventDefault();
  if (!els.signUpEmail || !els.signUpPassword) return;
  const email = els.signUpEmail.value.trim();
  const password = els.signUpPassword.value;
  if (!email || !password) {
    setMessage('Enter an email and password (min 6 characters).', 'error');
    return;
  }
  setMessage('Creating account…');
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin + '/login.html' }
  });
  if (error) {
    setMessage(`Error: ${error.message}`, 'error');
    return;
  }
  if (data?.user) await ensureProfile(data.user).catch(() => {});
  setMessage('Account created. Check your email to confirm your address.', 'success');
  showView('signin');
}

async function handleReset(event) {
  event.preventDefault();
  if (!els.resetEmail) return;
  const email = els.resetEmail.value.trim();
  if (!email) {
    setMessage('Enter your email first.', 'error');
    return;
  }
  setMessage('Sending reset email…');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/login.html'
  });
  if (error) {
    setMessage(`Error: ${error.message}`, 'error');
    return;
  }
  setMessage('Reset instructions sent — check your email.', 'success');
  showView('signin');
}

async function handleLogout(event) {
  event.preventDefault();
  await supabase.auth.signOut();
  setMessage('Signed out.', 'success');
  await refreshAccount();
  showView('signin');
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const openTrigger = event.target.closest('[data-open-auth]');
    if (openTrigger) {
      event.preventDefault();
      const view = openTrigger.getAttribute('data-open-auth');
      openAuth(view);
      return;
    }
    const closeTrigger = event.target.closest('[data-close-auth]');
    if (closeTrigger) {
      event.preventDefault();
      closeAuth();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.modal?.classList.contains('open')) {
      closeAuth();
    }
  });

  els.signInForm?.addEventListener('submit', handleSignIn);
  els.signUpForm?.addEventListener('submit', handleSignUp);
  els.resetForm?.addEventListener('submit', handleReset);
  els.magicLinkBtn?.addEventListener('click', handleMagicLink);
  els.logoutBtn?.addEventListener('click', handleLogout);

  els.views?.addEventListener('click', (event) => {
    const switcher = event.target.closest('[data-auth-switch]');
    if (!switcher) return;
    event.preventDefault();
    showView(switcher.getAttribute('data-auth-switch'));
  });
}

export function onAuthReady() {
  return state.readyPromise;
}

function normalizeRole(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeRole(item));
  }
  if (typeof value === 'object') {
    return Object.values(value).flatMap((item) => normalizeRole(item));
  }
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function profileHasRole(requiredRole) {
  const desired = (requiredRole || '').toString().trim().toLowerCase();
  if (!desired) return true;

  const profile = state.profile || {};
  const membership = state.membership || {};
  const userMeta = state.user?.app_metadata || {};
  const userClaims = state.user?.user_metadata || {};
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

  collect(userMeta.role);
  collect(userMeta.roles);
  collect(userMeta.access_level);
  collect(userMeta.permissions);

  collect(userClaims.role);
  collect(userClaims.roles);
  collect(userClaims.access_level);

  collect(membership.role);
  collect(membership.roles);
  collect(membership.access_level);
  collect(membership.plan);
  collect(membership.plan_name);

  if (desired === 'admin') {
    const elevated = ['admin', 'administrator', 'superadmin', 'owner', 'editor'];
    const flagSources = [profile, membership, userMeta, userClaims];
    const flagKeys = ['is_admin', 'admin', 'isAdmin', 'is_superadmin', 'superuser', 'staff', 'is_staff'];
    const hasFlag = flagSources.some((source) => flagKeys.some((key) => Boolean(source?.[key])));
    if (hasFlag) return true;
    if (normalizeRole(profile.role).some((role) => elevated.includes(role))) return true;
    if (normalizeRole(profile.roles).some((role) => elevated.includes(role))) return true;
    if (normalizeRole(userMeta.roles).some((role) => elevated.includes(role))) return true;
    if (normalizeRole(userClaims.roles).some((role) => elevated.includes(role))) return true;
    if (normalizeRole(membership.roles).some((role) => elevated.includes(role))) return true;
  }

  return buckets.has(desired);
}

export function hasRole(role = null) {
  if (!role) return true;
  if (!state.user) return false;
  return profileHasRole(role);
}

export async function requireRole(role = null) {
  await onAuthReady();
  if (!state.user) {
    openAuth('signin');
    const err = new Error('Not signed in');
    err.code = 'auth/not-signed-in';
    throw err;
  }
  if (role) {
    const desired = role.toString().trim().toLowerCase();
    if (!hasRole(desired)) {
      const err = new Error('Not authorized');
      err.code = 'auth/not-authorized';
      throw err;
    }
  }
  return state.user;
}

export function getAccountState() {
  return {
    user: state.user,
    profile: state.profile,
    membership: state.membership,
  };
}

export async function refreshAuthState() {
  await refreshAccount();
}

supabase.auth.onAuthStateChange(() => {
  refreshAccount();
});

document.addEventListener('DOMContentLoaded', async () => {
  queryElements();
  bindEvents();
  await refreshAccount();
  document.dispatchEvent(new Event('ffauth:ready'));
});

window.ffAuth = {
  openAuth,
  closeAuth,
  onReady: onAuthReady,
  requireRole,
  getAccount: getAccountState,
  refresh: refreshAuthState,
  supabase,
};
