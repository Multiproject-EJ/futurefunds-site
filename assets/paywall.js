// DEV MODES (toggle in the console while building)
window.__DEV__ = {
  forcePatron: false,   // set true to simulate Patreon access
  forceLicense: false   // set true to simulate valid purchase/license
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

/* ---- Patreon: login + check (via serverless) ----
   You’ll deploy two endpoints on Cloudflare Workers:
   - GET /api/patreon/login   -> redirects to Patreon OAuth
   - GET /api/patreon/cb      -> handles callback, sets a session cookie
   - GET /api/patreon/me      -> returns { ok: boolean, amount_cents: number } for this user
   Docs: OAuth + membership verification via Patreon v2 API. :contentReference[oaicite:1]{index=1}
*/
function startPatreonOAuth(){ window.location.href = '/api/patreon/login'; }
async function checkPatreonTier(minCents){
  try{
    const r = await fetch('/api/patreon/me',{credentials:'include'});
    if(!r.ok) return false;
    const j = await r.json();
    return !!(j.ok && (!minCents || (j.amount_cents||0)>=minCents));
  }catch(_){ return false; }
}

/* ---- Paid licenses: Lemon Squeezy / Gumroad / Stripe ----
   We verify licenses server-side and only then unlock the tool.
   Lemon Squeezy and Gumroad both provide license key verification APIs. :contentReference[oaicite:2]{index=2}
*/
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
  // fallback to any previously verified key in localStorage (optional)
  return !!localStorage.getItem(`license:${sku}`);
}

/* header buttons */
document.addEventListener('DOMContentLoaded',()=>{
  const pat = document.getElementById('patreonLogin');
  if (pat) pat.onclick = (e)=>{ e.preventDefault(); startPatreonOAuth(); };
});
