/* util */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const fmtPct = n => (n==null ? '—' : (n>0?'+':'') + (n*100).toFixed(1) + '%');
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString() : '—';

/* common footer year */
document.addEventListener('DOMContentLoaded', () => {
  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
});

/* home: render portfolio cards */
async function loadPortfoliosIndex(){
  const mount = document.getElementById('portfolio-grid');
  if (!mount) return;
  const data = await fetch('/data/portfolios.json').then(r => r.json()).catch(()=>({portfolios:[]}));
  const list = data.portfolios || [];
  mount.innerHTML = list.map(p => `
    <article class="card">
      <h3><a href="/portfolio.html?id=${encodeURIComponent(p.id)}">${p.title}</a></h3>
      <div class="muted">${p.subtitle ?? ''}</div>
      <div class="row"><span>Since inception</span><strong>${fmtPct(p.metrics?.cumulative_return)}</strong></div>
      <div class="row"><span>Holdings</span><strong>${p.holdings?.length ?? 0}</strong></div>
      <div class="row"><span>Inception</span><strong>${fmtDate(p.inception)}</strong></div>
    </article>
  `).join('');
}

/* portfolio page */
async function loadPortfolioDetail(){
  const article = document.getElementById('portfolio-article');
  if (!article) return;

  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id){ article.innerHTML = '<p>Portfolio not found.</p>'; return; }

  const {portfolios=[]} = await fetch('/data/portfolios.json').then(r => r.json());
  const p = portfolios.find(x => x.id === id);
  if (!p){ article.innerHTML = '<p>Portfolio not found.</p>'; return; }

  $('#p-title').textContent = p.title;
  $('#p-subtitle').textContent = p.subtitle ?? '';
  $('#p-inception').textContent = fmtDate(p.inception);
  $('#p-universe').textContent = p.universe ?? '—';
  $('#p-holdings-count').textContent = p.holdings?.length ?? 0;
  $('#p-cumret').textContent = fmtPct(p.metrics?.cumulative_return);

  /* theory */
  $('#p-theory').innerHTML = (p.theory_paragraphs || []).map(t => `<p>${t}</p>`).join('');

  /* rules */
  $('#p-rules').innerHTML = (p.rules || []).map(r => `<li>${r}</li>`).join('');

  /* holdings */
  const body = $('#p-holdings tbody');
  body.innerHTML = (p.holdings || []).map(h => `
    <tr><td>${h.ticker}</td><td>${h.name}</td><td>${(h.weight*100).toFixed(1)}%</td><td>${h.note ?? ''}</td></tr>
  `).join('');

  /* performance chart */
  if (p.performance?.dates && p.performance?.values){
    const ctx = document.getElementById('perfChart').getContext('2d');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: p.performance.dates,
        datasets: [{ label: 'Cumulative Return', data: p.performance.values }]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        scales: { y: { ticks: { callback: v => (v*100).toFixed(0)+'%' } } }
      }
    });
  }

  /* metrics */
  const m = p.metrics || {};
  const metrics = [
    ['Cumulative return', fmtPct(m.cumulative_return)],
    ['Ann. return', fmtPct(m.annualized_return)],
    ['Volatility', fmtPct(m.annualized_vol)],
    ['Sharpe (rf=0)', m.sharpe?.toFixed?.(2) ?? '—'],
    ['Max drawdown', fmtPct(m.max_drawdown)]
  ];
  $('#p-metrics tbody').innerHTML = metrics.map(([k,v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  /* methodology & changelog */
  $('#p-methodology').innerHTML = (p.methodology_notes||[]).map(x=>`<li>${x}</li>`).join('');
  $('#p-changelog').innerHTML   = (p.changelog||[]).map(x=>`<li><strong>${fmtDate(x.date)}</strong> — ${x.note}</li>`).join('');
}

/* blog index */
async function loadBlog(){
  const mount = document.getElementById('posts-list');
  if (!mount) return;
  const {posts=[]} = await fetch('/data/posts.json').then(r=>r.json()).catch(()=>({posts:[]}));
  mount.innerHTML = posts.map(post => `
    <div class="post-item">
      <h3><a href="${post.url}">${post.title}</a></h3>
      <div class="muted">${new Date(post.date).toLocaleDateString()} · ${post.tagline ?? ''}</div>
      <p>${post.excerpt ?? ''}</p>
    </div>
  `).join('');
}

/* boot */
document.addEventListener('DOMContentLoaded', () => {
  loadPortfoliosIndex();
  loadPortfolioDetail();
  loadBlog();
});
