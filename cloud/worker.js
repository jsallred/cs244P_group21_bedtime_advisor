// Bedtime Cooling Advisor - cloud logger + dashboard (Cloudflare Worker + D1)
//
// EMQX (HTTP action) --POST /ingest--> this Worker --> D1 database
// Browser --> GET /?key=VIEW_KEY  -> dashboard page
//         --> GET /api/data       -> 72 h history as JSON
//
// Needs: a D1 binding named DB, and two secrets: INGEST_KEY, VIEW_KEY.

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const GAP_MS = 150 * 1000;       // a silence longer than this counts as a gap
const MAX_POINTS = 1000;         // chart points returned

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}
function eq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function num(x) {
  const n = Number(x);
  return x === null || x === undefined || x === "" || !isFinite(n) ? null : n;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/ingest" && req.method === "POST") return await ingest(req, env);
      if (url.pathname === "/api/data" && req.method === "GET") return await data(url, env);
      if (url.pathname === "/" && req.method === "GET") {
        return new Response(PAGE, {
          headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};

// ---------------------------------------------------------------- ingest
async function ingest(req, env) {
  const auth = req.headers.get("authorization") || "";
  if (!env.INGEST_KEY || !eq(auth, "Bearer " + env.INGEST_KEY)) return json({ error: "unauthorized" }, 401);

  // EMQX's "Test" button sends an empty or topic-less request: answer OK so it can be saved.
  let body = null;
  try { body = JSON.parse(await req.text()); } catch (e) { body = null; }
  if (!body || typeof body !== "object" || !body.topic) return json({ ok: true, note: "test request, nothing stored" });
  const topic = String(body.topic || "");
  let p = body.payload;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { /* plain string, e.g. "online" */ } }
  const leaf = topic.split("/").pop();
  const ts = Date.now();

  if (leaf === "temp" && p && typeof p === "object") {
    const t = num(p.temperature_f);
    if (t === null) return json({ error: "bad temperature" }, 400);
    await env.DB.prepare("INSERT INTO temps (ts, device_ts, seq, temp_f, target_f) VALUES (?,?,?,?,?)")
      .bind(ts, p.timestamp ?? null, num(p.sequence), t, num(p.target_f)).run();
  } else if (leaf === "advice" && p && typeof p === "object" && p.advice) {
    await env.DB.prepare("INSERT INTO advice (ts, advice, predicted_f, minutes_left, cannot_reach) VALUES (?,?,?,?,?)")
      .bind(ts, String(p.advice), num(p.predicted_f), num(p.minutes_left), p.cannot_reach ? 1 : 0).run();
  } else if (leaf === "status") {
    await env.DB.prepare("INSERT INTO status (ts, status) VALUES (?,?)")
      .bind(ts, String(typeof p === "string" ? p : JSON.stringify(p)).slice(0, 32)).run();
  } else {
    return json({ error: "ignored topic " + topic }, 400);
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------- read API
async function data(url, env) {
  if (!env.VIEW_KEY || !eq(url.searchParams.get("key") || "", env.VIEW_KEY)) return json({ error: "unauthorized" }, 401);

  const now = Date.now();
  const latestTemp = await env.DB.prepare("SELECT ts, temp_f, target_f FROM temps ORDER BY ts DESC LIMIT 1").first();
  const latestAdvice = await env.DB.prepare("SELECT ts, advice, predicted_f, minutes_left, cannot_reach FROM advice ORDER BY ts DESC LIMIT 1").first();
  const latestStatus = await env.DB.prepare("SELECT ts, status FROM status ORDER BY ts DESC LIMIT 1").first();
  const latest = { now, temp: latestTemp, advice: latestAdvice, status: latestStatus };

  if (url.searchParams.get("light") === "1") return json({ latest });

  const hours = Math.min(Math.max(Number(url.searchParams.get("hours")) || 72, 1), 168);
  const since = now - hours * 3600 * 1000;

  const temps = (await env.DB.prepare("SELECT ts, temp_f, target_f FROM temps WHERE ts >= ? ORDER BY ts").bind(since).all()).results;
  const advice = (await env.DB.prepare("SELECT ts, advice, predicted_f, minutes_left, cannot_reach FROM advice WHERE ts >= ? ORDER BY ts DESC LIMIT 200").bind(since).all()).results;
  const status = (await env.DB.prepare("SELECT ts, status FROM status WHERE ts >= ? ORDER BY ts DESC LIMIT 200").bind(since).all()).results;

  // gaps (from raw readings), including a trailing gap up to "now"
  const gaps = [];
  for (let i = 1; i < temps.length; i++) {
    if (temps[i].ts - temps[i - 1].ts > GAP_MS) gaps.push({ from: temps[i - 1].ts, to: temps[i].ts });
  }
  if (temps.length && now - temps[temps.length - 1].ts > GAP_MS) gaps.push({ from: temps[temps.length - 1].ts, to: now, open: true });

  const first = temps.length ? Math.max(temps[0].ts, since) : now;
  const span = Math.max(now - first, 1);
  const gapTotal = gaps.reduce((s, g) => s + (g.to - g.from), 0);
  const coverage = temps.length ? Math.max(0, 100 * (1 - gapTotal / span)) : null;

  // downsample to <= MAX_POINTS by averaging into time buckets
  const bucketMs = Math.max(Math.ceil((hours * 3600 * 1000) / MAX_POINTS), 1000);
  const points = [];
  let cur = null;
  for (const r of temps) {
    const b = Math.floor(r.ts / bucketMs);
    if (!cur || cur.b !== b) {
      if (cur) points.push([Math.round(cur.ts / cur.n), +(cur.t / cur.n).toFixed(2), cur.g === null ? null : +(cur.g / cur.n).toFixed(1)]);
      cur = { b, ts: 0, t: 0, g: 0, n: 0 };
    }
    cur.ts += r.ts; cur.t += r.temp_f; cur.n++;
    cur.g = r.target_f === null || cur.g === null ? null : cur.g + r.target_f;
  }
  if (cur) points.push([Math.round(cur.ts / cur.n), +(cur.t / cur.n).toFixed(2), cur.g === null ? null : +(cur.g / cur.n).toFixed(1)]);

  return json({
    latest, hours, bucketMs, gapMs: GAP_MS, points, gaps, advice, status,
    stats: { readings: temps.length, coverage_pct: coverage, gap_count: gaps.length, gap_seconds: Math.round(gapTotal / 1000) },
  });
}

// ---------------------------------------------------------------- dashboard page
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bedtime Cooling Advisor</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14181f;--mute:#5d6675;--line:#e2e6ec;--accent:#2563eb;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--okbg:#dcfce7;--warnbg:#fef3c7;--badbg:#fee2e2;--grid:rgba(0,0,0,.08)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1116;--card:#171b22;--ink:#e8ecf2;--mute:#9aa4b2;--line:#262c36;--accent:#6ea0ff;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--okbg:#12301d;--warnbg:#3a2c0b;--badbg:#3b1616;--grid:rgba(255,255,255,.08)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{font-size:20px;margin:0}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-weight:600;font-size:13px}
.pill i{width:8px;height:8px;border-radius:50%;background:currentColor;display:inline-block}
.ok{color:var(--ok);background:var(--okbg)}.warn{color:var(--warn);background:var(--warnbg)}.bad{color:var(--bad);background:var(--badbg)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.lab{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.big{font-size:34px;font-weight:700;line-height:1.1;margin-top:4px}
.sub{color:var(--mute);font-size:13px;margin-top:2px}
.chartcard{padding:14px 12px 10px}
.tools{display:flex;gap:6px;justify-content:space-between;align-items:center;margin:0 4px 8px;flex-wrap:wrap}
.seg button{border:1px solid var(--line);background:var(--card);color:var(--ink);padding:5px 12px;font:inherit;cursor:pointer}
.seg button:first-child{border-radius:8px 0 0 8px}.seg button:last-child{border-radius:0 8px 8px 0}.seg button+button{border-left:0}
.seg button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
canvas{width:100%!important;height:320px!important}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line)}
th{color:var(--mute);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:12px}
.empty{color:var(--mute);padding:8px 6px}
#gate{display:none;max-width:420px;margin:80px auto;text-align:center}
#gate input{width:100%;padding:10px;margin:12px 0;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit}
#gate button{padding:9px 18px;border-radius:8px;border:0;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
</style>
</head>
<body>
<div id="gate" class="card">
  <h1>Bedtime Cooling Advisor</h1>
  <p class="sub">Enter the view key to open the dashboard.</p>
  <input id="keyin" type="password" placeholder="view key" autocomplete="off">
  <button id="keygo">Open</button>
  <p class="sub" id="keyerr"></p>
</div>
<div class="wrap" id="app" style="display:none">
  <header>
    <h1>Bedtime Cooling Advisor <span class="sub">- device T21</span></h1>
    <span id="conn" class="pill warn"><i></i><span>loading</span></span>
  </header>
  <div class="grid">
    <div class="card"><div class="lab">Room temperature</div><div class="big" id="temp">--</div><div class="sub" id="seen">&nbsp;</div></div>
    <div class="card"><div class="lab">Target</div><div class="big" id="target">--</div><div class="sub">set by the knob</div></div>
    <div class="card"><div class="lab">AC advice</div><div class="big" id="adv">--</div><div class="sub" id="advsub">&nbsp;</div></div>
    <div class="card"><div class="lab">Until 9 PM</div><div class="big" id="mins">--</div><div class="sub" id="pred">&nbsp;</div></div>
  </div>
  <div class="card chartcard">
    <div class="tools">
      <div class="lab">Temperature history (F)</div>
      <div class="seg" id="range"><button data-h="6">6 h</button><button data-h="24">24 h</button><button data-h="72" class="on">72 h</button></div>
    </div>
    <canvas id="chart"></canvas>
  </div>
  <div class="grid" style="margin-top:12px">
    <div class="card"><div class="lab">Readings received</div><div class="big" id="s_n">--</div><div class="sub" id="s_win">&nbsp;</div></div>
    <div class="card"><div class="lab">Coverage</div><div class="big" id="s_cov">--</div><div class="sub">share of time with data</div></div>
    <div class="card"><div class="lab">Gaps</div><div class="big" id="s_gaps">--</div><div class="sub" id="s_gapsub">&nbsp;</div></div>
  </div>
  <div class="two">
    <div class="card"><div class="lab">Gaps in data (over 2.5 min)</div><table><thead><tr><th>From</th><th>To</th><th>Length</th></tr></thead><tbody id="gaptb"></tbody></table></div>
    <div class="card"><div class="lab">Device status and advice changes</div><table><thead><tr><th>Time</th><th>Event</th></tr></thead><tbody id="evtb"></tbody></table></div>
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
var KEY = "", HOURS = 72, chart = null;
function $(id){return document.getElementById(id);}
function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v);}catch(e){return null;}}
function fmt(ts){return new Date(ts).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});}
function dur(ms){var s=Math.round(ms/1000);if(s<90)return s+" s";var m=Math.round(s/60);if(m<90)return m+" min";var h=Math.floor(m/60);return h+" h "+(m%60)+" min";}
function css(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim();}
function td(t){var c=document.createElement("td");c.textContent=t;return c;}
function row(cells){var r=document.createElement("tr");cells.forEach(function(c){r.appendChild(td(c));});return r;}
function empty(tb,msg){tb.textContent="";var r=document.createElement("tr"),c=td(msg);c.className="empty";c.colSpan=3;r.appendChild(c);tb.appendChild(r);}

function api(q){return fetch("/api/data?key="+encodeURIComponent(KEY)+q,{cache:"no-store"}).then(function(r){if(r.status===401)throw new Error("auth");if(!r.ok)throw new Error("http "+r.status);return r.json();});}

function showLatest(L){
  var t=L.temp, a=L.advice, s=L.status, now=L.now;
  $("temp").textContent = t ? t.temp_f.toFixed(1)+" F" : "--";
  $("target").textContent = t && t.target_f!==null ? Math.round(t.target_f)+" F" : "--";
  var age = t ? now - t.ts : null;
  $("seen").textContent = t ? "updated "+dur(age)+" ago" : "no data yet";
  var conn=$("conn"), lbl=conn.lastChild;
  if(!t){conn.className="pill warn";lbl.textContent="no data";}
  else if(age<=GAP){ conn.className="pill ok"; lbl.textContent="live"; }
  else if(s && s.status==="offline" && s.ts>=t.ts){ conn.className="pill bad"; lbl.textContent="device offline"; }
  else { conn.className="pill bad"; lbl.textContent="no data for "+dur(age); }
  if(a){
    $("adv").textContent=a.advice;
    $("adv").style.color = a.advice==="HIGH"?css("--bad"):a.advice==="LOW"?css("--warn"):css("--ok");
    $("advsub").textContent = a.cannot_reach ? "cannot reach target in time" : "since "+fmt(a.ts);
    $("mins").textContent = a.minutes_left!==null && a.minutes_left>=0 ? a.minutes_left+" min" : "holding";
    $("pred").textContent = a.predicted_f!==null ? "predicted "+a.predicted_f.toFixed(1)+" F at 9 PM" : "";
  }
}
var GAP = 150000;

function showFull(d){
  GAP = d.gapMs;
  showLatest(d.latest);
  var pts=[], tg=[], last=null;
  d.points.forEach(function(p){
    if(last!==null && p[0]-last > Math.max(d.gapMs, d.bucketMs*2)){ pts.push({x:last+1,y:null}); tg.push({x:last+1,y:null}); }
    pts.push({x:p[0],y:p[1]}); tg.push({x:p[0],y:p[2]}); last=p[0];
  });
  var now=d.latest.now, min=now-d.hours*3600000;
  var cfg={type:"line",data:{datasets:[
    {label:"Temperature",data:pts,borderColor:css("--accent"),backgroundColor:css("--accent"),borderWidth:2,pointRadius:0,tension:.2,spanGaps:false},
    {label:"Target",data:tg,borderColor:css("--warn"),borderDash:[6,4],borderWidth:2,pointRadius:0,spanGaps:false}
  ]},options:{animation:false,responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},
    scales:{x:{type:"linear",min:min,max:now,grid:{color:css("--grid")},ticks:{color:css("--mute"),maxTicksLimit:(window.innerWidth<600?4:7),callback:function(v){var dt=new Date(v);return d.hours<=6?dt.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}):dt.toLocaleString([], {weekday:"short",hour:"numeric"});}}},
      y:{grid:{color:css("--grid")},ticks:{color:css("--mute")}}},
    plugins:{legend:{labels:{color:css("--ink")}},tooltip:{callbacks:{title:function(i){return fmt(i[0].parsed.x);},label:function(c){return c.dataset.label+": "+(c.parsed.y===null?"--":c.parsed.y.toFixed(1)+" F");}}}}}};
  if(chart){chart.destroy();}
  chart=new Chart($("chart"),cfg);

  var st=d.stats;
  $("s_n").textContent=st.readings.toLocaleString();
  $("s_win").textContent="in the last "+d.hours+" h";
  $("s_cov").textContent=st.coverage_pct===null?"--":st.coverage_pct.toFixed(1)+"%";
  $("s_gaps").textContent=st.gap_count;
  $("s_gapsub").textContent=st.gap_count?dur(st.gap_seconds*1000)+" total":"no gaps";

  var gt=$("gaptb"); gt.textContent="";
  if(!d.gaps.length) empty(gt,"No gaps."); else d.gaps.slice().reverse().forEach(function(g){gt.appendChild(row([fmt(g.from),g.open?"still down":fmt(g.to),dur(g.to-g.from)]));});

  var ev=[];
  d.status.forEach(function(s){ev.push([s.ts,"Device "+s.status]);});
  d.advice.forEach(function(a){ev.push([a.ts,"Advice "+a.advice+(a.cannot_reach?" (cannot reach target)":"")]);});
  ev.sort(function(a,b){return b[0]-a[0];});
  var et=$("evtb"); et.textContent="";
  if(!ev.length) empty(et,"No events yet."); else ev.slice(0,40).forEach(function(e){et.appendChild(row([fmt(e[0]),e[1]]));});
}

function loadFull(){return api("&hours="+HOURS).then(showFull).catch(fail);}
function loadLight(){return api("&light=1").then(function(d){showLatest(d.latest);}).catch(fail);}
function fail(e){
  if(e.message==="auth"){store("bca_key","");$("app").style.display="none";$("gate").style.display="block";$("keyerr").textContent="That key was not accepted.";return;}
  var c=$("conn");c.className="pill bad";c.lastChild.textContent="cannot reach server";
}
function start(){
  $("gate").style.display="none";$("app").style.display="block";
  loadFull();
  setInterval(loadLight,15000);
  setInterval(loadFull,300000);
}
Array.prototype.forEach.call(document.querySelectorAll("#range button"),function(b){
  b.addEventListener("click",function(){
    HOURS=Number(b.getAttribute("data-h"));
    Array.prototype.forEach.call(document.querySelectorAll("#range button"),function(x){x.classList.toggle("on",x===b);});
    loadFull();
  });
});
$("keygo").addEventListener("click",function(){KEY=$("keyin").value.trim();if(!KEY)return;store("bca_key",KEY);start();});
$("keyin").addEventListener("keydown",function(e){if(e.key==="Enter")$("keygo").click();});
(function(){
  var q=new URLSearchParams(location.search).get("key");
  KEY=q||store("bca_key")||"";
  if(q){store("bca_key",q);history.replaceState(null,"",location.pathname);}
  if(KEY)start(); else $("gate").style.display="block";
})();
</script>
</body>
</html>`;
