// ---- Footer year (works with either #year or #yr) ----
(function setYear(){
  const el = document.getElementById('year') || document.getElementById('yr');
  if (el) el.textContent = new Date().getFullYear();
})();

// ---- Interactive click-through stepper ----
(function stepper(){
  const stepData = [
    {t:'Start with the entire market',p:'We consider every listed company globally. No early bias, no blind spots by design.'},
    {t:'Initial risk assessment',p:'AI risk screen excludes what doesn\'t meet baseline quality, liquidity, or red-flag checks.'},
    {t:'Assign the right analysis',p:'Different businesses need different lenses. Our Strategy AI routes each stock to the most fitting research track.'},
    {t:'Deep research → outputs',p:'We publish an article and store structured signals/metrics in the Universe database.'},
    {t:'Smart Watchlist',p:'Continuous tracking flags when price/action/fundamentals make a name “interesting” again.'},
    {t:'Portfolio AI managers',p:'Multiple styles (quality, value, momentum) select from the Universe and watchlist to run live experiments.'}
  ];

  const rail = document.getElementById('rail');
  if (!rail) return; // safe exit if markup is missing

  const fill    = document.getElementById('railFill');
  const nodes   = [...rail.querySelectorAll('.node')];
  const titleEl = document.getElementById('stepTitle');
  const textEl  = document.getElementById('stepText');
  const kickEl  = document.getElementById('kicker');
  const prevBtn = document.getElementById('prevStep');
  const nextBtn = document.getElementById('nextStep');

  let current = 0;

  function setStep(i, scroll=true){
    current = Math.max(0, Math.min(stepData.length - 1, i));
    nodes.forEach((n, idx) => {
      const active = idx <= current;
      n.classList.toggle('active', active);
      n.setAttribute('aria-current', idx === current ? 'step' : 'false');
    });
    titleEl.textContent = stepData[current].t;
    textEl.textContent  = stepData[current].p;
    kickEl.textContent  = `STEP ${current+1}`;

    const firstTop = nodes[0].offsetTop;
    const last     = nodes[current];
    const mid      = last.offsetTop - firstTop + last.offsetHeight/2;
    fill.style.height = `${mid}px`;

    if (scroll) last.scrollIntoView({behavior:'smooth', block:'center'});
    prevBtn.disabled = current === 0;
    nextBtn.textContent = current === stepData.length - 1 ? 'Done' : 'Next';
  }

  nodes.forEach((n, idx) => n.addEventListener('click', () => setStep(idx)));
  prevBtn.addEventListener('click', () => setStep(current - 1));
  nextBtn.addEventListener('click', () => {
    if (current === stepData.length - 1) {
      document.getElementById('north-star')?.scrollIntoView({behavior:'smooth'});
    } else {
      setStep(current + 1);
    }
  });

  // initial render + resize sync
  setTimeout(() => setStep(0, false), 0);
  window.addEventListener('resize', () => setStep(current, false));
})();

// ---- Mini sparkline (demo data) ----
(function drawSpark(){
  const c = document.getElementById('spark');
  if (!c) return;

  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);

  // demo points
  const n = 32; const pts = []; let v = 60;
  for (let i = 0; i < n; i++) { v += (Math.random()*10 - 5); v = Math.max(5, Math.min(100, v)); pts.push(v); }

  const pad = 12; const xStep = (W - 2*pad) / (n - 1);
  const min = Math.min(...pts), max = Math.max(...pts);
  const y = (val) => H - pad - ((val - min) / (max - min || 1)) * (H - 2*pad);

  // grid line
  const css = getComputedStyle(document.documentElement);
  ctx.strokeStyle = css.getPropertyValue('--border')?.trim() || '#1a2147';
  ctx.lineWidth = 1; ctx.globalAlpha = .8;
  ctx.beginPath(); ctx.moveTo(pad, H - pad); ctx.lineTo(W - pad, H - pad); ctx.stroke();

  // path
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(pad, y(pts[0]));
  for (let i=1; i<n; i++) ctx.lineTo(pad + i * xStep, y(pts[i]));
  ctx.strokeStyle = css.getPropertyValue('--accent')?.trim() || '#5af';
  ctx.lineWidth = 2; ctx.stroke();

  // fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, css.getPropertyValue('--accent')?.trim() || '#5af');
  grad.addColorStop(1, 'transparent');
  ctx.lineTo(W - pad, H - pad); ctx.lineTo(pad, H - pad); ctx.closePath();
  ctx.fillStyle = grad; ctx.globalAlpha = .2; ctx.fill();
})();

// ---- Demo counters (replace with real fetches later) ----
(function counters(){
  const demo = { universe: 42031, pass: '18%', pings: 127, articles: 311 };
  const setText = (sel, val) => { const el = document.querySelector(sel); if (el) el.textContent = val; };
  setText('#badge-universe', demo.universe.toLocaleString());
  setText('#badge-pass', demo.pass);
  setText('#badge-pings', String(demo.pings));
  setText('#badge-articles', String(demo.articles));
})();
