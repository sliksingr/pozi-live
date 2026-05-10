/**
 * POZi Widget v1.0
 * Hosted embed — drop one script tag on any retailer site.
 *
 * Usage:
 *   <script
 *     src="https://pozi.live/pozi-live.js"
 *     data-store-id="ace-lotp"
 *     data-store-name="Lake of the Pines Ace Hardware"
 *     data-store-color="#CC0000"
 *     data-store-badge="ACE"
 *     data-store-sub="Live Inventory · Auburn, CA"
 *   ></script>
 */

(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var cfg = {
    storeId:    script.getAttribute('data-store-id')       || '',
    storeName:  script.getAttribute('data-store-name')     || 'Local Store',
    color:      script.getAttribute('data-store-color')    || '#1a1a2e',
    badge:      script.getAttribute('data-store-badge')    || '',
    sub:        script.getAttribute('data-store-sub')      || 'Live Inventory',
    btnLabel:   script.getAttribute('data-button-label')   || 'Check Live Inventory',
    position:   script.getAttribute('data-button-position')|| 'bottom-right',
    targetEl:   script.getAttribute('data-target')         || '',
  };

  var API = 'https://eaagnkwtflsxiclpcaok.supabase.co/rest/v1';
  var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhYWdua3d0ZmxzeGljbHBjYW9rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4MTIwNjIsImV4cCI6MjA4OTM4ODA2Mn0.SMbN6FiLg-kYMsOYihJTbcDFptT8EB5dM_TJtiMIJnE';
  var SH  = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY };

  var DB = [], Q = '', F = 'all', loaded = false, refreshTimer = null;

  function hex2rgb(hex) {
    var r = parseInt(hex.slice(1,3),16);
    var g = parseInt(hex.slice(3,5),16);
    var b = parseInt(hex.slice(5,7),16);
    return r+','+g+','+b;
  }

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function injectStyles() {
    if (document.getElementById('pozi-widget-styles')) return;
    var c = cfg.color;
    var rgb = hex2rgb(c);
    var css = [
      '#pozi-widget-root *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '#pozi-float-btn{position:fixed;z-index:99998;display:inline-flex;align-items:center;gap:10px;background:'+c+';color:#fff;border:none;border-radius:14px;padding:14px 20px;font-size:14px;font-weight:800;cursor:pointer;box-shadow:0 4px 24px rgba('+rgb+',0.45);transition:transform 0.15s,box-shadow 0.15s;-webkit-tap-highlight-color:transparent;}',
      '#pozi-float-btn:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba('+rgb+',0.5)}',
      '#pozi-float-btn:active{transform:scale(0.97)}',
      '#pozi-float-btn.bottom-right{bottom:20px;right:20px}',
      '#pozi-float-btn.bottom-left{bottom:20px;left:20px}',
      '.pozi-inline-btn{display:inline-flex;align-items:center;gap:10px;background:'+c+';color:#fff;border:none;border-radius:12px;padding:14px 22px;font-size:14px;font-weight:800;cursor:pointer;box-shadow:0 4px 20px rgba('+rgb+',0.35);transition:transform 0.15s;-webkit-tap-highlight-color:transparent;}',
      '.pozi-inline-btn:active{transform:scale(0.97)}',
      '.pozi-inline-powered{font-size:10px;color:rgba(0,0,0,0.4);font-weight:600;margin-top:7px;letter-spacing:0.3px}',
      '.pozi-inline-powered b{color:'+c+';font-weight:800}',
      '.pozi-dot{width:8px;height:8px;border-radius:50%;background:#fff;animation:pozi-blink 1.5s infinite;flex-shrink:0}',
      '.pozi-dot.green{background:#43a047}',
      '@keyframes pozi-blink{0%,100%{opacity:1}50%{opacity:0.35}}',
      '#pozi-float-powered{position:fixed;z-index:99997;font-size:9px;font-weight:700;color:rgba(0,0,0,0.3);letter-spacing:0.3px;pointer-events:none}',
      '#pozi-float-powered.bottom-right{bottom:10px;right:20px;text-align:right}',
      '#pozi-float-powered.bottom-left{bottom:10px;left:20px}',
      '#pozi-float-powered b{color:'+c+'}',
      '#pozi-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:none;flex-direction:column;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}',
      '#pozi-overlay.open{display:flex}',
      '#pozi-modal{background:#fff;flex:1;display:flex;flex-direction:column;overflow:hidden;margin-top:52px;border-radius:20px 20px 0 0;box-shadow:0 -4px 40px rgba(0,0,0,0.18)}',
      '#pozi-modal-bar{padding:13px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:2.5px solid '+c+';flex-shrink:0;gap:8px;background:#fff}',
      '.pozi-modal-logo{display:flex;align-items:center;gap:9px}',
      '.pozi-store-badge{background:'+c+';color:#fff;font-weight:800;font-size:11px;padding:4px 7px;border-radius:4px;letter-spacing:-0.3px;flex-shrink:0}',
      '.pozi-store-name{font-size:13px;font-weight:800;color:#111;line-height:1}',
      '.pozi-store-sub{font-size:10px;color:#999;font-weight:600;margin-top:1px}',
      '.pozi-live-pill{display:flex;align-items:center;gap:5px;background:#f0faf0;border:1px solid #b2dfb2;border-radius:20px;padding:5px 10px;flex-shrink:0}',
      '.pozi-live-dot{width:6px;height:6px;border-radius:50%;background:#43a047;animation:pozi-blink 1.5s infinite}',
      '.pozi-live-txt{font-size:10px;color:#2e7d32;font-weight:700}',
      '.pozi-close{width:32px;height:32px;background:#f5f5f5;border:1px solid #ddd;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#666;font-size:16px;flex-shrink:0;line-height:1;-webkit-tap-highlight-color:transparent}',
      '#pozi-status{padding:8px 14px;font-size:10px;color:#999;font-weight:700;display:flex;align-items:center;gap:6px;flex-shrink:0;border-bottom:1px solid #f0f0f0;letter-spacing:0.5px;text-transform:uppercase;background:#fafafa}',
      '#pozi-status-dot{width:5px;height:5px;border-radius:50%;background:#ffcc00;flex-shrink:0}',
      '#pozi-status-dot.live{background:#43a047;animation:pozi-blink 1.5s infinite}',
      '#pozi-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 0 50px;background:#fff}',
      '.pozi-search-wrap{padding:14px 14px 0;position:relative;margin-bottom:12px}',
      '.pozi-search{width:100%;background:#f5f5f5;border:1.5px solid #e0e0e0;border-radius:12px;padding:13px 16px 13px 42px;font-size:15px;color:#111;outline:none;-webkit-appearance:none;font-family:inherit}',
      '.pozi-search:focus{border-color:'+c+';background:#fff}',
      '.pozi-search::placeholder{color:#aaa}',
      '.pozi-search-icon{position:absolute;left:26px;top:50%;transform:translateY(-50%);color:#aaa;font-size:16px;margin-top:7px;pointer-events:none}',
      '.pozi-filters{display:flex;gap:8px;padding:0 14px 12px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}',
      '.pozi-filters::-webkit-scrollbar{display:none}',
      '.pozi-chip{background:#f5f5f5;border:1.5px solid #e0e0e0;border-radius:20px;padding:7px 14px;font-size:11px;font-weight:700;color:#666;white-space:nowrap;cursor:pointer;flex-shrink:0;transition:all 0.15s;-webkit-tap-highlight-color:transparent}',
      '.pozi-chip.on{background:#fff0f0;border-color:'+c+';color:'+c+'}',
      '.pozi-inv-list{padding:0 14px}',
      '.pozi-item{background:#fff;border:1.5px solid #eee;border-radius:14px;padding:15px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 1px 4px rgba(0,0,0,0.04)}',
      '.pozi-item-left{flex:1;min-width:0}',
      '.pozi-item-sku{font-size:9px;color:#bbb;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:3px}',
      '.pozi-item-name{font-size:14px;font-weight:700;color:#111;line-height:1.3;margin-bottom:4px}',
      '.pozi-item-cat{font-size:10px;color:#aaa;font-weight:600}',
      '.pozi-qty-wrap{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0}',
      '.pozi-qty{font-weight:800;font-size:24px;color:#2e7d32;line-height:1}',
      '.pozi-qty.low{color:#f57c00}.pozi-qty.out{color:#cc0000}',
      '.pozi-qty-label{font-size:9px;color:#bbb;font-weight:700;letter-spacing:0.5px;text-transform:uppercase}',
      '.pozi-empty{text-align:center;padding:48px 20px;color:#bbb;font-size:13px;font-weight:600}',
      '.pozi-loading{text-align:center;padding:48px 20px;color:#ccc;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase}',
      '#pozi-modal-footer{padding:16px;text-align:center;border-top:1px solid #f0f0f0;flex-shrink:0}',
      '#pozi-modal-footer a{font-size:10px;color:#bbb;text-decoration:none;font-weight:700;letter-spacing:0.5px}',
      '#pozi-modal-footer a b{color:'+c+'}',
    ].join('');

    var s = el('style', { id: 'pozi-widget-styles' });
    s.textContent = css;
    document.head.appendChild(s);
  }

  function buildDOM() {
    var root = el('div', { id: 'pozi-widget-root' });

    if (cfg.position === 'inline' && cfg.targetEl) {
      var target = document.querySelector(cfg.targetEl);
      if (target) {
        var wrap = el('div');
        var btn = el('button', { class: 'pozi-inline-btn' });
        btn.innerHTML = '<span class="pozi-dot"></span>' + cfg.btnLabel;
        var powered = el('div', { class: 'pozi-inline-powered' });
        powered.innerHTML = 'Powered by <b>POZi</b> · Real-Time Network';
        wrap.appendChild(btn);
        wrap.appendChild(powered);
        target.appendChild(wrap);
        btn.addEventListener('click', openPortal);
      }
    } else {
      var floatBtn = el('button', { id: 'pozi-float-btn', class: cfg.position, 'aria-label': cfg.btnLabel });
      floatBtn.innerHTML = '<span class="pozi-dot"></span>' + cfg.btnLabel;
      floatBtn.addEventListener('click', openPortal);
      root.appendChild(floatBtn);
      var powered = el('div', { id: 'pozi-float-powered', class: cfg.position });
      powered.innerHTML = 'Powered by <b>POZi</b>';
      root.appendChild(powered);
    }

    var overlay = el('div', { id: 'pozi-overlay' });
    var modal = el('div', { id: 'pozi-modal' });
    var bar = el('div', { id: 'pozi-modal-bar' });
    var logoWrap = el('div', { class: 'pozi-modal-logo' });

    if (cfg.badge) {
      logoWrap.appendChild(el('div', { class: 'pozi-store-badge' }, cfg.badge));
    }

    var nameWrap = el('div');
    nameWrap.innerHTML = '<div class="pozi-store-name">'+cfg.storeName+'</div><div class="pozi-store-sub">'+cfg.sub+'</div>';
    logoWrap.appendChild(nameWrap);
    bar.appendChild(logoWrap);

    var barRight = el('div', { style: 'display:flex;align-items:center;gap:8px' });
    barRight.innerHTML = '<div class="pozi-live-pill"><div class="pozi-live-dot"></div><div class="pozi-live-txt">LIVE</div></div>';
    var closeBtn = el('div', { class: 'pozi-close', id: 'pozi-close', role: 'button', 'aria-label': 'Close' }, '✕');
    closeBtn.addEventListener('click', closePortal);
    barRight.appendChild(closeBtn);
    bar.appendChild(barRight);
    modal.appendChild(bar);

    var status = el('div', { id: 'pozi-status' });
    status.innerHTML = '<div id="pozi-status-dot"></div><span id="pozi-status-txt">Connecting to POZi network...</span>';
    modal.appendChild(status);

    var body = el('div', { id: 'pozi-body' });
    var searchWrap = el('div', { class: 'pozi-search-wrap' });
    searchWrap.innerHTML = '<span class="pozi-search-icon">🔍</span><input class="pozi-search" id="pozi-search" type="search" placeholder="Search inventory..." autocomplete="off"/>';
    body.appendChild(searchWrap);

    var filters = el('div', { class: 'pozi-filters', id: 'pozi-filters' });
    var chips = [
      { f:'all', label:'All Items' }, { f:'Hardware', label:'🔩 Hardware' },
      { f:'Tools', label:'🛠 Tools' }, { f:'Paint', label:'🎨 Paint' },
      { f:'Plumbing', label:'🔧 Plumbing' }, { f:'Electrical', label:'⚡ Electrical' },
      { f:'Lawn', label:'🌿 Lawn' }, { f:'Outdoor', label:'🔥 Outdoor' },
    ];
    chips.forEach(function(chip) {
      var c = el('div', { class:'pozi-chip'+(chip.f==='all'?' on':''), 'data-f':chip.f }, chip.label);
      filters.appendChild(c);
    });
    body.appendChild(filters);

    var invList = el('div', { class:'pozi-inv-list', id:'pozi-inv-list' });
    invList.innerHTML = '<div class="pozi-loading">Loading inventory...</div>';
    body.appendChild(invList);
    modal.appendChild(body);

    var footer = el('div', { id:'pozi-modal-footer' });
    footer.innerHTML = '<a href="https://pozi.live" target="_blank" rel="noopener">Live inventory powered by <b>POZi</b></a>';
    modal.appendChild(footer);

    overlay.appendChild(modal);
    root.appendChild(overlay);
    document.body.appendChild(root);

    document.getElementById('pozi-search').addEventListener('input', function() { Q = this.value; render(); });
    document.getElementById('pozi-filters').addEventListener('click', function(e) {
      var chip = e.target.closest('.pozi-chip');
      if (!chip) return;
      F = chip.getAttribute('data-f');
      document.querySelectorAll('.pozi-chip').forEach(function(c) { c.classList.remove('on'); });
      chip.classList.add('on');
      render();
    });
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closePortal(); });
  }

  function fetchInventory() {
    var url = API + '/inventory?select=*&order=product_name';
    if (cfg.storeId) url += '&store_id=eq.' + encodeURIComponent(cfg.storeId);
    fetch(url, { headers: SH })
      .then(function(r) { return r.ok ? r.json() : []; })
      .then(function(d) {
        DB = Array.isArray(d) ? d : [];
        render();
        var dot = document.getElementById('pozi-status-dot');
        var txt = document.getElementById('pozi-status-txt');
        if (dot) dot.className = 'live';
        if (txt) txt.textContent = DB.length
          ? 'Live · ' + DB.length + ' items · Updates in real time'
          : 'Connected — inventory loading soon';
      })
      .catch(function() {
        var txt = document.getElementById('pozi-status-txt');
        if (txt) txt.textContent = 'Connection error — tap to retry';
      });
  }

  function render() {
    var list = DB.filter(function(d) {
      var qm = !Q || (d.product_name && d.product_name.toLowerCase().indexOf(Q.toLowerCase()) !== -1) || (d.sku && d.sku.toLowerCase().indexOf(Q.toLowerCase()) !== -1);
      var fm = F === 'all' || (d.category && d.category.toLowerCase().indexOf(F.toLowerCase()) !== -1);
      return qm && fm;
    });
    var inv = document.getElementById('pozi-inv-list');
    if (!inv) return;
    if (!list.length) {
      inv.innerHTML = '<div class="pozi-empty">No items found' + (Q ? ' for "' + escHtml(Q) + '"' : '') + '</div>';
      return;
    }
    inv.innerHTML = list.map(function(d) {
      var qty = parseInt(d.quantity) || 0;
      var qc = qty === 0 ? 'out' : qty <= 5 ? 'low' : '';
      var ql = qty === 0 ? 'Out of Stock' : qty <= 5 ? 'Low Stock' : 'In Stock';
      return '<div class="pozi-item"><div class="pozi-item-left"><div class="pozi-item-sku">'+escHtml(d.sku||'')+'</div><div class="pozi-item-name">'+escHtml(d.product_name||'')+'</div><div class="pozi-item-cat">'+escHtml(d.category||'')+(d.location?' · '+escHtml(d.location):'')+'</div></div><div class="pozi-qty-wrap"><div class="pozi-qty '+qc+'">'+qty+'</div><div class="pozi-qty-label">'+ql+'</div></div></div>';
    }).join('');
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function openPortal() {
    var overlay = document.getElementById('pozi-overlay');
    if (!overlay) return;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (!loaded) { fetchInventory(); loaded = true; }
    refreshTimer = setInterval(fetchInventory, 30000);
  }

  function closePortal() {
    var overlay = document.getElementById('pozi-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  window.POZi = { open: openPortal, close: closePortal,
    setFilter: function(dept) {
      F = dept || 'all';
      document.querySelectorAll('.pozi-chip').forEach(function(c) { c.classList.toggle('on', c.getAttribute('data-f') === F); });
      render(); openPortal();
    }
  };

  function init() {
    if (!cfg.storeId) console.warn('[POZi] Missing data-store-id on widget script tag.');
    injectStyles();
    buildDOM();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
