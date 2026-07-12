/* ═══════════════════════════════════════════════════════════════════
   CANONICAL DOCUMENT ENGINE — doc-engine.js
   All letterhead, document CSS, and the docShell wrapper live HERE
   and ONLY here. Never add doc styling to dashboard.html or server.js.
   Consumed by: public/dashboard.html (browser) + server.js (Node).
   Editing this file triggers a Render redeploy (~2-3 min).
   ═══════════════════════════════════════════════════════════════════ */
(function(root){

  var LETTERHEAD=''
    +'<div class="lh">'
    +'<img class="logo light" src="https://the-super-1.onrender.com/mullins-logo.png" alt="Mullins Construction">'
    +'<img class="logo dark" src="https://the-super-1.onrender.com/mullins-logo-dark.png" alt="Mullins Construction">'
    +'<div class="co"><div class="name">Mullins Construction Inc.</div>License #855578<br>1702-L Meridian Ave #164, San Jose, CA 95125<br>408.569.3434 &nbsp;&middot;&nbsp; mullinsconstruction@yahoo.com</div>'
    +'</div>';

  var DOC_CSS=''
    +'html,body{margin:0;padding:0;width:100%;min-height:100%;background:#fff}'
    +':root{--ink:#1a1a2e;--paper:#fff;--muted:#556;--line:#e4e8ee;--bar:#0f3d6e;--barink:#fff;--totbg:#f5f7fa;--navy:#0a1a2f;--gold:#e8a020}'
    +'html.dark,html.dark body{background:#0a1a2f}'
    +'html.dark{--ink:#e8ecf4;--paper:#0a1a2f;--muted:#8a94a8;--line:#1e2e4e;--bar:#0f3d6e;--barink:#fff;--totbg:#0f2038;--navy:#050f1e;--gold:#e8a020}'
    +'body{font-family:Arial,Helvetica,sans-serif;color:var(--ink);padding:24px;box-sizing:border-box;background:var(--paper)}'
    +'.wrap{max-width:816px;margin:0 auto}'
    +'.lh{display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap;border-bottom:3px solid var(--navy);padding-bottom:10px;margin-bottom:6px}'
    +'html.dark .lh{border-color:var(--gold)}'
    +'.lh .logo{height:69px;width:auto;flex-shrink:0}'
    +'.lh .logo.dark{display:none}'
    +'html.dark .lh .logo.light{display:none}'
    +'html.dark .lh .logo.dark{display:block}'
    +'.lh .co{text-align:right;font-size:10.5px;color:var(--muted);line-height:1.4}'
    +'.lh .co .name{font-size:14px;font-weight:bold;color:var(--ink);margin-bottom:2px}'
    +'.meta{display:flex;justify-content:space-between;margin:16px 0 6px;font-size:12px;color:var(--ink);gap:10px;flex-wrap:wrap}'
    +'.meta b{color:var(--ink)}'
    +'h2.doc{font-size:13px;color:var(--gold);letter-spacing:.14em;margin:18px 0 4px}'
    +'html:not(.dark) h2.doc{color:#0f3d6e}'
    +'.inv-meta{background:var(--totbg);border:1px solid var(--line);border-radius:6px;padding:10px 14px;font-size:12px;display:flex;gap:24px;flex-wrap:wrap;margin:10px 0}'
    +'.inv-meta b{color:var(--ink)}'
    +'table.sec{width:100%;border-collapse:collapse;margin:14px 0 4px;font-size:12px}'
    +'table.sec td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}'
    +'table.sec .amt{text-align:right;white-space:nowrap;width:110px}'
    +'table.sec tr.hd td{background:var(--bar);color:var(--barink);font-weight:bold;font-size:11px;letter-spacing:.06em;text-transform:uppercase}'
    +'table.sec tr.tot td{font-weight:bold;border-top:2px solid var(--navy);border-bottom:none;background:var(--totbg)}'
    +'html.dark table.sec tr.tot td{border-top-color:var(--gold)}'
    +'.grand{display:flex;justify-content:space-between;align-items:center;background:var(--navy);color:#fff;border-radius:6px;padding:8px 16px;margin-top:18px;gap:8px;flex-wrap:wrap}'
    +'html.dark .grand{border:1px solid var(--gold)}'
    +'.grand .l{font-size:13px;font-weight:bold;letter-spacing:.08em}'
    +'.grand .v{font-size:20px;font-weight:bold;color:var(--gold)}'
    +'.terms{margin-top:14px;font-size:11px;color:var(--muted)}'
    +'.foot{margin-top:26px;font-size:10px;color:var(--muted);border-top:1px solid var(--line);padding-top:10px}'
    +'.noprint{margin:0 0 18px;display:flex;gap:8px;flex-wrap:wrap}'
    +'.noprint button{background:#0f3d6e;color:#fff;border:none;border-radius:6px;padding:9px 16px;font-size:13px;cursor:pointer}'
    +'.noprint button.thm{background:#333c4e}'
    +'@media(max-width:640px){body{padding:14px}.wrap{max-width:100%}.lh .logo{height:44px}.lh .co{font-size:9.5px}.meta{flex-direction:column}.meta>div[style]{text-align:left!important}table.sec{font-size:11px}table.sec td{padding:5px 6px}table.sec .amt{width:84px}.grand .v{font-size:17px}}'
    +'@media print{.noprint{display:none}body{padding:14px}}';

  function docShell(title,inner){
    return '<!DOCTYPE html><html lang="en"><head>'
      +'<meta charset="UTF-8">'
      +'<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">'
      +'<title>'+title+'</title>'
      +'<style>'+DOC_CSS+'</style></head><body>'
      +'<div class="wrap">'
      +'<div class="noprint"><button onclick="window.print()">\uD83D\uDDA8 Print / Save as PDF</button>'
      +'<button class="thm" onclick="document.documentElement.classList.toggle(\'dark\')">\uD83C\uDF13 Light / Dark</button></div>'
      +LETTERHEAD
      +inner
      +'</div></body></html>';
  }

  var DocEngine={LETTERHEAD:LETTERHEAD,DOC_CSS:DOC_CSS,docShell:docShell};

  if(typeof module!=='undefined'&&module.exports){
    module.exports=DocEngine;            // Node / server.js
  }else{
    root.DocEngine=DocEngine;            // Browser / dashboard.html
  }

})(typeof window!=='undefined'?window:this);
