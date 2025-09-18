// /assets/auth.js
import { supabase, getUser, getProfile } from './supabase.js';

const els = {
  authModal: null,
  authForm: null,
  authEmail: null,
  authMsg: null,
  openers: null,
  closers: null,
  gateBlocks: null,
  headerMembershipBtn: null,
};

function qs(s, root=document){ return root.querySelector(s); }
function qsa(s, root=document){ return [...root.querySelectorAll(s)]; }

async function refreshUI() {
  const user = await getUser();
  const isAuthed = !!user;

  // Gating: show overlay on any [data-gated] when not authed
  els.gateBlocks.forEach(block => {
    block.classList.toggle('is-gated', !isAuthed);
  });

  // Header button behavior
  if (els.headerMembershipBtn) {
    els.headerMembershipBtn.onclick = (e) => {
      e.preventDefault();
      if (!isAuthed) openAuth();
      else window.location.href = '/membership.html'; // or a profile page
    };
  }
}

function openAuth(){ els.authModal?.classList.add('open'); els.authEmail?.focus(); }
function closeAuth(){ els.authModal?.classList.remove('open'); }

async function sendMagicLink(e){
  e.preventDefault();
  const email = els.authEmail.value.trim();
  if (!email) return;
  els.authMsg.textContent = 'Sending magic link…';
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
  els.authMsg.textContent = error ? ('Error: ' + error.message) : 'Check your email for a sign-in link.';
  if (!error) els.authForm.reset();
}

// auth state → refreshUI
supabase.auth.onAuthStateChange(async () => { await refreshUI(); });

document.addEventListener('DOMContentLoaded', async () => {
  els.authModal = qs('#authModal');
  els.authForm  = qs('#authForm');
  els.authEmail = qs('#authEmail');
  els.authMsg   = qs('#authMsg');
  els.openers   = qsa('[data-open-auth]');
  els.closers   = qsa('[data-close-auth]');
  els.gateBlocks = qsa('[data-gated]');
  els.headerMembershipBtn = qs('#patreonLogin') || qs('#membershipBtn');

  els.openers.forEach(b => b.addEventListener('click', (e)=>{ e.preventDefault(); openAuth(); }));
  els.closers.forEach(b => b.addEventListener('click', (e)=>{ e.preventDefault(); closeAuth(); }));
  els.authForm?.addEventListener('submit', sendMagicLink);

  await refreshUI();
});
