// ==UserScript==
// @name         My Survey Control
// @namespace    my-survey-guard
// @version      1.4.0
// @description  Admin Approval + Blocklist + Repeat-survey detection + 7/15/30-day locks
// @match        *://*/*
// @noframes
// @updateURL    https://raw.githubusercontent.com/sagorking1/my-survey-guard/main/my-survey-control.user.js
// @downloadURL  https://raw.githubusercontent.com/sagorking1/my-survey-guard/main/my-survey-control.user.js
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

// নোট: @name আর @namespace কখনো বদলাবেন না। বদলালে Access ID আর সংরক্ষিত ডেটা নতুন করে শুরু হবে।
// নেটওয়ার্ক শুধু GitHub-এর config.json পড়তে ও Update যাচাইয়ে ব্যবহার হয়। Survey Log শুধু আপনার ব্রাউজারে থাকে।

(function () {
  'use strict';

  const GITHUB_USER = 'sagorking1';
  const GITHUB_REPO = 'my-survey-guard';

  const SCRIPT_VERSION = '1.4.0';
  const CONFIG_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/config.json`;
  const REFRESH_MS = 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;

  // ================= Pure helpers (পরীক্ষাযোগ্য অংশ) =================
  // <PURE>
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  const alnum = (s) => norm(s).replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function stripUrl(s) {
    return String(s || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Blocklist মেলানো। মিললে কারণ (লেখা) ফেরত দেয়, নাহলে null।
  //  blockedDomains : "example.com" = ওই domain ও সব subdomain; "site.com/path" = URL ওই দিয়ে শুরু/ওই অংশ থাকলে
  //  blockedSurveys : "p::টুকরো" = URL-এ ওই অংশ থাকলে | "u::টুকরো" = URL ওই দিয়ে শুরু হলে
  //                   "id::প্ল্যাটফর্ম::আইডি" = URL-এ ওই আইডি থাকলে
  //  blockedKeywords: URL ও পেজ Title-এ যেকোনো জায়গায়; পেজের লেখায় (শুধু Survey-মতো পেজে) পূর্ণ শব্দ হিসেবে
  function matchBlocklist(cfg, host, url, title, bodyText) {
    host = stripUrl(host);
    url = stripUrl(url);
    const safe = (cfg.safeDomains || []).map(stripUrl).filter(Boolean);
    if (safe.some((d) => host === d || host.endsWith('.' + d))) return null;

    for (const raw of cfg.blockedDomains || []) {
      const d = stripUrl(raw);
      if (!d) continue;
      if (d.includes('/')) { if (url.includes(d)) return 'Domain: ' + raw; }
      else if (host === d || host.endsWith('.' + d)) return 'Domain: ' + raw;
    }
    for (const raw of cfg.blockedSurveys || []) {
      const parts = String(raw).split('::');
      const type = (parts[0] || '').toLowerCase();
      const value = stripUrl(parts.slice(type === 'id' ? 2 : 1).join('::'));
      if (!value) continue;
      if (type === 'u') { if (url.startsWith(value)) return 'Survey: ' + raw; }
      else if (type === 'p' || type === 'id') { if (url.includes(value)) return 'Survey: ' + raw; }
    }
    const t = norm(title);
    const kws = (cfg.blockedKeywords || []).map(norm).filter(Boolean);
    for (const k of kws) { if (url.includes(k) || t.includes(k)) return 'Keyword: ' + k; }
    if (bodyText) {
      const b = norm(bodyText);
      for (const k of kws) {
        const re = new RegExp('(^|[^\\p{L}\\p{M}\\p{N}])' + escRe(k) + '($|[^\\p{L}\\p{M}\\p{N}])', 'u');
        if (re.test(b)) return 'Keyword: ' + k;
      }
    }
    return null;
  }
  function similarCount(a, b) {
    const set = new Set(b);
    let n = 0;
    for (const h of new Set(a)) if (set.has(h)) n++;
    return n;
  }
  // সাধারণ প্রশ্ন (বয়স/লিঙ্গ) যেন ভুল সতর্কতা না দেয়, তাই অন্তত ৩-৪টি প্রশ্ন মিলতে হবে
  function isRepeat(shared, lenA, lenB) {
    const m = Math.min(lenA, lenB);
    return shared >= 4 || (shared >= 3 && m > 0 && shared / m >= 0.5);
  }
  // </PURE>

  // ================= Storage =================
  const load = (k, d) => { try { const v = GM_getValue(k, ''); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = (k, v) => { try { GM_setValue(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const ssGet = (k) => { try { return sessionStorage.getItem('msc:' + k); } catch (e) { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem('msc:' + k, v); } catch (e) { /* ignore */ } };

  // ---------- Access ID (একবার তৈরি হয়, সংরক্ষিত থাকে) ----------
  function getAccessId() {
    let id = GM_getValue('accessId', '');
    if (!id) {
      const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)))
        .map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
      id = `MSC-${rnd(4)}-${rnd(4)}-${rnd(4)}`;
      GM_setValue('accessId', id);
    }
    return id;
  }
  const ACCESS_ID = getAccessId();

  // ---------- State ----------
  let status = 'PENDING'; // PENDING | ACTIVE | BLOCKED | ERROR
  let latestVersion = SCRIPT_VERSION;
  let updateUrl = '';
  let lastError = '';
  let cfg = {};
  let cfgStamp = '';
  let featuresStarted = false;
  let collapsed = GM_getValue('collapsed', '0') === '1';

  // "1.3.10" > "1.3.9" এভাবে সংখ্যা ধরে তুলনা
  function isNewer(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  // ---------- Config আনা ----------
  function fetchConfig() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: CONFIG_URL + '?t=' + Date.now(),
        headers: { 'Cache-Control': 'no-cache' },
        timeout: 15000,
        onload: (r) => {
          try {
            if (r.status !== 200) return reject(new Error('HTTP ' + r.status));
            resolve(JSON.parse(r.responseText));
          } catch (e) { reject(e); }
        },
        onerror: reject,
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  async function refreshStatus() {
    const prev = status;
    let cfgChanged = false;
    try {
      const c = await fetchConfig();
      const list = (a) => (Array.isArray(a) ? a.map(String) : []);
      const blocked = list(c.blockedIds);
      const allowed = list(c.allowedIds);
      cfg = c;
      const stamp = JSON.stringify(c);
      cfgChanged = stamp !== cfgStamp;
      cfgStamp = stamp;
      latestVersion = c.latestVersion || SCRIPT_VERSION;
      updateUrl = c.updateUrl || '';
      if (blocked.includes(ACCESS_ID)) status = 'BLOCKED';
      else if (allowed.includes(ACCESS_ID)) status = 'ACTIVE';
      else status = 'PENDING'; // allowedIds ছাড়া কেউ ACTIVE নয় (খালি লিস্টেও)
      lastError = '';
    } catch (e) {
      status = 'ERROR'; // সংযোগ না থাকলে কখনোই ACTIVE নয়
      lastError = (e && e.message) ? e.message : String(e && e.error ? e.error : e);
    }
    render();
    if (status === 'ACTIVE') {
      const started = startProtectedFeatures();
      if (!started && cfgChanged) checkPage();
    } else {
      stopProtectedFeatures();
    }
    if (prev !== status || !menusReady) setMenus();
  }

  // ================= UI helpers =================
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(text, fn) {
    const b = el('button', 'margin:4px 4px 0 0;padding:4px 8px;border:1px solid #888;border-radius:6px;background:#f3f4f6;color:#111;cursor:pointer;font-size:12px', text);
    b.onclick = fn;
    return b;
  }
  const fmt = (t) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  function toast(msg) {
    const old = document.getElementById('msc-toast');
    if (old) old.remove();
    const t = el('div', 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;padding:8px 12px;border-radius:8px;font:13px Arial,sans-serif', msg);
    t.id = 'msc-toast';
    document.documentElement.append(t);
    setTimeout(() => t.remove(), 3500);
  }
  function removeOverlay() { const o = document.getElementById('msc-overlay'); if (o) o.remove(); }
  function removeBanner() { const o = document.getElementById('msc-banner'); if (o) o.remove(); }

  function showOverlay(title, lines) {
    removeOverlay();
    const ov = el('div', 'position:fixed;inset:0;z-index:2147483646;background:rgba(127,29,29,.96);display:flex;align-items:center;justify-content:center;font:16px/1.5 Arial,sans-serif;color:#111');
    ov.id = 'msc-overlay';
    const card = el('div', 'background:#fff;max-width:520px;margin:16px;padding:22px;border-radius:12px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)');
    card.append(el('div', 'font-size:42px', '⛔'), el('h2', 'margin:8px 0;color:#b91c1c;font-size:20px', title));
    lines.forEach((l) => card.append(el('p', 'margin:6px 0;color:#333;word-break:break-word', l)));
    card.append(
      btn('← পিছনে যান', () => { if (history.length > 1) history.back(); else location.href = 'about:blank'; }),
      btn('এবারের জন্য উপেক্ষা করুন', () => { ssSet('ignore:' + urlKey(), '1'); removeOverlay(); scheduleRepeatCheck(); })
    );
    ov.append(card);
    document.documentElement.append(ov);
  }

  function showBanner(text) {
    removeBanner();
    const b = el('div', 'position:fixed;top:0;left:0;right:0;z-index:2147483645;background:#fef3c7;color:#78350f;border-bottom:2px solid #f59e0b;padding:8px 40px 8px 12px;font:14px/1.4 Arial,sans-serif;text-align:center');
    b.id = 'msc-banner';
    b.append(document.createTextNode(text));
    const x = el('span', 'position:absolute;right:12px;top:6px;cursor:pointer;font-size:18px', '×');
    x.onclick = removeBanner;
    b.append(x);
    document.documentElement.append(b);
  }

  // ---------- Panel ----------
  const COLORS = { PENDING: '#f59e0b', ACTIVE: '#16a34a', BLOCKED: '#dc2626', ERROR: '#6b7280' };
  const LABELS = {
    PENDING: 'PENDING – Admin Approval-এর অপেক্ষায়',
    ACTIVE: 'ACTIVE – ব্যবহার করা যাবে',
    BLOCKED: 'BLOCKED – Admin ব্লক করেছেন',
    ERROR: 'VERIFICATION ERROR – যাচাই করা যায়নি',
  };

  const box = el('div', 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#fff;color:#111;border:2px solid #999;border-radius:10px;font:13px/1.4 Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25)');
  box.id = 'msc-box';
  document.body.appendChild(box);

  function setCollapsed(v) { collapsed = v; GM_setValue('collapsed', v ? '1' : '0'); render(); }

  function render() {
    box.innerHTML = '';
    box.style.borderColor = COLORS[status];
    if (collapsed) {
      box.style.width = 'auto';
      box.style.padding = '4px 10px';
      const pill = el('span', 'cursor:pointer;font-size:12px;font-weight:bold;color:' + COLORS[status], '● MSC ' + status);
      pill.onclick = () => setCollapsed(false);
      box.append(pill);
      return;
    }
    box.style.width = '280px';
    box.style.padding = '10px';

    const head = el('div', 'display:flex;justify-content:space-between;align-items:center');
    const title = el('div');
    title.innerHTML = '<b>My Survey Control</b> v' + SCRIPT_VERSION;
    const min = el('span', 'cursor:pointer;font-size:16px;padding:0 4px', '–');
    min.title = 'ছোট করুন';
    min.onclick = () => setCollapsed(true);
    head.append(title, min);

    const st = el('div', `margin:6px 0;padding:4px 6px;border-radius:6px;color:#fff;background:${COLORS[status]}`, LABELS[status]);
    const idLine = el('div');
    idLine.innerHTML = 'Access ID:<br><code style="user-select:all">' + ACCESS_ID + '</code>';
    box.append(head, st, idLine);

    if (status === 'ACTIVE') {
      const n = (a) => (Array.isArray(a) ? a.length : 0);
      box.append(el('div', 'margin-top:4px;font-size:11px;color:#555',
        `Blocklist: ${n(cfg.blockedDomains)} domain, ${n(cfg.blockedKeywords)} keyword, ${n(cfg.blockedSurveys)} survey`));
    }

    box.append(btn('Copy ID', copyId));
    box.append(btn('Refresh', refreshStatus));
    box.append(btn('Check Update', checkUpdate));

    if (status === 'PENDING') {
      box.append(el('div', 'margin-top:6px;font-size:12px;color:#555', 'Admin-কে এই Access ID পাঠান। Approve না হওয়া পর্যন্ত Script বন্ধ থাকবে।'));
    }
  }

  function copyId() { GM_setClipboard(ACCESS_ID); alert('Access ID কপি হয়েছে'); }

  async function checkUpdate() {
    await refreshStatus(); // সবসময় GitHub থেকে নতুন করে যাচাই
    if (status === 'ERROR') {
      alert('Update যাচাই করা যায়নি।\nকারণ: ' + (lastError || 'অজানা') +
        '\n\nGitHub repo public আছে কিনা, config.json আপলোড হয়েছে কিনা এবং ইন্টারনেট ঠিক আছে কিনা দেখুন।');
      return;
    }
    if (isNewer(latestVersion, SCRIPT_VERSION)) {
      if (!updateUrl) { alert(`নতুন সংস্করণ ${latestVersion} আছে, কিন্তু config.json-এ updateUrl নেই।`); return; }
      if (confirm(`নতুন সংস্করণ ${latestVersion} পাওয়া গেছে (আপনার: ${SCRIPT_VERSION})।\nইনস্টল পেজ খুলবেন?`)) {
        try { GM_openInTab(updateUrl, { active: true }); } catch (e) { window.open(updateUrl, '_blank'); }
      }
    } else {
      alert(`আপনি সর্বশেষ সংস্করণেই আছেন।\nআপনার: ${SCRIPT_VERSION} | GitHub-এ: ${latestVersion}`);
    }
  }

  // ================= Page helpers =================
  function urlKey() { return (location.host + location.pathname).toLowerCase().replace(/^www\./, '').replace(/\/+$/, ''); }
  function hostKey() { return location.hostname.toLowerCase().replace(/^www\./, ''); }
  function radioCount() { return document.querySelectorAll('input[type=radio], input[type=checkbox]').length; }
  function isSurveyLike() { return radioCount() >= 2; }

  // ================= Locks (৭/১৫/৩০ দিন) =================
  function lockKey(scope) { return scope === 'site' ? 'site:' + hostKey() : 'survey:' + urlKey(); }
  function getLocks() {
    const locks = load('locks', {});
    const now = Date.now();
    let changed = false;
    Object.keys(locks).forEach((k) => { if (!locks[k] || locks[k].until <= now) { delete locks[k]; changed = true; } });
    if (changed) save('locks', locks);
    return locks;
  }
  function addLock(scope, days) {
    const locks = getLocks();
    locks[lockKey(scope)] = { until: Date.now() + days * DAY, days, set: Date.now() };
    save('locks', locks);
    toast(`🔒 ${scope === 'site' ? 'এই Site' : 'এই Survey'} ${days} দিনের জন্য লক হয়েছে`);
    ssSet('ignore:' + urlKey(), '');
    checkPage();
  }
  function unlockHere() {
    const locks = getLocks();
    let n = 0;
    ['survey', 'site'].forEach((s) => { if (locks[lockKey(s)]) { delete locks[lockKey(s)]; n++; } });
    save('locks', locks);
    toast(n ? '🔓 লক খোলা হয়েছে' : 'এই পেজে কোনো লক নেই');
    removeOverlay();
  }
  function activeLock() {
    const locks = getLocks();
    return locks[lockKey('survey')] || locks[lockKey('site')] || null;
  }
  function showLocks() {
    const locks = getLocks();
    const keys = Object.keys(locks);
    if (!keys.length) { alert('কোনো লক নেই।'); return; }
    const now = Date.now();
    alert('চালু লক:\n\n' + keys.map((k) => `${k}\n   বাকি ${Math.ceil((locks[k].until - now) / DAY)} দিন (শেষ: ${fmt(locks[k].until)})`).join('\n\n'));
  }

  // ================= Repeat survey detection =================
  function labelText(inp) {
    let t = '';
    try {
      if (inp.id) { const l = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]'); if (l) t = l.innerText; }
      if (!t) { const l = inp.closest('label'); if (l) t = l.innerText; }
      if (!t && inp.nextSibling) t = inp.nextSibling.textContent || '';
      if (!t && inp.parentElement) t = inp.parentElement.innerText;
    } catch (e) { /* ignore */ }
    return norm(t).slice(0, 120);
  }
  function questionText(first, opts) {
    let node = first.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      const lines = (node.innerText || '').split('\n').map(norm).filter(Boolean);
      const q = lines.find((l) => l.length > 3 && !opts.includes(l));
      if (q) return q.slice(0, 200);
    }
    return '';
  }
  function extractQuestions() {
    const groups = new Map();
    document.querySelectorAll('input[type=radio], input[type=checkbox]').forEach((inp) => {
      if (inp.closest('#msc-box, #msc-overlay, #msc-banner')) return;
      const key = inp.name ? 'n:' + inp.name : inp.closest('fieldset,[role=radiogroup],li,div');
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inp);
    });
    const out = [];
    for (const els of groups.values()) {
      if (out.length >= 40) break;
      const opts = els.map(labelText).filter(Boolean);
      if (opts.length < 2) continue;
      const q = questionText(els[0], opts);
      if (!q) continue;
      out.push({ h: hash(alnum(q) + '|' + opts.map(alnum).sort().join(',')) });
    }
    return out;
  }

  let idChecked = false;
  const warned = new Set();
  let repeatTimer = null;
  function scheduleRepeatCheck() {
    clearTimeout(repeatTimer);
    repeatTimer = setTimeout(runRepeatCheck, 1500);
  }
  function runRepeatCheck() {
    if (status !== 'ACTIVE' || !isSurveyLike() || document.getElementById('msc-overlay')) return;
    const qs = extractQuestions();
    if (!qs.length) return;
    const now = Date.now();
    const id = urlKey();
    const list = load('surveys', []);
    let cur = list.find((s) => s.id === id);

    if (!idChecked) {
      idChecked = true;
      if (cur && now - cur.last > 2 * 3600 * 1000 && !warned.has('same')) {
        warned.add('same');
        showBanner('⚠️ এই Survey আগেও খুলেছিলেন (শেষবার: ' + fmt(cur.last) + ')। আবার করার আগে নিশ্চিত হোন।');
      }
    }
    const merged = [...new Set([...(cur ? cur.q || [] : []), ...qs.map((q) => q.h)])].slice(-300);
    if (!warned.has('similar')) {
      for (const o of list) {
        if (o.id === id) continue;
        const oq = o.q || [];
        if (isRepeat(similarCount(merged, oq), merged.length, oq.length)) {
          warned.add('similar');
          showBanner(`⚠️ এই Survey-র প্রশ্ন আগের একটি Survey-র সাথে মিলছে (${o.host}, ${fmt(o.last)})। সম্ভবত আগে করা হয়েছে।`);
          break;
        }
      }
    }
    if (!cur) { cur = { id, host: location.hostname, title: '', q: [], first: now, last: now }; list.push(cur); }
    cur.q = merged;
    cur.last = now;
    cur.title = (document.title || '').slice(0, 80);
    list.sort((a, b) => a.last - b.last);
    save('surveys', list.slice(-400));
  }
  function showLog() {
    const list = load('surveys', []).slice().sort((a, b) => b.last - a.last).slice(0, 20);
    if (!list.length) { alert('এখনো কোনো Survey Log নেই।'); return; }
    alert('সর্বশেষ Survey (সর্বোচ্চ ২০টি):\n\n' + list.map((s) => `${fmt(s.last)}  ${s.host}\n   ${s.title || '-'}  (${(s.q || []).length} প্রশ্ন)`).join('\n\n'));
  }
  function clearLog() {
    if (confirm('Survey Log মুছে ফেলবেন? (লক মুছবে না)')) { save('surveys', []); toast('Log মুছে ফেলা হয়েছে'); }
  }

  // ================= মূল পরীক্ষা =================
  function checkPage() {
    removeOverlay();
    if (status !== 'ACTIVE') return;
    const ignored = ssGet('ignore:' + urlKey()) === '1';
    if (!ignored) {
      const lock = activeLock();
      if (lock) {
        showOverlay('এই পেজ লক করা আছে', [
          `আর ${Math.ceil((lock.until - Date.now()) / DAY)} দিন বাকি (শেষ: ${fmt(lock.until)})`,
          'লক খুলতে Tampermonkey মেনু থেকে "লক খুলুন" চাপুন।',
        ]);
        return;
      }
      const hit = matchBlocklist(
        cfg, location.hostname, location.host + location.pathname + location.search, document.title,
        isSurveyLike() ? (document.body && document.body.innerText || '').slice(0, 20000) : ''
      );
      if (hit) {
        showOverlay('Blocklist-এ আছে', [cfg.message || 'এই survey/website blocklist-এ আছে। এখানে কাজ বা survey continue করবেন না।', hit]);
        return;
      }
    }
    scheduleRepeatCheck();
  }

  // ================= Protected Features =================
  let observer = null;
  let hrefTimer = null;
  let lastHref = '';

  function startProtectedFeatures() {
    if (featuresStarted) return false;
    featuresStarted = true;
    lastHref = location.href;
    checkPage();
    try {
      observer = new MutationObserver((muts) => {
        const outside = muts.some((m) => {
          const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
          return !(t && t.closest && t.closest('#msc-box,#msc-overlay,#msc-banner,#msc-toast'));
        });
        if (outside) scheduleRepeatCheck();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    hrefTimer = setInterval(() => {
      if (location.href !== lastHref) { lastHref = location.href; idChecked = false; warned.clear(); checkPage(); }
    }, 1500);
    return true;
  }
  function stopProtectedFeatures() {
    if (!featuresStarted) return;
    featuresStarted = false;
    if (observer) { observer.disconnect(); observer = null; }
    clearInterval(hrefTimer);
    clearTimeout(repeatTimer);
    removeOverlay();
    removeBanner();
  }

  // ================= Tampermonkey মেনু =================
  let menuIds = [];
  let menusReady = false;
  function clearMenus() {
    menuIds.forEach((id) => { try { GM_unregisterMenuCommand(id); } catch (e) { /* ignore */ } });
    menuIds = [];
  }
  function setMenus() {
    clearMenus();
    menusReady = true;
    const add = (t, f) => { try { menuIds.push(GM_registerMenuCommand(t, f)); } catch (e) { /* ignore */ } };
    add('📋 Access ID কপি', copyId);
    add('🔄 Check Update', checkUpdate);
    add('ℹ️ Status দেখুন', () => alert(`Status: ${LABELS[status]}\nAccess ID: ${ACCESS_ID}\nVersion: ${SCRIPT_VERSION}`));
    if (status === 'ACTIVE') {
      add('🔒 এই Survey ৭ দিন লক', () => addLock('survey', 7));
      add('🔒 এই Survey ১৫ দিন লক', () => addLock('survey', 15));
      add('🔒 এই Survey ৩০ দিন লক', () => addLock('survey', 30));
      add('🔒 এই Site ৩০ দিন লক', () => addLock('site', 30));
      add('🔓 এই পেজের লক খুলুন', unlockHere);
      add('📃 লক তালিকা', showLocks);
      add('📊 Survey Log', showLog);
      add('🚫 Blocklist তথ্য', () => {
        const n = (a) => (Array.isArray(a) ? a.length : 0);
        alert(`Blocklist:\n• Domain: ${n(cfg.blockedDomains)}\n• Keyword: ${n(cfg.blockedKeywords)}\n• Survey: ${n(cfg.blockedSurveys)}`);
      });
      add('🗑️ Log মুছুন', clearLog);
    }
  }

  render();
  refreshStatus();
  setInterval(refreshStatus, REFRESH_MS);
})();
