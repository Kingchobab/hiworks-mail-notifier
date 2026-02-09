// ==UserScript==
// @name         Hiworks Mail Notifier (Alpha)
// @namespace    https://github.com/Kingchobab/hiworks-mail-notifier
// @version      0.3.1
// @description  Notify only newly arrived Hiworks mails and open them directly on click.
// @author       Kingchobab
// @match        https://mails.office.hiworks.com/*
// @updateURL    https://raw.githubusercontent.com/Kingchobab/hiworks-mail-notifier/master/hiworks-mail-notifier.user.js
// @downloadURL  https://raw.githubusercontent.com/Kingchobab/hiworks-mail-notifier/master/hiworks-mail-notifier.user.js
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      count-api.office.hiworks.com
// @connect      mail-api.office.hiworks.com
// ==/UserScript==

(() => {
    'use strict';
  
    /********************
     * Config
     ********************/
    const STATUS_API_MATCH = '/mbox/status';
    const MAILS_API_MATCH  = '/v2/mails';
    const FALLBACK_NO_STATUS_MS = 3 * 60 * 1000; // 3 minutes
    const FALLBACK_TICK_MS = 30 * 1000;          // check every 30s
    const MAX_SEEN = 800;                        // keep last 800 mail nos
    const LIST_LIMIT = 30;                       // fetch latest 30
    const SUMMARY_MAX = 5;                       // show up to 5 lines
  
    // API endpoints (same-site, cookie auth)
    const STATUS_URL = 'https://count-api.office.hiworks.com/mbox/status?with=managed';
    const MAILS_URL  = `https://mail-api.office.hiworks.com/v2/mails?page[limit]=${LIST_LIMIT}&page[offset]=0&sort[received_date]=desc&filter[mailbox_id][eq]=all`;
  
    /********************
     * Persistent state
     ********************/
    const K_SEEN = 'hiworks_seen_nos_v1';
    const K_LAST_UNREAD = 'hiworks_last_all_unread_v1';

    const K_NOTIFY_LEADER = 'hiworks_notify_leader_v1';
    const LEADER_TTL_MS = 15000; // 15초

  
    /** @type {number[]} */
    let seenNos = GM_getValue(K_SEEN, []);
    if (!Array.isArray(seenNos)) seenNos = [];
  
    /** @type {number|null} */
    let lastAllUnread = GM_getValue(K_LAST_UNREAD, null);
    if (typeof lastAllUnread !== 'number') lastAllUnread = null;
  
    // runtime state
    let lastStatusSeenAt = 0;
    let initDone = false;
    let fetching = false;
  
    /********************
     * Helpers
     ********************/
    function saveSeen() {
      // cap size
      if (seenNos.length > MAX_SEEN) {
        seenNos = seenNos.slice(seenNos.length - MAX_SEEN);
      }
      GM_setValue(K_SEEN, seenNos);
    }
  
    function markSeen(nos) {
      const set = new Set(seenNos);
      let changed = false;
      for (const n of nos) {
        if (!set.has(n)) {
          set.add(n);
          changed = true;
        }
      }
      if (changed) {
        seenNos = Array.from(set);
        // keep stable-ish order by sorting numeric; not required but neat
        seenNos.sort((a, b) => a - b);
        saveSeen();
      }
    }
  
    function isSeen(no) {
      return seenNos.includes(no);
    }
  
    function notify(title, text, onClick) {
      if (!tryBecomeLeader()) return;
      // 1) Web Notification
      if ('Notification' in window) {
        const show = () => {
          const n = new Notification(title, {
            body: text,
            requireInteraction: true,
            silent: false,
          });
          if (typeof onClick === 'function') {
            n.onclick = () => {
              try { onClick(); } finally { n.close(); }
            };
          }
        };

        if (Notification.permission === 'granted') { show(); return; }
        if (Notification.permission !== 'denied') {
          Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
          return;
        }
      }

      // 2) GM_notification fallback
      try {
        GM_notification({
          title,
          text,
          timeout: 0,
          silent: false,
          onclick: () => { if (typeof onClick === 'function') onClick(); },
        });
      } catch (_) {
        document.title = `🔴 ${title}`;
      }
    }
  
    function safeText(s, max = 80) {
      const t = String(s ?? '').replace(/\s+/g, ' ').trim();
      if (t.length <= max) return t;
      return t.slice(0, max - 1) + '…';
    }
  
    function parseAllUnreadFromStatus(json) {
      const arr = json?.data;
      if (!Array.isArray(arr)) return null;
      const all = arr.find(x => String(x?.mbox_no) === 'all');
      const unread = all?.unread;
      return (typeof unread === 'number') ? unread : null;
    }
  
    function extractNewMailsFromList(json) {
      const arr = json?.data;
      if (!Array.isArray(arr)) return [];
      // Each mail: { no, from, subject, received_date, ... }
      const items = [];
      for (const m of arr) {
        const no = m?.no;
        if (typeof no !== 'number') continue;
        items.push({
          no,
          from: safeText(m?.from, 60),
          subject: safeText(m?.subject, 90),
          received: m?.received_date ?? null,
        });
      }
      return items;
    }
  
    function buildSummary(newItems) {
      const top = newItems.slice(0, SUMMARY_MAX);
      const lines = top.map(m => `${m.subject || '(제목 없음)'} — ${m.from || '(보낸사람 없음)'}`);
      const extra = newItems.length - top.length;
      if (extra > 0) lines.push(`…외 ${extra}건`);
      return lines.join('\n');
    }
  
    function fetchJson(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'json',
                // 쿠키 포함(세션 기반이면 이게 중요)
                withCredentials: true,
                headers: {
                    'Accept': 'application/json;charset=UTF-8',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'x-skip-session-refresh': 'true',
                },
                onload: (res) => {
                    const ok = res.status >= 200 && res.status < 300;
                    if (!ok) return reject(new Error(`HTTP ${res.status}`));
                    // responseType:'json'이면 res.response에 JSON이 들어옴
                    if (res.response) return resolve(res.response);
  
                    // 혹시 json 파싱이 안 됐을 때 fallback
                    try { resolve(JSON.parse(res.responseText)); }
                    catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('GM_xmlhttpRequest failed')),
                ontimeout: () => reject(new Error('GM_xmlhttpRequest timeout')),
            });
        });
    }
  
  
    async function syncBaselineOnce() {
      // First run: fetch latest mails and mark them seen so we don't notify a burst
      try {
        const j = await fetchJson(MAILS_URL);
        const items = extractNewMailsFromList(j);
        markSeen(items.map(x => x.no));
        initDone = true;
      } catch (e) {
        // If baseline fails, still mark initDone so we don't block forever.
        initDone = true;
      }
    }
  
    async function handleNewMailFlow() {
      if (!tryBecomeLeader()) return;
      if (fetching) return;
      fetching = true;
      try {
        const listJson = await fetchJson(MAILS_URL);
        const items = extractNewMailsFromList(listJson);
  
        // Determine genuinely new mail nos
        const newItems = items.filter(m => !isSeen(m.no));
        if (newItems.length > 0) {
          // Mark seen first to avoid duplicate notify if something fires twice
          markSeen(newItems.map(m => m.no));
  
          const title = `📧 Hiworks 새 메일 ${newItems.length}건`;
          const body = buildSummary(newItems);
          const firstNo = newItems[0].no;
          notify(title, body, () => openMailFromNotification(firstNo));
        }
      } catch (e) {
        // ignore silently
      } finally {
        fetching = false;
      }
    }
  
    function handleStatusJson(statusJson) {
      lastStatusSeenAt = Date.now();
  
      const unread = parseAllUnreadFromStatus(statusJson);
      if (unread == null) return;
  
      // initialize lastAllUnread on first sight
      if (lastAllUnread == null) {
        lastAllUnread = unread;
        GM_setValue(K_LAST_UNREAD, lastAllUnread);
        return;
      }
  
      if (unread > lastAllUnread) {
        lastAllUnread = unread;
        GM_setValue(K_LAST_UNREAD, lastAllUnread);
  
        // If baseline not done, do it first (so we don't notify old stuff)
        if (!initDone) {
          syncBaselineOnce().then(() => handleNewMailFlow());
        } else {
          handleNewMailFlow();
        }
      } else {
        // keep tracking decreases but do nothing (avoid repeat notifications)
        lastAllUnread = unread;
        GM_setValue(K_LAST_UNREAD, lastAllUnread);
      }
    }
  
    function openMailFromNotification(mailNo) {
      const url = `https://mails.office.hiworks.com/view/personal/${encodeURIComponent(mailNo)}`;
      window.open(url, '_blank', 'noopener,noreferrer');
    }

    function getTabId() {
      return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    
    const TAB_ID = getTabId();
    
    function tryBecomeLeader() {
      const now = Date.now();
      const cur = GM_getValue(K_NOTIFY_LEADER, null);
    
      if (!cur || now - cur.ts > LEADER_TTL_MS) {
        // 비어있거나 만료 → 내가 리더
        GM_setValue(K_NOTIFY_LEADER, { tabId: TAB_ID, ts: now });
        return true;
      }
    
      // 이미 내가 리더면 갱신
      if (cur.tabId === TAB_ID) {
        GM_setValue(K_NOTIFY_LEADER, { tabId: TAB_ID, ts: now });
        return true;
      }
    
      // 다른 탭이 리더
      return false;
    }
  
    /********************
     * Hook XHR + fetch
     ********************/
    function tryHandleResponse(url, text) {
      if (!url || typeof text !== 'string' || text.length < 2) return;
  
      // status
      if (url.includes(STATUS_API_MATCH) && url.includes('with=managed')) {
        try {
          const j = JSON.parse(text);
          handleStatusJson(j);
        } catch (_) {}
        return;
      }
  
      // mails(all) - optional: could be used, but we primarily call ourselves
      // You can add logic here if you want to leverage captured list without extra fetch.
    }
  
    // XHR hook
    const XHROpen = XMLHttpRequest.prototype.open;
    const XHRSend = XMLHttpRequest.prototype.send;
  
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__hw_url = url;
      return XHROpen.call(this, method, url, ...rest);
    };
  
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener('load', function() {
        const url = this.__hw_url || '';
        const text = (typeof this.responseText === 'string') ? this.responseText : '';
        tryHandleResponse(url, text);
      });
      return XHRSend.apply(this, args);
    };
  
    // fetch hook (in case they use fetch in some routes)
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      const res = await origFetch(input, init);
      try {
        const url = (typeof input === 'string') ? input : (input?.url ?? '');
        // Clone so we don't consume body
        const clone = res.clone();
        const ct = clone.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const text = await clone.text();
          tryHandleResponse(url, text);
        }
      } catch (_) {}
      return res;
    };
  
    /********************
     * Fallback polling (insurance)
     ********************/
    async function pollStatusOnceIfNeeded() {
      const now = Date.now();
      if (now - lastStatusSeenAt < FALLBACK_NO_STATUS_MS) return;
  
      try {
        const j = await fetchJson(STATUS_URL);
        handleStatusJson(j);
      } catch (e) {
        // ignore
      }
    }
  
    /********************
     * Boot
     ********************/
    // baseline once so we don't notify old emails immediately
    syncBaselineOnce();
  
    // insurance timer
    setInterval(pollStatusOnceIfNeeded, FALLBACK_TICK_MS);

    // 하트비트 갱신
    setInterval(() => {
      tryBecomeLeader();
    }, LEADER_TTL_MS / 2);
  
    // optional: a small startup ping
    notify('Hiworks 알림 감시 시작', '새 메일(안읽음)만 요약 알림으로 알려요.');
  })();
