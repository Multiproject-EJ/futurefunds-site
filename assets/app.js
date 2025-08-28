/* ======= Tiny utilities ======= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const fmt = {
  pct: n => (n == null ? '—' : ((n > 0 ? '+' : '') + (n * 100).toFixed(1) + '%')),
  date: iso => (iso ? new Date(iso).toLocaleDateString() : '—')
};

document.addEventListener('DOMContentLoaded', () => {
  const y = $('#year'); if (y) y.textContent = new Date().getFullYear();
  renderToolsIndex();
  renderToolDetail();
  renderPortfoliosHub();
  renderStrategyDetail();
});

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

    ${t.links?.demo ? `<p><a class="btn" href="${t.links.demo}" target="_blank" rel="noopener">Open Demo</a></p>` : ''}
    ${t.links?.sheet ? `<p><a class="btn primary" href="${t.links.sheet}" target="_blank" rel="noopener">Open Google Sheet</a></p>` : ''}
    ${t.notes?.length ? `<div class="note-box"><strong>Notes</strong><ul>${t.notes.map(n => `<li>${n}</li>`).join('')}</ul></div>` : ''}
  `;
}

/* =========================================
   PORTFOLIOS: Hub + Strategy detail
   Data file: /data/portfolios.json
   Keys used: id, title, subtitle, access, comingSoon,
              teaser_chart, full_chart, metrics{ytd,sharpe,holdings},
              summary, inception, theory_paragraphs, rules, holdings[],
              methodology_notes[], changelog[]
   ========================================= */

// Safe wrappers for gating so this file works even if paywall.js isn't loaded yet
async function __gatePortfolioAccess(p) {
  if (typeof gatePortfolioAccess === 'function') return gatePortfolioAccess(p);
  // default: public unless p.access explicitly locks
  if (p.access === 'public' || !p.access) return { allowed: true };
  return {
    allowed: false,
    reason: (p.access === 'patreon') ? 'Patreon membership required' : 'Subscription required',
    ctaHTML: '<a class="btn" href="/portfolio.html">Back</a>'
  };
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
      return `
        <article class="card">
          <h3>${p.title}</h3>
          <div class="muted">${p.subtitle || ''}</div>
          <div class="portfolio-thumb locked-card">
            <img src="${p.teaser_chart || '/images/og-card.png'}" alt="${p.title} chart (locked)">
            <div class="locked-overlay">🔒 ${gated.reason || 'Locked'}</div>
          </div>
          ${stats}
          <p class="muted">${p.summary || ''}</p>
          ${gated.ctaHTML || ''}
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
    mount.innerHTML = `
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

    <section><h2>The theory</h2>${th
eory}</section>
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
