const SUPPORTED = ['en','zh','es','hi','ar'];
function pickLang(){
  const qp = new URLSearchParams(location.search).get('lang');
  if (qp && SUPPORTED.includes(qp)) return qp;
  const html = document.documentElement.getAttribute('lang');
  if (html && SUPPORTED.includes(html)) return html;
  const bl = (navigator.language||'en').slice(0,2);
  return SUPPORTED.includes(bl)?bl:'en';
}
async function loadLang(lang){
  const dict = await fetch(`/i18n/${lang}.json`).then(r=>r.json()).catch(()=>({}));
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key = el.getAttribute('data-i18n');
    if (dict[key]) el.innerHTML = dict[key];
  });
  document.documentElement.setAttribute('lang', lang);
  const btn = document.getElementById('langBtn');
  if (btn) btn.textContent = lang.toUpperCase()+' ▾';
}
document.addEventListener('DOMContentLoaded',()=>{
  const lang = pickLang(); loadLang(lang);
  const btn = document.getElementById('langBtn');
  if(btn){
    btn.onclick = (e)=>{
      e.preventDefault();
      const i = SUPPORTED.indexOf(document.documentElement.getAttribute('lang')||'en');
      const next = SUPPORTED[(i+1)%SUPPORTED.length];
      loadLang(next);
    };
  }
});
