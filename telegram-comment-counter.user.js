// ==UserScript==
// @name         Telegram 评论统计助手
// @namespace    tg-comment-counter
// @version      0.5.0
// @description  只读解析 Web K 右侧聊天区帖子评论数+正文，悬浮UI + IndexedDB + 排序 + CSV导出，不触碰左侧列表/不调用 API
// @match        https://web.telegram.org/k/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------- config ----------

  const config = {
    MID_PACK_BASE: 4294967296, // 2^32，data-mid 为打包值
    scanDebounceMs: 300,
    db: { name: 'tg-comment-stats', store: 'records', version: 1 },
    ui: {
      title: 'Telegram评论统计助手',
      maxListRows: 50
    }
  };

  // ---------- parser ----------

  function findChatPane() {
    return document.querySelector('#column-center .chat.active'); // 右侧聊天区，永不查询 #column-left
  }

  function extractChannel() {
    const m = location.hash.match(/[@/-]([A-Za-z][A-Za-z\d_]{3,})/);
    const username = m ? m[1] : '';
    const titleEl = document.querySelector('#column-center .sidebar-header.topbar .peer-title');
    return { username, title: titleEl ? titleEl.textContent.trim() : username };
  }

  function extractPostId(bubble) {
    const raw = Number(bubble.getAttribute('data-mid'));
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw >= config.MID_PACK_BASE ? raw - config.MID_PACK_BASE : raw;
  }

  function extractCommentCount(bubble) {
    if (!bubble.classList.contains('with-replies')) return null;
    const el = bubble.querySelector('.replies-footer-text .i18n') || bubble.querySelector('.replies-footer-text');
    if (!el) return null;
    const m = el.textContent.match(/(\d+)/); // "43 Comments" / "11条评论"
    return m ? Number(m[1]) : 0; // "Leave a comment" → 0
  }

  function findMessages(pane) {
    return pane.querySelectorAll('.bubble.channel-post');
  }

  // 递归取文本：<br>→\n，媒体节点→占位符，其余保留原样
  function nodeToText(n) {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1) return '';
    if (n.tagName === 'BR') return '\n';
    if (['IMG', 'PICTURE', 'VIDEO', 'CANVAS'].includes(n.tagName) ||
        (n.className + '').includes('media-sticker')) return '[媒体]';
    let s = '';
    for (const c of n.childNodes) s += nodeToText(c);
    if ((n.tagName === 'DIV' || n.tagName === 'P') && s && !s.endsWith('\n')) s += '\n';
    return s;
  }

  function extractContent(bubble) {
    const msg = bubble.querySelector('.message');
    if (!msg) return '';
    const clone = msg.cloneNode(true);
    clone.querySelectorAll('reactions-element, .reactions, .clearfix').forEach(n => n.remove());
    return nodeToText(clone).replace(/\u200b/g, '').trim();
  }

  function buildRecord(bubble, channel) {
    const postId = extractPostId(bubble);
    if (postId === null || !channel.username) return null;
    return {
      key: channel.username + '_' + postId,
      channel: channel.username,
      channel_title: channel.title,
      post_id: String(postId),
      post_url: 'https://t.me/' + channel.username + '/' + postId,
      comment_count: extractCommentCount(bubble),
      content: extractContent(bubble),
      collected_at: Date.now()
    };
  }

  // ---------- storage (IndexedDB) ----------

  const storage = (() => {
    let db = null;

    function open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(config.db.name, config.db.version);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(config.db.store, { keyPath: 'key' });
        };
        req.onsuccess = () => { db = req.result; resolve(db); };
        req.onerror = () => reject(req.error);
      });
    }

    function tx(mode) {
      return db.transaction(config.db.store, mode).objectStore(config.db.store);
    }

    function wrap(req) {
      return new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    }

    return {
      open,
      loadAll: () => wrap(tx('readonly').getAll()),
      put: rec => wrap(tx('readwrite').put(rec)),
      clear: () => wrap(tx('readwrite').clear())
    };
  })();

  // ---------- state ----------

  const records = new Map(); // key -> record，内存镜像，兼作去重缓存
  let monitoring = true;
  let currentChannel = { username: '', title: '' };
  let sortMode = 'id'; // 'id' | 'comments-desc' | 'comments-asc'

  // ---------- export ----------

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCSV() {
    const header = ['channel', 'channel_title', 'post_id', 'post_url', 'comment_count', 'content'];
    const rows = sortRecords([...records.values()]).map(r =>
      [r.channel, r.channel_title, r.post_id, r.post_url, r.comment_count ?? '', r.content || ''].map(csvEscape).join(',')
    );
    const blob = new Blob(['\uFEFF' + header.join(',') + '\n' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = csvFileName() + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function csvFileName() {
    const all = [...records.values()];
    const src = all.find(r => r.channel === currentChannel.username) || all[0] || {};
    const safe = s => (s || '').replace(/[\\/:*?"<>|\s]/g, '');
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const ymd = p(d.getFullYear() % 100) + p(d.getMonth() + 1) + p(d.getDate());
    return safe(src.channel) + safe(src.channel_title) + ymd;
  }

  function sortRecords(list) {
    if (sortMode === 'comments-desc') return list.sort((a, b) => (b.comment_count ?? -1) - (a.comment_count ?? -1));
    if (sortMode === 'comments-asc') return list.sort((a, b) => (a.comment_count ?? Infinity) - (b.comment_count ?? Infinity));
    return list.sort((a, b) => Number(b.post_id) - Number(a.post_id));
  }

  // ---------- ui ----------

  const ui = (() => {
    let panel, body, statsEl, listEl, chEl, toggleBtn;

    const css = `
      #tcc-panel{position:fixed;top:70px;right:16px;width:300px;max-height:70vh;display:flex;flex-direction:column;
        background:#17212b;color:#f5f5f5;border:1px solid #101921;border-radius:10px;z-index:99999;
        font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5)}
      #tcc-panel.tcc-hidden{display:none}
      .tcc-head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#0e1621;border-radius:10px 10px 0 0;cursor:move;user-select:none}
      .tcc-head b{flex:1;font-size:13px}
      .tcc-head button{background:none;border:none;color:#aab8c6;cursor:pointer;font-size:14px;padding:0 4px}
      .tcc-body{padding:8px 10px;overflow:hidden auto}
      .tcc-stats{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px}
      .tcc-stats>div{background:#0e1621;border-radius:6px;padding:6px 8px}
      .tcc-stats small{color:#708499;display:block}
      .tcc-channel{color:#708499;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .tcc-btns{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      .tcc-btns button{flex:1 1 44%;background:#2b5278;border:none;color:#fff;border-radius:6px;padding:6px 4px;cursor:pointer;font-size:12px}
      .tcc-btns button:hover{background:#3a6a96}
      .tcc-list{list-style:none;margin:0;padding:0;max-height:200px;overflow:auto}
      .tcc-list li{display:flex;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px solid #101921;flex-wrap:wrap}
      .tcc-list .prev{flex:1 1 100%;order:3;color:#aab8c6;font-size:12px;white-space:pre-line;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
      .tcc-list li a{color:#6ab3f3;text-decoration:none}
      .tcc-list .rank{color:#e8b34b;width:34px;flex:none}
      .tcc-list .open{background:#24364a;border:none;color:#6ab3f3;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:12px}
      .tcc-list .cnt{color:#708499;margin-left:auto}
      #tcc-fab{position:fixed;bottom:80px;right:16px;width:36px;height:36px;border-radius:50%;background:#2b5278;color:#fff;
        border:none;cursor:pointer;z-index:99999;display:none}
    `;

    function build() {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);

      panel = document.createElement('div');
      panel.id = 'tcc-panel';
      panel.innerHTML = `
        <div class="tcc-head"><b>${config.ui.title}</b>
          <button data-act="min" title="折叠">–</button>
          <button data-act="close" title="关闭">×</button></div>
        <div class="tcc-body">
          <div class="tcc-channel">当前频道：—</div>
          <div class="tcc-stats">
            <div><small>已发现帖子</small><span data-stat="total">0</span></div>
            <div><small>有评论帖子</small><span data-stat="with">0</span></div>
          </div>
          <div class="tcc-btns">
            <button data-act="start">开始监控</button>
            <button data-act="pause">暂停</button>
            <button data-act="refresh">刷新数据</button>
            <button data-act="sort">评论排序</button>
            <button data-act="export">导出CSV</button>
            <button data-act="clear">清空数据</button>
          </div>
          <ul class="tcc-list"></ul>
        </div>`;
      document.body.appendChild(panel);

      toggleBtn = document.createElement('button');
      toggleBtn.id = 'tcc-fab';
      toggleBtn.textContent = '统';
      toggleBtn.title = '打开评论统计面板';
      document.body.appendChild(toggleBtn);

      body = panel.querySelector('.tcc-body');
      statsEl = panel.querySelector('.tcc-stats');
      listEl = panel.querySelector('.tcc-list');
      chEl = panel.querySelector('.tcc-channel');

      panel.querySelector('.tcc-head').addEventListener('click', e => {
        const act = e.target.dataset.act;
        if (act === 'min') body.style.display = body.style.display === 'none' ? '' : 'none';
        if (act === 'close') { panel.classList.add('tcc-hidden'); toggleBtn.style.display = 'block'; }
      });
      toggleBtn.addEventListener('click', () => { panel.classList.remove('tcc-hidden'); toggleBtn.style.display = 'none'; });

      panel.querySelector('.tcc-btns').addEventListener('click', e => onAction(e.target.dataset.act));
      sortBtn = panel.querySelector('[data-act=sort]');
      listEl.addEventListener('click', e => {
        const b = e.target.closest('button.open');
        if (b) window.open(b.dataset.url, '_blank', 'noopener');
      });
      enableDrag(panel, panel.querySelector('.tcc-head'));
    }

    function onAction(act) {
      if (act === 'start') { monitoring = true; flash('监控已开启'); }
      if (act === 'pause') { monitoring = false; flash('监控已暂停'); }
      if (act === 'refresh') { rescanCurrent(); flash('已刷新'); }
      if (act === 'sort') {
        sortMode = sortMode === 'id' ? 'comments-desc' : sortMode === 'comments-desc' ? 'comments-asc' : 'id';
      }
      if (act === 'export') { exportCSV(); flash('CSV 已导出'); }
      if (act === 'clear') { clearAll(); flash('已清空'); }
      render();
    }

    function enableDrag(el, handle) {
      let sx, sy, ox, oy, on = false;
      handle.addEventListener('pointerdown', e => {
        if (e.target.dataset.act) return;
        on = true; sx = e.clientX; sy = e.clientY;
        const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', e => {
        if (!on) return;
        el.style.left = ox + e.clientX - sx + 'px';
        el.style.top = oy + e.clientY - sy + 'px';
        el.style.right = 'auto';
      });
      handle.addEventListener('pointerup', () => { on = false; });
    }

    let flashTimer = null;
    function flash(msg) {
      chEl.textContent = msg;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(renderChannel, 1200);
    }

    function renderChannel() {
      chEl.textContent = '当前频道：' + (currentChannel.title || '—');
    }

    let sortBtn;

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    }

    function render() {
      const all = [...records.values()].filter(r => r.channel === currentChannel.username || !currentChannel.username);
      statsEl.querySelector('[data-stat=total]').textContent = all.length;
      statsEl.querySelector('[data-stat=with]').textContent = all.filter(r => r.comment_count > 0).length;
      renderChannel();
      if (sortBtn) sortBtn.textContent = sortMode === 'id' ? '评论排序' : sortMode === 'comments-desc' ? '评论 ↓' : '评论 ↑';
      const rows = sortRecords(all).slice(0, config.ui.maxListRows);
      listEl.innerHTML = rows.map((r, i) =>
        `<li><span class="rank">TOP${i + 1}</span>` +
        `<a href="${r.post_url}" target="_blank" rel="noopener">#${r.post_id}</a>` +
        `<span class="cnt">${r.comment_count === null ? '—' : r.comment_count + ' 评论'}</span>` +
        `<button class="open" data-url="${r.post_url}">打开</button>` +
        `<div class="prev">${escapeHtml(r.content || '')}</div></li>`
      ).join('');
    }

    return { build, render };
  })();

  // ---------- collector ----------

  async function collectBubble(bubble) {
    if (!monitoring) return;
    const rec = buildRecord(bubble, currentChannel);
    if (!rec) return;
    const old = records.get(rec.key);
    if (old && old.content) return; // 已有完整记录
    if (old) rec.comment_count = rec.comment_count ?? old.comment_count;
    records.set(rec.key, rec);
    try { await storage.put(rec); } catch (e) { console.warn('[评论统计] 写入失败', e); }
    ui.render();
  }

  function scanPane(pane) {
    currentChannel = extractChannel();
    findMessages(pane).forEach(b => collectBubble(b));
  }

  function rescanCurrent() {
    const pane = findChatPane();
    if (pane) scanPane(pane);
  }

  async function clearAll() {
    records.clear();
    try { await storage.clear(); } catch (e) { console.warn(e); }
  }

  // ---------- observer ----------

  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(rescanCurrent, config.scanDebounceMs);
  }

  const observer = new MutationObserver(muts => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList && (node.classList.contains('bubble') || node.classList.contains('channel-post'))) {
          scheduleScan();
          return;
        }
        if (node.querySelector && node.querySelector('.bubble.channel-post')) {
          scheduleScan();
          return;
        }
      }
    }
  });

  // ---------- boot ----------

  (async function main() {
    ui.build();
    try {
      await storage.open();
      const saved = await storage.loadAll();
      saved.forEach(r => records.set(r.key, r));
      console.log('[评论统计] 已从 IndexedDB 恢复', saved.length, '条记录');
    } catch (e) {
      console.warn('[评论统计] IndexedDB 不可用，仅内存模式', e);
    }
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', scheduleScan);
    rescanCurrent();
    console.log('[评论统计] 脚本已加载（阶段4，全功能）');
  })();
})();
