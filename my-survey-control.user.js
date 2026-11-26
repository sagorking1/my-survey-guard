// ==UserScript==
// @name         My Survey Control
// @namespace    my-survey-guard
// @version      1.6.0
// @description  Admin Approval + Blocklist (links too) + Repeat detection + Auto-lock completed surveys + Duration
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

  const SCRIPT_VERSION = '1.6.0';
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
  // Survey শেষ হয়েছে কিনা (Thank-you পেজ) বোঝার চেষ্টা। Screen-out/অযোগ্য হলে false।
  function isCompletionText(text, url) {
    const t = norm(text).slice(0, 5000);
    const u = String(url || '').toLowerCase();
    if (/(screen(ed)? ?out|not eligible|do not qualify|don't qualify|unfortunately|disqualif|quota (is )?(full|reached)|terminated|over quota)/.test(t)) return false;
    if (/\/(thank-?you|thanks|completed?|finish(ed)?|survey-?end|end-?page)(\/|\.|\?|$)/.test(u)) return true;
    return /thank(s| you)[^.!\n]{0,40}(completing|your participation|taking part|for your time|your feedback|your responses|participating)/.test(t)
      || /(survey|questionnaire) (is |has been |was )?(complete|completed|finished|submitted)\b/.test(t)
      || /you('ve| have) (successfully )?(completed|finished)/.test(t)
      || /your (responses?|answers?) (has|have) been (recorded|submitted|saved)/.test(t)
      || /submission (received|complete)/.test(t);
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
  let ACCESS_ID = getAccessId();

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
    if (prev !== status || cfgChanged || !menusReady) setMenus();
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
    if (status !== 'ACTIVE') return;
    markLinks();
    if (document.getElementById('msc-overlay')) return;
    if (!isSurveyLike()) { tryCompletion(); return; }
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
    if (!cur) { cur = { id, host: location.hostname, title: '', q: [], first: now, last: now, ss: now, dur: 0 }; list.push(cur); }
    if (!cur.ss || now - cur.last > 30 * 60 * 1000) cur.ss = now; // নতুন সেশন
    cur.q = merged;
    cur.last = now;
    cur.dur = now - cur.ss;
    ssSet('lastSurvey', id);
    ssSet('lastSurveyAt', String(now));
    cur.title = (document.title || '').slice(0, 80);
    list.sort((a, b) => a.last - b.last);
    save('surveys', list.slice(-400));
  }
  function showLog() {
    const list = load('surveys', []).slice().sort((a, b) => b.last - a.last).slice(0, 20);
    if (!list.length) { alert('এখনো কোনো Survey Log নেই।'); return; }
    alert('সর্বশেষ Survey (সর্বোচ্চ ২০টি):\n\n' + list.map((s) => `${fmt(s.last)}  ${s.host}\n   ${s.title || '-'}  (${(s.q || []).length} প্রশ্ন, ${Math.round((s.dur || 0) / 60000)} মিনিট${s.done ? ', সম্পন্ন ✅' : ''})`).join('\n\n'));
  }
  function clearLog() {
    if (confirm('Survey Log মুছে ফেলবেন? (লক মুছবে না)')) { save('surveys', []); toast('Log মুছে ফেলা হয়েছে'); }
  }

  // ================= সম্পন্ন Survey অটো-লক =================
  const autoLockDays = () => parseInt(GM_getValue('autoLockDays', '7'), 10) || 0;
  function touchSurvey() {
    try {
      const sid = ssGet('lastSurvey');
      if (!sid) return;
      const list = load('surveys', []);
      const rec = list.find((x) => x.id === sid);
      if (!rec) return;
      const now = Date.now();
      rec.last = now;
      rec.dur = now - (rec.ss || rec.first);
      save('surveys', list);
    } catch (e) { /* ignore */ }
  }
  function tryCompletion() {
    const days = autoLockDays();
    const sid = ssGet('lastSurvey');
    if (!days || !sid || ssGet('doneFor') === sid) return;
    if (Date.now() - parseInt(ssGet('lastSurveyAt') || '0', 10) > 3 * 3600 * 1000) return;
    const text = (document.body && document.body.innerText || '').slice(0, 5000);
    if (!isCompletionText(text, location.pathname + location.search)) return;
    ssSet('doneFor', sid);
    const now = Date.now();
    const list = load('surveys', []);
    const rec = list.find((x) => x.id === sid);
    if (rec) { rec.done = now; rec.dur = now - (rec.ss || rec.first); save('surveys', list); }
    const locks = getLocks();
    locks['survey:' + sid] = { until: now + days * DAY, days, set: now, auto: true };
    save('locks', locks);
    toast(`✅ Survey সম্পন্ন মনে হচ্ছে। ${days} দিনের জন্য লক হয়েছে`);
  }
  function setAutoLock() {
    const v = prompt('সম্পন্ন Survey কত দিন অটো-লক থাকবে? (0 = বন্ধ, 7, 15 বা 30)', String(autoLockDays()));
    if (v === null) return;
    const n = parseInt(v, 10);
    if (![0, 7, 15, 30].includes(n)) { alert('শুধু 0, 7, 15 বা 30 লিখুন।'); return; }
    GM_setValue('autoLockDays', String(n));
    toast(n ? `⚙️ Auto-lock: ${n} দিন` : '⚙️ Auto-lock বন্ধ');
    setMenus();
  }

  // ================= পেজের লিংকে Blocklist =================
  const inOwnUi = (n) => !!(n.closest && n.closest('#msc-box,#msc-overlay,#msc-banner,#msc-toast'));
  function linkHit(a) {
    let u;
    try { u = new URL(a.href, location.href); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    return matchBlocklist(cfg, u.hostname, u.host + u.pathname + u.search, '', '');
  }
  function resetLinkMarks() {
    document.querySelectorAll('a[data-msc]').forEach((a) => {
      a.removeAttribute('data-msc');
      if (a.hasAttribute('data-msc-block')) { a.removeAttribute('data-msc-block'); a.style.outline = ''; if ((a.title || '').startsWith('⛔')) a.removeAttribute('title'); }
    });
  }
  function markLinks() {
    const as = document.querySelectorAll('a[href]:not([data-msc])');
    let n = 0;
    for (const a of as) {
      if (n++ > 400) break;
      if (inOwnUi(a)) continue;
      a.setAttribute('data-msc', '1');
      const hit = linkHit(a);
      if (hit) { a.setAttribute('data-msc-block', hit); a.style.outline = '2px solid #dc2626'; a.title = '⛔ Blocklist: ' + hit; }
    }
  }
  function onLinkClick(e) {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || inOwnUi(a)) return;
    const hit = a.getAttribute('data-msc-block') || (a.hasAttribute('data-msc') ? null : linkHit(a));
    if (!hit) return;
    if (!confirm('⛔ এই লিংক Blocklist-এ আছে:\n' + hit + '\n\nতবুও খুলবেন?')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  }

  // ================= মূল পরীক্ষা =================
  function checkPage() {
    removeOverlay();
    if (status !== 'ACTIVE') return;
    resetLinkMarks();
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
        recordBlock(hit);
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
    document.addEventListener('click', onLinkClick, true);
    document.addEventListener('auxclick', onLinkClick, true);
    window.addEventListener('pagehide', touchSurvey);
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
    document.removeEventListener('click', onLinkClick, true);
    document.removeEventListener('auxclick', onLinkClick, true);
    window.removeEventListener('pagehide', touchSurvey);
    resetLinkMarks();
    removeOverlay();
    removeBanner();
  }

  // ================= Log / Backup / Debug =================
  const pad = (n) => String(n).padStart(2, '0');
  const fmtFull = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const countOf = (a) => (Array.isArray(a) ? a.length : 0);

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.documentElement.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

  function downloadCsv(label, sinceMs) {
    const list = load('surveys', []).filter((s) => s.last >= sinceMs).sort((a, b) => b.last - a.last);
    if (!list.length) { alert('এই সময়ের মধ্যে কোনো Survey Log নেই।'); return; }
    const rows = [['Last seen', 'First seen', 'Site', 'Title', 'Questions', 'Minutes', 'Completed', 'Page']].concat(
      list.map((s) => [fmtFull(s.last), fmtFull(s.first), s.host, s.title, (s.q || []).length, Math.round((s.dur || 0) / 60000), s.done ? 'yes' : '', s.id]));
    download(`survey-log-${label}.csv`, '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    toast(`📥 ${list.length}টি Survey ডাউনলোড হয়েছে`);
  }

  function backup() {
    const data = { app: 'my-survey-control', version: SCRIPT_VERSION, savedAt: Date.now(), surveys: load('surveys', []), locks: getLocks(), blocked: load('blockedHistory', []) };
    download(`my-survey-control-backup-${fmtFull(Date.now()).slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
    toast('💾 Backup ডাউনলোড হয়েছে');
  }
  function importBackup() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const d = JSON.parse(String(r.result));
          if (!d || d.app !== 'my-survey-control') throw new Error('এটি My Survey Control-এর Backup ফাইল নয়');
          const map = new Map(load('surveys', []).map((s) => [s.id, s]));
          (d.surveys || []).forEach((s) => {
            if (!s || !s.id) return;
            const o = map.get(s.id);
            if (!o) map.set(s.id, s);
            else {
              o.q = [...new Set([...(o.q || []), ...(s.q || [])])].slice(-300);
              o.first = Math.min(o.first || s.first, s.first || o.first);
              o.last = Math.max(o.last || 0, s.last || 0);
            }
          });
          save('surveys', [...map.values()].sort((a, b) => a.last - b.last).slice(-400));
          const locks = getLocks();
          Object.keys(d.locks || {}).forEach((k) => {
            const v = d.locks[k];
            if (v && v.until > Date.now() && (!locks[k] || locks[k].until < v.until)) locks[k] = v;
          });
          save('locks', locks);
          toast('✅ Backup মার্জ হয়েছে');
          checkPage();
        } catch (e) { alert('Import ব্যর্থ: ' + e.message); }
      };
      r.readAsText(f);
    };
    inp.click();
  }

  function recordBlock(reason) {
    const list = load('blockedHistory', []);
    const u = location.host + location.pathname;
    const now = Date.now();
    const last = list[list.length - 1];
    if (last && last.u === u && last.r === reason && now - last.t < 60000) return;
    list.push({ t: now, u, r: reason });
    save('blockedHistory', list.slice(-50));
  }
  function showBlockedHistory() {
    const list = load('blockedHistory', []).slice().reverse();
    if (!list.length) { alert('এখনো কোনো Blocked ইতিহাস নেই।'); return; }
    alert('Blocked ইতিহাস (শেষ ৫০):\n\n' + list.map((x) => `${fmtFull(x.t)}  ${x.u}\n   ${x.r}`).join('\n'));
  }

  function currentHit() {
    return matchBlocklist(
      cfg, location.hostname, location.host + location.pathname + location.search, document.title,
      isSurveyLike() ? (document.body && document.body.innerText || '').slice(0, 20000) : ''
    );
  }
  function whyBlocked() {
    const lock = activeLock();
    const hit = currentHit();
    if (lock) alert(`এই পেজ লক করা আছে (শেষ: ${fmt(lock.until)})।`);
    else if (hit) alert('এই পেজ Blocklist-এ আছে।\nকারণ: ' + hit);
    else alert('এই পেজ ব্লক নয়।');
  }
  function debugScan() {
    const lock = activeLock();
    alert([
      `Status: ${status}${lastError ? ' (' + lastError + ')' : ''}`,
      `Access ID: ${ACCESS_ID}`,
      `Config: ${cfgStamp ? 'আনা হয়েছে' : 'আনা যায়নি'}`,
      `Survey-মতো পেজ: ${isSurveyLike() ? 'হ্যাঁ' : 'না'} (রেডিও/চেকবক্স: ${radioCount()})`,
      `চেনা প্রশ্ন: ${extractQuestions().length}`,
      `লক: ${lock ? 'আছে' : 'নেই'}`,
      `Blocklist: ${currentHit() || 'মেলেনি'}`,
    ].join('\n'));
  }
  function showListInfo() {
    alert(`Admin list${cfg.listVersion ? ' v' + cfg.listVersion : ''}:\n• Domain: ${countOf(cfg.blockedDomains)}\n• Keyword: ${countOf(cfg.blockedKeywords)}\n• Survey: ${countOf(cfg.blockedSurveys)}\n• Allowed ID: ${countOf(cfg.allowedIds)}\n• Blocked ID: ${countOf(cfg.blockedIds)}`);
  }
  async function refreshListNow() {
    await refreshStatus();
    toast(status === 'ERROR' ? 'List আনা যায়নি: ' + lastError : '🔄 Admin list আপডেট হয়েছে');
  }
  function restoreOldId() {
    const v = prompt('আগের Access ID দিন (MSC-XXXX-XXXX-XXXX):', '');
    if (!v) return;
    const id = v.trim().toUpperCase();
    if (!/^MSC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(id)) { alert('ID-র ফরম্যাট ঠিক নয়।'); return; }
    GM_setValue('accessId', id);
    ACCESS_ID = id;
    toast('♻️ Access ID ফিরিয়ে আনা হয়েছে');
    refreshStatus();
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
    if (status === 'ACTIVE') {
      add('🩺 Scan debug (কেন Status নেই?)', debugScan);
      add('🔍 এই পেজ কেন ব্লক?', whyBlocked);
      add('📥 আজকের Spreadsheet (CSV)', () => downloadCsv('today', startOfToday()));
      add('📥 গত ১৫ দিন (CSV)', () => downloadCsv('last-15-days', Date.now() - 15 * DAY));
      add('📥 সব সংরক্ষিত (CSV)', () => downloadCsv('all', 0));
      add('💾 Backup (JSON: লক + Log)', backup);
      add('📤 Import backup (মার্জ)', importBackup);
      add(`⚙️ Auto-lock সম্পন্ন Survey: ${autoLockDays() ? autoLockDays() + ' দিন' : 'বন্ধ'} (বদলান)`, setAutoLock);
      add('🔒 এই Survey ৭ দিন লক', () => addLock('survey', 7));
      add('🔒 এই Survey ১৫ দিন লক', () => addLock('survey', 15));
      add('🔒 এই Survey ৩০ দিন লক', () => addLock('survey', 30));
      add('🔒 এই Site ৩০ দিন লক', () => addLock('site', 30));
      add('🔓 এই পেজের লক খুলুন', unlockHere);
      add('📃 লক তালিকা', showLocks);
      add('📊 Survey Log (শেষ ২০)', showLog);
      add('🗂️ Blocked history (শেষ ৫০)', showBlockedHistory);
      add('🗑️ Log মুছুন', clearLog);
    }
    add(`ℹ️ Version ${SCRIPT_VERSION} (চলছে)`, () => alert(`My Survey Control v${SCRIPT_VERSION}`));
    add('⬆️ Check for script update', checkUpdate);
    add('🔐 Privacy তথ্য', () => alert('নেটওয়ার্ক শুধু GitHub-এর config.json পড়তে ও Update যাচাইয়ে ব্যবহার হয়।\nSurvey Log, লক ও Blocked history শুধু এই ব্রাউজারে থাকে, কোথাও পাঠানো হয় না।'));
    add(`🛡️ Admin list (${countOf(cfg.blockedDomains)} domains, ${countOf(cfg.blockedKeywords)} keywords, ${countOf(cfg.blockedSurveys)} surveys, ${countOf(cfg.allowedIds)} allowed)`, showListInfo);
    add('🔄 Admin list এখনই রিফ্রেশ', refreshListNow);
    add(`🔑 Access ID: ${ACCESS_ID} (${status === 'ACTIVE' ? 'Active ✅' : status})`, copyId);
    add('♻️ আমার পুরনো Access ID ফিরিয়ে আনুন', restoreOldId);
  }

  render();
  refreshStatus();
  setInterval(refreshStatus, REFRESH_MS);
})();
