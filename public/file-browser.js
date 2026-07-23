/* ── Reusable File Browser component (docs modal, floaters, anywhere files attach) ── */
(function(){
  if (window.__fileBrowserInit) return; window.__fileBrowserInit = true;

  function qsFromScope(s){
    if (!s) return '';
    if (s.clientAll) return 'clientAll=' + encodeURIComponent(s.clientAll) + '&only=' + (s.mode || 'docs');
    if (s.lead)      return 'lead='    + encodeURIComponent(s.lead);
    if (s.client)    return 'client='  + encodeURIComponent(s.client);
    if (s.project === '__unfiled__') return 'project=__unfiled__';
    if (s.project)   return 'project=' + encodeURIComponent(s.project);
    return '';
  }
  function scopeToOwner(s){
    if (s.clientAll) return { client: s.clientAll };
    if (s.lead) return { lead: s.lead };
    if (s.client) return { client: s.client };
    if (s.project && s.project !== '__unfiled__') return { project: s.project };
    return {};
  }
  function isImg(d){ return /^image\//.test(d.mimeType || ''); }
  function iconFor(d){
    const m = d.mimeType || '';
    if (/pdf/.test(m)) return '\u{1F4D5}';
    if (/word|document/.test(m)) return '\u{1F4D8}';
    if (/sheet|excel|csv/.test(m)) return '\u{1F4D7}';
    if (/text/.test(m)) return '\u{1F4C4}';
    if (d.kind === 'generated') return '\u{1F9FE}';
    return '\u{1F4C4}';
  }
  function titleOf(d){ return (d.meta && d.meta.title) || d.title || d.name || 'Untitled'; }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }
  function fmtSize(n){ n=+n||0; return n>1048576 ? (n/1048576).toFixed(1)+' MB' : n>1024 ? Math.round(n/1024)+' KB' : n+' B'; }

  function shrinkImage(file){
    return new Promise((resolve,reject)=>{
      const r = new FileReader();
      r.onload = () => { const img = new Image();
        img.onload = () => {
          const max = 1600; let w = img.width, h = img.height;
          if (w > max || h > max){ const sc = Math.min(max/w, max/h); w = Math.round(w*sc); h = Math.round(h*sc); }
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve({ data: c.toDataURL('image/jpeg', 0.82).split(',')[1], type: 'image/jpeg' });
        };
        img.onerror = reject; img.src = r.result; };
      r.onerror = reject; r.readAsDataURL(file);
    });
  }
  function fileToB64(file){ return new Promise((resolve,reject)=>{ const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.onerror = reject; r.readAsDataURL(file); }); }

  window.renderFileBrowser = function(container, scope, opts){
    opts = opts || {};
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!el) return;
    let view = el.dataset.fbView || 'gallery';
    el.classList.add('fb-root');
    el.innerHTML =
      '<div class="fb-bar"><div class="fb-tools"></div><div class="fb-spacer"></div>'
      + '<button class="fb-btn" data-fb="upload">\u2B06 Upload</button>'
      + '<button class="fb-btn" data-fb="photo">\u{1F4F7} Take Photo</button>'
      + '<button class="fb-btn" data-fb="view">' + (view==='gallery'?'\u2630 List':'\u25A6 Gallery') + '</button></div>'
      + '<input type="file" class="fb-file" accept="image/*,.pdf,.docx,.xlsx,.xls,.csv,.tsv,.txt,.md" multiple style="display:none">'
      + '<input type="file" class="fb-cam" accept="image/*" capture="environment" style="display:none">'
      + '<div class="fb-status"></div><div class="fb-items"></div>';

    const itemsEl = el.querySelector('.fb-items'), statusEl = el.querySelector('.fb-status');
    const fileInput = el.querySelector('.fb-file'), camInput = el.querySelector('.fb-cam');
    function setStatus(t){ statusEl.textContent = t || ''; if (t) setTimeout(()=>{ if(statusEl.textContent===t) statusEl.textContent=''; }, 2500); }

    async function load(){
      itemsEl.innerHTML = '<div class="fb-empty">Loading\u2026</div>';
      try {
        const res = await fetch('/api/docs?' + qsFromScope(scope));
        let docs = await res.json(); if (!Array.isArray(docs)) docs = [];
        if (scope.only === 'photos') docs = docs.filter(isImg);
        else if (scope.only === 'docs') docs = docs.filter(function(d){ return !isImg(d); });
        if (typeof opts.extraDocs === 'function'){ docs = docs.concat(opts.extraDocs() || []); docs.sort(function(a,b){ return new Date(b.uploadedAt||0) - new Date(a.uploadedAt||0); }); }
        render(docs);
      }
      catch(e){ itemsEl.innerHTML = '<div class="fb-empty">Could not load files.</div>'; }
    }
    el._fbReload = load;

    function render(docs){
      el.dataset.fbView = view;
      itemsEl.className = 'fb-items ' + (view === 'gallery' ? 'fb-gallery' : 'fb-list');
      if (!docs.length){ itemsEl.innerHTML = '<div class="fb-empty">No files yet. Upload or take a photo to add one.</div>'; return; }
      itemsEl.innerHTML = docs.map(d => {
        const t = esc(titleOf(d));
        const thumb = isImg(d) ? '<img class="fb-thumb" loading="lazy" src="/api/docs/' + d.id + '/view" alt="">'
                               : '<div class="fb-thumb fb-generic">' + iconFor(d) + '</div>';
        const sub = esc((d.docType && d.docType!=='file' ? d.docType.toUpperCase()+' \u00B7 ' : '') + fmtSize(d.size));
        const extra = (opts.tileActions ? opts.tileActions(d) : '');
        const acts = d.sig
          ? '<button class="fb-a" data-a="view" title="View">\u{1F441}\uFE0F</button>'
          : '<button class="fb-a" data-a="view" title="View">\u{1F441}\uFE0F</button><button class="fb-a" data-a="rename" title="Edit title">\u270F\uFE0F</button><button class="fb-a" data-a="del" title="Delete">\u{1F5D1}\uFE0F</button>';
        return '<div class="fb-item" data-id="' + (d.id || '') + '"' + (d.sig ? ' data-sig="1" data-token="' + esc(d.token || '') + '"' : '') + '>' + thumb
          + '<div class="fb-meta"><div class="fb-title" title="'+t+'">'+t+'</div><div class="fb-sub">'+sub+'</div></div>'
          + '<div class="fb-actions">' + acts + extra + '</div></div>';
      }).join('');
    }

    itemsEl.addEventListener('click', async function(e){
      const btn = e.target.closest('.fb-a'); if (!btn) return;
      const item = e.target.closest('.fb-item'); if (!item) return;
      const id = item.dataset.id;
      const a = btn.dataset.a;
      if (a === 'view'){ window.open(item.dataset.sig ? ('/proposal/' + item.dataset.token) : ('/api/docs/' + id + '/view'), '_blank'); return; }
      if (!id) return;
      else if (a === 'del'){ if (!confirm('Delete this file? This cannot be undone.')) return;
        try { await fetch('/api/docs/' + id, { method:'DELETE' }); load(); if (opts.onChange) opts.onChange(); } catch(err){ setStatus('Delete failed'); } }
      else if (a === 'rename'){
        const cur = item.querySelector('.fb-title').textContent;
        const nt = prompt('Display title for this file:', cur); if (nt == null) return;
        try { await fetch('/api/docs/meta', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: id, meta: { title: nt.trim() } }) }); load(); }
        catch(err){ setStatus('Could not save title'); }
      }
    });

    async function uploadFiles(files){
      const arr = [...files]; if (!arr.length) return; let done = 0;
      for (const file of arr){
        setStatus('Uploading ' + (done+1) + ' of ' + arr.length + '\u2026');
        try {
          let data, mimeType;
          if (/^image\//.test(file.type)){ const sh = await shrinkImage(file); data = sh.data; mimeType = sh.type; }
          else { data = await fileToB64(file); mimeType = file.type || 'application/octet-stream'; }
          const body = Object.assign({}, scopeToOwner(scope), { name: file.name, mimeType: mimeType, data: data, docType: 'file' });
          await fetch('/api/docs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          done++;
        } catch(err){}
      }
      setStatus('Uploaded ' + done + ' file' + (done===1?'':'s') + ' \u2713');
      load(); if (opts.onChange) opts.onChange();
    }

    el.querySelector('.fb-bar').addEventListener('click', function(e){
      const b = e.target.closest('.fb-btn'); if (!b) return;
      const act = b.dataset.fb;
      if (act === 'upload') fileInput.click();
      else if (act === 'photo') camInput.click();
      else if (act === 'view'){ view = (view === 'gallery' ? 'list' : 'gallery'); b.textContent = (view==='gallery'?'\u2630 List':'\u25A6 Gallery'); load(); }
    });
    fileInput.addEventListener('change', e => { uploadFiles(e.target.files); e.target.value=''; });
    camInput.addEventListener('change', e => { uploadFiles(e.target.files); e.target.value=''; });

    load();
  };

  const css = document.createElement('style');
  css.textContent =
    '.fb-root{display:flex;flex-direction:column;height:100%;min-height:0}'
  + '.fb-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2a3a5e;flex-shrink:0}'
  + '.fb-tools{display:flex;gap:6px}.fb-spacer{flex:1}'
  + '.fb-btn{background:#0f3460;border:1px solid #2a3a5e;border-radius:7px;color:#cdd;font-size:12px;padding:6px 11px;cursor:pointer;white-space:nowrap}'
  + '.fb-btn:hover{color:#fff}'
  + '.fb-status{font-size:12px;color:#2ecc40;padding:0 12px}.fb-status:not(:empty){padding:6px 12px}'
  + '.fb-items{overflow:auto;flex:1;padding:12px}'
  + '.fb-empty{color:#889;font-size:13px;text-align:center;padding:30px 12px}'
  + '.fb-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;align-content:start}'
  + '.fb-gallery .fb-item{display:flex;flex-direction:column;background:#0f1a2e;border:1px solid #2a3a5e;border-radius:10px;overflow:hidden}'
  + '.fb-gallery .fb-thumb{width:100%;height:120px;object-fit:cover;background:#0b1220}'
  + '.fb-gallery .fb-generic{display:flex;align-items:center;justify-content:center;font-size:44px}'
  + '.fb-gallery .fb-meta{padding:8px 10px;flex:1}'
  + '.fb-gallery .fb-actions{display:flex;gap:2px;padding:6px 8px;border-top:1px solid #2a3a5e;justify-content:flex-end}'
  + '.fb-list{display:flex;flex-direction:column;gap:6px}'
  + '.fb-list .fb-item{display:flex;align-items:center;gap:12px;background:#0f1a2e;border:1px solid #2a3a5e;border-radius:8px;padding:8px 10px}'
  + '.fb-list .fb-thumb{width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0;background:#0b1220}'
  + '.fb-list .fb-generic{display:flex;align-items:center;justify-content:center;font-size:24px}'
  + '.fb-list .fb-meta{flex:1;min-width:0}.fb-list .fb-actions{display:flex;gap:2px;flex-shrink:0}'
  + '.fb-title{font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
  + '.fb-sub{font-size:11px;color:#889;margin-top:2px}'
  + '.fb-a{background:none;border:none;cursor:pointer;font-size:14px;padding:3px 5px;border-radius:5px;opacity:.8}'
  + '.fb-a:hover{opacity:1;background:rgba(255,255,255,.1)}'
  + 'html.light .fb-gallery .fb-item,html.light .fb-list .fb-item{background:#f4f6fa}';
  document.head.appendChild(css);
})();
