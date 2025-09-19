// DEV MODES (toggle in the console while building)
window.__DEV__ = {
  forcePatron: false,    // simulate Patreon access
  forceLicense: false,   // simulate valid purchase/license
  forceSubscriber: false // simulate free-subscriber access
};

/** Gatekeeper for a tool */
async function gateToolAccess(t){
  if (t.visibility==='hidden' || t.comingSoon) {
    return {allowed:false, html:'<p>Coming soon.</p>'};
  }
  if (t.access==='free') return {allowed:true};

  const accessType = t.access || 'free';

  // Simulated dev unlocks
  if (window.__DEV__.forcePatron && (accessType==='patreon' || accessType==='member')) return {allowed:true};
  if (window.__DEV__.forceLicense && t.access==='paid') return {allowed:true};

  // Real checks (when wired):
  if (accessType==='patreon' || accessType==='member') {
    const gate = await ensureMemberAccess({
      title: t.title,
      subtitle: t.subtitle,
      backHref: '/tools.html'
    });
    if (gate.allowed) return { allowed:true };
    return { allowed:false, html: gate.html };
  }
  if (t.access==='paid') {
    const ok = await verifyLicenseForTool(t.license?.provider, t.license?.sku);
    if (ok) return {allowed:true};
    return {allowed:false, html:lockedPaidHTML(t)};
  }
  return {allowed:false, html:'<p>Locked.</p>'};
}

function lockedPaidHTML(t){
  const price = t.price || '';
  const buyBtn = t.checkout?.url
    ? `<a class="btn primary" href="${t.checkout.url}" target="_blank" rel="noopener">Buy ${price}</a>`
    : '';
  return `
    <h1>${t.title}</h1>
    <p class="muted">${t.subtitle||''}</p>
    <div class="chips"><span class="chip paid">Paid</span></div>
    <p>Purchase to unlock. ${price?`Price: ${price}.`:''}</p>
    <p>${buyBtn} <a class="btn" href="/tools.html">Back to tools</a></p>
    <div class="note-box">Already purchased? Paste your license key:
      <p><input id="licenseKey" placeholder="XXXX-XXXX-XXXX-XXXX" /> <button class="btn" id="licenseBtn">Verify</button></p>
    </div>
    <script>
      document.getElementById('licenseBtn').onclick = async ()=>{
        const key = document.getElementById('licenseKey').value.trim();
        const ok = await verifyLicenseForTool('${t.license?.provider||''}','${t.license?.sku||''}', key);
        if (ok) location.reload(); else alert('License not valid for this tool.');
      };
    </script>
  `;
}

/* ---- Supabase membership helpers ---- */
async function ensureMemberAccess(context={}){
  if (window.__DEV__.forcePatron) return { allowed:true };
  if (!window.ffAuth) {
    await waitForAuthReady();
  }
  const auth = window.ffAuth || {};
  if (typeof auth.onReady === 'function') {
    try { await auth.onReady(); } catch(_) {}
  }
  const account = (typeof auth.getAccount === 'function') ? auth.getAccount() : null;
  const user = account?.user || null;
  const membership = account?.membership || null;
  if (user && membershipIsActive(membership)) {
    return { allowed:true };
  }
  const signedIn = !!user;
  return {
    allowed:false,
    html: membershipLockedHTML({ ...context, signedIn })
  };
}

function membershipIsActive(record){
  if (!record) return false;
  const status = (record.status || '').toLowerCase();
  if (status && status !== 'active') return false;
  if (record.current_period_end){
    const expiry = new Date(record.current_period_end).getTime();
    if (!Number.isNaN(expiry) && expiry < Date.now()) return false;
  }
  return true;
}

function membershipLockedHTML({ title, subtitle, backHref, signedIn }){
  const heading = title ? `<h1>${escapeHtml(title)}</h1>` : '<h1>Members only</h1>';
  const sub = subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : '';
  const status = signedIn
    ? 'Your account is signed in but does not have an active membership yet.'
    : 'Sign in or join the membership to unlock this content.';
  const backLink = backHref ? ` <a class="btn" href="${escapeHtml(backHref)}">Back</a>` : '';
  const openView = signedIn ? 'profile' : 'signin';
  return `
    ${heading}
    ${sub}
    <div class="chips"><span class="chip patreon">Membership</span></div>
    <p>${status}</p>
    <p><button class="btn primary" data-open-auth="${openView}">Open account</button>${backLink}</p>
    <div class="note-box"><strong>Need help?</strong> Email <a href="mailto:support@futurefunds.ai">support@futurefunds.ai</a> and we’ll get you sorted.</div>
  `;
}

function escapeHtml(str){
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

async function waitForAuthReady(){
  if (window.ffAuth) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1200);
    document.addEventListener('ffauth:ready', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/* ---- Paid licenses: Lemon Squeezy / Gumroad / Stripe ---- */
async function verifyLicenseForTool(provider, sku, key){
  if (window.__DEV__.forceLicense) return true;
  if (!key) return false;
  try{
    const r = await fetch('/api/license/verify', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ provider, sku, key })
    });
    const j = await r.json();
    if (j.ok){ localStorage.setItem(`license:${sku}`, key); return true; }
  }catch(_){}
  return !!localStorage.getItem(`license:${sku}`);
}

/* ==================================================
   Portfolio gating (public | subscriber | patreon)
   ================================================== */
async function gatePortfolioAccess(p){
  if (!p) return { allowed:false, reason:'Unknown portfolio', ctaHTML:'<a class="btn" href="/portfolio.html">Back</a>' };
  if (p.comingSoon) {
    return { allowed:false, reason:'Coming soon', ctaHTML:'<a class="btn" href="/portfolio.html">Back</a>' };
  }

  const access = p.access || 'public';
  if (access === 'public') return { allowed:true };

  // Dev overrides
  if (window.__DEV__.forceSubscriber && access === 'subscriber') return { allowed:true };
  if (window.__DEV__.forcePatron && (access === 'patreon' || access === 'member')) return { allowed:true };

  if (access === 'subscriber'){
    return {
      allowed:false,
      reason:'Free subscription required',
      ctaHTML:'<a class="btn primary" href="#" onclick="alert(\'Coming soon: free signup\')">Subscribe free</a> <a class="btn" href="/portfolio.html">Back</a>'
    };
  }

  if (access === 'patreon' || access === 'member'){
    const gate = await ensureMemberAccess({
      title: p.title,
      subtitle: p.summary || 'Members unlock full portfolio details.',
      backHref: '/portfolio.html'
    });
    if (gate.allowed) return { allowed:true };
    return {
      allowed:false,
      reason:'Membership required',
      html: gate.html
    };
  }

  return { allowed:false, reason:'Locked', ctaHTML:'<a class="btn" href="/portfolio.html">Back</a>' };
}
