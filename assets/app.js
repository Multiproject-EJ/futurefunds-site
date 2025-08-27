const $ = (s,r=document)=>r.querySelector(s);
const fmt = {
  pct: n => (n==null?'—':((n>0?'+':'')+(n*100).toFixed(1)+'%')),
  date: iso => iso ? new Date(iso).toLocaleDateString() : '—'
};
document.addEventListener('DOMContentLoaded',()=>{
  const y=$('#year'); if(y) y.textContent=new Date().getFullYear();
  renderToolsIndex();
  renderToolDetail();
});

/* Tools Grid */
async function renderToolsIndex(){
  const grid = $('#toolsGrid'); if(!grid) return;
  const data = await fetch('/data/tools.json').then(r=>r.json());
  const list = (data.tools||[]).filter(t => t.visibility !== 'hidden'); // hide "off" items
  grid.innerHTML = list.map(t => toolCardHTML(t)).join('');
}
function toolCardHTML(t){
  const chips = `<div class="chips">
    ${t.access==='free'?'<span class="chip free">Free</span>':''}
    ${t.access==='patreon'?'<span class="chip patreon">Patreon</span>':''}
    ${t.access==='paid'?`<span class="chip paid">Paid${t.price?' · '+t.price:''}</span>`:''}
  </div>`;
  const lock = (t.access!=='free')?'<div class="lock">🔒</div>':'';
  const soon = t.comingSoon?'<div class="coming">COMING&nbsp;SOON</div>':'';
  const href = t.comingSoon? '#': `/tool.html?id=${encodeURIComponent(t.id)}`;
  return `<article class="card">
    ${lock}${soon}
    <h3><a href="${href}">${t.title}</a></h3>
    <div class="muted">${t.subtitle||''}</div>
    ${chips}
  </article>`;
}

/* Tool Detail */
async function renderToolDetail(){
  const article = $('#toolArticle'); if(!article) return;
  const id = new URLSearchParams(location.search).get('id');
  const {tools=[]} = await fetch('/data/tools.json').then(r=>r.json());
  const t = tools.find(x=>x.id===id);
  if(!t){ article.innerHTML='<p>Tool not found.</p>'; return; }

  // gate if needed
  const gated = await gateToolAccess(t);
  if(!gated.allowed){
    article.innerHTML = gated.html; return;
  }

  // Render unlocked content (marketing + links to Sheet/template)
  article.innerHTML = `
    <h1>${t.title}</h1>
    <p class="muted">${t.subtitle||''}</p>
    <div class="chips">${t.access==='free'?'<span class="chip free">Free</span>':''}
      ${t.access==='patreon'?'<span class="chip patreon">Patreon</span>':''}
      ${t.access==='paid'?'<span class="chip paid">Paid</span>':''}</div>

    <div>${(t.description||[]).map(p=>`<p>${p}</p>`).join('')}</div>

    ${t.links?.demo ? `<p><a class="btn" href="${t.links.demo}" target="_blank" rel="noopener">Open Demo</a></p>`:''}
    ${t.links?.sheet ? `<p><a class="btn primary" href="${t.links.sheet}" target="_blank" rel="noopener">Open Google Sheet</a></p>`:''}
    ${t.notes?.length?`<div class="note-box"><strong>Notes</strong><ul>${t.notes.map(n=>`<li>${n}</li>`).join('')}</ul></div>`:''}
  `;
}
