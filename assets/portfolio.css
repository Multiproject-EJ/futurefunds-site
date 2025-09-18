// Simple demo data generator + page wiring for Portfolio cards & modal.
// Uses theme tokens (CSS variables) for chart colors so it fits light/dark.

(function(){
  const portfolios = [
    mkPortfolio('quality-core', 'Quality Core', 'Live'),
    mkPortfolio('value-explorer', 'Value Explorer', 'Live'),
    mkPortfolio('momentum-pulse', 'Momentum Pulse', 'Experimental'),
    mkPortfolio('global-moat', 'Global Moat', 'Live'),
    mkPortfolio('tech-growth', 'Tech Growth', 'Experimental'),
    mkPortfolio('income-shield', 'Income Shield', 'Live'),
  ];

  function mkPortfolio(id, name, status){
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
    return { id, name, status, series, kpis: {return: ret, dd, vol, sharpe: sh}, holdings };
  }

  // Helpers
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const getCssVal = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Draw simple line chart
  function drawLine(canvas, values){
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr,dpr);

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

  // Render cards
  function hydrateCards(){
    portfolios.forEach(p=>{
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
      const open = () => openModal(p.id);
      card.addEventListener('click', open);
      card.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' ') { e.preventDefault(); open(); }});
    });
  }

  // Modal wiring
  const modal = document.getElementById('pfModal');
  const bigChart = document.getElementById('pfBigChart');
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
      }, 20);
    });
  }

  // init
  window.addEventListener('DOMContentLoaded', hydrateCards);
})();
