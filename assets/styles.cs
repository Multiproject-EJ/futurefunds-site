:root {
  --bg:#0f1115; 
  --panel:#151923; 
  --text:#e0ebf1; 
  --muted:#8a8c92; 
  --brand:#66d9ed; 
  --accent:#9ee493;
  --max:1100px; 
  --radius:14px; 
  --shadow:0 10px 30px rgba(0,0,0,.35);
}

* {box-sizing:border-box}
html,body {
  margin:0;
  padding:0;
  background:var(--bg);
  color:var(--text);
  font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;
}
a {color:var(--brand); text-decoration:none}
a:hover {opacity:.9}
img {max-width:100%; display:block}

.container {
  max-width:var(--max);
  margin:0 auto;
  padding:28px 20px;
}

.header {
  position:sticky;top:0;
  backdrop-filter:blur(10px);
  background:rgba(15,17,21,.6);
  border-bottom:1px solid rgba(255,255,255,.06);
  z-index:10;
}
.nav {display:flex; align-items:center; gap:20px; justify-content:space-between}
.brand {display:flex; align-items:center; gap:10px; font-weight:700; letter-spacing:2px}
.brand .dot {
  width:10px;height:10px;border-radius:50%;
  background:var(--brand);
  box-shadow:0 0 12px var(--brand);
}
.menu {display:flex; gap:18px; flex-wrap:wrap}
.menu a {color:var(--text); opacity:.9}
.menu a.active {color:var(--brand)}

.cta {
  background:linear-gradient(135deg,var(--brand),var(--accent));
  color:#0a0d12; font-weight:700;
  padding:10px 16px;
  border-radius:10px;
  box-shadow:0 0 12px rgba(0,0,0,.25);
}

.hero {display:grid; gap:24px; grid-template-columns:1.1fr .9fr; align-items:center; padding:56px 0}
.hero div {background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02));
  border:1px solid rgba(255,255,255,.08);
  border-radius:var(--radius);
  padding:18px;
  box-shadow:var(--shadow);
}
h1 {margin:0 0 10px;font-size:42px;line-height:1.1}
.lead {color:var(--muted); max-width:60ch}
.badges {display:flex; gap:10px; flex-wrap:wrap; margin:14px 0}
.badge {
  border:1px solid rgba(255,255,255,.12);
  border-radius:999px;
  padding:6px 12px;
  font-size:13px;
  color:var(--muted);
}
.section {margin:28px 0}
.buy {
  display:inline-block;
  background:linear-gradient(135deg,var(--brand),var(--accent));
  color:#0a0d12;
  font-weight:600;
  padding:12px 20px;
  border-radius:10px;
}
.notice {font-size:13px; opacity:.7}

.grid {display:grid; gap:20px}
.cards {grid-template-columns:repeat(12,1fr)}
.card {
  background:var(--panel);
  border:1px solid rgba(255,255,255,.07);
  border-radius:var(--radius);
  padding:18px;
  box-shadow:var(--shadow);
  display:block;
  color:var(--text);
}
.card h3 {margin:10px 0 6px}
.card p {margin:0; font-size:15px; color:var(--muted)}

.kicker {
  font-size:13px;
  letter-spacing:.2em;
  text-transform:uppercase;
  color:var(--muted);
  margin-bottom:8px;
}

.footer {
  margin-top:60px;
  border-top:1px solid rgba(255,255,255,.07);
  padding:24px 0;
  font-size:14px;
  text-align:center;
  opacity:.8;
}
