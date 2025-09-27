// Simple demo data generator + page wiring for Portfolio cards & modal.
// Uses theme tokens (CSS variables) for chart colors so it fits light/dark.

(function(){
  const defaultNotes = [
    'Strategy insights placeholder — AI monitoring keeps rebalancing disciplined.',
    'Risk guardrails watch drawdowns and volatility while sizing positions.',
    'Expect ongoing tuning as datasets expand and new signals ship.'
  ];

  const portfolios = [
    mkPortfolio('quality-core', 'Quality Core', 'Live'),
    mkPortfolio('value-explorer', 'Value Explorer', 'Live'),
    mkPortfolio('momentum-pulse', 'Momentum Pulse', 'Experimental'),
    mkPortfolio('global-moat', 'Global Moat', 'Live'),
    mkPortfolio('tech-growth', 'Tech Growth', 'Experimental'),
    mkPortfolio('income-shield', 'Income Shield', 'Live'),
    mkPortfolio('insurance', 'Insurance', 'Live', {
      notes: [
        `(why - its needed because the world is a scary place, then combined with the idea that chance, will yield and destroy, and ist like mine swiper, but you dont have to play, you can open the entire play all at once (owning it all), and so its important that the the whole, of it, is represented , - i guess after an initial survival phase, and "hype" products, can either transform of die. Har to know, but not too many hypes should be ipo'ed`
      ]
    }),
    mkPortfolio('food-pleasure', "Food — it's a pleasurable thing", 'Experimental'),
    mkPortfolio('tech-health-tech', 'Tech & Health Tech', 'Experimental'),
  ];

  const access = {
    isMember: false,
    isSignedIn: false,
  };

  function mkPortfolio(id, name, status, options = {}){
    // demo series
    const n = 60;
    let v = 100; const series = [];
    for(let i=0;i<n;i++){ v += (Math.random()*4-2); series.push(Math.max(80, Math.min(140, v))); }

    // random facts
    const ret = (Math.random()*20-2).toFixed(1) + '%';
    const dd  = '-' + (10+Math.random()*10|0) + '%';
    const vol = (10+Math.random()*10|0) + '%';
    const sh  = (0.3+Math.random()*1.2).toFixed(2);

    // mock holdings
    const tickers = ['AAPL','MSFT','NVDA','AMZN','GOOGL','META','UNH','XOM','V','MA','JPM','AVGO','TSLA','KO','PEP'];
    const holdings = Array.from({length: 10 + (Math.random()*10|0)}, (_,i)=>{
      const t = tickers[(Math.random()*tickers.length)|0];
      return {
        ticker: t,
        name: t + ' Corp.',
        weight: (2 + Math.random()*8).toFixed(1)+'%',
        entry: '$' + (80 + Math.random()*200|0),
        pl: ((Math.random()*20-10).toFixed(1))+'%',
        notes: (Math.random()>.7 ? 'Earnings soon' : '')
      };
    });
    const notes = Array.isArray(options.notes) && options.notes.length ? options.notes : defaultNotes;
    return { id, name, status, series, kpis: {return: ret, dd, vol, sharpe: sh}, holdings, notes: [...notes] };
  }

  // Helpers
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const getCssVal = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const combinedSeries = computeCombinedSeries();

  function computeCombinedSeries(){
    if (!portfolios.length) return [];
    const longest = Math.max(...portfolios.map(p => p.series.length));
    return Array.from({ length: longest }, (_, idx) => {
      let total = 0;
      let count = 0;
      portfolios.forEach(portfolio => {
        if (idx < portfolio.series.length) {
          total += portfolio.series[idx];
          count += 1;
        }
      });
      return count ? total / count : 0;
    });
  }

  // Draw simple line chart
  function drawLine(canvas, values){
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr,dpr);

    if (!values || !values.length) {
      ctx.clearRect(0, 0, W, H);
      return;
    }

    const pad = 10;
    const min = Math.min(...values), max = Math.max(...values);
    const xStep = (W - 2*pad) / (values.length - 1 || 1);
    const y = v => H - pad - ((v - min) / (max - min || 1)) * (H - 2*pad);

    // grid baseline
    ctx.strokeStyle = getCssVal('--line') || '#e6e9ee';
    ctx.globalAlpha = .9; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, H-pad); ctx.lineTo(W-pad, H-pad); ctx.stroke();

    // line
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(pad, y(values[0]));
    for(let i=1;i<values.length;i++) ctx.lineTo(pad + i*xStep, y(values[i]));
    ctx.strokeStyle = getCssVal('--accent') || '#1a73e8';
    ctx.lineWidth = 2; ctx.stroke();

    // subtle fill
    const grad = ctx.createLinearGradient(0,0,0,H);
    grad.addColorStop(0, getCssVal('--accent') || '#1a73e8');
    grad.addColorStop(1, 'transparent');
    ctx.lineTo(W-pad, H-pad); ctx.lineTo(pad, H-pad); ctx.closePath();
    ctx.globalAlpha = .15; ctx.fillStyle = grad; ctx.fill();
  }

  function drawOverview(){
    if (!overviewChart) return;
    drawLine(overviewChart, combinedSeries);
  }

  // Render cards
  function hydrateCards(){
    portfolios.forEach((p, index)=>{
      const card = document.querySelector(`.p-card[data-id="${p.id}"]`);
      if(!card) return;

      // KPIs
      card.querySelectorAll('.kpi').forEach(el=>{
        const which = el.getAttribute('data-kpi');
        el.textContent = p.kpis[which];
      });

      // Preview holdings (first 3)
      const tbody = card.querySelector('table.preview tbody');
      tbody.innerHTML = p.holdings.slice(0,3).map(h=>(
        `<tr><td>${h.ticker}</td><td>${h.weight}</td><td>${h.pl}</td></tr>`
      )).join('');

      // Mini chart
      const c = card.querySelector('.mini-chart');
      drawLine(c, p.series);

      // open modal on click / Enter
      const open = () => {
        if (!isUnlocked(index)) {
          promptMembership();
          return;
        }
        openModal(p.id);
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' ') { e.preventDefault(); open(); }});
    });
  }

  // Modal wiring
  const modal = document.getElementById('pfModal');
  const bigChart = document.getElementById('pfBigChart');
  const overviewChart = document.getElementById('portfolioCombinedChart');
  const notesList = document.getElementById('pfNotes');
  const body = document.body;

  function openModal(id){
    const p = portfolios.find(x=>x.id===id);
    if(!p) return;

    modal.querySelector('#pfTitle').textContent = p.name;
    const badge = modal.querySelector('#pfBadge');
    badge.textContent = p.status;
    badge.className = 'pill ' + (p.status.toLowerCase()==='live' ? 'live' : 'experimental');

    modal.querySelector('#pfRet').textContent = p.kpis.return;
    modal.querySelector('#pfDD').textContent  = p.kpis.dd;
    modal.querySelector('#pfVol').textContent = p.kpis.vol;
    modal.querySelector('#pfSharpe').textContent = p.kpis.sharpe;

    // table
    const tb = modal.querySelector('#pfTbody');
    tb.innerHTML = p.holdings.map(h=>(
      `<tr>
        <td>${h.ticker}</td>
        <td>${h.name}</td>
        <td>${h.weight}</td>
        <td>${h.entry}</td>
        <td>${h.pl}</td>
        <td>${h.notes}</td>
      </tr>`
    )).join('');

    if (notesList) {
      const items = Array.isArray(p.notes) && p.notes.length ? p.notes : defaultNotes;
      notesList.innerHTML = items.map(note => `<li>${note}</li>`).join('');
    }

    drawLine(bigChart, p.series);

    modal.classList.add('active');
    modal.setAttribute('aria-hidden','false');
    body.style.overflow = 'hidden';
  }

  function closeModal(){
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden','true');
    body.style.overflow = '';
  }

  modal.addEventListener('click', e=>{
    if(e.target.matches('[data-close]') || e.target.classList.contains('pf-backdrop')) closeModal();
  });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape' && modal.classList.contains('active')) closeModal(); });

  // Redraw charts on resize or theme toggle (if present)
  window.addEventListener('resize', ()=>{
    $$('.mini-chart').forEach((c,i)=> drawLine(c, portfolios[i].series));
    if(modal.classList.contains('active')){
      const id = modal.querySelector('#pfTitle').textContent;
      const p = portfolios.find(x=>x.name===id);
      if(p) drawLine(bigChart, p.series);
    }
    drawOverview();
  });
  const themeBtn = document.getElementById('themeToggle');
  if(themeBtn){
    themeBtn.addEventListener('click', ()=>{
      // Give global script a tick to toggle classes, then redraw
      setTimeout(()=>{
        $$('.mini-chart').forEach((c,i)=> drawLine(c, portfolios[i].series));
        if(modal.classList.contains('active')){
          const id = modal.querySelector('#pfTitle').textContent;
          const p = portfolios.find(x=>x.name===id);
          if(p) drawLine(bigChart, p.series);
        }
        drawOverview();
      }, 20);
    });
  }

  function membershipIsActive(record, account){
    if(record){
      const status = (record.status || '').toLowerCase();
      if (status && status !== 'active') return accountHasAdminRole(account);
      if (record.current_period_end){
        const expiry = new Date(record.current_period_end).getTime();
        if (!Number.isNaN(expiry) && expiry < Date.now()) return accountHasAdminRole(account);
      }
      return true;
    }
    return accountHasAdminRole(account);
  }

  function normalizeRole(value){
    if (value == null) return [];
    if (Array.isArray(value)) return value.flatMap((entry)=>normalizeRole(entry));
    if (typeof value === 'object') return Object.values(value).flatMap((entry)=>normalizeRole(entry));
    return String(value ?? '')
      .split(/[\s,]+/)
      .map((part)=>part.trim().toLowerCase())
      .filter(Boolean);
  }

  function accountHasAdminRole(account){
    if (!account) return false;
    const profile = account.profile || {};
    const membership = account.membership || {};
    const user = account.user || {};
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

    collect(appMeta.role);
    collect(appMeta.roles);
    collect(appMeta.access_level);
    collect(appMeta.permissions);

    collect(userMeta.role);
    collect(userMeta.roles);
    collect(userMeta.access_level);

    collect(membership.role);
    collect(membership.roles);
    collect(membership.access_level);
    collect(membership.plan);
    collect(membership.plan_name);

    const flagSources = [profile, membership, appMeta, userMeta];
    const flagKeys = ['is_admin', 'admin', 'isAdmin', 'is_superadmin', 'superuser', 'staff', 'is_staff'];
    if (flagSources.some((source) => flagKeys.some((key) => Boolean(source?.[key])))) {
      return true;
    }

    const elevated = new Set(['admin', 'administrator', 'superadmin', 'owner', 'editor', 'staff']);
    for (const role of buckets) {
      if (role === 'admin' || elevated.has(role)) {
        return true;
      }
    }
    return false;
  }

  function computeVisibleCount(){
    if (access.isMember) return portfolios.length;
    if (!portfolios.length) return 0;
    const raw = Math.ceil(portfolios.length * 0.2);
    return Math.min(portfolios.length, Math.max(1, raw));
  }

  function isUnlocked(index){
    return index < computeVisibleCount() || access.isMember;
  }

  function applyAccess(){
    const visibleCount = computeVisibleCount();
    portfolios.forEach((p, idx) => {
      const card = document.querySelector(`.p-card[data-id="${p.id}"]`);
      if (!card) return;
      const locked = !access.isMember && idx >= visibleCount;
      card.hidden = locked;
      card.dataset.locked = locked ? 'true' : 'false';
      card.tabIndex = locked ? -1 : 0;
      if (locked) card.setAttribute('aria-hidden', 'true');
      else card.removeAttribute('aria-hidden');
    });
    updatePaywallCard(visibleCount);
  }

  function updatePaywallCard(visibleCount){
    const paywall = document.getElementById('portfolioPaywall');
    if (!paywall) return;
    const lockedCount = access.isMember ? 0 : Math.max(0, portfolios.length - visibleCount);
    if (!lockedCount) {
      paywall.hidden = true;
      return;
    }
    paywall.hidden = false;
    const msgEl = document.getElementById('portfolioPaywallMsg');
    if (msgEl) {
      const label = lockedCount === 1 ? 'one more portfolio' : `${lockedCount} more portfolios`;
      msgEl.textContent = access.isSignedIn
        ? `Your account is signed in but needs an active membership to unlock ${label}.`
        : `Join FutureFunds.ai to unlock ${label}.`;
    }
    const previewEl = document.getElementById('portfolioPaywallPreview');
    if (previewEl) {
      previewEl.textContent = `Preview shows ${visibleCount} of ${portfolios.length} portfolios.`;
    }
    const secondary = paywall.querySelector('[data-lock-secondary]');
    if (secondary) {
      secondary.textContent = access.isSignedIn ? 'Manage account' : 'Sign in';
      secondary.setAttribute('data-open-auth', access.isSignedIn ? 'profile' : 'signin');
    }
  }

  function updateAccessFromAccount(payload = {}){
    const account = payload && (payload.user !== undefined || payload.membership !== undefined)
      ? payload
      : payload.detail || {};
    const membership = account?.membership || null;
    const isMember = membershipIsActive(membership, account);
    const isSignedIn = !!account?.user;
    const changed = isMember !== access.isMember || isSignedIn !== access.isSignedIn;
    access.isMember = isMember;
    access.isSignedIn = isSignedIn;
    if (changed) applyAccess();
  }

  function initAccessWatcher(){
    const readCurrent = () => {
      if (window.ffAuth && typeof window.ffAuth.getAccount === 'function') {
        updateAccessFromAccount(window.ffAuth.getAccount());
      } else {
        updateAccessFromAccount({});
      }
    };

    if (window.ffAuth && typeof window.ffAuth.onReady === 'function') {
      window.ffAuth.onReady().then(readCurrent).catch(readCurrent);
    } else {
      document.addEventListener('ffauth:ready', readCurrent, { once: true });
      setTimeout(readCurrent, 1200);
    }

    document.addEventListener('ffauth:change', (event) => {
      updateAccessFromAccount(event.detail || {});
    });

    readCurrent();
  }

  function promptMembership(){
    if (window.ffAuth && typeof window.ffAuth.openAuth === 'function') {
      const view = access.isSignedIn ? 'profile' : 'signup';
      window.ffAuth.openAuth(view);
    } else {
      location.href = '/membership.html';
    }
  }

  // init
  window.addEventListener('DOMContentLoaded', () => {
    hydrateCards();
    drawOverview();
    applyAccess();
    initAccessWatcher();
  });
})();
