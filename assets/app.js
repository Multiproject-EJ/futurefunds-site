/* ======= Tiny utilities ======= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const fmt = {
  pct: n => (n == null ? '—' : ((n > 0 ? '+' : '') + (n * 100).toFixed(1) + '%')),
  date: iso => (iso ? new Date(iso).toLocaleDateString() : '—')
};

document.addEventListener('DOMContentLoaded', () => {
  ensureFavicon();
  initResponsiveNav();
  initNewsletterCapture();
  const y = $('#year'); if (y) y.textContent = new Date().getFullYear();
  renderToolsIndex();
  renderToolDetail();
  renderPortfoliosHub();
  renderStrategyDetail();
});

function ensureFavicon() {
  const head = document.head;
  if (!head) return;
  const existing = head.querySelector('link[rel="icon"][href*="logo.webp"]');
  if (existing) return;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/webp';
  link.href = '/images/logo.webp';
  head.appendChild(link);
}

function initResponsiveNav() {
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('siteNav') || document.querySelector('.site-header .nav');
  if (!toggle || !nav) return;

  const closeMenu = () => {
    if (!nav.classList.contains('open')) return;
    nav.classList.remove('open');
    document.body.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.setAttribute('aria-expanded', 'false');

  toggle.addEventListener('click', () => {
    const isOpen = !nav.classList.contains('open');
    nav.classList.toggle('open', isOpen);
    document.body.classList.toggle('nav-open', isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
  });

  nav.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('a')) {
      closeMenu();
    }
  });

  document.addEventListener('click', (event) => {
    if (!nav.classList.contains('open')) return;
    if (event.target === toggle || toggle.contains(event.target)) return;
    if (nav.contains(event.target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('open')) {
      closeMenu();
      toggle.focus();
    }
  });

  const mq = window.matchMedia('(min-width: 901px)');
  const handleMq = (e) => { if (e.matches) closeMenu(); };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handleMq);
  else if (typeof mq.addListener === 'function') mq.addListener(handleMq);
}

function initNewsletterCapture() {
  const forms = $$('.newsletter-form');
  forms.forEach((form, index) => {
    const emailInput = form.querySelector('input[type="email"]');
    const status = form.querySelector('.newsletter-status');
    if (!emailInput) return;

    if (status) {
      if (!status.id) status.id = `newsletter-status-${index + 1}`;
      emailInput.setAttribute('aria-describedby', status.id);
    }

    if (status) {
      emailInput.addEventListener('input', () => {
        if (!status.textContent) return;
        status.textContent = '';
        delete status.dataset.tone;
      });
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (status) {
        status.textContent = '';
        delete status.dataset.tone;
      }

      const email = emailInput.value.trim();
      emailInput.value = email;

      const isValid = email && (!emailInput.checkValidity || emailInput.checkValidity());
      if (!isValid) {
        if (status) {
          status.dataset.tone = 'error';
          status.textContent = 'Please enter a valid email address.';
        }
        if (typeof emailInput.reportValidity === 'function') emailInput.reportValidity();
        else emailInput.focus();
        return;
      }

      if (status) {
        status.dataset.tone = 'success';
        status.textContent = 'Thanks! You\'re on the list.';
      }

      form.reset();
    });
  });
}

/* =========================================
   TOOLS: Index (grid) + Detail (gated)
   ========================================= */
async function renderToolsIndex() {
  const grid = $('#toolsGrid'); if (!grid) return;
  const data = await fetch('/data/tools.json').then(r => r.json()).catch(() => ({ tools: [] }));
  const list = (data.tools || []).filter(t => t.visibility !== 'hidden');
  grid.innerHTML = list.map(t => toolCardHTML(t)).join('');
}

function toolCardHTML(t) {
  const chips = `<div class="chips">
    ${t.access === 'free' ? '<span class="chip free">Free</span>' : ''}
    ${t.access === 'patreon' ? '<span class="chip patreon">Patreon</span>' : ''}
    ${t.access === 'paid' ? `<span class="chip paid">Paid${t.price ? ' · ' + t.price : ''}</span>` : ''}
  </div>`;
  const lock = (t.access !== 'free') ? '<div class="lock">🔒</div>' : '';
  const soon = t.comingSoon ? '<div class="coming">COMING&nbsp;SOON</div>' : '';
  const href = t.comingSoon ? '#' : `/tool.html?id=${encodeURIComponent(t.id)}`;
  return `<article class="card">
    ${lock}${soon}
    <h3><a href="${href}">${t.title}</a></h3>
    <div class="muted">${t.subtitle || ''}</div>
    ${chips}
  </article>`;
}

async function renderToolDetail() {
  const article = $('#toolArticle'); if (!article) return;
  const id = new URLSearchParams(location.search).get('id');
  const { tools = [] } = await fetch('/data/tools.json').then(r => r.json()).catch(() => ({ tools: [] }));
  const t = tools.find(x => x.id === id);
  if (!t) { article.innerHTML = '<p>Tool not found.</p>'; return; }

  // Gate if needed (fallback to allowed if gate not present)
  const gated = (typeof gateToolAccess === 'function') ? await gateToolAccess(t) : { allowed: true };
  if (!gated.allowed) { article.innerHTML = gated.html || '<p>Locked.</p>'; return; }

  // Unlocked content
  article.innerHTML = `
    <h1>${t.title}</h1>
    <p class="muted">${t.subtitle || ''}</p>
    <div class="chips">
      ${t.access === 'free' ? '<span class="chip free">Free</span>' : ''}
      ${t.access === 'patreon' ? '<span class="chip patreon">Patreon</span>' : ''}
      ${t.access === 'paid' ? '<span class="chip paid">Paid</span>' : ''}
    </div>

    <div>${(t.description || []).map(p => `<p>${p}</p>`).join('')}</div>

    ${t.links?.demo  ? `<p><a class="btn" href="${t.links.demo}"  target="_blank" rel="noopener">Open Demo</a></p>` : ''}
    ${t.links?.site  ? `<p><a class="btn" href="${t.links.site}"  target="_blank" rel="noopener">Visit Site</a></p>` : ''}
    ${t.links?.sheet ? `<p><a class="btn primary" href="${t.links.sheet}" target="_blank" rel="noopener">Open Google Sheet</a></p>` : ''}

    ${t.notes?.length ? `<div class="note-box"><strong>Notes</strong><ul>${t.notes.map(n => `<li>${n}</li>`).join('')}</ul></div>` : ''}
  `;
}

/* =========================================
   PORTFOLIOS: Hub + Strategy detail
   Data file: /data/portfolios.json
   ========================================= */

// Safe wrappers so this file works even if paywall.js isn't loaded yet
async function __gatePortfolioAccess(p) {
  if (typeof gatePortfolioAccess === 'function') return gatePortfolioAccess(p);
  if (p?.access === 'public' || !p?.access) return { allowed: true };
  return { allowed: false, reason: 'Locked', ctaHTML: '<a class="btn" href="/portfolio.html">Back</a>' };
}

async function renderPortfoliosHub() {
  const grid = $('#portfoliosGrid'); if (!grid) return;
  const { portfolios = [] } = await fetch('/data/portfolios.json').then(r => r.json()).catch(() => ({ portfolios: [] }));

  const items = await Promise.all((portfolios || []).map(async p => {
    const gated = await __gatePortfolioAccess(p);
    const stats = `<div class="statline">
      <span>YTD ${fmt.pct(p.metrics?.ytd)}</span>
      <span>Sharpe ${p.metrics?.sharpe?.toFixed?.(2) ?? '—'}</span>
      <span>${p.metrics?.holdings ?? p.holdings?.length ?? 0} holdings</span>
    </div>`;

    if (!gated.allowed) {
      const htmlBlock = gated.html || `
        <div class="portfolio-thumb locked-card">
          <img src="${p.teaser_chart || '/images/og-card.png'}" alt="${p.title} chart (locked)">
          <div class="locked-overlay">🔒 ${gated.reason || 'Locked'}</div>
        </div>
        ${gated.ctaHTML || ''}
      `;

      return `
        <article class="card">
          <h3>${p.title}</h3>
          <div class="muted">${p.subtitle || ''}</div>
          ${htmlBlock}
          ${stats}
          <p class="muted">${p.summary || ''}</p>
        </article>
      `;
    }

    // Allowed
    return `
      <article class="card">
        <h3><a href="/strategy.html?id=${encodeURIComponent(p.id)}">${p.title}</a></h3>
        <div class="muted">${p.subtitle || ''}</div>
        <div class="portfolio-thumb">
          <img src="${p.full_chart || p.teaser_chart || '/images/og-card.png'}" alt="${p.title} chart">
        </div>
        ${stats}
        <p class="muted">${p.summary || ''}</p>
        <a class="btn" href="/strategy.html?id=${encodeURIComponent(p.id)}">View strategy →</a>
      </article>
    `;
  }));

  grid.innerHTML = items.join('');
}

async function renderStrategyDetail() {
  const mount = $('#strategyArticle'); if (!mount) return;
  const id = new URLSearchParams(location.search).get('id');
  const { portfolios = [] } = await fetch('/data/portfolios.json').then(r => r.json()).catch(() => ({ portfolios: [] }));
  const p = portfolios.find(x => x.id === id);
  if (!p) { mount.innerHTML = '<p>Portfolio not found.</p>'; return; }

  const gated = await __gatePortfolioAccess(p);

  if (!gated.allowed) {
    mount.innerHTML = gated.html || `
      <h1>${p.title}</h1>
      <p class="muted">${p.subtitle || ''}</p>
      <div class="portfolio-thumb locked-card">
        <img src="${p.teaser_chart || '/images/og-card.png'}" alt="${p.title} chart (locked)">
        <div class="locked-overlay">🔒 ${gated.reason || 'Locked'}</div>
      </div>
      <p>${p.summary || ''}</p>
      ${gated.ctaHTML || '<a class="btn" href="/portfolio.html">Back</a>'}
    `;
    return;
  }

  // Unlocked view
  const theory = (p.theory_paragraphs || []).map(t => `<p>${t}</p>`).join('');
  const rules = (p.rules || []).map(r => `<li>${r}</li>`).join('');
  const holdings = (p.holdings || []).map(h => `
    <tr><td>${h.ticker}</td><td>${h.name || ''}</td><td>${(h.weight * 100 || 0).toFixed(1)}%</td><td>${h.note || ''}</td></tr>
  `).join('');
  const notes = (p.methodology_notes || []).map(n => `<li>${n}</li>`).join('');
  const log = (p.changelog || []).map(c => `<li><strong>${fmt.date(c.date)}</strong> — ${c.note}</li>`).join('');

  mount.innerHTML = `
    <h1>${p.title}</h1>
    <p class="muted">${p.subtitle || ''}</p>
    <div class="portfolio-thumb">
      <img src="${p.full_chart || p.teaser_chart || '/images/og-card.png'}" alt="${p.title} chart">
    </div>

    <div class="stats">
      <div><span class="label">Inception</span><span>${fmt.date(p.inception)}</span></div>
      <div><span class="label">Holdings</span><span>${p.metrics?.holdings ?? p.holdings?.length ?? 0}</span></div>
      <div><span class="label">YTD</span><span>${fmt.pct(p.metrics?.ytd)}</span></div>
      <div><span class="label">Sharpe</span><span>${p.metrics?.sharpe?.toFixed?.(2) ?? '—'}</span></div>
    </div>

    <section><h2>The theory</h2>${theory}</section>
    <section><h2>Rules</h2><ul>${rules}</ul></section>

    <section>
      <h2>Current holdings</h2>
      <table class="table">
        <thead><tr><th>Ticker</th><th>Name</th><th>Weight</th><th>Note</th></tr></thead>
        <tbody>${holdings}</tbody>
      </table>
    </section>

    <section class="two-col">
      <div class="note-box">
        <strong>Methodology notes</strong>
        <ul>${notes}</ul>
      </div>
      <div class="note-box">
        <strong>Changelog</strong>
        <ul>${log}</ul>
      </div>
    </section>
  `;
}

/* AI Economy Hub */
async function renderAiEconomy() {
  const grid = document.querySelector('#aiEconomyGrid');
  if (!grid) return;
  const { articles=[] } = await fetch('/data/ai-economy.json').then(r=>r.json()).catch(()=>({articles:[]}));

  grid.innerHTML = articles.map(a => `
    <article class="card">
      <h3><a href="/ai-article.html?id=${encodeURIComponent(a.id)}">${a.title}</a></h3>
      <div class="muted">${a.subtitle || ''}</div>
      <p>${a.summary || ''}</p>
    </article>
  `).join('');
}
document.addEventListener('DOMContentLoaded', renderAiEconomy);

/* Single AI Economy Article */
async function renderAiArticle() {
  const mount = document.querySelector('#aiArticle');
  if (!mount) return;
  const id = new URLSearchParams(location.search).get('id');
  const { articles=[] } = await fetch('/data/ai-economy.json').then(r=>r.json()).catch(()=>({articles:[]}));
  const a = articles.find(x => x.id === id);
  if (!a) { mount.innerHTML = '<p>Article not found.</p>'; return; }

  mount.innerHTML = `
    <h1>${a.title}</h1>
    <p class="muted">${a.subtitle || ''}</p>
    ${a.youtube ? `<div class="video"><iframe width="100%" height="400" src="${a.youtube}" frameborder="0" allowfullscreen></iframe></div>` : ''}
    <div class="article-body">
      <p>${a.summary}</p>
      <p><em>More philosophical + political reflections go here...</em></p>
    </div>
  `;
}
document.addEventListener('DOMContentLoaded', renderAiArticle);


// ===== Global Theme Toggle (dark <-> light; persists in localStorage)
(function themeInit(){
  const KEY = 'ff_theme';
  const body = document.body;
  const order = ['theme-dark','theme-light']; // add 'theme-earth' if you want to cycle 3

  // Ensure exactly one theme class is present at start
  const saved = localStorage.getItem(KEY);
  const start = order.includes(saved) ? saved : 'theme-dark';
  order.forEach(t => body.classList.remove(t));
  body.classList.add(start);

  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const idx = order.findIndex(t => body.classList.contains(t));
      const next = order[(idx + 1) % order.length];
      order.forEach(t => body.classList.remove(t));
      body.classList.add(next);
      localStorage.setItem(KEY, next);
    });
  }
})();

