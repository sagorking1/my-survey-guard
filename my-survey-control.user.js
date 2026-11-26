// ==UserScript==
// @name         My Survey Control
// @namespace    https://github.com/sagorking1/my-survey-control
// @version      1.2.0
// @description  Survey timer, site locks, reports, backup/restore, GitHub access rules and update checker.
// @match        *://*/*
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/sagorking1/my-survey-guard/main/my-survey-control.user.js
// @downloadURL  https://raw.githubusercontent.com/sagorking1/my-survey-guard/main/my-survey-control.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      raw.githubusercontent.com
// ==/UserScript==

(() => {
  'use strict';

  // STEP 1: After creating your GitHub repository, replace YOUR_GITHUB_USERNAME below.
  // Keep config.json public and data-only. Never put passwords or GitHub tokens in this script.
  const CONFIG_URL = 'https://raw.githubusercontent.com/sagorking1/my-survey-guard/main/config.json';
  const UPDATE_URL = 'https://raw.githubusercontent.com/sagorking1/my-survey-guard/main/my-survey-control.user.js';
  const CURRENT_VERSION = '1.2.0';

  const KEY = {
    id: 'msc_client_id',
    locks: 'msc_locks',
    sessions: 'msc_sessions',
    settings: 'msc_settings',
    lockHistory: 'msc_lock_history'
  };

  const defaults = {
    lockDays: 7,
    timerEnabled: true,
    remoteRulesEnabled: false,
    showNotifications: true,
    displayName: ''
  };

  const get = (k, fallback) => GM_getValue(k, fallback);
  const set = (k, v) => GM_setValue(k, v);
  const hostname = location.hostname.toLowerCase();
  const now = () => Date.now();

  function clientId() {
    let id = get(KEY.id, '');
    if (!id) {
      id = 'MSC-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).toUpperCase();
      set(KEY.id, id);
    }
    return id;
  }

  function settings() { return { ...defaults, ...get(KEY.settings, {}) }; }
  function locks() { return get(KEY.locks, {}); }
  function saveLocks(v) { set(KEY.locks, v); }
  function lockHistory() { return get(KEY.lockHistory, []); }
  function addLockHistory(action, site, details = {}) {
    const history = lockHistory();
    history.unshift({ action, site, at: now(), ...details });
    set(KEY.lockHistory, history.slice(0, 500));
  }
  function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function csvCell(value) {
    return '"' + String(value ?? '').replace(/"/g, '""') + '"';
  }
  function downloadTimerCsv() {
    const rows = [['Website', 'Total time (seconds)', 'Formatted time']];
    Object.entries(get(KEY.sessions, {})).forEach(([site, data]) => {
      rows.push([site, data.totalSeconds || 0, formatTime(data.totalSeconds || 0)]);
    });
    downloadText('my-survey-control-timer-report.csv',
      rows.map(row => row.map(csvCell).join(',')).join('\\r\\n'),
      'text/csv;charset=utf-8');
  }
  function showLockHistory() {
    const rows = lockHistory();
    alert('LOCK HISTORY (latest 50)\\n\\n' + (rows.slice(0, 50).map(x =>
      `${new Date(x.at).toLocaleString()} — ${x.action} — ${x.site}${x.days ? ` (${x.days} days)` : ''}`
    ).join('\n') || 'কোনো lock history নেই'));
  }
  function notify(message) {
    if (settings().showNotifications) {
      try { GM_notification({ title: 'My Survey Control', text: message, timeout: 5000 }); }
      catch (_) { alert('My Survey Control: ' + message); }
    }
  }

  function currentLock() {
    const item = locks()[hostname];
    if (!item) return null;
    if (item.until <= now()) {
      const all = locks(); delete all[hostname]; saveLocks(all);
      addLockHistory('EXPIRED', hostname, { days: item.days });
      return null;
    }
    return item;
  }

  // Session timer stores only hostname and elapsed seconds; it does not collect page text or answers.
  function startTimer() {
    if (!settings().timerEnabled) return;
    const all = get(KEY.sessions, {});
    const record = all[hostname] || { totalSeconds: 0, startedAt: now() };
    record.startedAt = now();
    all[hostname] = record;
    set(KEY.sessions, all);
    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      const data = get(KEY.sessions, {});
      const r = data[hostname];
      if (r && r.startedAt) {
        r.totalSeconds = (r.totalSeconds || 0) + Math.max(0, Math.floor((now() - r.startedAt) / 1000));
        r.startedAt = 0;
        data[hostname] = r;
        set(KEY.sessions, data);
      }
    };
    window.addEventListener('pagehide', finish, { once: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') finish();
    });
  }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
  }

  function lockCurrentSite(days) {
    const all = locks();
    all[hostname] = { until: now() + days * 86400000, createdAt: now(), days };
    saveLocks(all);
    addLockHistory('LOCK', hostname, { days });
    notify(`${hostname} ${days} দিনের জন্য lock করা হয়েছে।`);
  }

  function unlockCurrentSite() {
    const all = locks(); delete all[hostname]; saveLocks(all);
    addLockHistory('UNLOCK', hostname);
    notify(`${hostname} unlock করা হয়েছে।`);
  }

  function exportBackup() {
    const data = {
      app: 'My Survey Control',
      version: 1,
      exportedAt: new Date().toISOString(),
      clientId: clientId(),
      locks: locks(),
      sessions: get(KEY.sessions, {}),
      settings: settings(),
      lockHistory: lockHistory()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'my-survey-control-backup.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function importBackup() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files && input.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.app !== 'My Survey Control' || !data.locks || !data.settings) throw new Error('Invalid backup file');
        if (!confirm('বর্তমান lock, timer ও settings backup দিয়ে replace হবে। Continue?')) return;
        saveLocks(data.locks);
        set(KEY.sessions, data.sessions || {});
        set(KEY.settings, { ...defaults, ...data.settings });
        set(KEY.lockHistory, Array.isArray(data.lockHistory) ? data.lockHistory : []);
        notify('Backup restore complete.');
      } catch (e) { alert('Backup import failed: ' + e.message); }
    };
    input.click();
  }

  function showDashboard() {
    const allLocks = locks();
    const sessions = get(KEY.sessions, {});
    const lockRows = Object.entries(allLocks).map(([site, v]) =>
      `${site} — ${new Date(v.until).toLocaleString()} (${v.days} days)`).join('\n') || 'কোনো active lock নেই';
    const timeRows = Object.entries(sessions).map(([site, v]) =>
      `${site} — ${formatTime(v.totalSeconds)}`).join('\n') || 'এখনও কোনো timer data নেই';
    const s = settings();
    const choice = prompt(
`MY SURVEY CONTROL
Client ID: ${clientId()}

এই সাইট: ${hostname}
1 = এই সাইট 7 দিন lock
2 = এই সাইট 15 দিন lock
3 = এই সাইট 30 দিন lock
4 = এই সাইট unlock
5 = সব active lock দেখাও
6 = সব timer দেখাও
7 = settings
8 = backup export
9 = backup import
10 = timer report CSV
11 = lock history
12 = access ID
13 = set name / employee ID
0 = cancel

নম্বর লিখুন:`);
    if (choice === '1') lockCurrentSite(7);
    else if (choice === '2') lockCurrentSite(15);
    else if (choice === '3') lockCurrentSite(30);
    else if (choice === '4') unlockCurrentSite();
    else if (choice === '5') alert('ACTIVE LOCKS\n\n' + lockRows);
    else if (choice === '6') alert('TIME BY SITE\n\n' + timeRows);
    else if (choice === '7') editSettings();
    else if (choice === '8') exportBackup();
    else if (choice === '9') importBackup();
    else if (choice === '10') downloadTimerCsv();
    else if (choice === '11') showLockHistory();
    else if (choice === '12') showAccessId();
    else if (choice === '13') setDisplayName();
  }

  function editSettings() {
    const old = settings();
    const days = prompt('Default lock days (7, 15, or 30):', String(old.lockDays));
    if (days === null) return;
    if (![7, 15, 30].includes(Number(days))) return alert('শুধু 7, 15 অথবা 30 দিন দিন।');
    const timer = confirm('Survey timer চালু রাখবেন? OK = Yes, Cancel = No');
    const remote = confirm('GitHub remote rules চালু করবেন? config.json তৈরি ও URL ঠিক করার পরেই Yes দিন।');
    set(KEY.settings, { ...old, lockDays: Number(days), timerEnabled: timer, remoteRulesEnabled: remote });
    notify('Settings saved.');
  }

  function checkForUpdate() {
    notify('GitHub থেকে update check করা হচ্ছে...');
    GM_xmlhttpRequest({
      method: 'GET',
      url: UPDATE_URL + '?t=' + Date.now(),
      timeout: 15000,
      onload: (response) => {
        if (response.status < 200 || response.status >= 300) {
          alert('Update check ব্যর্থ হয়েছে। GitHub-এ my-survey-control.user.js ফাইলটি main branch-এ upload করা আছে কি না দেখুন।');
          return;
        }
        const match = response.responseText.match(/@version\s+([0-9]+(?:\.[0-9]+){1,3})/);
        if (!match) {
          alert('GitHub script থেকে version পড়া যায়নি।');
          return;
        }
        const latest = match[1];
        if (latest === CURRENT_VERSION) {
          alert('আপনার My Survey Control সর্বশেষ version (' + CURRENT_VERSION + ') ব্যবহার করছে।');
          return;
        }
        if (!confirm('নতুন version পাওয়া গেছে: ' + latest +
          '\\nআপনার version: ' + CURRENT_VERSION +
          '\\n\\nGitHub থেকে update/install page খুলবেন?')) return;
        GM_openInTab(UPDATE_URL, { active: true, insert: true });
      },
      onerror: () => alert('Update check করা যায়নি। Internet connection পরীক্ষা করুন।'),
      ontimeout: () => alert('Update check timeout হয়েছে। পরে আবার চেষ্টা করুন।')
    });
  }

  function scanDebug() {
    const s = settings();
    const active = Object.keys(locks()).length;
    const sessionCount = Object.keys(get(KEY.sessions, {})).length;
    alert(`SCAN DEBUG\n\nHost: ${hostname}\nClient ID: ${clientId()}\nTimer: ${s.timerEnabled ? 'ON' : 'OFF'}\nRemote rules: ${s.remoteRulesEnabled ? 'ON' : 'OFF'}\nActive locks: ${active}\nTracked websites: ${sessionCount}\nUser label: ${s.displayName || '(not set)'}`);
  }

  function showLastLockouts() {
    const rows = Object.entries(locks()).sort((a, b) => b[1].createdAt - a[1].createdAt);
    alert('ACTIVE LOCKOUTS\n\n' + (rows.map(([site, v]) =>
      `${site} — ${new Date(v.until).toLocaleString()} (${v.days} days)`
    ).join('\n') || 'কোনো active lock নেই'));
  }

  function showUsageInfo() {
    alert('USAGE & PRIVACY\\n\\nএই script আপনার browser-এর Tampermonkey storage-এ Client ID, active locks, timer totals এবং settings রাখে। Timer শুধু website hostname ও elapsed time রাখে; survey question বা answer সংগ্রহ করে না। GitHub remote rules চালু করলে config.json পড়তে request পাঠায়। কোনো usage report স্বয়ংক্রিয়ভাবে পাঠানো হয় না।');
  }

  function setDisplayName() {
    const old = settings();
    const name = prompt('আপনার নাম / Employee ID লিখুন (শুধু এই browser-এ সংরক্ষিত হবে):', old.displayName || '');
    if (name === null) return;
    set(KEY.settings, { ...old, displayName: name.trim() });
    notify('নাম / Employee ID সংরক্ষণ হয়েছে।');
  }

  function showAccessId() {
    alert('আপনার Access ID:\n' + clientId() + '\n\nএটি এই browser-এর local ID।');
  }

  function restoreOldAccessId() {
    const oldId = prompt('পুরোনো Access ID লিখুন। ভুল ID দিলে access rules কাজ নাও করতে পারে:');
    if (oldId === null) return;
    const clean = oldId.trim();
    if (!/^MSC-[A-Z0-9-]{8,100}$/i.test(clean)) return alert('Access ID format সঠিক নয়।');
    if (!confirm('বর্তমান Access ID বদলে পুরোনো ID restore করবেন?')) return;
    set(KEY.id, clean);
    notify('পুরোনো Access ID restore হয়েছে।');
  }

  function showAdminList() {
    fetchRemoteRules((cfg) => {
      if (!cfg) return alert('Admin list পাওয়া যায়নি। Remote rules চালু আছে কি না এবং config URL ঠিক আছে কি না দেখুন।');
      const allowed = Array.isArray(cfg.allowedIds) ? cfg.allowedIds : [];
      const blocked = Array.isArray(cfg.blockedIds) ? cfg.blockedIds : [];
      const pending = Array.isArray(cfg.pendingIds) ? cfg.pendingIds : [];
      alert(`REMOTE ACCESS LIST\\n\\nAllowed: ${allowed.length}\\nPending: ${pending.length}\\nBlocked: ${blocked.length}\\n\\nAllowed IDs:\\n${allowed.join('\n') || '(none)'}\\n\\nPending IDs:\\n${pending.join('\n') || '(none)'}\\n\\nBlocked IDs:\\n${blocked.join('\n') || '(none)'}`);
    });
  }

  function fetchRemoteRules(callback) {
    const s = settings();
    if (!s.remoteRulesEnabled || CONFIG_URL.includes('YOUR_GITHUB_USERNAME')) return callback(null);
    GM_xmlhttpRequest({
      method: 'GET', url: CONFIG_URL, timeout: 10000,
      onload: (r) => {
        try { callback(JSON.parse(r.responseText)); }
        catch (_) { callback(null); }
      },
      onerror: () => callback(null),
      ontimeout: () => callback(null)
    });
  }

  function applyRemoteRules() {
    fetchRemoteRules((cfg) => {
      if (!cfg) return; // Fail open: a missing config/network does not block browsing.
      const id = clientId();
      const allowed = Array.isArray(cfg.allowedIds) ? cfg.allowedIds : [];
      const blocked = Array.isArray(cfg.blockedIds) ? cfg.blockedIds : [];
      const pending = Array.isArray(cfg.pendingIds) ? cfg.pendingIds : [];
      const denyPage = (heading, detail) => {
        const render = () => {
          if (!document.body) return;
          document.body.innerHTML = '';
          document.body.style.cssText = 'margin:0;background:#111;color:#fff;font:16px sans-serif;min-height:100vh;display:grid;place-items:center;text-align:center;padding:24px;box-sizing:border-box';
          const panel = document.createElement('div');
          const h = document.createElement('h2'); h.textContent = heading;
          const p = document.createElement('p'); p.textContent = detail;
          const idLine = document.createElement('p'); idLine.textContent = 'Your local access ID: ' + id;
          panel.append(h, p, idLine); document.body.append(panel);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
        else render();
      };
      if (blocked.includes(id)) {
        denyPage('Access blocked by administrator', 'এই access ID administrator block করেছেন।');
        return;
      }
      if (allowed.length && !allowed.includes(id)) {
        const status = pending.includes(id) ? 'Approval pending' : 'Not approved';
        denyPage(status, 'Admin approval না পাওয়া পর্যন্ত এই page ব্যবহার করা যাবে না।');
        return;
      }
      const blockedDomains = (cfg.blockedDomains || []).map(x => String(x).toLowerCase());
      const blockedKeywords = (cfg.blockedKeywords || []).map(x => String(x).toLowerCase());
      if (blockedDomains.some(d => hostname === d || hostname.endsWith('.' + d))) {
        denyPage('This domain is blocked', 'এই domain administrator blocklist-এ আছে: ' + hostname);
        return;
      }
      const checkLinks = () => {
        for (const a of document.querySelectorAll('a[href]')) {
          const href = (a.href || '').toLowerCase();
          if (blockedKeywords.some(k => k && href.includes(k))) {
            a.style.outline = '2px solid #d33';
            a.title = 'Blocked link by My Survey Control';
          }
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkLinks, { once: true });
      else checkLinks();
    });
  }

  GM_registerMenuCommand('Check for Script Update (v' + CURRENT_VERSION + ')', checkForUpdate);
  GM_registerMenuCommand('My Survey Control — Dashboard', showDashboard);
  GM_registerMenuCommand('Lock this site — 7 days', () => lockCurrentSite(7));
  GM_registerMenuCommand('Unlock this site', unlockCurrentSite);
  GM_registerMenuCommand('Export backup', exportBackup);
  GM_registerMenuCommand('Import backup', importBackup);
  GM_registerMenuCommand('Scan debug', scanDebug);
  GM_registerMenuCommand('Last lockouts result', showLastLockouts);
  GM_registerMenuCommand('Download timer report (CSV)', downloadTimerCsv);
  GM_registerMenuCommand('Blocked / lock history', showLockHistory);
  GM_registerMenuCommand('Download everything saved (JSON)', exportBackup);
  GM_registerMenuCommand('Usage reporting info', showUsageInfo);
  GM_registerMenuCommand('Set my name / employee ID', setDisplayName);
  GM_registerMenuCommand('Admin list (GitHub config)', showAdminList);
  GM_registerMenuCommand('Refresh admin list now', showAdminList);
  GM_registerMenuCommand('Access ID', showAccessId);
  GM_registerMenuCommand('Restore my old Access ID', restoreOldAccessId);

  const lock = currentLock();
  if (lock) {
    // Lock is a reminder/interstitial, not a bypass of a survey provider's own controls.
    document.addEventListener('DOMContentLoaded', () => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483647;inset:0;background:#111;color:#fff;display:grid;place-items:center;font:16px sans-serif;text-align:center;padding:24px';
      const wrap = document.createElement('div');
      const h = document.createElement('h2'); h.textContent = 'এই সাইটটি আপনার দ্বারা সাময়িকভাবে lock করা';
      const p = document.createElement('p'); p.textContent = `Unlock হবে: ${new Date(lock.until).toLocaleString()}`;
      const b = document.createElement('button'); b.textContent = 'আমি বুঝেছি'; b.style.cssText = 'padding:10px 18px;cursor:pointer';
      b.onclick = () => box.remove();
      wrap.append(h, p, b); box.append(wrap); document.body.append(box);
    }, { once: true });
  }

  startTimer();
  applyRemoteRules();
})();
