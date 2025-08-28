// DEV MODES (toggle in the console while building)
window.__DEV__ = {
  forcePatron: false,   // set true to simulate Patreon access
  forceLicense: false,  // set true to simulate valid purchase/license
  forceSubscriber: false // set true to simulate free-subscriber access
};

/** Gatekeeper for a tool */
async function gateToolAccess(t){
  if (t.visibility==='hidden' || t.comingSoon) {
    return {allowed:false, html:'<p>Coming soon.</p>'};
  }
  if (t.access==='free') return {allowed:true};

  // Simulated dev unlocks
  if (window.__DEV__.forcePatron && t.access==='patreon') return {allowed:true};
  if (window.__DEV__.forceLicense && t.access==='paid') return {allowed:true};

  // Real checks (when wired):
  if (t.access==='patreon') {
    const ok = await checkPatreonTier(t.patreon?.minCents || 100);
    if (ok) return {allowed:true};
    return {allowed:false, html:lockedPatreonHTML(t)};
  }
  if (t.access==='paid') {
    const ok = await verifyLicenseForTool(t.license?.provider, t.license?.sku);
    if (ok) return {allowed:true};
    return {allowed:false, html:lockedPaidHTML(t)};
  }
  return {allowed:false, html:'<p>Locked.</p>'};
}

function lockedPatreonHTML(t){
  return `
    <h1>${t.title}</h1>
    <p class="muted">${t.subtitle||''}</p>
    <div class="chips"><span class="chip patreon">Patreon</span></div>
    <p>This tool unlocks for active patrons${t.patreon?.minCents?` (≥ ${(t.patreon.minCents/100).toFixed(0)} ${t.patreon.currency||'USD'}/mo)`:''}.</p>
    <p><a class="btn primary" id="connectPatreon">Connect Patreon</a>
       <a class="btn" href="/tools.html">Back to tools</a></p>
    <div class="note-box"><strong>Alternative:</strong> Included after 24 months on Patreon—email us to unlock.</div>
    <script>document.getElementById('connectPatreon').onclick=()=>startPatreonOAuth();</script>
  `;
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

/* ---- Patreon: login + check (via serverless) ---- */
function startPatreonOAuth(){ window.location.href = '/api/patreon/login'; }
async function checkPatreonTier(minCents){
  try{
    const r = await fetch('/api/patreon/me',{credentials:'include'});
    if(!r.ok) return false;
    const j = await r.json();
    return !!(j.ok && (!minCents || (j.amount_cents||0)>=minCents));
  }catch(_){ return false; }
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

/* header buttons */
document.addEventListener('DOMContentLoaded',()=>{
  const pat = document.getElementById('patreonLogin');
  if (pat) pat.onclick = (e)=>{ e.preventDefault(); startPatreonOAuth(); };
});

/* ==================================================
   NEW: Portfolio gating (public | subscriber | patreon)
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
  if (window.__DEV__.forcePatron && access === 'patreon') return { allowed:true };

  if (access === 'subscriber'){
    return {
      allowed:false,
      reason:'Free subscription required',
      ctaHTML:'<a class="btn primary" href="#" onclick="alert(\'Coming soon: free signup\')">Subscribe free</a> <a class="btn" href="/portfolio.html">Back</a>'
    };
  }

  if (access === 'patreon'){
    const ok = await checkPatreonTier(100); // default $1+
    if (ok) return { allowed:true };
    return {
      allowed:false,
      reason:'Patreon membership required',
      ctaHTML:'<a class="btn primary" href="/api/patreon/login">Connect Patreon</a> <a class="btn" href="/portfolio.html">Back</a>'
    };
  }

  return { allowed:false, reason:'Locked', ctaHTML:'<a class="btn" href="/portfolio.html">Back</a>' };
}
