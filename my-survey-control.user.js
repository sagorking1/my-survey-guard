// ==UserScript==
// @name         My Survey Control
// @namespace    my-survey-guard
// @version      1.3.1
// @description  Admin Approval System: PENDING -> ACTIVE / BLOCKED
// @match        *://*/*
// @updateURL    https://raw.githubusercontent.com/sagorking1/my-survey-guard/main/my-survey-control.user.js
// @downloadURL  https://raw.githubusercontent.com/sagorking1/my-survey-guard/main/my-survey-control.user.js
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ====== আপনাকে শুধু এই দুটি লাইন বদলাতে হবে ======
  const GITHUB_USER = 'sagorking1';
  const GITHUB_REPO = 'my-survey-guard';
  // ================================================

  const SCRIPT_VERSION = '1.3.1';
  const CONFIG_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/config.json`;
  const REFRESH_MS = 60 * 1000;

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
  let featuresStarted = false;
  let lastError = '';

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
    try {
      const cfg = await fetchConfig();
      const norm = (a) => (Array.isArray(a) ? a.map(String) : []);
      const blocked = norm(cfg.blockedIds);
      const allowed = norm(cfg.allowedIds);
      latestVersion = cfg.latestVersion || SCRIPT_VERSION;
      updateUrl = cfg.updateUrl || '';
      if (blocked.includes(ACCESS_ID)) status = 'BLOCKED';
      else if (allowed.includes(ACCESS_ID)) status = 'ACTIVE';
      else status = 'PENDING'; // allowedIds ছাড়া কেউ ACTIVE নয় (খালি লিস্টেও)
      lastError = '';
    } catch (e) {
      status = 'ERROR'; // সংযোগ না থাকলে কখনোই ACTIVE নয়
      lastError = (e && e.message) ? e.message : String(e && e.error ? e.error : e);
    }
    render();
    if (status === 'ACTIVE') startProtectedFeatures();
    else stopProtectedFeatures();
  }

  // ---------- Protected Features ----------
  // আপনার আগের Script-এর মূল ফিচারগুলো এই দুই ফাংশনের ভেতরে বসান।
  // এগুলো শুধু ACTIVE থাকলেই চলবে।
  function startProtectedFeatures() {
    if (featuresStarted) return;
    featuresStarted = true;
    console.log('[My Survey Control] Protected features ON');
    // TODO: আপনার মূল Script-এর কোড এখানে
  }
  function stopProtectedFeatures() {
    if (!featuresStarted) return;
    featuresStarted = false;
    console.log('[My Survey Control] Protected features OFF');
    // TODO: চালু থাকা timer/observer থাকলে এখানে বন্ধ করুন
  }

  // ---------- UI ----------
  const COLORS = { PENDING: '#f59e0b', ACTIVE: '#16a34a', BLOCKED: '#dc2626', ERROR: '#6b7280' };
  const LABELS = {
    PENDING: 'PENDING – Admin Approval-এর অপেক্ষায়',
    ACTIVE: 'ACTIVE – ব্যবহার করা যাবে',
    BLOCKED: 'BLOCKED – Admin ব্লক করেছেন',
    ERROR: 'VERIFICATION ERROR – যাচাই করা যায়নি',
  };

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;width:280px;' +
    'background:#fff;color:#111;border:2px solid #999;border-radius:10px;padding:10px;' +
    'font:13px/1.4 Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25)';
  document.body.appendChild(box);

  function btn(text, fn) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'margin:4px 4px 0 0;padding:4px 8px;border:1px solid #888;border-radius:6px;background:#f3f4f6;cursor:pointer;font-size:12px';
    b.onclick = fn;
    return b;
  }

  function render() {
    box.innerHTML = '';
    box.style.borderColor = COLORS[status];
    const title = document.createElement('div');
    title.innerHTML = '<b>My Survey Control</b> v' + SCRIPT_VERSION;
    const st = document.createElement('div');
    st.textContent = LABELS[status];
    st.style.cssText = `margin:6px 0;padding:4px 6px;border-radius:6px;color:#fff;background:${COLORS[status]}`;
    const idLine = document.createElement('div');
    idLine.innerHTML = 'Access ID:<br><code style="user-select:all">' + ACCESS_ID + '</code>';
    box.append(title, st, idLine);

    box.append(btn('Copy ID', () => { GM_setClipboard(ACCESS_ID); alert('Access ID কপি হয়েছে'); }));
    box.append(btn('Refresh', refreshStatus));
    box.append(btn('Check Update', async () => {
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
    }));

    if (status === 'PENDING') {
      const n = document.createElement('div');
      n.style.cssText = 'margin-top:6px;font-size:12px;color:#555';
      n.textContent = 'Admin-কে এই Access ID পাঠান। Approve না হওয়া পর্যন্ত Script বন্ধ থাকবে।';
      box.append(n);
    }
  }

  render();
  refreshStatus();
  setInterval(refreshStatus, REFRESH_MS);
})();
