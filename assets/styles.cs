:root{
  --bg:#0b1020; --card:#121733; --text:#e9ecf8; --muted:#a7b0d0;
  --accent:#59f; --accent-2:#88f;
  --maxw:1100px; --radius:14px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:linear-gradient(180deg,#0b1020,#0e1430);color:var(--text);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.container{max-width:var(--maxw);margin:auto;padding:2rem}
.container.narrow{max-width:800px}
.site-header,.site-footer{display:flex;align-items:center;justify-content:space-between;padding:1rem 2rem;border-bottom:1px solid #1a2147}
.site-footer{border-top:1px solid #1a2147;border-bottom:none}
.brand{display:flex;gap:.6rem;align-items:center;font-weight:700}
.brand img{width:28px;height:28px;display:block}
.nav a{margin-left:1rem}
.hero{padding:6rem 2rem;text-align:center;background:radial-gradient(1200px 400px at 50% -50%, #2030a0 0%, transparent 70%)}
.hero h1{font-size:clamp(2rem,3.6vw,3rem);margin:.2rem 0 1rem}
.hero p{color:var(--muted);max-width:780px;margin:auto}
.hero-ctas{display:flex;gap:.75rem;justify-content:center;margin:1.2rem 0}
.btn{display:inline-block;border:1px solid #2c3b7a;padding:.7rem 1rem;border-radius:10px}
.btn.primary{background:linear-gradient(90deg,var(--accent),var(--accent-2));color:#050a1a;border:none}
.hero-note{display:block;color:#9bb;opacity:.9;margin-top:.6rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;margin-top:1rem}
.card{background:var(--card);border:1px solid #1a2147;border-radius:var(--radius);padding:1rem}
.card h3{margin:.2rem 0 .4rem}
.card .muted{color:var(--muted);font-size:.95rem}
.card .row{display:flex;gap:.5rem;justify-content:space-between;margin-top:.6rem}
.pillars{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;padding:0;margin:0;list-style:none}
.pillars li{background:var(--card);border:1px solid #1a2147;border-radius:var(--radius);padding:1rem}
.table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid #1a2147;border-radius:var(--radius);overflow:hidden}
.table th,.table td{padding:.6rem .75rem;border-bottom:1px solid #1a2147}
.table tr:last-child td{border-bottom:none}
.table.compact th,.table.compact td{padding:.45rem .6rem}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem}
.note-box{background:#0e1536;border:1px solid #28306a;border-radius:var(--radius);padding:1rem}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.6rem;margin:1rem 0}
.stats .label{display:block;color:var(--muted);font-size:.85rem}
.muted{color:var(--muted)}
.backlink{display:inline-block;margin:1rem 0}
.list{display:grid;gap:.8rem}
.post-item{background:var(--card);border:1px solid #1a2147;border-radius:var(--radius);padding:1rem}
.post-item h3{margin:.2rem 0}
@media (max-width:900px){.two-col{grid-template-columns:1fr}}
