/**
 * The Phase-1 Cockpit Mobile web client, served by the LAN gateway (gateway.ts).
 * Self-contained (no build step, no external deps): connects to the gateway's
 * Server-Sent Events stream and renders a live, read-only session dashboard.
 * Styled to match docs/mockups/cockpit-mobile.html. Kept as an embedded string so
 * it works identically in dev and packaged builds (no asset-path juggling).
 */
export const MOBILE_CLIENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="theme-color" content="#14161b" />
<title>Cockpit</title>
<style>
  :root{--screen:#14161b;--panel:#1a1d24;--border:#2a2f39;--text:#d7dbe3;
    --muted:#8b93a3;--faint:#5c6472;--green:#46d17f;--amber:#f0b23a;--blue:#5b9dff;--danger:#f0623a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--screen);color:var(--text);
    font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",Segoe UI,Roboto,sans-serif;
    -webkit-font-smoothing:antialiased;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
  header{position:sticky;top:0;background:rgba(20,22,27,.92);backdrop-filter:blur(8px);
    border-bottom:1px solid var(--border);padding:14px 18px 10px;z-index:5}
  .row1{display:flex;align-items:center;gap:10px}
  .row1 h1{font-size:18px;font-weight:650;margin:0;flex:1}
  .conn{font-size:11px;font-weight:700;padding:3px 9px;border-radius:9px;background:var(--panel);color:var(--muted)}
  .conn.ok{color:#7ee7b0;background:rgba(70,209,127,.14)}
  .conn.bad{color:#f7a08f;background:rgba(240,98,58,.14)}
  .stats{display:flex;gap:16px;color:var(--muted);font-size:12px;margin-top:8px}
  .stats b{color:var(--text);font-weight:650}
  main{padding:12px 12px 40px}
  .wshead{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.7px;
    font-weight:700;padding:12px 6px 8px}
  .srow{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--border);
    border-radius:14px;padding:13px 13px;margin-bottom:9px}
  .body{flex:1;min-width:0}
  .nm{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mt{color:var(--muted);font-size:12px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dot{width:10px;height:10px;border-radius:50%;flex:none}
  .dot.work{background:var(--green);box-shadow:0 0 8px var(--green)}
  .dot.wait{background:var(--amber);box-shadow:0 0 8px var(--amber)}
  .dot.start{background:var(--blue)}
  .dot.exit{background:var(--danger)}
  .dot.idle{background:#4a505c}
  .pill{font-size:10.5px;font-weight:700;border-radius:8px;padding:3px 8px;flex:none}
  .pill.wait{color:#f7c76a;background:rgba(240,178,58,.14)}
  .pill.sub{color:#9cc2ff;background:rgba(91,157,255,.14)}
  .empty{color:var(--faint);text-align:center;padding:60px 20px;font-size:14px}
  .foot{color:var(--faint);text-align:center;font-size:11px;padding:20px}
</style>
</head>
<body>
  <header>
    <div class="row1"><h1>Cockpit</h1><span id="conn" class="conn">connecting…</span></div>
    <div class="stats">
      <span>CPU <b id="cpu">–</b></span>
      <span>MEM <b id="mem">–</b></span>
      <span>~<b id="tok">–</b> tok/m</span>
    </div>
  </header>
  <main id="list"><div class="empty">Loading sessions…</div></main>
  <div class="foot">Read-only preview · live over your network</div>

<script>
(function(){
  var qs = location.search || "";
  var state = { sessions: [], workspaces: {}, stats: null };

  function dotClass(s){
    s = (s||"").toLowerCase();
    if(s.indexOf("work")>=0) return "work";
    if(s.indexOf("wait")>=0) return "wait";
    if(s.indexOf("start")>=0||s.indexOf("launch")>=0) return "start";
    if(s.indexOf("exit")>=0||s.indexOf("dead")>=0) return "exit";
    return "idle";
  }
  function fmtTok(n){ n=n||0; return n>=1000 ? (n/1000).toFixed(1)+"k" : String(n); }
  function esc(t){ return String(t==null?"":t).replace(/[&<>"]/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]; }); }

  function render(){
    var st = state.stats;
    if(st){
      document.getElementById("cpu").textContent = Math.round(st.cpu)+"%";
      document.getElementById("mem").textContent = Math.round(st.memPercent)+"%";
      document.getElementById("tok").textContent = Math.round(st.tokenRate||0);
    }
    var list = document.getElementById("list");
    var sess = state.sessions || [];
    if(!sess.length){ list.innerHTML = '<div class="empty">No sessions open.</div>'; return; }

    // group by workspace, preserving first-seen order
    var order = [], groups = {};
    sess.forEach(function(s){
      var k = s.workspaceId || "_";
      if(!groups[k]){ groups[k]=[]; order.push(k); }
      groups[k].push(s);
    });
    var html = "";
    order.forEach(function(k){
      var name = k==="_" ? "Sessions" : (state.workspaces[k] || "Workspace");
      html += '<div class="wshead">'+esc(name)+'</div>';
      groups[k].forEach(function(s){
        var meta = [];
        if(s.issueNumber) meta.push("#"+s.issueNumber);
        if(s.model) meta.push(esc(s.model));
        if(s.tokensTotal) meta.push(fmtTok(s.tokensTotal)+" tok");
        var pills = "";
        if(dotClass(s.status)==="wait") pills += '<span class="pill wait">needs you</span>';
        if(s.subagentCount>0) pills += ' <span class="pill sub">'+s.subagentCount+' sub</span>';
        html += '<div class="srow">'
          + '<span class="dot '+dotClass(s.status)+'"></span>'
          + '<div class="body"><div class="nm">'+esc(s.name)+'</div>'
          + '<div class="mt">'+meta.join(" · ")+(s.lastActivity? ' · '+esc(s.lastActivity):'')+'</div></div>'
          + pills + '</div>';
      });
    });
    list.innerHTML = html;
  }

  function setConn(cls, txt){
    var el = document.getElementById("conn");
    el.className = "conn "+cls; el.textContent = txt;
  }

  if(!/token=/.test(qs)){
    setConn("bad","no token");
    document.getElementById("list").innerHTML =
      '<div class="empty">Open the URL shown in Cockpit → Settings → Phone access (it includes a token).</div>';
    return;
  }

  var es = new EventSource("/events"+qs);
  es.addEventListener("snapshot", function(e){
    var d = JSON.parse(e.data);
    state.sessions = d.sessions||[]; state.workspaces = d.workspaces||{}; state.stats = d.stats||null;
    render();
  });
  es.addEventListener("sessions", function(e){ state.sessions = JSON.parse(e.data); render(); });
  es.addEventListener("workspaces", function(e){ state.workspaces = JSON.parse(e.data); render(); });
  es.addEventListener("stats", function(e){ state.stats = JSON.parse(e.data); render(); });
  es.onopen = function(){ setConn("ok","live"); };
  es.onerror = function(){ setConn("bad","reconnecting…"); };
})();
</script>
</body>
</html>`
