// ==UserScript==
// @name         Telegram 评论统计助手
// @namespace    tg-comment-counter
// @version      1.19.0
// @description  只读解析 Web K 右侧聊天区帖子（评论数+正文+发布时间+浏览量+表情反应），分频道采集与视图切换、悬浮UI（按钮悬停说明+按键区滚动条）、页内跳转到指定消息、IndexedDB 持久化、CSV 导入/导出（CSV 即数据库，导入前嗅探 UTF-8 编码）、导入/清空前内存快照可一键恢复、模拟滚动、全量+增量采集、排序、分频道批量导出；不调用任何 Telegram API
// @match        https://web.telegram.org/k/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 模块结构：
 *   Config            统一配置（滚动/扫描/存储/UI 默认值）
 *   Utils             通用工具
 *   StorageManager    IndexedDB（records + meta 两个 store）
 *   MessageParser     右侧聊天区定位 + 帖子解析（channel/post_id/comment_count/content/publish_time）
 *   ScanManager       Full Scan + Incremental Update（initial / incremental 两种模式）
 *   ScrollSimulator   模拟滚动（只操作 Telegram 真实消息滚动容器；步长/间隔在用户给定区间内随机）
 *   UIManager         悬浮面板（状态、采集计数、滚屏参数编辑、按钮绿色状态机）
 *   CSVExporter       UTF-8 BOM CSV
 * 安全约束：全程只读取 #column-center 右侧聊天区已渲染 DOM，绝不触碰 #column-left 会话列表。
 */

(function () {
  'use strict';

  // 版本号单一来源：优先读油猴识别的 @version（GM_info），读不到才用兜底常量。
  // 兜底常量必须和头部 @version 保持一致，否则粘贴安装后标题会显示旧版本。
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.19.0';

  // ============================================================
  // Config
  // ============================================================

  const CONFIG = {
    MID_PACK_BASE: 4294967296, // 2^32：K 版 data-mid 为打包值，真实 post_id = mid - 2^32
    scanDebounceMs: 300,

    db: { name: 'tg-comment-stats', storeRecords: 'records', storeMeta: 'meta', version: 2 },

    // 模拟滚动配置（v1.5.0 精简；v1.12.0 去掉"方向"——采集只应朝历史方向滚，方向语义曾判反）
    scrollConfig: {
      speedMin: 60,            // e px
      speedMax: 140,           // f px
      intervalMin: 700,        // g ms
      intervalMax: 1500,       // h ms
      maxSteps: 3000,          // 内部上限：防失控
      maxRuntime: 3600000      // 内部上限：60 分钟
    },

    // 扫描配置
    scanConfig: {
      maxDuplicateCount: 10,     // 增量模式：连续 N 屏全是已知帖 → 判定历史边界
      initialEndStableRounds: 5, // 初始模式：已到顶部且最小 post_id 连续 N 轮不变 → 完成
      bubbleSelector: '.bubble.channel-post'
    },

    // rowCap：一次最多渲染多少行 DOM。数据上万条时全量渲染会让面板卡住，
    // 超过部分靠筛选缩小范围（面板会明确写出"仅显示前 N 条"）
    ui: { title: 'Telegram频道分析助手', rowCap: 500, defaultWidth: 520 }
  };

  // ============================================================
  // Utils
  // ============================================================

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => min + Math.random() * (max - min);
  const clampInt = (v, min, max, dft) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dft;
  };
  const pad2 = n => String(n).padStart(2, '0');

  // 用户界面设置持久化（localStorage，与页面同源，刷新/切标签回来不丢失）
  const SETTINGS_KEY = 'tcc-settings-v1';
  const LOG = '[频道分析]';
  const Settings = (() => {
    function load() {
      try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
    }
    function save(patch) {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(Object.assign(load(), patch))); }
      catch (e) { console.warn(LOG, '设置保存失败', e); }
    }
    return { load, save };
  })();

  // 同一页面只允许有一份在跑。Tampermonkey 里如果这个脚本被复制成两份（改名导入最容易造成这个），
  // 两个实例会各起一个 ScrollSimulator 抢同一个消息容器：滚动互相抵消、增量边界判定失真、双写同一个库。
  if (window.__tccLoaded) {
    console.warn(LOG, '已有一份脚本在运行，本次注入直接跳过（检查 Tampermonkey 是否装了重复脚本）');
    return;
  }
  window.__tccLoaded = true;

  // ============================================================
  // State
  // ============================================================

  const records = new Map();      // key(channel_postId) -> record，去重缓存
  const byChannel = new Map();    // channel -> { keys:Set, title, maxId }，避免每次渲染/导出全表扫描
  const sessionKnown = new Set(); // 本次扫描开始前就已存在的 key，用于增量边界判断
  // S7：写库失败过的 key。内存里有了、库里没有＝刷新页面就丢，所以每轮扫描都补写，直到真落库
  const pendingPersist = new Set();
  let monitoring = true;          // 边滚边采开关（原名"被动监控/手动滚屏"）
  let activeTask = null;          // 'init' | 'incr' | null，驱动面板按钮绿色状态
  const uiBusy = { batch: false, impcsv: false }; // 长耗时导出/导入的持续状态
  let currentChannel = { username: '', title: '' };
  let channelFilter = 'auto';     // 'auto'=跟随当前打开的频道 | 'all'=全部 | 其他=指定频道 username
  let snapshot = null;            // 导入/清空前的内存快照 { kind, at, count, records:[...] }，只留最近一次，刷新页面即失效

  const stats = { added: 0, dup: 0, scrolls: 0, status: '空闲', stopReason: '' };

  // ============================================================
  // 表格状态：列定义 / 列宽 / 显隐 / 筛选 / 排序（全部持久化到 Settings.table）
  // ============================================================

  const COLUMNS = [
    { key: 'post_id', label: '消息ID', w: 84, num: true },
    { key: 'comment_count', label: '评论数', w: 74, num: true },
    { key: 'views', label: '浏览量', w: 84, num: true },
    { key: 'reactions_total', label: '反应', w: 68, num: true },
    { key: 'publish_time', label: '发布时间', w: 116, num: false, date: true },
    { key: 'content', label: '正文', w: 240, num: false }
  ];
  const COLBYKEY = {};
  COLUMNS.forEach(c => { COLBYKEY[c.key] = c; });
  const COL_MIN_W = 12, COL_MAX_W = 640; // 最小宽＝一个字的宽度再往下（用户要"能挤成一个字，裁一半也行"）
  const ACTION_W = 46; // 「打开」按钮列，固定宽、不参与显隐、不参与拖宽
  const RANK_W = 40;   // 序号列默认宽：只是当前排序下的行号，不参与筛选/排序/导出，但可拖窄

  const tableState = {
    widths: {},          // key -> 像素宽
    hidden: {},          // key -> true
    filters: {},         // key -> { text, min, max } 或日期列 { from, to, fromVals, toVals }
    mode: 'and',         // 'and' 同时包含 | 'or' 任意一个 | 'exact' 完整串（全局记住）
    sort: { key: 'post_id', dir: 'desc' }
  };
  COLUMNS.forEach(c => { tableState.widths[c.key] = c.w; });
  tableState.widths.rank = RANK_W; // 序号列宽度独立存，仍不进 COLUMNS/CSV

  function saveTable() {
    Settings.save({ table: {
      widths: tableState.widths, hidden: tableState.hidden,
      mode: tableState.mode, sort: tableState.sort
    } });
  }

  function restoreTable() {
    const t = Settings.load().table;
    if (!t) return;
    const clamp = w => Math.min(COL_MAX_W, Math.max(COL_MIN_W, w));
    if (t.widths) {
      COLUMNS.forEach(c => { const w = Number(t.widths[c.key]); if (Number.isFinite(w)) tableState.widths[c.key] = clamp(w); });
      const rw = Number(t.widths.rank); // 序号列宽同样存档（它不在 COLUMNS 里，手动带一下）
      if (Number.isFinite(rw)) tableState.widths.rank = clamp(rw);
    }
    if (t.hidden) Object.keys(t.hidden).forEach(k => { if (COLUMNS.some(c => c.key === k)) tableState.hidden[k] = !!t.hidden[k]; });
    if (['and', 'or', 'exact'].includes(t.mode)) tableState.mode = t.mode;
    if (t.sort && COLUMNS.some(c => c.key === t.sort.key)) tableState.sort = { key: t.sort.key, dir: t.sort.dir === 'asc' ? 'asc' : 'desc' };
  }

  const activeColumns = () => COLUMNS.filter(c => !tableState.hidden[c.key]);
  const hasFilters = () => Object.keys(tableState.filters).length > 0;

  // 数据每变一次就 +1：列表指纹带上它，才能让「面板空白 / 数字不更新」这类问题不再靠猜
  let dataVersion = 0;

  // 数字取值：正文/时间里的 "3.5K" 之类不用管，这里只处理记录里已是数字或纯数字串
  function numOf(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function textMatch(hay, needle, mode) {
    if (!needle) return true;
    const h = String(hay === null || hay === undefined ? '' : hay).toLowerCase();
    if (mode === 'exact') return h.includes(needle.toLowerCase());
    const toks = needle.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return true;
    return mode === 'or' ? toks.some(t => h.includes(t)) : toks.every(t => h.includes(t));
  }

  // 时间口径（v1.17.0，方案 B1）：全链路只有北京时间一个口径。
  // Telegram 的 data-timestamp 是 UTC 秒，采集时就 +8 换成定宽串 "YYYY-MM-DD HH:mm" 存进库里，
  // 表格显示、日期筛选、CSV 读写用的都是这一串，不再有显示层换算，也不会出现二次 +8。
  // 中国无夏令时（偏移恒为 +8），且定宽串字典序＝时间序，所以排序与日期比较逻辑一行都不用改。
  const CN_OFF = 8 * 3600 * 1000;
  const fmt = d => d.toISOString().replace('T', ' ').slice(0, 16);

  // 发布时间筛选：五格（年/月/日/时/分）→ 可比较串。库里这列存的是 "YYYY-MM-DD HH:mm" 定宽串，
  // 直接按字符串比大小就是按时间比。规则：从左往右第一个留空的格子及其后面取边界值（最小补最早、最大补最晚），
  // 也就是"留空＝这一档及之后不设限"；更小的格子在大格子留空时不起作用。
  const DATE_PAD = [[4, '0000', '9999'], [2, '01', '12'], [2, '01', '31'], [2, '00', '23'], [2, '00', '59']];
  function dateBound(vals, side) {
    const out = [];
    let stop = false;
    for (let i = 0; i < 5; i++) {
      const s = stop ? '' : String(vals[i] === null || vals[i] === undefined ? '' : vals[i]).trim();
      const n = s === '' ? NaN : Number(s);
      if (!Number.isFinite(n)) { // 空或非法：从此档起取边界值，后面几档一律忽略
        stop = true;
        out.push(side === 'min' ? DATE_PAD[i][1] : DATE_PAD[i][2]);
        continue;
      }
      const lo = i === 0 ? 1 : i >= 3 ? 0 : 1;       // 时/分可以为 0，年/月/日最小是 1
      const hi = Number(DATE_PAD[i][2]);
      out.push(String(Math.min(hi, Math.max(lo, Math.round(n)))).padStart(DATE_PAD[i][0], '0'));
    }
    return out[0] + '-' + out[1] + '-' + out[2] + ' ' + out[3] + ':' + out[4];
  }
  const dateEmpty = vals => vals.every(v => String(v === null || v === undefined ? '' : v).trim() === '');

  // 逐列筛选：关键字按全局匹配模式，数字列还支持最小/最大
  function matchFilters(rec) {
    for (const key of Object.keys(tableState.filters)) {
      const f = tableState.filters[key];
      if (!f) continue;
      const col = COLBYKEY[key];
      if (col && col.date) { // 日期列只走时间区间，不做关键字匹配
        if (!f.from && !f.to) continue;
        const v = String(rec[key] || '');
        if (!v) return false;
        if (f.from && v < f.from) return false;
        if (f.to && v > f.to) return false;
        continue;
      }
      if (f.min !== null || f.max !== null) {
        const n = numOf(rec[key]);
        if (n === null) return false;
        if (f.min !== null && n < f.min) return false;
        if (f.max !== null && n > f.max) return false;
      }
      if (f.text && !textMatch(rec[key], f.text, tableState.mode)) return false;
    }
    return true;
  }

  // 补采（S4-B）时这次没读到的字段沿用库里的值：DOM 偶尔会瞬时读空（虚拟列表回收、动画未落定），
  // 不加这层保护"刷新统计"反而会把有值的字段清成 null/空串，等于自己把自己的数据降级。
  function fillFromOld(rec, old) {
    rec.comment_count = rec.comment_count ?? old.comment_count;
    rec.views = rec.views ?? old.views;
    rec.content = rec.content || old.content;
    rec.publish_time = rec.publish_time || old.publish_time;
    rec.channel_title = rec.channel_title || old.channel_title;
    if (!rec.reactions_total && old.reactions_total) {
      rec.reactions = old.reactions;
      rec.reactions_total = old.reactions_total;
    }
  }

  // 只有会变的字段参与比较；collected_at 每次解析都不同，必须排除，否则每条每轮都算"变了"→ 无意义写库
  function statsChanged(old, rec) {
    return old.content !== rec.content ||
      old.comment_count !== rec.comment_count ||
      old.views !== rec.views ||
      old.reactions !== rec.reactions ||
      old.reactions_total !== rec.reactions_total ||
      old.publish_time !== rec.publish_time ||
      old.channel_title !== rec.channel_title;
  }

  // 写入内存镜像并同步维护频道索引；返回是否为新记录
  function putRecord(rec) {
    const old = records.get(rec.key);
    records.set(rec.key, rec);
    let g = byChannel.get(rec.channel);
    if (!g) { g = { keys: new Set(), title: rec.channel_title || '', maxId: 0 }; byChannel.set(rec.channel, g); }
    const id = Number(rec.post_id) || 0;
    if (!old) g.keys.add(rec.key);
    if (id > g.maxId) g.maxId = id;
    if (rec.channel_title) g.title = rec.channel_title;
    dataVersion++;
    return !!old;
  }

  // ============================================================
  // StorageManager (IndexedDB)
  // ============================================================

  const StorageManager = (() => {
    let db = null;

    function open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(CONFIG.db.name, CONFIG.db.version);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(CONFIG.db.storeRecords)) {
            d.createObjectStore(CONFIG.db.storeRecords, { keyPath: 'key' });
          }
          if (!d.objectStoreNames.contains(CONFIG.db.storeMeta)) {
            d.createObjectStore(CONFIG.db.storeMeta, { keyPath: 'k' });
          }
        };
        req.onsuccess = () => { db = req.result; resolve(db); };
        req.onerror = () => reject(req.error);
      });
    }

    const wrap = req => new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const store = (name, mode) => db.transaction(name, mode).objectStore(name);

    return {
      open,
      loadAll: () => wrap(store(CONFIG.db.storeRecords, 'readonly').getAll()),
      putMany(list) {
        return new Promise((res, rej) => {
          const tx = db.transaction(CONFIG.db.storeRecords, 'readwrite');
          const os = tx.objectStore(CONFIG.db.storeRecords);
          for (const r of list) os.put(r);
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error);
        });
      },
      clearRecords: () => wrap(store(CONFIG.db.storeRecords, 'readwrite').clear()),
    // 只清某个频道时用：一次事务批量按 key 删
    deleteMany(keys) {
      return new Promise((res, rej) => {
        const tx = db.transaction(CONFIG.db.storeRecords, 'readwrite');
        const os = tx.objectStore(CONFIG.db.storeRecords);
        for (const k of keys) os.delete(k);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
    },
      getMeta: k => wrap(store(CONFIG.db.storeMeta, 'readonly').get(k)),
      setMeta: obj => wrap(store(CONFIG.db.storeMeta, 'readwrite').put(obj)),
      clearMeta: () => wrap(store(CONFIG.db.storeMeta, 'readwrite').clear()),
      hasDb: () => !!db,
      // 快照恢复专用：清表 + 整批写回 + meta 都放在同一个事务里。
      // 旧写法是 clearRecords() 和 putMany() 两个独立事务，中间失败＝库被清空却没写回，刷新页面就真丢数据。
      // meta 三态：对象＝写回；null＝快照那一刻没有（删掉）；undefined＝当初没读成功（不动）。
      replaceAll(list, meta) {
        return new Promise((res, rej) => {
          const tx = db.transaction([CONFIG.db.storeRecords, CONFIG.db.storeMeta], 'readwrite');
          const os = tx.objectStore(CONFIG.db.storeRecords);
          os.clear();
          for (const r of list) os.put(r);
          const ms = tx.objectStore(CONFIG.db.storeMeta);
          if (meta === undefined) { /* 不动 meta */ }
          else if (meta === null) ms.delete('scan');
          else ms.put(meta);
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error);
        });
      }
    };
  })();

  // ============================================================
  // MessageParser —— 只处理右侧 #column-center
  // ============================================================

  const MessageParser = (() => {

    function findChatPane() {
      return document.querySelector('#column-center .chat.active'); // 右侧聊天区，永不查询 #column-left
    }

    // Telegram 真实消息滚动容器（禁止 window/document 滚动）；结果按 pane 缓存，
    // 因为兜底分支要遍历全部后代节点，每步滚动都算一次开销很大
    const scrollerCache = new WeakMap();
    function findScroller(pane) {
      if (!pane) return null;
      const hit = scrollerCache.get(pane);
      if (hit && hit.isConnected) return hit;
      const sc = pane.querySelector('.bubbles-scrollable') ||
                 [...pane.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 200 && e.clientWidth > 200);
      if (sc) scrollerCache.set(pane, sc);
      return sc || null;
    }

    function extractChannel() {
      const m = location.hash.match(/[@/-]([A-Za-z][A-Za-z\d_]{3,})/);
      const username = m ? m[1] : '';
      const titleEl = document.querySelector('#column-center .sidebar-header.topbar .peer-title');
      return { username, title: titleEl ? titleEl.textContent.trim() : username };
    }

    function extractPostId(bubble) {
      const raw = Number(bubble.getAttribute('data-mid'));
      if (!Number.isFinite(raw) || raw <= 0) return null; // 排除 service / sponsored
      return raw >= CONFIG.MID_PACK_BASE ? raw - CONFIG.MID_PACK_BASE : raw;
    }

    // 评论数：i18n 文本形如 "43 Comments" / "11条评论" / "1,234 Comments" / "1.2K Comments"。
    // 原先用 /(\d+)/ 只取第一段连续数字，千分位会把 1,234 读成 1，而且这个错值入库后再不会被纠正。
    // 现在先截出「数字 + 可能的千分位分隔 + 可能的缩写单位」再交给 parseCompact：1,234→1234，1.2K→1200。
    function extractCommentCount(bubble) {
      if (!bubble.classList.contains('with-replies')) return null;
      const el = bubble.querySelector('.replies-footer-text .i18n') || bubble.querySelector('.replies-footer-text');
      if (!el) return null;
      const m = el.textContent.match(/\d[\d.,]*\s*[KMB万]?/i); // 词序不固定，不能用 ^ 锚定
      const n = m ? parseCompact(m[0]) : null;
      return n === null ? 0 : n; // "Leave a comment" → 0
    }

    // 递归取文本：<br>→\n，媒体节点→占位符（不保留媒体文件），保留原始换行结构
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

    // "3.5K" / "1.2M" / "12,340" / "1.5万" → 整数
    function parseCompact(s) {
      s = (s || '').replace(/\s+/g, '');
      const m = s.match(/^([\d.,]+)([KMB万]?)/i);
      if (!m) return null;
      let n = parseFloat(m[1].replace(/,/g, ''));
      if (!Number.isFinite(n)) return null;
      const u = m[2].toUpperCase();
      if (u === 'K') n *= 1e3; else if (u === 'M') n *= 1e6; else if (m[2] === '万') n *= 1e4;
      return Math.round(n);
    }

    // 浏览量：time > .post-views（可能出现两处，取第一个有数字的；空文本 = 浏览量关闭）
    function extractViews(bubble) {
      for (const e of bubble.querySelectorAll('.post-views')) {
        const n = parseCompact(e.textContent);
        if (n !== null) return n;
      }
      return null;
    }

    // 表情反应：reactions-element 内每个 .reaction
    //   表情名与计数一律先读属性，textContent 只作兜底——文本里混着零宽空格/换行，
    //   计数器数字和表情挤在一起，付费✦组还没有计数器（连写字符数即数量）
    const RX_NAME_ATTRS = ['data-emoji', 'alt', 'data-name', 'title', 'aria-label'];
    const RX_COUNT_ATTRS = ['data-count', 'data-total', 'data-reaction-count', 'data-value'];

    function firstAttr(el, names) {
      if (!el) return '';
      for (const n of names) {
        const v = el.getAttribute(n);
        if (v && v.trim()) return v.trim();
      }
      return '';
    }

    // title/aria-label 在部分版本里是"Hans、Anna 和其他 12 人赞了"这类长句，
    // 只接受形似表情的短值（无空格、够短），否则当作不可用
    const asReactionName = v => (v && v.length <= 8 && !/[\s\d]/.test(v.trim()) ? v.trim() : '');

    function digits(v) {
      const s = (v || '').replace(/[^\d]/g, '');
      return s ? Number(s) : null;
    }

    function readReaction(item) {
      const cntEl = item.querySelector('.reaction-counter');
      const cntText = cntEl ? (cntEl.textContent || '').trim() : '';
      let count = cntEl
        ? (digits(firstAttr(cntEl, RX_COUNT_ATTRS)) ?? digits(cntText))
        : digits(firstAttr(item, RX_COUNT_ATTRS));
      let name = asReactionName(firstAttr(item, RX_NAME_ATTRS)) ||
                 (item.textContent || '').replace(/\u200b/g, '').trim();
      if (cntText && name.includes(cntText)) name = name.replace(cntText, '');
      name = name.replace(/[\s\u200b]+/g, '');
      const chars = [...name];
      if (count === null) { // 无计数器的付费✦组：连写字符本身的数量即计数
        if (!chars.length) return null;
        return { name: chars[0], count: chars.length };
      }
      return { name: chars.length ? name : '[表情]', count };
    }

    function extractReactions(bubble) {
      const el = bubble.querySelector('reactions-element');
      if (!el) return { summary: '', total: 0 };
      const parts = [];
      let total = 0;
      for (const item of el.querySelectorAll('.reaction')) {
        const r = readReaction(item);
        if (!r) continue;
        parts.push(r.name + '×' + r.count);
        total += r.count;
      }
      return { summary: parts.join(' '), total };
    }

    function extractPublishTime(bubble) {
      const ts = Number(bubble.getAttribute('data-timestamp'));
      if (!Number.isFinite(ts) || ts <= 0) return '';
      return fmt(new Date(ts * 1000 + CN_OFF)); // 直接存北京时间 "YYYY-MM-DD HH:mm"
    }

    // keepContent：补采（S4-B）时库里已有的正文。已知帖子只需要刷新评论数/浏览量/反应，
    // 正文不再重新克隆整棵 .message 子树——那是每屏最贵的一次 DOM 操作。
    // 库里正文为空时传 undefined，走 extractContent 正常解析，原有「缺正文就补采」行为不变。
    function buildRecord(bubble, channel, keepContent) {
      const postId = extractPostId(bubble);
      if (postId === null || !channel.username) return null;
      const rx = extractReactions(bubble);
      return {
        key: channel.username + '_' + postId,
        channel: channel.username,
        channel_title: channel.title,
        post_id: String(postId),
        post_url: 'https://t.me/' + channel.username + '/' + postId,
        comment_count: extractCommentCount(bubble),
        content: keepContent || extractContent(bubble),
        publish_time: extractPublishTime(bubble),
        views: extractViews(bubble),
        reactions: rx.summary,
        reactions_total: rx.total,
        collected_at: Date.now()
      };
    }

    function findMessages(pane) {
      return pane.querySelectorAll(CONFIG.scanConfig.bubbleSelector);
    }

    function findBubbleByPostId(postId) {
      const pane = findChatPane();
      if (!pane) return null;
      const target = Number(postId);
      for (const b of findMessages(pane)) {
        if (extractPostId(b) === target) return b;
      }
      return null;
    }

    // 把某气泡滚到聊天区视口中央：只改 Telegram 容器的 scrollTop，不碰 window/document
    function centerBubble(bubble) {
      const pane = findChatPane();
      const sc = pane && findScroller(pane);
      if (!sc) return false;
      const offset = bubble.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      sc.scrollTop += offset - sc.clientHeight / 2 + bubble.clientHeight / 2;
      return true;
    }

    return { findChatPane, findScroller, extractChannel, buildRecord, findMessages, extractPostId,
      findBubbleByPostId, centerBubble, parseCompact };
  })();

  // ============================================================
  // 采集核心：扫描当前已渲染帖子
  // ============================================================

  // 返回 { added, seenIds(本轮可见的 post_id), knownVisible(可见屏中"扫描前已知"的条数) }
  // countDup=false：空闲补采专用，不把重复累加进统计格（否则挂机一小时这个数字会虚涨几千）
  async function scanCurrentPane(countDup = true) {
    const idle = { added: 0, seenIds: new Set(), knownVisible: 0 };
    const pane = MessageParser.findChatPane();
    if (!pane) return idle;
    const prevCh = currentChannel.username;
    currentChannel = MessageParser.extractChannel();
    // 只在"从有到无以外的真切换"且确实有任务在跑时提示；刚进页面 prevCh 还是空，不算切换
    const channelChanged = !!currentChannel.username && !!prevCh && currentChannel.username !== prevCh;
    if (channelChanged && ScanManager.isRunning()) {
      stats.status = '已切换到频道 ' + currentChannel.title + '，本次采集结束';
    }
    if (!currentChannel.username) { UIManager.scheduleRender(); return idle; }
    if (!monitoring && !ScanManager.isRunning()) { UIManager.scheduleRender(); return idle; }

    let added = 0;
    const seenIds = new Set();
    let knownVisible = 0;
    const dirty = [];
    const ch = currentChannel.username;

    for (const bubble of MessageParser.findMessages(pane)) {
      const postId = MessageParser.extractPostId(bubble);
      if (postId === null) continue;
      seenIds.add(postId);
      const key = ch + '_' + postId;
      const old = records.get(key);
      if (old && sessionKnown.has(key)) knownVisible++;
      // S4-B：已有帖子也重读评论数/浏览量/反应；正文沿用库里的（见 buildRecord 的 keepContent）
      const rec = MessageParser.buildRecord(bubble, currentChannel, old && old.content);
      if (!rec) continue;
      if (old) {
        fillFromOld(rec, old);
        if (!statsChanged(old, rec)) continue; // 数字没变就不入库、不触发重绘（无效写库是采集期最大的浪费）
      }
      if (!putRecord(rec)) { added++; stats.added++; }
      dirty.push(rec);
    }
    if (countDup) stats.dup += Math.max(0, knownVisible - added);
    // S7：把上次没落库的也带上（dirty 里没有它们），一次事务补写
    let toWrite = dirty;
    if (pendingPersist.size) {
      const have = new Set(dirty.map(r => r.key));
      toWrite = dirty.slice();
      pendingPersist.forEach(k => {
        if (have.has(k)) return;
        const r = records.get(k);
        if (r) toWrite.push(r); else pendingPersist.delete(k); // 记录已被清掉/删掉就不用再补
      });
    }
    if (toWrite.length && StorageManager.hasDb()) {
      try { await StorageManager.putMany(toWrite); pendingPersist.clear(); }
      catch (e) {
        toWrite.forEach(r => pendingPersist.add(r.key));
        console.warn(LOG, '写入失败', e);
        UIManager.flash('本地库写入失败：' + e.message + '（数据仍在内存，别刷新页面，下轮扫描会自动补写）');
      }
    }
    UIManager.scheduleRender();
    return { added, seenIds, knownVisible };
  }

  // ============================================================
  // ScrollSimulator —— 只操作 Telegram 消息容器
  // ============================================================

  const ScrollSimulator = (() => {
    let running = false;
    let paused = false;
    let abort = false;
    let scroller = null;

    function isRunning() { return running; }
    function isPaused() { return paused; }
    function setPaused(v) { paused = v; }

    function stepPx() {
      const c = CONFIG.scrollConfig;
      return Math.round(rand(Math.min(c.speedMin, c.speedMax), Math.max(c.speedMin, c.speedMax)));
    }

    function intervalMs() {
      const c = CONFIG.scrollConfig;
      return Math.round(rand(Math.min(c.intervalMin, c.intervalMax), Math.max(c.intervalMin, c.intervalMax)));
    }

    async function maybePause() {
      if (Math.random() > 0.1) return; // 10% 概率模拟阅读停顿
      await sleep(rand(1000, 4000));
    }

    // onEach: async () => 停止原因字符串 | null。返回非空则停止。
    async function run(direction, onEach) {
      const pane = MessageParser.findChatPane();
      scroller = pane && MessageParser.findScroller(pane);
      if (!scroller) throw new Error('未找到消息滚动容器');

      running = true; abort = false; paused = false;
      const startedAt = Date.now();
      let count = 0;
      stats.stopReason = '';

      try {
        while (running && !abort) {
          const c = CONFIG.scrollConfig;
          if (Date.now() - startedAt > c.maxRuntime) return '达到最大运行时长';
          if (count >= c.maxSteps) return '达到最大滚动步数（安全上限）';

          if (paused) { await sleep(400); continue; }
          await maybePause();
          if (abort) return '手动停止';

          const d = stepPx() * (direction === 'up' ? -1 : 1);
          scroller.scrollTop += d;
          count++; stats.scrolls = count;

          const reason = await onEach();
          if (reason) return reason;

          await sleep(intervalMs());
        }
        return '手动停止';
      } finally {
        running = false;
      }
    }

    function stop() { abort = true; running = false; paused = false; }

    return { run, stop, isRunning, isPaused, setPaused };
  })();

  // ============================================================
  // ScanManager —— initial（首次完整采集）/ incremental（增量采集）
  // ============================================================

  const ScanManager = (() => {
    // S6：屏幕上连续三轮看不到任何帖子时的停止原因，全量/增量共用
    const EMPTY_PANE_REASON = '当前频道没有可采集的帖子（频道为空或消息尚未加载）';

    function isRunning() { return ScrollSimulator.isRunning() || activeTask !== null; }

    function markSessionKnown() {
      sessionKnown.clear();
      records.forEach((r, k) => sessionKnown.add(k)); // 采集前的全集，增量边界依据
    }

    async function saveState(patch) {
      const old = (await StorageManager.getMeta('scan')) || { k: 'scan' };
      Object.assign(old, patch, { lastScanTime: new Date().toISOString() });
      try { await StorageManager.setMeta(old); } catch (e) { console.warn(e); }
      return old;
    }

    // 当前可见帖子的最小 id（用于判断是否已到最早历史）；Set 上用 reduce，避免展开大数组
    function minVisibleId(seenIds) {
      let mn = Infinity;
      for (const v of seenIds) if (v < mn) mn = v;
      return mn;
    }

    // ---------- 首次完整采集：向历史方向一直滚到最早帖子 ----------
    // S1：整段包 try/finally。ScrollSimulator.run 起手会 throw（右侧没打开频道、容器找不到），
    // 旧写法此时 activeTask 永远留在 'init'，面板常亮绿、边滚边采/恢复/跳转全被永久拒绝。
    async function runInitial() {
      if (isRunning()) return;
      activeTask = 'init';
      markSessionKnown();
      stats.added = 0; stats.dup = 0; stats.scrolls = 0;
      stats.status = '全量采集运行中（向历史方向）';
      UIManager.render();

      let stable = 0;
      let lastMin = Infinity;
      let emptyAtTop = 0; // S6：到顶却一条消息都看不到的连续轮数
      let anchorCh = currentChannel.username; // 起手频道；为空则由第一轮扫描锚定，避免刚进页面就误判"换了频道"

      try {
        // 定位到消息流底部（最新帖），只操作容器
        const pane0 = MessageParser.findChatPane();
        const sc0 = pane0 && MessageParser.findScroller(pane0);
        if (sc0) sc0.scrollTop = sc0.scrollHeight;
        await sleep(800);

        // 全量固定朝历史方向滚：曾按用户"方向"下拉走，选「最新消息」时会跑反方向并立刻判定完成
        const reason = await ScrollSimulator.run('up', async () => {
          // M2：切频道后 Telegram 会换掉消息容器，起手拿到的节点会变成游离体（scrollTop 恒 0 → 误判已到顶），
          // 所以每步重新解析，不用缓存
          const pane = MessageParser.findChatPane();
          const sc = pane && MessageParser.findScroller(pane);
          if (!sc) return '消息容器已不可用，任务结束';
          if (anchorCh && currentChannel.username && currentChannel.username !== anchorCh) {
            return '已切换频道，本次任务结束（要采新频道请重新点「全量采集」）';
          }
          if (!anchorCh) anchorCh = currentChannel.username;

          if (sc.scrollTop <= 8) {
            // 已贴近顶部：强制归顶并给 Telegram 留出加载更老消息的时间，
            // 否则虚拟列表异步加载未落地，最小 id 会"假稳定"导致误判边界
            sc.scrollTop = 0;
            await sleep(2000);
          }
          const { seenIds } = await scanCurrentPane();
          const mn = minVisibleId(seenIds);
          // S6：已到顶但屏幕上没有任何帖子——空频道或消息一直没加载。
          // 旧写法靠 mn===Infinity 永远不满足 stable 条件，会一路空转到 3000 步上限（约 1.5 小时）。
          if (sc.scrollTop <= 1 && seenIds.size === 0) {
            if (++emptyAtTop >= 3) return EMPTY_PANE_REASON;
          } else emptyAtTop = 0;
          const atTop = sc.scrollTop <= 1;
          if (atTop && mn === lastMin && mn !== Infinity) stable++;
          else stable = 0;
          lastMin = mn;
          if (stable >= CONFIG.scanConfig.initialEndStableRounds) return '已到达历史边界（最早帖子）';
          return null;
        });

        stats.stopReason = reason || '已停止';
        stats.status = reason === '已到达历史边界（最早帖子）' ? '全量完成' : '已停止：' + stats.stopReason;
        if (reason === '已到达历史边界（最早帖子）') {
          await saveState({ initialized: true, lastPostId: String(maxPostId()) });
        } else {
          await saveState({ lastPostId: String(maxPostId()) });
        }
      } catch (e) {
        stats.stopReason = e.message;
        stats.status = '全量失败：' + e.message;
      } finally {
        activeTask = null;
        UIManager.render();
      }
    }

    // ---------- 日常增量：从最新向上滚，连续 N 屏帖子全在库里则停 ----------
    async function runIncremental() {
      if (isRunning()) return;
      activeTask = 'incr';
      markSessionKnown();
      stats.added = 0; stats.dup = 0; stats.scrolls = 0;
      stats.status = '增量采集运行中';
      UIManager.render();

      let anchorCh = currentChannel.username;
      try {
        // 定位到最新消息
        const pane0 = MessageParser.findChatPane();
        const sc0 = pane0 && MessageParser.findScroller(pane0);
        if (sc0) sc0.scrollTop = sc0.scrollHeight;
        await sleep(800);
        await scanCurrentPane(); // 先收当前屏新帖
        if (!anchorCh) anchorCh = currentChannel.username;

        let dupRun = 0;
        let emptyRun = 0; // S6：同全量——屏幕上没帖子时"整屏都在库里"永远不成立，会空转到步数上限
        const reason = await ScrollSimulator.run('up', async () => {
          if (anchorCh && currentChannel.username && currentChannel.username !== anchorCh) {
            return '已切换频道，本次任务结束（新频道对增量来说是陌生的，会一路滚到最早历史）';
          }
          const { seenIds, knownVisible } = await scanCurrentPane();
          if (seenIds.size === 0) {
            if (++emptyRun >= 3) return EMPTY_PANE_REASON;
          } else emptyRun = 0;
          // M1：旧写法只要屏上有 1 个已知帖就算"重复"，而步长只有 60–140px，10 步勉强一屏高，
          //     新帖尚未挂载时会被误判成"已到边界"→ 漏帖。改成整屏都在库里才算一次重复。
          const allKnown = seenIds.size > 0 && knownVisible === seenIds.size;
          dupRun = allKnown ? dupRun + 1 : 0;
          if (dupRun >= CONFIG.scanConfig.maxDuplicateCount) return '已达到历史边界（连续 ' + dupRun + ' 屏帖子都在库里）';
          return null;
        });

        stats.stopReason = reason || '已停止';
        stats.status = '增量完成：' + stats.stopReason;
        // 空频道/未加载完不该把 meta.initialized 置真，否则下次进页面显示"已完成全量"，误导用户跳过全量
        await saveState(reason === EMPTY_PANE_REASON ? { lastPostId: String(maxPostId()) }
          : { initialized: true, lastPostId: String(maxPostId()) });
      } catch (e) {
        stats.stopReason = e.message;
        stats.status = '增量失败：' + e.message;
      } finally {
        activeTask = null;
        UIManager.render();
      }
    }

    function maxPostId() {
      const g = byChannel.get(currentChannel.username);
      return g ? g.maxId : 0;
    }

    function stopAll() {
      ScrollSimulator.stop();
      stats.status = '已停止：手动停止';
      UIManager.render();
    }

    return { runInitial, runIncremental, stopAll, isRunning };
  })();

  // ============================================================
  // CSVExporter —— 支持单频道导出与分频道批量导出（每频道一个文件）
  // ============================================================

  const CSVExporter = (() => {
    // v1.17.0 起 publish_time 这一列是北京时间（与库里同一串，导出不换算）；此前的 UTC 备份 CSV 一律作废
    const HEADER = ['channel', 'channel_title', 'post_id', 'post_url', 'comment_count', 'content', 'publish_time', 'views', 'reactions', 'reactions_total'];

    function csvEscape(v) {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    const safeName = s => (s || '').replace(/[\\/:*?"<>|\s]/g, '');

    function fileName(list, forChannel) {
      const src = list.find(r => r.channel === (forChannel || currentChannel.username)) || list[0] || {};
      const d = new Date();
      return safeName(src.channel) + safeName(src.channel_title) + pad2(d.getFullYear() % 100) + pad2(d.getMonth() + 1) + pad2(d.getDate());
    }

    function downloadList(list, name) {
      const rows = sortRecords(list).map(r =>
        [r.channel, r.channel_title, r.post_id, r.post_url, r.comment_count ?? '', r.content || '', r.publish_time || '',
         r.views ?? '', r.reactions || '', r.reactions_total ?? 0]
          .map(csvEscape).join(',')
      );
      const blob = new Blob(['\uFEFF' + HEADER.join(',') + '\n' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name + '.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    function groups() { // username -> [records]，直接用频道索引，不遍历全表
      const g = new Map();
      for (const [ch, bucket] of byChannel) {
        const list = [];
        for (const k of bucket.keys) { const r = records.get(k); if (r) list.push(r); }
        g.set(ch, list);
      }
      return g;
    }

    // 导出指定频道；channel='all' 时合并为一个文件。
    // ignoreFilter=false 时套用表头筛选（"筛完就导"）；「忽略筛选导出全部」传 true。
    // 注意：分频道批量导出走的是备份语义，永远忽略筛选。
    function exportCSV(channel, ignoreFilter) {
      const ch = channel || effectiveChannelValue();
      const pick = list => (ignoreFilter || !hasFilters() ? list : list.filter(matchFilters));
      if (ch === 'all') {
        const all = pick([...records.values()]);
        if (!all.length) return 0;
        downloadList(all, 'TG全部频道' + fileName(all, ''));
        return 1;
      }
      const bucket = byChannel.get(ch);
      if (!bucket) return 0;
      const list = pick([...bucket.keys].map(k => records.get(k)).filter(Boolean));
      if (!list.length) return 0;
      downloadList(list, fileName(list, ch));
      return 1;
    }

    // 分频道批量导出：每个频道单独一个 CSV 文件
    async function exportAllByChannel() {
      const g = groups();
      let i = 0;
      for (const [ch, list] of g) {
        downloadList(list, fileName(list, ch));
        i++;
        if (i < g.size) await sleep(500); // 间隔，避免浏览器拦截连续下载
      }
      return g.size;
    }

    // ---- 导入：CSV（本脚本导出格式）作为"数据库文件"使用 ----
    // 解析带引号转义/内嵌换行的标准 CSV 文本
    function parseCSV(text) {
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const rows = [];
      let row = [], cell = '', q = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
          if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
          else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n') { row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
        else if (c !== '\r') cell += c;
      }
      if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0] !== '') rows.push(row); }
      return rows;
    }

    // 导入前的编码嗅探：只认 UTF-8。Excel/WPS 在中文 Windows 上「另存为 CSV」默认写 ANSI(GBK)，
    // 那类字节流不是合法 UTF-8；已经写坏过的 UTF-8 文件里则带 U+FFFD。两种都整份拒绝——
    // 乱码正文一旦入库就"非空"，之后拿正确文件再导入也会被判重跳过，只能清库。
    function decodeCsv(buf) {
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch (e) {
        throw new Error('这份文件不是 UTF-8 编码（多半是表格软件存成了 ANSI/GBK）。请另存为「CSV UTF-8（逗号分隔）」后再导入');
      }
      const bad = (text.match(/\uFFFD/g) || []).length;
      if (bad) throw new Error('这份文件里有 ' + bad + ' 处乱码字符，已整份拒绝导入（一条都没写进库）。请另存为「CSV UTF-8（逗号分隔）」后再导入');
      return text;
    }

    // 返回 { added, updated, skipped, dbError }；记录整行写回内存 + IndexedDB，之后按 channel+post_id 判重
    // onProgress(已写入条数, 待写入总条数)：只在分块落库的间歇回调，让页面有机会刷新提示行
    async function importCSV(text, onProgress) {
      const rows = parseCSV(text);
      if (!rows.length) throw new Error('文件为空');
      const head = rows[0].map(h => h.trim().toLowerCase());
      const idx = name => head.indexOf(name);
      if (idx('channel') < 0 || idx('post_id') < 0) throw new Error('缺少 channel / post_id 列，不是本脚本导出的 CSV');
      // 数字列统一走 parseCompact：千分位 "1,234"→1234，缩写 "1.2K"→1200（口径已定：CSV 永远存纯整数）。
      // 原先的 replace(/\D/g,'') 会把 "-5" 读成 5、"1.5K" 读成 15，读不出来就当没有更诚实。
      const num = v => MessageParser.parseCompact(String(v).trim());
      // 时间列只认库里那一套格式："YYYY-MM-DD HH:mm"（纯日期补 00:00）。
      // 手工改过的脏值（"2024/10/1"、"10月1日"、"abc"）一旦进库，排序和时分区间筛选都会算出 NaN，所以直接当空。
      const normTime = v => {
        let s = String(v).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += ' 00:00';
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) return '';
        // 形状对还得是真实时刻："2024-13-99 99:99" 进库后排序和时分区间筛选都会算出 NaN
        return Number.isNaN(new Date(s.replace(' ', 'T') + ':00Z').getTime()) ? '' : s;
      };
      const now = Date.now();
      let added = 0, updated = 0, skipped = 0;
      const pending = [];

      for (const r of rows.slice(1)) {
        const get = i => (i >= 0 && r[i] !== undefined ? r[i] : '');
        const channel = get(idx('channel')).trim();
        const postId = get(idx('post_id')).trim();
        if (!channel || !/^\d+$/.test(postId)) { skipped++; continue; }
        const key = channel + '_' + postId;
        const rec = {
          key, channel,
          channel_title: get(idx('channel_title')) || channel,
          post_id: postId,
          post_url: get(idx('post_url')) || 'https://t.me/' + channel + '/' + postId,
          comment_count: num(get(idx('comment_count'))),
          content: get(idx('content')),
          publish_time: normTime(get(idx('publish_time'))),
          views: num(get(idx('views'))),
          reactions: get(idx('reactions')),
          reactions_total: num(get(idx('reactions_total'))) ?? 0,
          collected_at: now
        };
        const old = records.get(key);
        if (old) {
          // 已有记录：导入行里空缺的字段沿用库里的（表格里删过一格也不会把好数据清成空），
          // 真变了才覆盖——与采集侧 S4-B 同一套语义，重复导入同一份备份不会产生多余写入
          fillFromOld(rec, old);
          if (statsChanged(old, rec)) { putRecord(rec); pending.push(rec); updated++; }
          else skipped++;
        } else {
          putRecord(rec);
          pending.push(rec);
          added++;
        }
      }
      // M8：分块落库。旧写法把几万行塞进一个事务，主线程被占住几十秒（Telegram 页面点不动、滚不动）。
      // 每块之间 await sleep(0) 让浏览器有机会画提示、响应点击。
      let dbError = '';
      const CHUNK = 2000;
      for (let i = 0; i < pending.length; i += CHUNK) {
        try { await StorageManager.putMany(pending.slice(i, i + CHUNK)); }
        catch (e) {
          dbError = e.message;
          // S7：这一块和后面还没写的都记为"欠库"，之后每轮扫描自动补写
          for (let j = i; j < pending.length; j++) pendingPersist.add(pending[j].key);
          console.warn(LOG, '导入写入失败', e);
          break;
        }
        await sleep(0);
        if (onProgress) onProgress(Math.min(i + CHUNK, pending.length), pending.length);
      }
      return { added, updated, skipped, dbError };
    }

    return { exportCSV, exportAllByChannel, importCSV, decodeCsv };
  })();

  // 面板/导出实际生效的频道：'auto' 解析为当前打开的频道
  function effectiveChannelValue() {
    return channelFilter === 'auto' ? (currentChannel.username || 'all') : channelFilter;
  }

  // 当前视图的全部记录（未经表头筛选）——「总数」格用它，筛选不会让你以为数据丢了
  function viewRecords() {
    const ch = effectiveChannelValue();
    if (ch === 'all') return [...records.values()];
    const bucket = byChannel.get(ch);
    if (!bucket) return [];
    const list = [];
    for (const k of bucket.keys) { const r = records.get(k); if (r) list.push(r); }
    return list;
  }

  // 表头排序循环的终点：不点表头时的默认顺序＝消息 ID 从新到旧
  const SORT_DEFAULT = { key: 'post_id', dir: 'desc' };

  function sortRecords(list) {
    const { key, dir } = tableState.sort;
    const col = COLUMNS.find(c => c.key === key) || COLUMNS[0];
    const sign = dir === 'asc' ? 1 : -1;
    return list.sort((a, b) => {
      if (col.num) {
        const x = numOf(a[key]), y = numOf(b[key]);
        if (x === null && y === null) return 0;
        if (x === null) return 1;  // 空值永远排最后，不随升降序跳到另一头
        if (y === null) return -1;
        return (x - y) * sign;
      }
      return String(a[key] || '').localeCompare(String(b[key] || '')) * sign;
    });
  }

  // ============================================================
  // UIManager
  // ============================================================

  // 在当前频道内按 post_id 逐步滚动查找（纯容器滚动，不依赖地址栏路由格式）
  async function seekPostInChannel(postId) {
    const pane = MessageParser.findChatPane();
    const sc = pane && MessageParser.findScroller(pane);
    if (!sc) return false;
    const target = Number(postId);
    const ids = [...pane.querySelectorAll(CONFIG.scanConfig.bubbleSelector)]
      .map(b => MessageParser.extractPostId(b)).filter(Boolean);
    const goDown = ids.length && target > Math.max(...ids); // 目标比当前最新帖还新 → 向下找
    const dir = goDown ? 1 : -1;
    const jump = Math.max(CONFIG.scrollConfig.speedMin, CONFIG.scrollConfig.speedMax) * 4;

    for (let i = 0; i < 200; i++) {
      // L3：跳转最长要滚 200 步×400ms≈80 秒。入口虽然查过运行状态，但这期间用户可能点了「全量采集」，
      // 两个滚动逻辑抢同一个容器会把边界判定全打乱，所以循环里也守一次
      if (ScanManager.isRunning()) { UIManager.flash('采集已开始，跳转定位已中断'); return false; }
      const b = MessageParser.findBubbleByPostId(target);
      if (b) { MessageParser.centerBubble(b); return true; }
      const before = sc.scrollTop;
      sc.scrollTop += dir * jump;
      await sleep(400); // 留出 Telegram 加载相邻历史的时间
      if (sc.scrollTop === before) break; // 已到边界
    }
    return !!MessageParser.findBubbleByPostId(target);
  }

  // 页内跳转到指定消息：同频道 → 滚动查找；跨频道 → 先走 Web K 路由，再滚动查找
  async function jumpToMessage(ch, postId) {
    if (ScanManager.isRunning()) { UIManager.flash('采集任务进行中，请先点「停止」再跳转'); return; }
    const b0 = ch === currentChannel.username && MessageParser.findBubbleByPostId(postId);
    if (b0 && MessageParser.centerBubble(b0)) { UIManager.flash('已定位到 #' + postId); return; }

    if (ch !== currentChannel.username) {
      location.hash = '#@' + ch + '/' + postId;
      for (let i = 0; i < 12; i++) {
        await sleep(250);
        currentChannel = MessageParser.extractChannel();
        if (currentChannel.username === ch) break;
      }
    }
    if (ch === currentChannel.username && await seekPostInChannel(postId)) {
      UIManager.flash('已滚动定位到 #' + postId);
    } else {
      UIManager.flash('未找到 #' + postId + '（该帖可能已删除或不属于当前频道）');
    }
  }

  const UIManager = (() => {
    let panel, chEl, chSel, statusEl, flashTimer, orb, orbCount;
    let flashing = false;       // 有提示语占用频道行时，render 不去覆盖它
    let statTotal, statAdded, statDup, statScrolls; // 缓存节点引用，避免每次渲染重复 querySelector
    let cgEl, theadEl, tbodyEl, tableEl, matchEl, colsEl, fpopEl, fpopTitle, fpopNums, fpopModes, fpopTextRow, fpopDates, fpopText, fpopMin, fpopMax;
    let confirmEl, cfmTxt, cfmTimer, filterCol = '';  // filterCol：当前筛选小窗对应的列
    let restoreBtn;                                    // 「恢复本次…前的数据」，只在有快照时出现

    // 发布时间列的五档输入：side=min|max，part 顺序与 dateBound() 的 DATE_PAD 一致
    const DATE_PARTS = [['y', '年', 4, 1, 9999], ['mo', '月', 2, 1, 12], ['d', '日', 2, 1, 31], ['h', '时', 2, 0, 23], ['mi', '分', 2, 0, 59]];
    function dateRowHtml(side, label) {
      return `<div class="drow"><em>${label}</em>` + DATE_PARTS.map(p =>
        `<input type="number" data-d="${side}" data-p="${p[0]}" placeholder="${p[1]}" min="${p[3]}" max="${p[4]}"` +
        ` title="${p[1]}（${p[3]}–${p[4]}）；填北京时间，留空＝这一档及之后不设限">`).join('') + '</div>';
    }
    const readDateRow = side => DATE_PARTS.map(p => {
      const el = fpopEl.querySelector(`input[data-d=${side}][data-p=${p[0]}]`);
      return el ? el.value : '';
    });
    let headTap = { col: '', ts: 0, snap: null };     // 表头首次单击的时间/列/排序快照，用于识别双击
    const colEls = {};      // key -> <col>，拖列宽时只改它，不重建表格
    let renderedSig = '';   // 上一次渲染的指纹，没变化就不动 DOM
    let lastTablePaint = 0; // 上次整表重建的时刻，采集运行期用它做节流
    let headSig = '';       // 表头/列宽指纹，变化才重建 thead（拖列宽不重建）
    let lastRows = [];      // 当前渲染的数据顺序，双击分隔线自适应列宽时按它量内容
    let measureCtx = null;  // canvas 量字宽，比临时插 DOM 探针少一次重排
    let chSig = ''; // 频道列表指纹，变化才重建下拉框

    const css = `
      /* box-sizing:border-box 让写进 style 的宽高＝屏幕上的实际宽高（旧版差 2px 边框，会累积成偏差）。
         max-* 只在"从未手动缩放"时兜底；一旦尺寸由脚本写死，enableResize/applyGeom 会放开成 calc(100v*-20px)，
         与 JS 里的硬限制取同一套值——两者不一致时视觉被 CSS 卡住而记录值还在涨，就是"拖不动/位移不匹配"的根因 */
      #tcc-panel{position:fixed;top:70px;right:16px;width:520px;min-width:250px;min-height:170px;
        max-width:94vw;max-height:82vh;box-sizing:border-box;
        display:flex;flex-direction:column;overflow:hidden;
        background:#17212b;color:#f5f5f5;border:1px solid #101921;border-radius:10px;z-index:99999;
        font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5)}
      .tcc-head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#0e1621;border-radius:10px 10px 0 0;cursor:move;user-select:none}
      .tcc-head b{flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .tcc-head button{background:none;border:none;color:#aab8c6;cursor:pointer;font-size:14px;padding:0 4px}
      .tcc-grip{position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;z-index:3;touch-action:none;user-select:none}
      .tcc-grip::after{content:'';position:absolute;right:4px;bottom:4px;width:8px;height:8px;
        border-right:2px solid #6ab3f3;border-bottom:2px solid #6ab3f3;border-radius:0 0 3px 0}
      .tcc-grip:hover::after{border-color:#8ecbff}
      .tcc-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:8px 10px 18px;overflow:hidden auto}
      .tcc-body>*{flex:none}
      .tcc-body>.tcc-tablewrap{flex:1 1 auto;min-height:80px}
      .tcc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:6px}
      .tcc-stats>div{background:#0e1621;border-radius:6px;padding:5px 6px;text-align:center}
      .tcc-stats small{color:#708499;display:block;font-size:10px}
      .tcc-status{color:#e8b34b;margin-bottom:4px;font-size:12px}
      .tcc-channel{color:#708499;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .tcc-cfg{border:1px solid #101921;border-radius:8px;padding:6px 8px;margin-bottom:8px;font-size:12px}
      .tcc-cfg h4{margin:0 0 4px;font-size:12px;color:#aab8c6}
      .tcc-cfg-row{display:flex;align-items:center;gap:6px;margin:3px 0;flex-wrap:wrap}
      .tcc-cfg-row label{flex:1;color:#708499}
      .tcc-cfg-row input[type=number]{width:58px;background:#0e1621;border:1px solid #101921;color:#f5f5f5;border-radius:4px;padding:2px 4px}
      .tcc-cfg-row select{background:#0e1621;border:1px solid #101921;color:#f5f5f5;border-radius:4px}
      .tcc-btns{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:6px;margin-bottom:8px;
        max-height:106px;overflow-y:auto;overflow-x:hidden;padding-right:4px}
      .tcc-btns button{width:100%;min-width:0;background:#2b5278;border:none;color:#fff;border-radius:6px;padding:6px 2px;cursor:pointer;font-size:12px;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .tcc-btns button:hover{background:#3a6a96}
      .tcc-btns button.active{background:#2e7d32}
      .tcc-btns button.active:hover{background:#39913e}
      .tcc-btns button.moment{background:#2e7d32}
      .tcc-btns button.warn{background:#7a3b3b}
      .tcc-scroll::-webkit-scrollbar,.tcc-btns::-webkit-scrollbar,.tcc-tablewrap::-webkit-scrollbar{width:8px;height:8px}
      .tcc-scroll::-webkit-scrollbar-track,.tcc-btns::-webkit-scrollbar-track,.tcc-tablewrap::-webkit-scrollbar-track{background:#0e1921;border-radius:4px}
      .tcc-scroll::-webkit-scrollbar-thumb,.tcc-btns::-webkit-scrollbar-thumb,.tcc-tablewrap::-webkit-scrollbar-thumb{background:#2b5278;border-radius:4px}
      .tcc-scroll::-webkit-scrollbar-thumb:hover,.tcc-btns::-webkit-scrollbar-thumb:hover,.tcc-tablewrap::-webkit-scrollbar-thumb:hover{background:#3a6a96}
      /* ---- 采集内容表格：表头吸顶、列宽可拖、超出横向滚动 ---- */
      .tcc-bar{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:12px;color:#708499;flex-wrap:wrap}
      .tcc-bar .tcc-match{color:#e8b34b}
      .tcc-bar button{background:#24364a;border:none;color:#cfe2f5;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:11px}
      .tcc-bar button:hover{background:#3a6a96}
      .tcc-cols{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px}
      .tcc-cols span{border:1px solid #2b5278;background:#0e1621;color:#7fd18b;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:11px;user-select:none}
      .tcc-cols span.off{color:#5a6b7d;border-color:#223;  text-decoration:line-through}
      /* ---- 本列筛选小浮窗：固定 216px，弹在表头下方，不占整行 ---- */
      .tcc-fpop{position:fixed;z-index:6;width:216px;box-sizing:border-box;font-size:11px;
        background:#111c26;border:1px solid #2b5278;border-radius:8px;padding:6px 8px;
        box-shadow:0 6px 18px rgba(0,0,0,.55)}
      .tcc-fpop .hd{display:flex;align-items:center;gap:4px}
      .tcc-fpop .hd b{flex:1;min-width:0;color:#cfe2f5;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .tcc-fpop .hd .x{background:none;border:none;color:#708499;cursor:pointer;font-size:14px;line-height:1;padding:0 2px}
      .tcc-fpop .hd .x:hover{color:#fff}
      .tcc-fpop .row{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:5px}
      .tcc-fpop .row label{display:flex;align-items:center;gap:3px;color:#708499}
      .tcc-fpop b{color:#cfe2f5}
      .tcc-fpop input{background:#0e1621;border:1px solid #101921;color:#f5f5f5;border-radius:4px;padding:2px 4px;font-size:11px;min-width:0}
      .tcc-fpop input[data-f=text]{flex:1}
      .tcc-fpop input[data-f=min],.tcc-fpop input[data-f=max]{width:44px}
      /* 发布时间列：最小/最大各一行「年月日时分」小格，窄屏要塞进 216px */
      .tcc-fpop .drow{display:flex;align-items:center;gap:2px;margin-top:4px}
      .tcc-fpop .drow>em{width:24px;color:#708499;font-size:10px;font-style:normal}
      .tcc-fpop input[data-d]{width:26px;padding:2px 1px;text-align:center}
      .tcc-fpop input[data-d][data-p=y]{width:38px}
      .tcc-fpop input[type=number]{-moz-appearance:textfield;appearance:textfield}
      .tcc-fpop input[type=number]::-webkit-inner-spin-button,.tcc-fpop input[type=number]::-webkit-outer-spin-button{
        -webkit-appearance:none;margin:0}
      .tcc-fpop .modes{display:flex;gap:3px;margin-top:5px}
      .tcc-fpop .modes button{flex:1;background:#0e1621;border:1px solid #2b5278;color:#aab8c6;border-radius:4px;
        padding:2px 0;cursor:pointer;font-size:10px;text-align:center}
      .tcc-fpop .modes button.on{background:#2e7d32;border-color:#2e7d32;color:#fff}
      .tcc-fpop .cmds button{background:#24364a;border:none;color:#cfe2f5;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px}
      .tcc-fpop .cmds button:hover{background:#3a6a96}
      .tcc-tablewrap{flex:1 1 auto;min-height:80px;overflow:auto;border:1px solid #101921;border-radius:6px}
      .tcc-table{border-collapse:separate;border-spacing:0;table-layout:fixed;min-width:100%;font-size:12px}
      .tcc-table th,.tcc-table td{padding:3px 6px;border-bottom:1px solid #101921;text-align:left;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
      /* 表头标题整行居中；单元格内容一律靠左（数字列也靠左，用户 2026-10-05 点名） */
      .tcc-table th{position:sticky;top:0;z-index:2;background:#0e1621;color:#aab8c6;font-weight:600;user-select:none;text-align:center}
      .tcc-table thead th.on{color:#e8b34b}
      .tcc-table th .lab{display:inline-block;max-width:calc(100% - 14px);vertical-align:bottom;
        overflow:hidden;text-overflow:ellipsis;cursor:pointer}
      .tcc-table th .arr{color:#6ab3f3;cursor:default;font-size:10px;padding:0 2px}
      .tcc-table .grip{position:absolute;top:0;right:0;width:6px;height:100%;cursor:col-resize;z-index:3}
      .tcc-table .grip:hover,.tcc-table .grip.drag{background:#2b5278}
      .tcc-table tbody tr:hover td{background:#1c2b38}
      .tcc-table td a{color:#6ab3f3;text-decoration:none}
      .tcc-table td.num{color:#dfe9f2}
      .tcc-table th.rank{text-align:center;color:#708499;padding:0 6px}
      .tcc-table td.rank{text-align:center;color:#708499;padding:0 6px;font-variant-numeric:tabular-nums}
      .tcc-table td.dim{color:#5a6b7d}
      .tcc-table td button{background:#24364a;border:none;color:#6ab3f3;border-radius:4px;padding:1px 6px;cursor:pointer;font-size:11px}
      .tcc-empty{padding:8px;color:#708499;font-size:12px}
      #tcc-orb{position:fixed;right:16px;bottom:80px;width:44px;height:44px;border-radius:50%;background:#2b5278;color:#fff;
        border:1px solid #101921;cursor:pointer;z-index:99999;display:none;align-items:center;justify-content:center;
        box-shadow:0 4px 14px rgba(0,0,0,.5);touch-action:none;user-select:none;font-size:13px}
      #tcc-orb b{position:absolute;right:-2px;top:-2px;min-width:18px;padding:0 3px;border-radius:9px;background:#e8b34b;
        color:#17212b;font-size:10px;line-height:16px;text-align:center}
      .tcc-confirm{border:1px solid #7a3b3b;background:#1d1414;border-radius:8px;padding:6px 8px;margin-bottom:6px;font-size:12px;color:#f0c9c9}
      .tcc-confirm .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
      .tcc-confirm button{background:#24364a;border:none;color:#cfe2f5;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px}
      .tcc-confirm button.yes{background:#7a3b3b;color:#fff}
      .tcc-confirm button:hover{filter:brightness(1.15)}
    `;

    function esc(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    }

    function build() {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);

      panel = document.createElement('div');
      panel.id = 'tcc-panel';
      panel.innerHTML = `
        <div class="tcc-head" title="按住这里拖动面板；靠近屏幕边缘会自动吸附"><b>${CONFIG.ui.title} v${VERSION}</b>
          <button data-act="min" title="收成右下角一个悬浮球（点球可恢复面板）">–</button></div>
        <div class="tcc-body tcc-scroll">
          <div class="tcc-channel" title="当前右侧聊天区正在显示的频道；下拉框可切换到已采集过的其他频道视图">当前频道：—</div>
          <div class="tcc-status">状态：空闲</div>
          <div class="tcc-stats">
            <div title="当前频道视图下去重后的帖子条数（不受表头筛选影响）"><small>总数</small><span data-stat="total">0</span></div>
            <div title="本次任务新入库的帖子条数"><small>新增</small><span data-stat="added">0</span></div>
            <div title="本次任务里反复看到的老帖命中次数，会大于总数，属正常"><small>重复</small><span data-stat="dup">0</span></div>
            <div title="本次任务自动滚动的步数"><small>滚动</small><span data-stat="scrolls">0</span></div>
          </div>
          <div class="tcc-cfg" title="自动滚屏的节奏：每步随机滚动 e–f 像素，两步之间随机停 g–h 毫秒。数值越接近真人越自然，也越慢">
            <h4>滚屏设置</h4>
            <div class="tcc-cfg-row"><label>滚动速度</label>
              <input type="number" data-cfg="speedMin" min="10" max="5000"> px -
              <input type="number" data-cfg="speedMax" min="10" max="5000"> px 随机</div>
            <div class="tcc-cfg-row"><label>滚动间隔</label>
              <input type="number" data-cfg="intervalMin" min="100" max="60000"> ms -
              <input type="number" data-cfg="intervalMax" min="100" max="60000"> ms 随机</div>
          </div>
          <div class="tcc-cfg-row" style="margin-bottom:8px"><label title="决定面板列表和「导出CSV」作用在哪个频道">频道</label>
            <select data-el="chsel" style="flex:1;min-width:0;background:#0e1621;border:1px solid #101921;color:#f5f5f5;border-radius:4px;padding:2px 4px"></select></div>
          <div class="tcc-btns">
            <button data-act="init" title="从头到尾滚完整个频道，逐屏采集所有帖子。第一次用这个频道时点它">全量采集</button>
            <button data-act="incr" title="只往上找没采过的新帖，连续碰到老帖就自动停。日常更新点它">增量采集</button>
            <button data-act="pausebtn" title="暂停/继续当前的自动滚屏（绿色＝已暂停，再点一下继续）">暂停</button>
            <button data-act="stop" title="结束本次采集任务，已采到的数据保留（停了要重新点开始）">停止</button>
            <button data-act="start" title="开启后：你自己在页面上滚动，脚本自动记录看到的帖子">边滚边采·开</button>
            <button data-act="pausemon" title="关闭后：自己滚动时不再记录，只留手动点开始的采集">边滚边采·停</button>
            <button data-act="export" title="导出下拉框选中频道、且通过表头筛选的帖子（一个 CSV 文件）">导出CSV</button>
            <button data-act="exportall" title="同上，但忽略表头筛选，导出该频道全部数据（备份用这个）">导出全部</button>
            <button data-act="batchcsv" title="每个频道各存一个 CSV 文件（忽略筛选，全量备份）。频道多时会连续弹多个下载">分频道导出</button>
            <button data-act="impcsv" title="读回之前导出的 CSV。按「频道+消息 ID」判重，已存在的不会重复入库；非 UTF-8 或含乱码的文件会整份拒绝">导入CSV</button>
            <button data-act="clear" class="warn" title="删除已采集数据（会先让你二次确认）。刷新页面前可点「恢复本次清空前的数据」退回">清空数据</button>
          </div>
          <input type="file" accept=".csv,text/csv" style="display:none" data-el="csvfile">
          <div class="tcc-confirm" data-el="confirm" hidden>
            <span data-el="cfmtxt"></span>
            <div class="row">
              <button class="yes" data-cf="channel" title="只删除当前「频道」下拉框选中频道的数据">只清当前频道</button>
              <button class="yes" data-cf="all" title="删除所有频道的数据（内存 + 本地库）">全部清空</button>
              <button class="yes" data-cf="restore" hidden title="按上面说明把数据换回快照那一刻">确认恢复</button>
              <button data-cf="cancel" title="取消，不动任何数据">取消</button>
            </div>
          </div>
          <div class="tcc-bar">
            <span class="tcc-match" data-el="match">共 0 条</span>
            <button data-act="colmenu" title="勾选要在表格里显示哪些列">列显示</button>
            <button data-act="filterclear" title="一次性去除所有列的筛选条件，恢复显示全部">去除所有筛选条件</button>
            <button data-act="restore" hidden>恢复本次导入前的数据</button>
          </div>
          <div class="tcc-cols" data-el="cols" hidden></div>
          <div class="tcc-tablewrap tcc-scroll" data-el="tw">
            <table class="tcc-table"><colgroup data-el="cg"></colgroup><thead data-el="th"></thead><tbody data-el="tb"></tbody></table>
          </div>
        </div>
        <div class="tcc-fpop" data-el="fpop" hidden>
          <div class="hd"><b data-el="fpoptitle">筛选</b>
            <button class="x" data-f="close" title="收起筛选窗口">×</button></div>
          <div class="modes" data-el="fmodes">
            <button data-mode="and" title="空格分隔的每个词都必须出现">同时包含</button>
            <button data-mode="or" title="空格分隔的词出现任意一个即可">任意一个</button>
            <button data-mode="exact" title="整串（连空格一起）当一个词精确匹配">完整串</button>
          </div>
          <div class="row" data-el="ftext"><input type="text" data-f="text" placeholder="关键字，空格分隔" title="在本列查找关键字；匹配方式用上面三个按钮切换"></div>
          <div class="row" data-el="fnums" hidden><label>最小<input type="number" data-f="min"></label><label>最大<input type="number" data-f="max"></label></div>
          <div data-el="fdates" hidden>${dateRowHtml('min', '最小')}${dateRowHtml('max', '最大')}</div>
          <div class="row cmds">
            <button data-f="clear" title="清掉这一列的全部筛选条件（关键字/区间都清）">去除本列筛选条件</button>
            <button data-f="ok" title="应用筛选并收起窗口">完成</button>
          </div>
        </div>
        <div class="tcc-grip" title="按住这里拖动可改变面板宽高（松手后自动记住）"></div>`;
      document.body.appendChild(panel);

      orb = document.createElement('div');
      orb.id = 'tcc-orb';
      orb.title = '频道分析助手 v' + VERSION + '：点一下恢复面板；按住可以拖动，靠近屏幕边缘会自动吸附';
      orb.innerHTML = '<span>析</span><b>0</b>';
      document.body.appendChild(orb);
      orb.style.display = 'none';

      chEl = panel.querySelector('.tcc-channel');
      chSel = panel.querySelector('[data-el=chsel]');
      statusEl = panel.querySelector('.tcc-status');
      const statsEl = panel.querySelector('.tcc-stats');
      statTotal = statsEl.querySelector('[data-stat=total]');
      statAdded = statsEl.querySelector('[data-stat=added]');
      statDup = statsEl.querySelector('[data-stat=dup]');
      statScrolls = statsEl.querySelector('[data-stat=scrolls]');
      tableEl = panel.querySelector('.tcc-table');
      cgEl = panel.querySelector('[data-el=cg]');
      theadEl = panel.querySelector('[data-el=th]');
      tbodyEl = panel.querySelector('[data-el=tb]');
      matchEl = panel.querySelector('[data-el=match]');
      colsEl = panel.querySelector('[data-el=cols]');
      fpopEl = panel.querySelector('[data-el=fpop]');
      fpopTitle = panel.querySelector('[data-el=fpoptitle]');
      fpopNums = panel.querySelector('[data-el=fnums]');
      fpopModes = panel.querySelector('[data-el=fmodes]');
      fpopTextRow = panel.querySelector('[data-el=ftext]');
      fpopDates = panel.querySelector('[data-el=fdates]');
      fpopText = fpopEl.querySelector('[data-f=text]');
      fpopMin = fpopEl.querySelector('[data-f=min]');
      fpopMax = fpopEl.querySelector('[data-f=max]');
      confirmEl = panel.querySelector('[data-el=confirm]');
      cfmTxt = panel.querySelector('[data-el=cfmtxt]');
      restoreBtn = panel.querySelector('[data-act=restore]');
      orbCount = orb.querySelector('b');

      panel.querySelector('.tcc-head').addEventListener('click', e => {
        if (e.target.dataset.act === 'min') minimize();
      });
      panel.querySelector('.tcc-btns').addEventListener('click', e => onAction(e.target.dataset.act));
      chSel.addEventListener('change', e => {
        channelFilter = e.target.value;
        flash('已切换频道视图：' + (e.target.selectedOptions[0] ? e.target.selectedOptions[0].textContent : e.target.value));
      });

      tbodyEl.addEventListener('click', e => {
        const link = e.target.closest('a.jump');
        if (link) { // 左键：页内跳转；Ctrl/中键仍走新标签打开 t.me 链接
          if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          jumpToMessage(link.dataset.ch, link.dataset.mid);
          return;
        }
        const b = e.target.closest('button.open');
        if (b) window.open(b.dataset.url, '_blank', 'noopener');
      });

      // 表头：单击＝本列排序循环（降→升→默认），双击＝弹出本列筛选小窗；分隔线只管列宽
      theadEl.addEventListener('click', e => {
        const th = e.target.closest('th[data-col]');
        if (!th || e.target.dataset.act === 'grip') return;
        const col = th.dataset.col;
        const now = Date.now();
        if (col === headTap.col && now - headTap.ts < 300) { // 第二次点击＝双击
          tableState.sort = headTap.snap; // 撤销第一次单击带来的排序变化
          headTap = { col: '', ts: 0, snap: null };
          saveTable();
          render();
          openFilter(col, th);
          return;
        }
        headTap = { col, ts: now, snap: { key: tableState.sort.key, dir: tableState.sort.dir } };
        cycleSort(col);
      });
      theadEl.addEventListener('dblclick', e => {
        // 分隔线用自己的 data-col（序号列也有一根），所以这里不看 th[data-col]
        if (e.target.dataset.act === 'grip') autoFit(e.target.dataset.col);
      });
      theadEl.addEventListener('pointerdown', e => {
        if (e.target.dataset.act === 'grip') dragColumn(e, e.target.dataset.col);
      });
      // 点窗口外面（含拖面板、按缩放拉手、点别的列表头）就收起筛选小窗
      document.addEventListener('pointerdown', e => {
        if (fpopEl.hidden) return;
        if (fpopEl.contains(e.target)) return;
        const th = e.target.closest && e.target.closest('th[data-col]');
        if (th && th.dataset.col === filterCol) return; // 同一列上的双击由表头逻辑处理
        closeFilter();
      }, true);

      colsEl.addEventListener('click', e => {
        const span = e.target.closest('span[data-col]');
        if (!span) return;
        tableState.hidden[span.dataset.col] = !tableState.hidden[span.dataset.col];
        saveTable();
        render();
      });
      panel.querySelector('.tcc-bar').addEventListener('click', e => {
        if (e.target.dataset.act === 'colmenu') { colsEl.hidden = !colsEl.hidden; return; }
        if (e.target.dataset.act === 'restore') { askRestore(); return; }
        if (e.target.dataset.act === 'filterclear') {
          tableState.filters = {};
          closeFilter();
          render();
          flash('已去除所有筛选条件');
        }
      });
      fpopEl.addEventListener('click', e => {
        if (e.target.dataset.mode) { tableState.mode = e.target.dataset.mode; saveTable(); paintModes(); applyFilter(); return; }
        if (e.target.dataset.f === 'clear') {
          fpopText.value = ''; fpopMin.value = ''; fpopMax.value = '';
          fpopEl.querySelectorAll('input[data-d]').forEach(inp => { inp.value = ''; });
          applyFilter();
          return;
        }
        if (e.target.dataset.f === 'ok' || e.target.dataset.f === 'close') { applyFilter(); closeFilter(); }
      });
      fpopText.addEventListener('input', applyFilter);
      fpopEl.addEventListener('change', e => {
        const d = e.target.dataset;
        if (d.f === 'min' || d.f === 'max' || d.d) applyFilter();
      });

      confirmEl.addEventListener('click', e => {
        const cf = e.target.dataset.cf;
        if (!cf) return;
        clearTimeout(cfmTimer);
        confirmEl.hidden = true;
        if (cf === 'cancel') { flash('已取消，数据没有变动'); return; }
        if (cf === 'restore') { restoreSnapshot(); return; }
        if (cf === 'all') { removeData('all'); return; }
        const ch = channelFilter === 'auto' ? currentChannel.username : channelFilter;
        if (!ch || ch === 'all') { flash('请先在「频道」下拉框选一个具体频道，或用「全部清空」'); return; }
        removeData(ch);
      });

      panel.querySelector('.tcc-cfg').addEventListener('change', readConfigInputs);
      enableDrag(panel, panel.querySelector('.tcc-head'));
      enableResize(panel.querySelector('.tcc-grip'));
      restoreGeom();
      enableOrb();
      let winTimer = null; // 浏览器窗口变小/换屏时把面板拉回可视范围，避免跑出去找不到
      window.addEventListener('resize', () => { clearTimeout(winTimer); winTimer = setTimeout(() => applyGeom(geom()), 200); });
      writeConfigInputs();
    }

    // ---- 最小化 = 收成右下角悬浮球，点球恢复面板 ----

    function minimize() {
      panel.style.display = 'none';
      orb.style.display = 'flex';
      restoreOrb();
      if (orbCount) orbCount.textContent = statTotal.textContent || '0';
    }

    function expand() {
      orb.style.display = 'none';
      panel.style.display = '';
      renderedSig = '';
      render();
    }

    function enableOrb() {
      trackPointer(orb, (e, s) => {
        const p = snapPos(s.ox + e.clientX - s.startX, s.oy + e.clientY - s.startY, s.ow, s.oh);
        orb.style.left = p.left + 'px';
        orb.style.top = p.top + 'px';
        orb.style.right = 'auto';
        orb.style.bottom = 'auto';
      }, moved => {
        if (moved <= 3) expand(); // 当成点击
        else saveOrb();
      }, orb);
    }

    function restoreOrb() {
      const o = Settings.load().orb;
      if (!o || !Number.isFinite(o.left) || !Number.isFinite(o.top)) return;
      const r = orb.getBoundingClientRect();
      const p = snapPos(o.left, o.top, r.width || 44, r.height || 44);
      orb.style.left = p.left + 'px';
      orb.style.top = p.top + 'px';
      orb.style.right = 'auto';
      orb.style.bottom = 'auto';
    }

    let orbTimer = null;
    function saveOrb() {
      clearTimeout(orbTimer);
      orbTimer = setTimeout(() => {
        const r = orb.getBoundingClientRect();
        if (!r.width) return; // 球还没真正显示过（宽高量不到）就别写位置，免得存成 0,0
        Settings.save({ orb: { left: Math.round(r.left), top: Math.round(r.top) } });
      }, 250);
    }

    // ---- 列宽 / 排序 / 筛选 ----

    function syncTableWidth() {
      const sum = activeColumns().reduce((s, c) => s + (tableState.widths[c.key] || c.w), 0) +
        ACTION_W + (tableState.widths.rank || RANK_W);
      tableEl.style.width = sum + 'px';
    }

    function dragColumn(e, key) {
      const grip = e.target;
      const startX = e.clientX;
      // 这里原来写的是 th.getBoundingClientRect()，而 dragColumn 作用域里根本没有 th——
      // 只是被左边的 || 短路掩盖着（每列都有默认宽），一旦存档缺键就会 ReferenceError
      const startW = tableState.widths[key] || grip.parentElement.getBoundingClientRect().width;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('drag');
      const move = ev => {
        const w = Math.min(COL_MAX_W, Math.max(COL_MIN_W, Math.round(startW + ev.clientX - startX)));
        tableState.widths[key] = w;
        if (colEls[key]) colEls[key].style.width = w + 'px';
        syncTableWidth();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        grip.classList.remove('drag');
        saveTable();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    }

    function fitContext() {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
      measureCtx.font = '12px system-ui,sans-serif';
      return measureCtx;
    }

    // 双击分隔线：按当前显示的数据把这一列拉到刚好放得下（上限 COL_MAX_W）；序号列按「序」+ 行数位数算
    function autoFit(key) {
      const col = COLBYKEY[key];
      if (!col && key !== 'rank') return;
      const ctx = fitContext();
      let max = ctx.measureText(col ? col.label : '序').width;
      if (col) lastRows.forEach(r => {
        const raw = r[key];
        const s = key === 'post_id' ? '#' + raw : String(raw === null || raw === undefined ? '—' : raw);
        const w = ctx.measureText(s).width;
        if (w > max) max = w;
      });
      else max = Math.max(max, ctx.measureText(String(Math.max(lastRows.length, 1))).width);
      tableState.widths[key] = Math.min(COL_MAX_W, Math.max(COL_MIN_W, Math.round(max) + 14));
      if (colEls[key]) colEls[key].style.width = tableState.widths[key] + 'px';
      syncTableWidth();
      saveTable();
    }

    // 单击表头的排序循环：降序 → 升序 → 默认（消息 ID 从新到旧）
    function cycleSort(key) {
      const cur = tableState.sort;
      if (cur.key !== key) tableState.sort = { key, dir: 'desc' };
      else if (cur.dir === 'desc') tableState.sort = { key, dir: 'asc' };
      else tableState.sort = { key: SORT_DEFAULT.key, dir: SORT_DEFAULT.dir };
      saveTable();
      render();
    }

    function paintModes() {
      fpopEl.querySelectorAll('.modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === tableState.mode));
    }

    function openFilter(key, th) {
      const col = COLUMNS.find(c => c.key === key);
      if (!col) return;
      filterCol = key;
      const f = tableState.filters[key] || {};
      fpopTitle.textContent = '筛选：' + col.label + (col.date ? '（填北京时间）' : '');
      fpopText.value = f.text || '';
      fpopMin.value = f.min === null || f.min === undefined ? '' : f.min;
      fpopMax.value = f.max === null || f.max === undefined ? '' : f.max;
      fpopNums.hidden = !col.num;
      const isDate = !!col.date;            // 日期列：只给「年月日时分」区间，不给关键字和匹配模式
      fpopModes.hidden = isDate;
      fpopTextRow.hidden = isDate;
      fpopDates.hidden = !isDate;
      DATE_PARTS.forEach((p, i) => {
        ['min', 'max'].forEach(side => {
          const el = fpopEl.querySelector('input[data-d=' + side + '][data-p=' + p[0] + ']');
          if (el) el.value = ((side === 'min' ? f.fromVals : f.toVals) || [])[i] ?? '';
        });
      });
      paintModes();
      fpopEl.hidden = false;
      // 小窗挂在被点表头的正下方，下方放不下就挂上方，并保证不跑出视口
      const anchor = th && th.isConnected ? th : theadEl.querySelector('th[data-col="' + key + '"]');
      if (anchor) {
        const r = anchor.getBoundingClientRect();
        const w = fpopEl.offsetWidth, h = fpopEl.offsetHeight;
        const below = r.bottom + 4;
        fpopEl.style.left = Math.round(Math.max(8, Math.min(r.left, innerWidth - w - 8))) + 'px';
        fpopEl.style.top = Math.round(below + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : below) + 'px';
      }
      (isDate ? fpopEl.querySelector('input[data-d=min][data-p=y]') : fpopText).focus();
    }

    function closeFilter() {
      fpopEl.hidden = true;
      filterCol = '';
    }

    function applyFilter() {
      if (!filterCol) return;
      const f = tableState.filters[filterCol] || (tableState.filters[filterCol] = {});
      const col = COLBYKEY[filterCol];
      if (col && col.date) { // 发布时间列：五档一组，空档取边界值
        const fv = readDateRow('min'), tv = readDateRow('max');
        f.fromVals = fv; f.toVals = tv;
        f.from = dateEmpty(fv) ? '' : dateBound(fv, 'min');   // 库里就是北京时间，填的也是，直接比
        f.to = dateEmpty(tv) ? '' : dateBound(tv, 'max');
        if (f.from && f.to && f.from > f.to) flash('「最小」比「最大」还晚，这样一条都不会匹配');
        if (!f.from && !f.to) delete tableState.filters[filterCol];
        render();
        return;
      }
      f.text = fpopText.value.trim();
      const min = fpopMin.value === '' ? null : Number(fpopMin.value);
      const max = fpopMax.value === '' ? null : Number(fpopMax.value);
      f.min = Number.isFinite(min) ? min : null;
      f.max = Number.isFinite(max) ? max : null;
      if (!f.text && f.min === null && f.max === null) delete tableState.filters[filterCol];
      render();
    }

    // 确认条是复用的：清空与恢复要按的按钮不一样
    function prepCfm(txt, mode) {
      cfmTxt.textContent = txt;
      confirmEl.querySelector('[data-cf=channel]').hidden = mode !== 'clear';
      confirmEl.querySelector('[data-cf=all]').hidden = mode !== 'clear';
      confirmEl.querySelector('[data-cf=restore]').hidden = mode !== 'restore';
      confirmEl.hidden = false;
      clearTimeout(cfmTimer);
      cfmTimer = setTimeout(() => {
        confirmEl.hidden = true;
        flash('确认已超时自动取消，数据没有变动');
      }, 6000);
    }

    function askClear() {
      const ch = channelFilter === 'auto' ? (currentChannel.username || '（还没打开频道）') : channelFilter;
      prepCfm('清空后本页面内还能点「恢复本次清空前的数据」退回，刷新页面就退不回来了。建议先点「导出全部」备份。当前视图频道：' + ch, 'clear');
    }

    function askRestore() {
      const s = snapshot;
      if (!s) { flash('没有可恢复的快照'); return; }
      if (activeTask || ScanManager.isRunning()) { flash('请先停止采集，再执行恢复'); return; }
      const verb = s.kind === 'clear' ? '清空' : '导入';
      prepCfm('恢复会把库换回 ' + s.at + ' 那次' + verb + '之前的 ' + s.count + ' 条，' + verb + '之后新增的会丢掉。', 'restore');
    }

    // ---- 配置 <-> UI ----

    function writeConfigInputs() {
      const c = CONFIG.scrollConfig;
      panel.querySelector('[data-cfg=speedMin]').value = c.speedMin;
      panel.querySelector('[data-cfg=speedMax]').value = c.speedMax;
      panel.querySelector('[data-cfg=intervalMin]').value = c.intervalMin;
      panel.querySelector('[data-cfg=intervalMax]').value = c.intervalMax;
    }

    function readConfigInputs() {
      const c = CONFIG.scrollConfig;
      c.speedMin = clampInt(panel.querySelector('[data-cfg=speedMin]').value, 10, 5000, c.speedMin);
      c.speedMax = clampInt(panel.querySelector('[data-cfg=speedMax]').value, 10, 5000, c.speedMax);
      c.intervalMin = clampInt(panel.querySelector('[data-cfg=intervalMin]').value, 100, 60000, c.intervalMin);
      c.intervalMax = clampInt(panel.querySelector('[data-cfg=intervalMax]').value, 100, 60000, c.intervalMax);
      if (c.speedMax < c.speedMin) c.speedMax = c.speedMin;
      if (c.intervalMax < c.intervalMin) c.intervalMax = c.intervalMin;
      writeConfigInputs();
      Settings.save({ scroll: {
        speedMin: c.speedMin, speedMax: c.speedMax,
        intervalMin: c.intervalMin, intervalMax: c.intervalMax
      } });
      flash('滚屏设置已应用并保存');
    }

    // ---- 按钮状态：持续性=任务运行期间绿色；复位性=按下瞬间绿色 ----

    function btnOf(act) { return panel.querySelector('.tcc-btns button[data-act=' + act + ']'); }

    function momentary(act) {
      const b = btnOf(act);
      if (!b) return;
      b.classList.add('moment');
      setTimeout(() => b.classList.remove('moment'), 350);
    }

    function paintButtons() {
      const states = {
        init: activeTask === 'init',
        incr: activeTask === 'incr',
        pausebtn: ScrollSimulator.isPaused(),
        start: monitoring,
        pausemon: !monitoring,
        batchcsv: uiBusy.batch,
        impcsv: uiBusy.impcsv
      };
      Object.keys(states).forEach(act => {
        const b = btnOf(act);
        if (b) b.classList.toggle('active', !!states[act]);
      });
    }

    // 有快照才露出「恢复本次…前的数据」，文案跟着这次操作是导入还是清空走
    function paintRestore() {
      restoreBtn.hidden = !snapshot;
      if (!snapshot) return;
      const verb = snapshot.kind === 'clear' ? '清空' : '导入';
      restoreBtn.textContent = '恢复本次' + verb + '前的数据';
      restoreBtn.title = '把库换回 ' + snapshot.at + ' 那次' + verb + '之前的 ' + snapshot.count +
        ' 条（含' + verb + '之前已有的全部频道）。点了会先弹确认。快照只在本次页面内存里，刷新页面就没了。';
    }

    function onAction(act) {
      if (['stop', 'export', 'exportall', 'clear'].includes(act)) momentary(act);
      if (act === 'init') { ScanManager.runInitial().catch(e => flash('全量失败：' + e.message)); }
      if (act === 'incr') { ScanManager.runIncremental().catch(e => flash('增量失败：' + e.message)); }
      if (act === 'stop') { ScanManager.stopAll(); }
      if (act === 'pausebtn') {
        const on = !ScrollSimulator.isPaused();
        ScrollSimulator.setPaused(on);
        flash(on ? '滚动已暂停' : '滚动已继续');
      }
      if (act === 'start') { monitoring = true; Settings.save({ monitoring: true }); flash('边滚边采已开启'); }
      if (act === 'pausemon') { monitoring = false; Settings.save({ monitoring: false }); flash('边滚边采已关闭'); }
      if (act === 'export' || act === 'exportall') {
        const ignore = act === 'exportall';
        const ch = effectiveChannelValue();
        if (CSVExporter.exportCSV(ch, ignore)) {
          flash((ch === 'all' ? '已导出全部频道（合并 CSV）' : '已导出当前频道 CSV') + (ignore ? '｜未筛选' : hasFilters() ? '｜按筛选' : ''));
        } else flash('该频道暂无数据');
      }
      if (act === 'batchcsv') {
        if (!records.size || uiBusy.batch) { flash(uiBusy.batch ? '正在导出中…' : '暂无数据'); }
        else {
          uiBusy.batch = true; render();
          flash('正在分频道导出…');
          CSVExporter.exportAllByChannel()
            .then(n => flash('已导出 ' + n + ' 个频道文件'))
            .catch(e => flash('批量导出失败：' + e.message))
            .finally(() => { uiBusy.batch = false; render(); });
        }
      }
      if (act === 'impcsv') {
        const inp = panel.querySelector('[data-el=csvfile]');
        inp.value = '';
        inp.onchange = async () => {
          const f = inp.files[0];
          if (!f) return;
          uiBusy.impcsv = true; render();
          try {
            const text = CSVExporter.decodeCsv(await f.arrayBuffer());
            flash('正在导入 CSV…');
            await takeSnapshot('import'); // 编码合格才留快照：出问题可一键退回导入前
            const r = await CSVExporter.importCSV(text,
              (done, all) => flash('正在写入本地库 ' + done + '/' + all + '…'));
            stats.status = 'CSV 导入：新增 ' + r.added + '，更新 ' + r.updated + '，跳过 ' + r.skipped +
              (r.dbError ? '（本地库写入失败：' + r.dbError + '）' : '');
            // M5：写库失败以前只打在 console 里，UI 照样报"导入完成"，刷新页面才发现全丢了
            flash(r.dbError
              ? '导入失败：' + r.dbError + '。已进内存 ' + (r.added + r.updated) + ' 条但没落库，刷新页面会丢，建议先点「导出全部」备份'
              : '导入完成：新增' + r.added + ' 更新' + r.updated + ' 跳过' + r.skipped);
          } catch (e) { flash('导入失败：' + e.message); }
          uiBusy.impcsv = false;
          render();
        };
        inp.click();
      }
      if (act === 'clear') { askClear(); }
      render();
    }

    // ---- 面板位置/尺寸：拖动 + 拉角调整 + 靠边吸附，松手后记住 ----
    const SNAP = 20;   // 距屏幕边缘多少像素内触发吸附
    const EDGE = 10;   // 吸附后留出的边距
    const MIN_W = 250, MIN_H = 170;
    let userW = 0, userH = 0; // 我们写进 style 的宽高（content box），存/取都用它，避免每次重载漂 2px 边框

    function geom() {
      const r = panel.getBoundingClientRect();
      return { left: r.left, top: r.top, w: userW || r.width, h: userH }; // h=0 表示高度仍是自适应，不写死
    }

    function snapPos(left, top, w, h) {
      const vw = innerWidth, vh = innerHeight;
      if (left < SNAP) left = EDGE;
      if (left + w > vw - SNAP) left = vw - w - EDGE;
      if (top < SNAP) top = EDGE;
      if (top + h > vh - SNAP) top = vh - h - EDGE;
      return {
        left: Math.round(Math.max(0, Math.min(left, vw - w))),
        top: Math.round(Math.max(0, Math.min(top, vh - h)))
      };
    }

    function uncaps() {
      // 尺寸一旦由脚本写死，CSS 的 94vw/82vh 兜底上限就要同步放开到与 JS 硬限制同一套值，
      // 否则 style 还在涨、屏幕上的面板却被卡住，拖拽立刻表现为"不跟手"
      panel.style.maxWidth = 'calc(100vw - ' + 2 * EDGE + 'px)';
      panel.style.maxHeight = 'calc(100vh - ' + 2 * EDGE + 'px)';
    }

    function applyGeom(g) {
      const vw = innerWidth, vh = innerHeight;
      const w = Math.round(Math.max(MIN_W, Math.min(Number.isFinite(g.w) ? g.w : CONFIG.ui.defaultWidth, vw - 2 * EDGE)));
      panel.style.width = w + 'px';
      userW = w;
      if (Number.isFinite(g.h) && g.h > 0) {
        uncaps();
        const h = Math.round(Math.max(MIN_H, Math.min(g.h, vh - 2 * EDGE)));
        panel.style.height = h + 'px';
        userH = h;
      }
      const cur = panel.getBoundingClientRect(); // 先量一次，position 才能贴着新尺寸算
      const p = snapPos(Number.isFinite(g.left) ? g.left : cur.left, Number.isFinite(g.top) ? g.top : cur.top, cur.width, cur.height);
      panel.style.left = p.left + 'px';
      panel.style.top = p.top + 'px';
      panel.style.right = 'auto';
    }

    function restoreGeom() {
      const g = Settings.load().panel;
      if (g && g.w === 320) g.w = CONFIG.ui.defaultWidth; // 老版本默认 320，首次升级到 520
      applyGeom(g && Number.isFinite(g.w) ? g : { w: panel.getBoundingClientRect().width });
    }

    let geomTimer = null;
    function saveGeom() {
      clearTimeout(geomTimer);
      geomTimer = setTimeout(() => {
        const r = geom();
        Settings.save({ panel: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.w), h: Math.round(r.h) } });
      }, 250);
    }

    function trackPointer(handle, onMove, onEnd, baseEl) {
      let startX = 0, startY = 0, ox = 0, oy = 0, ow = 0, oh = 0, on = false, moved = 0;
      handle.addEventListener('pointerdown', e => {
        if (e.target.dataset.act) return; // 标题栏上的折叠/关闭按钮不触发拖动
        const r = (baseEl || panel).getBoundingClientRect();
        startX = e.clientX; startY = e.clientY; ox = r.left; oy = r.top; ow = r.width; oh = r.height;
        moved = 0;
        on = true;
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', e => {
        if (!on) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
        if (moved > 2) onMove(e, { startX, startY, ox, oy, ow, oh }); // 前 2px 当手抖，不跟
      });
      const end = () => { if (!on) return; on = false; onEnd(moved); };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    function enableDrag(el, handle) {
      trackPointer(handle, (e, s) => {
        const p = snapPos(s.ox + e.clientX - s.startX, s.oy + e.clientY - s.startY, s.ow, s.oh);
        el.style.left = p.left + 'px';
        el.style.top = p.top + 'px';
        el.style.right = 'auto';
      }, saveGeom);
    }

    function enableResize(grip) {
      // 起手先把当前渲染尺寸钉成显式值并放开 CSS 上限：auto 高度时面板可能被 82vh 卡着，
      // 不钉这一步就会出现"往下拖完全不动、往回缩要先消化虚假增量"
      grip.addEventListener('pointerdown', () => {
        const r = panel.getBoundingClientRect();
        uncaps();
        userW = Math.round(r.width); userH = Math.round(r.height);
        panel.style.width = userW + 'px';
        panel.style.height = userH + 'px';
      });
      // 严格按鼠标位移 1:1 缩放：起点用按下瞬间的实际渲染尺寸（面板已 box-sizing:border-box，
      // 渲染尺寸与写进 style 的值同一坐标系），只做「不小于 MIN、不超出屏幕」两条硬限制。
      // 之前额外加的贴边回拉会让宽度在靠近边缘时倒退 10px，看起来就是「不跟手」
      trackPointer(grip, (e, s) => {
        const r = panel.getBoundingClientRect();
        const w = Math.max(MIN_W, Math.min(s.ow + e.clientX - s.startX, innerWidth - r.left - EDGE));
        const h = Math.max(MIN_H, Math.min(s.oh + e.clientY - s.startY, innerHeight - r.top - EDGE));
        userW = Math.round(w); userH = Math.round(h);
        panel.style.width = userW + 'px';
        panel.style.height = userH + 'px';
      }, saveGeom);
    }

    function flash(msg) {
      flashing = true;
      chEl.textContent = msg;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashing = false; render(); }, 1500);
    }

    function cellValue(col, raw) {
      return raw === null || raw === undefined || raw === '' ? '—' : String(raw);
    }

    function rowHtml(r, cols, rank) {
      const url = esc(r.post_url || ''); // 导入的 CSV 里若有引号/尖括号，不能让它跳出属性
      const tds = cols.map(col => {
        if (col.key === 'post_id') {
          return `<td class="num"><a href="${url}" class="jump" title="左键＝在当前页跳到这条消息；Ctrl/中键＝新标签打开 t.me" ` +
            `data-ch="${esc(r.channel)}" data-mid="${esc(String(r.post_id))}" target="_blank" rel="noopener">#${esc(String(r.post_id))}</a></td>`;
        }
        const raw = r[col.key];
        const empty = raw === null || raw === undefined || raw === '';
        const tip = empty ? '（无数据）' : (col.date ? '北京时间 ' + raw : String(raw));
        return `<td class="${col.num ? 'num' : ''}${empty ? ' dim' : ''}" title="${esc(tip)}">${esc(cellValue(col, raw))}</td>`;
      }).join('');
      return `<tr><td class="rank">${rank}</td>${tds}<td><button class="open" data-url="${url}" title="在新标签页打开这条消息的 t.me 链接">打开</button></td></tr>`;
    }

    // 表头 + 列显隐 chips + colgroup：只在列集合/排序/筛选变化时重建，拖列宽不重建
    function buildHead(cols) {
      Object.keys(colEls).forEach(k => { delete colEls[k]; });
      cgEl.textContent = '';
      const rankCol = document.createElement('col');
      rankCol.style.width = (tableState.widths.rank || RANK_W) + 'px';
      colEls.rank = rankCol; // 序号列也能拖窄，但它仍不在 COLUMNS 里（不排序/不筛选/不进 CSV）
      cgEl.appendChild(rankCol);
      cols.forEach(c => {
        const col = document.createElement('col');
        col.style.width = (tableState.widths[c.key] || c.w) + 'px';
        colEls[c.key] = col;
        cgEl.appendChild(col);
      });
      const actCol = document.createElement('col');
      actCol.style.width = ACTION_W + 'px';
      cgEl.appendChild(actCol);

      theadEl.innerHTML = '<tr><th class="rank" title="序号＝当前排序下的行号，不写入 CSV；右边线可拖宽">序' +
          '<span class="grip" data-act="grip" data-col="rank" title="拖动改这一列宽；双击＝自动适应内容宽度"></span></th>' + cols.map(c => {
        const arrow = tableState.sort.key === c.key ? (tableState.sort.dir === 'asc' ? '↑' : '↓') : '';
        const hint = '单击＝按本列排序（降→升→默认），双击＝弹出本列筛选' +
          (c.date ? '；显示与筛选都是北京时间，CSV 也是' : '');
        return `<th data-col="${c.key}"${tableState.filters[c.key] ? ' class="on"' : ''}>` +
          `<span class="lab" title="${esc(hint)}">${esc(c.label)}</span>` +
          `<span class="arr">${arrow}</span>` +
          `<span class="grip" data-act="grip" data-col="${c.key}" title="拖动改列宽；双击＝自动适应内容宽度"></span></th>`;
      }).join('') + '<th></th></tr>';
      colsEl.innerHTML = COLUMNS.map(c =>
        `<span data-col="${c.key}" class="${tableState.hidden[c.key] ? 'off' : ''}" title="点击显示/隐藏这一列">${esc(c.label)}</span>`
      ).join('');
      syncTableWidth();
    }

    function render() {
      paintButtons();
      paintRestore();
      const chs = [...byChannel.keys()];
      const titles = {};
      chs.forEach(c => { titles[c] = byChannel.get(c).title; });
      if (currentChannel.username) titles[currentChannel.username] = currentChannel.title;
      const sig = chs.map(c => c + ':' + (titles[c] || '')).join('|'); // 带上标题，频道改名后下拉框文案才会跟着刷新
      if (sig !== chSig || !chSel.options.length) { // 首次/清空后也要有默认两项
        chSig = sig;
        chSel.innerHTML = '<option value="auto">跟随当前频道</option><option value="all">全部频道</option>' +
          chs.map(c => `<option value="${esc(c)}">${esc(titles[c] || c)}</option>`).join('');
      }
      chSel.value = channelFilter;

      const view = viewRecords();                      // 「总数」＝未筛选真实条数
      const matched = hasFilters() ? view.filter(matchFilters) : view;
      statTotal.textContent = view.length;
      statAdded.textContent = stats.added;
      statDup.textContent = stats.dup;
      statScrolls.textContent = stats.scrolls;
      statusEl.textContent =
        '状态：' + stats.status + (stats.stopReason ? '｜停止原因：' + stats.stopReason : '');
      if (!flashing) { // flash() 的闸门：提示语 1.5 秒内不被 render 覆盖
        chEl.textContent = '当前频道：' + (currentChannel.title || '—') +
          (['auto', 'all'].includes(channelFilter) ? '' : '｜视图：' + (titles[channelFilter] || channelFilter));
      }
      matchEl.textContent = (hasFilters() ? '匹配 ' + matched.length + ' 条 / ' : '') + '共 ' + view.length + ' 条';
      if (orbCount) orbCount.textContent = view.length;
      // P2：收成悬浮球后面板根本看不见，再重建 500 行纯属白烧 CPU/电量。
      // renderedSig 保持不动，expand() 里会清空它并补画一次。
      if (panel.style.display === 'none') return;

      const cols = activeColumns();
      const hs = cols.map(c => c.key).join(',') + '|' + tableState.sort.key + tableState.sort.dir +
        '|' + Object.keys(tableState.filters).sort().join(',') + '|' + tableState.mode;
      if (hs !== headSig) { headSig = hs; buildHead(cols); }

      const vs = hs + '|' + matched.length + '|' + dataVersion;
      if (vs === renderedSig) return;
      // P1：S4-B 之后采集期每条帖的统计变化都会 dataVersion++，不节流就是每 300ms 整表重建一次。
      // 采集运行中把重绘降到 1.5 秒一次（上方统计数字仍然即时更新）；任务一结束必然再画一次，不会留在旧画面。
      if (activeTask !== null && renderedSig && Date.now() - lastTablePaint < 1500) return;
      renderedSig = vs;
      lastTablePaint = Date.now();
      lastRows = sortRecords(matched);
      const shown = lastRows.slice(0, CONFIG.ui.rowCap);
      const span = cols.length + 2; // 序号列 + 各显示列 + 「打开」列
      const rows = shown.map((r, i) => rowHtml(r, cols, i + 1)).join('');
      tbodyEl.innerHTML = cols.length ? (rows || (view.length
          ? `<tr><td colspan="${span}" class="tcc-empty">没有帖子符合当前的表头筛选条件，点上方「去除所有筛选条件」就能看到全部 ${view.length} 条</td></tr>`
          : `<tr><td colspan="${span}" class="tcc-empty">这里还没有数据：切到频道后点「全量采集」，或直接滚动页面（边滚边采开着时会自动记录）</td></tr>`))
        : `<tr><td colspan="${span}" class="tcc-empty">所有列都被隐藏了，点上方「列显示」把要看的列勾回来（数据仍在库里，导出不受影响）</td></tr>`;
      if (lastRows.length > shown.length) {
        tbodyEl.insertAdjacentHTML('beforeend',
          `<tr><td colspan="${span}" class="tcc-empty">列表只渲染前 ${CONFIG.ui.rowCap} 条（本视图共 ${lastRows.length} 条）。` +
          `「总数」和导出不受影响；要看更全的内容请用表头筛选。</td></tr>`);
      }
    }

    // ---- 渲染调度：rAF 合并高频重排，并用定时器兜底 ----
    // 后台标签页里 requestAnimationFrame 不触发，曾导致切走再回来时列表一片空白
    let pending = 0, fallbackTimer = null;
    function scheduleRender() {
      if (pending) return;
      pending = 1;
      const run = () => {
        if (!pending) return;
        pending = 0;
        clearTimeout(fallbackTimer);
        render();
      };
      requestAnimationFrame(run);
      fallbackTimer = setTimeout(run, 800);
    }

    // 从别的标签页 / 程序切回来时立刻补画一次，不等 rAF
    function renderNow() {
      pending = 0;
      clearTimeout(fallbackTimer);
      render();
    }

    return { build, render, renderNow, scheduleRender, flash };
  })();

  // ============================================================
  // 清空 / 被动监控 / 启动
  // ============================================================

  // 返回 ''＝内存和本地库都清干净了；返回错误信息＝只清了内存（刷新页面数据会回来），由调用方提示
  async function clearAll() {
    records.clear();
    byChannel.clear(); // 频道索引清空后，下拉框会在下次渲染因指纹变化自动重建
    sessionKnown.clear();
    pendingPersist.clear(); // 库已整表清掉，之前欠的补写不再成立
    tableState.filters = {};
    stats.added = 0; stats.dup = 0; stats.scrolls = 0; stats.status = '空闲'; stats.stopReason = '';
    dataVersion++;
    try {
      await StorageManager.clearRecords();
      await StorageManager.clearMeta();
    } catch (e) {
      console.warn(LOG, '清空本地库失败', e);
      return e.message;
    }
    return '';
  }

  // 导入/清空前把整库 + scan meta 复制进内存，事后一键退回；只留最近一次，刷新页面即消失。
  // meta 三态：对象＝那一刻的值；null＝确实没有；读失败＝undefined（恢复时不碰 meta，免得误删）。
  async function takeSnapshot(kind) {
    const list = [];
    records.forEach(r => list.push(Object.assign({}, r)));
    let meta;
    try { meta = (await StorageManager.getMeta('scan')) || null; }
    catch (e) { console.warn(LOG, '快照读 meta 失败', e); meta = undefined; }
    snapshot = { kind, at: fmt(new Date()), count: list.length, records: list, meta };
  }

  // 恢复顺序：先把库落到位（单事务，全成或全败），成功后才动内存、才摘快照。
  // 反过来就是"内存已回滚、库还是新的"，而且快照一被摘掉就没有第二次机会——所以失败必须原样保住快照。
  async function restoreSnapshot() {
    const snap = snapshot;
    if (!snap) return;
    // M6：确认条弹出后有 6 秒窗口，期间可能点了「全量采集」。守卫必须放在真正执行前，不能只在 askRestore 里。
    if (activeTask || ScanManager.isRunning()) { UIManager.flash('请先停止采集，再执行恢复'); return; }
    const verb = snap.kind === 'clear' ? '清空' : '导入';
    const useDb = StorageManager.hasDb();
    if (useDb) {
      try { await StorageManager.replaceAll(snap.records, snap.meta); }
      catch (e) {
        console.warn(LOG, '恢复快照写库失败', e);
        UIManager.flash('恢复失败：' + e.message + '（库和内存都没动，快照还在，可以再点一次恢复）');
        return;
      }
    }
    snapshot = null;
    records.clear();
    byChannel.clear();
    sessionKnown.clear();
    pendingPersist.clear(); // 整库已被快照替换，之前欠的补写不再成立
    snap.records.forEach(r => { putRecord(r); sessionKnown.add(r.key); });
    stats.status = '已恢复到 ' + snap.at + ' 那次' + verb + '前的数据';
    stats.stopReason = '';
    UIManager.flash('已恢复到' + verb + '前的 ' + snap.count + ' 条' + (useDb ? '' : '（内存模式，未写本地库）'));
    UIManager.renderNow();
  }

  // scope='all' 清所有频道；scope=频道 username 只清那一个频道
  async function removeData(scope) {
    if (scope === 'all') {
      if (records.size) await takeSnapshot('clear');
      const err = await clearAll();
      UIManager.flash(err
        ? '内存已清空，但本地库清除失败：' + err + '（刷新页面数据会回来）'
        : '已清空全部数据（内存 + 本地库）');
      UIManager.renderNow();
      return;
    }
    const bucket = byChannel.get(scope);
    if (!bucket) { UIManager.flash('该频道没有可清的数据'); return; }
    await takeSnapshot('clear');
    const keys = [...bucket.keys];
    keys.forEach(k => { records.delete(k); sessionKnown.delete(k); });
    byChannel.delete(scope);
    dataVersion++;
    try {
      await StorageManager.deleteMany(keys);
      UIManager.flash('已清空频道 ' + scope + ' 的 ' + keys.length + ' 条数据');
    } catch (e) {
      console.warn(LOG, '按频道删除本地记录失败', e);
      // 连着两条 flash 会被后一条盖掉，所以成功/失败各走一条
      UIManager.flash('内存里已清掉 ' + keys.length + ' 条，但本地库删除失败：' + e.message + '（刷新页面它们会回来）');
    }
    UIManager.renderNow();
  }

  let debounceTimer = null;
  function scheduleScan() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (ScanManager.isRunning()) return; // 扫描器运行期间由其统一采集
      scanCurrentPane();
    }, CONFIG.scanDebounceMs);
  }

  // M3：评论数/浏览量/反应更新时，Telegram 通常只改已有节点的文本或 class，不新增节点，
  // 只听 childList 的 MutationObserver 抓不到 → 空闲期低频重扫一次当前屏补上。
  // 不给 #column-center 整棵子树开 characterData/attributes（噪声极大，会把 300ms 防抖打满）。
  // 有了 S4-B 的「正文沿用库里 + 数字真变了才写库」，这轮重扫的成本只是读若干个数字。
  setInterval(() => {
    if (ScanManager.isRunning() || document.hidden) return; // 后台标签不烧 CPU，采集期由滚屏自己驱动
    scanCurrentPane(false).catch(e => console.warn(LOG, '空闲补采失败', e));
  }, 5000);

  // 只响应"新增消息气泡"；挂载到右侧 #column-center，左侧会话列表永不监听
  const observer = new MutationObserver(muts => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (node.nodeType !== 1) continue;
        if ((node.classList && (node.classList.contains('bubble') || node.classList.contains('channel-post'))) ||
            (node.querySelector && node.querySelector(CONFIG.scanConfig.bubbleSelector))) {
          scheduleScan();
          return;
        }
      }
    }
  });

  function attachObserver() {
    const root = document.getElementById('column-center');
    if (!root) { setTimeout(attachObserver, 1000); return; } // 右侧栏还没挂载，稍后重试，不退化成全页监听
    observer.observe(root, { childList: true, subtree: true });
  }

  (async function boot() {
    const savedSettings = Settings.load();
    if (savedSettings.scroll) {
      Object.assign(CONFIG.scrollConfig, savedSettings.scroll);
      delete CONFIG.scrollConfig.scrollDirection; // 旧设置里的「方向」不再有意义
    }
    if (typeof savedSettings.monitoring === 'boolean') monitoring = savedSettings.monitoring;
    restoreTable();
    UIManager.build();
    if (Object.keys(savedSettings).length) console.log(LOG, '已恢复界面设置', savedSettings);
    try {
      await StorageManager.open();
      const [saved, meta] = await Promise.all([StorageManager.loadAll(), StorageManager.getMeta('scan')]);
      // 边滚边采/空闲补采用的「已知帖子」集合要在起手就播种，否则重扫老帖会算成 0 重复；
      // 采集任务起手还会 markSessionKnown() 重算，两者不冲突
      saved.forEach(r => { putRecord(r); sessionKnown.add(r.key); });
      if (meta && meta.initialized) {
        stats.status = '已完成全量（可用增量模式）';
      } else {
        stats.status = '未做全量（建议先点「全量采集」）';
      }
      console.log(LOG, '已恢复', saved.length, '条记录，meta =', meta || null);
    } catch (e) {
      console.warn(LOG, 'IndexedDB 不可用，仅内存模式', e);
      stats.status = '内存模式（IndexedDB 不可用）';
    }
    attachObserver();
    window.addEventListener('hashchange', scheduleScan);
    // 切回本标签页/窗口重新获得焦点时立刻补画，避免后台期间 rAF 不触发导致的空列表
    document.addEventListener('visibilitychange', () => { if (!document.hidden) UIManager.renderNow(); });
    window.addEventListener('focus', () => UIManager.renderNow());
    scanCurrentPane();
    UIManager.render(); // 首屏直接画一次（rAF 在后台标签不触发，避免面板停在空状态）
    console.log(LOG, 'v' + VERSION + ' 已加载（发布时间全链路北京时间；导入前编码嗅探；导入/清空可一键恢复；已有帖子会刷新评论数/浏览量/反应）');
    console.log(LOG, '版本号来源：' + (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version ? '油猴 @version（会自动跟随）' : '代码内置兜底常量（需与 @version 手工保持一致）'));
  })();
})();
