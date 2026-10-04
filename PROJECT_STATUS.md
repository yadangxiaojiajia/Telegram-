# 项目开发状态记录（PROJECT_STATUS.md）

更新时间：2026-10-05（**v1.19.0**＝对 v1.18.0 的一次「只审不改 → 分阶段修 → 逐项实测」优化：S1–S7 正确性与数据安全、M1–M8 生命周期、P1–P2 性能、L1–L7 清理；**S4 采 B 方案（当前屏已有帖子每轮都刷新评论数/浏览量/反应，但只有值真变了才写库）**，**数字缩写口径采 A（`1.2K`→1200，CSV 永远存纯整数）**。上一版 v1.18.0：① 删除「×」关闭整个插件整条链；② 导入前嗅探 UTF-8 编码，非 UTF-8 或含 1 个 U+FFFD 就整份拒绝；③ 导入/清空前做**内存快照** + 表格上方「恢复本次导入/清空前的数据」按钮；④ 版本号单一来源（`GM_info.script.version` 优先、常量兜底）+ 面板标题带版本 + **交付文件改名 `Telegram频道分析助手V1.18.0.user.js`**。v1.17.0＝时区口径**方案 B1——全链路统一北京时间**（采集/存储/显示/筛选/CSV 同一串，删掉 v1.16.0 的显示层换算），**旧 CSV 备份一律作废**，用户自行「清空数据 + 重新全量采集」代替迁移；v1.15.0＝表头居中/内容靠左/序号居中 + 日期列「年月日时分」区间筛选 + 两处筛选按钮改名 + 列最小宽 12px 且序号列可拖窄；v1.14.0＝缩放跟手 + 216px 筛选小窗 + 表头单击排序双击筛选）
项目：Telegram Web K 频道分析助手（评论/浏览量/反应采集统计）油猴脚本
运行目标：`https://web.telegram.org/k/`（用户已登录会话，只读 DOM）

---

## 1. 当前完成情况

### 交付文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `Telegram频道分析助手V1.19.0.user.js` | **当前权威版本 v1.19.0**（2276 行，`node --check` 通过，本地 harness 逐项实测通过） | 完整单文件脚本；**文件名自 v1.19.0 起跟着版本号**；**磁盘已更新但用户尚未安装，必须重新整份复制进 Tampermonkey**；`@name` 未改；v1.18.0 那份文件已不在目录（`mv` 改名，内容连续） |
| `telegram-comment-counter.user.js` | 已废弃（v0.5.0） | 历史阶段产物，建议删除，避免与新版同时安装导致双脚本重复采集 |

### 版本历史（v1.4.0 之后）

- v1.4.1：UI 文案「被动监控」→「手动滚屏」
- v1.5.0：**按钮绿色状态机**（持续性按钮＝任务运行期间常亮绿；复位性按钮＝按下瞬间闪绿 350ms）；**滚屏设置精简**为三项：方向、滚动速度 e–f px 随机、滚动间隔 g–h ms 随机（其余随机暂停/上限等退为内部参数）
- v1.5.1：暂停按钮状态改读 `ScrollSimulator.isPaused()`，`stop()` 会清 paused，避免状态与按钮不同步
- v1.6.0：面板里点「消息 ID」链接改为**页内跳转**（左键定位、Ctrl/中键仍开新标签）
- v1.6.1：同频道跳转不再依赖地址栏 hash 格式，改为 `seekPostInChannel()` 容器滚动查找（跨频道仍用 hash，格式未证实）
- v1.7.0：**界面设置持久化**——localStorage `tcc-settings-v1` 存滚屏参数/排序方式/边滚边采开关，刷新、切标签回来不丢
- v1.8.0：面板标题更名 **「Telegram频道分析助手」**（`@name` 未改，见技术决定表）+ **性能精简**：便宜 `data-mid` 前置判重（不再每次滚动克隆 DOM 解析正文）、每屏一次 IndexedDB 事务 `putMany`、`requestAnimationFrame` 合并渲染、`byChannel` 频道索引（渲染/导出/最大 ID 不再全表扫描）、滚动容器 `WeakMap` 缓存、MutationObserver 监听根从 `document.body` 收窄到 `#column-center`；**修复** `clearAll()` 越界引用 UIManager 闭包内 `chSig`（表现为清了内存没清库）
- v1.9.0：**全部功能元素加鼠标悬停说明**（原生 `title`，11 个按钮 + 四个计数格 + 滚屏设置 + 频道下拉 + 打开按钮）；**按钮文案重命名**；按键区限高 106px + 自定义深色细滚动条
- v1.10.0：**靠屏幕边缘自动吸附**、**右下角手柄自由拉伸宽高**、面板内元素自适应（按键区改 auto-fill 网格、列表区 flex 伸缩）、位置与尺寸持久化；修复首屏渲染挂在 rAF 上导致后台标签面板空白、以及无数据时频道下拉为空
- v1.11.0：**表情反应解析改属性优先**——表情名按 `data-emoji → alt → data-name → title → aria-label → textContent` 顺序取，计数按 `data-count/data-total/data-reaction-count/data-value`（先看 `.reaction-counter` 的属性再看它的文本，都没有才按连写字符数还原付费✦组）；`title/aria-label` 只有"短且不含空格和数字"才被采信，避免把"Hans、Anna 和其他 12 人赞了"这类长句当成表情名；无字符的 blob 表情仍记作 `[表情]`
- （已作废的版本号 v1.12.0，2026-10-04 上午）曾把 `XLSXExporter`（手写 ZIP store + SpreadsheetML，「导出XLSX」「分频道XLSX」两个按钮）标为 v1.12.0，容器已用 `unzip -t` 校验通过；**用户随即要求「回档」，已全部撤销**，脚本回到 v1.11.0。现仓库内**没有任何 Excel/XLSX 代码**，导出仍只有 CSV。该版本号随后重新用于下面的表格/筛选批次
- **v1.12.0（2026-10-04，本批 6 项需求）**：
  1. **列表 → 表格**：6 列（消息ID/评论数/浏览量/反应/发布时间/正文）+ 固定「打开」按钮列；`colgroup` 定宽 + `table-layout:fixed` + 横向滚动；表头吸顶；**拖右分隔线改列宽**（实时改 `<col>`，松手存 `table.widths`）；**双击分隔线＝该列自适应内容**（canvas `measureText` 量当前显示行，不插 DOM 探针，46~640px 夹取）；「列显示」chips 小菜单控制显隐（**v1.12.0 时正文列不可隐藏，v1.14.0 起所有列都可隐藏**）；面板默认宽 320→**520**（旧存档里 `w===320` 首次自动升为 520）
  2. **WPS 式表头筛选**：点表头标题开筛选面板（标题/数字列给最小+最大两框）；三模式按钮 **同时包含 / 任意一个 / 完整串**（空格分词，模式全局记住存 `table.mode`）；**「总数」仍显示未筛选真实条数**，表格上方另起「匹配 N 条 / 共 M 条」；有筛选时表头变橙、`th.on`；「清筛选」一键复位；**导出CSV 走筛选**，新增**「导出全部」忽略筛选**；分频道批量导出仍是备份语义（永远忽略筛选）；**取消 30 行上限**，改为 `rowCap=500` 渲染上限 + 超出一行提示（数据量上万时不至于卡死，导出与「总数」不受影响）
  3. **「–」最小化＝收成右下角悬浮球**（球上角标显示当前视图条数，可拖动吸边，位置存 `orb`；点球恢复并强制重画）；**「×」＝卸载整个插件**：`unplug()` 停任务 + `monitoring=false` + `observer.disconnect()` + 摘掉 `hashchange` + 置 `pluginClosed`，再移除面板与悬浮球，**不留任何重开入口**（`scanCurrentPane()`/`render()`/`scheduleRender()` 首行都拦，实测关闭后新增气泡与切频道都不再入库；只有刷新页面才由 Tampermonkey 重新加载）
  4. **清空数据二次确认**：点「清空数据」只在面板内展开自绘确认条（6 秒不点自动取消），三选一：**只清当前频道 / 全部清空 / 取消**；按频道清走 `StorageManager.deleteMany(keys)` 单事务，只动该频道在 `records/byChannel/sessionKnown` 里的键，`meta` 保留
  5. **修「切走标签再回来后面板列表一片空白」**：根因确认是 `scheduleRender()` 只挂 `requestAnimationFrame`，后台标签 rAF 不触发，DOM 就一直停在旧状态且不自己恢复。现在 rAF 之外**加 800ms `setTimeout` 兜底**（谁先跑谁画，另一个作废），并监听 **`visibilitychange` / `window focus` → `renderNow()`** 强制补画；同时引入渲染指纹（列集合+排序+筛选+条数+`dataVersion`），没变化就不重写 DOM
  6. **删掉滚屏设置里的「方向」**：`CONFIG.scrollConfig.scrollDirection` 与下拉框移除，`runInitial`/`runIncremental` 固定 `run('up')` 朝历史滚（旧版按 UI 方向走，选「最新消息」时会跑反方向并立刻判"已完成"）；boot 时 `delete CONFIG.scrollConfig.scrollDirection` 清掉 localStorage 残留
- **v1.13.0（2026-10-04，「左侧增加一列序号栏，排序，但是不写入csv」）**：表格最左侧加固定「序」列（`RANK_W=40`，右对齐 + `tabular-nums`），序号＝**当前排序与筛选之后**的显示行号（`render()` 里 `shown.map((r,i)=>rowHtml(r,cols,i+1))`），滚动或重新排序后从 1 重新编号。设计取舍：**序号列不进 `COLUMNS`**，因此天然不参与列显隐 chips、不进表头筛选面板、点它不排序（`<th class="rank">` 无 `data-col`，拖列宽/双击自适应也跳过）、不写 localStorage、**不写进 CSV**（`CSVExporter` 的 10 列 `HEADER` 一个字节都没改，导出仍是 `channel,channel_title,post_id,post_url,comment_count,content,publish_time,views,reactions,reactions_total`）。`buildHead()` 在 `<colgroup>` 首位插 40px `<col>`、`syncTableWidth()` 加 `+RANK_W`、空状态行 `colspan` 改为 `cols.length + 2`。顺带把筛选无命中时的空状态文案改成「没有帖子符合当前的表头筛选条件，点上方「清筛选」就能看到全部 N 条」；加载日志同步为 v1.13.0

- **v1.14.0（2026-10-04，1 修 4 新）**：
  1. **修「拖右下角拉手缩放不跟手、鼠标位移≠面板位移」**，三个叠加根因：① CSS 的 `max-width:94vw/max-height:82vh` 与 JS 写进 `style` 的数值**不是同一套上限**——4K 15.6 寸缩放后可视区 CSS 高度很小，500 行表格的 auto 高度早就顶在 82vh，脚本还在往上涨，于是"视觉不动、记录值虚增"，往回缩时要先消化虚假增量；② 缩放里误用了拖动吸附的 `SNAP` 回拉，靠近边缘时宽度**倒退 10px**；③ 面板没写 `box-sizing`，style 的内容宽与屏幕上的边框框差 2px。修法＝`#tcc-panel{box-sizing:border-box}`（style 值＝渲染值）＋ **`uncaps()`**：一旦尺寸由脚本写死（`applyGeom` 写入显式高度，或**按下拉手时**），把 CSS 上限放开成 `calc(100vw/vh - 20px)`，与 JS 硬限制同一套值；拉手 `pointerdown` 先把当前渲染尺寸**钉成显式值**再解顶（避免解顶瞬间 auto 高度爆高）；`enableResize` 的增量只用按下瞬间的 `s.ow/s.oh` + 鼠标位移 1:1，取消 SNAP 回拉，只保留「≥MIN_W/MIN_H、不超出屏幕」两条硬限制
  2. **筛选面板 → 216px 小浮窗**：`.tcc-fpop` 从表格上方的整条横栏改成 `position:fixed` 的小窗，挂在被点表头**正下方**（`r.bottom+4`，下方放不下挂上方，左右夹在视口内），内容不变（列名 + `×` + 三模式按钮 + 关键字框 + 数字列最小/最大 + 清空本列/完成）。作为 `#tcc-panel` 的直接子节点存在（fixed 元素不被祖先 `overflow:hidden` 裁切，已用 `elementFromPoint` 命中验证），关闭随面板移除。**新增 `closeFilter()`**；document 捕获阶段 `pointerdown` 监听：点窗口外面／拖标题栏／按缩放拉手都会收起（点同一列表头除外，留给双击判定）
  3. **表头交互改规则**：单击＝本列排序循环 **降序→升序→默认**（默认＝`SORT_DEFAULT = {post_id,desc}`），**双击（300ms 内同列第二次点击）＝弹出本列筛选**；双击分支会先把 `tableState.sort` 还原成首次单击前的快照 `headTap.snap`，所以弹筛选不会顺带改排序。表头小箭头 `.arr` 去掉 `data-act="sort"` 与 pointer 光标，变成**只读指示**；`.lab` 的悬停说明改为「单击＝排序，双击＝筛选」。**分隔线的双击自适应列宽与拖拽改列宽不变**（`e.target.dataset.act === 'grip'` 在单击分支里直接 return）
  4. **删除「排序」按钮**：markup、`sortBtn` 引用、`SORT_PRESETS`、`sortLabel()`、`onAction` 的 `sort` 分支与 momentary 列表项全部移除；按键区 12→**11 个按钮**。排序状态仍然持久化（`table.sort`）
  5. **所有列都能隐藏**：去掉「正文列不可隐藏」的特殊保护（chips 分支与 `restoreTable` 里 `k !== 'content'` 过滤），`restoreTable` 改成按 `COLUMNS` 校验 key；全部隐藏时表格显示提示行「所有列都被隐藏了，点上方『列显示』把要看的列勾回来（数据仍在库里，导出不受影响）」，此时 `colgroup` 只剩 40px 序号列 + 46px 操作列、`table.style.width=86px`，「总数」与导出不受影响

- **v1.15.0（2026-10-05，1 个对齐 + 1 个筛选改造 + 2 处改名 + 1 个宽度参数）**：
  1. **对齐规则**（用户点名"每一列的每一个单元格向左对齐"，补充确认"序号列居中、表头整行居中"）：`.tcc-table th{text-align:center}`（表头标题全部居中）；`td.num` 去掉 `text-align:right` → 数字列（消息ID/评论数/浏览量/反应）与正文、时间一样**靠左**；`th.rank`/`td.rank` 改**居中**并去掉旧的 `padding-right:4px` 单边内边距（改 `padding:0 6px`，居中才不歪）
  2. **发布时间列筛选改成分段区间**：`COLUMNS` 给 `publish_time` 加 `date: true`；筛选小窗对这一列**隐藏关键字行与三模式按钮**（用户 2026-10-05 确认不留关键字框，"搜索功能也同理"＝这列不再用文本搜），改成两行各 5 个数字输入框：**最小 年/月/日/时/分、最大 年/月/日/时/分**（年 38px、其余 26px，窗宽仍 216px，`scrollWidth` 214 不溢出；`::-webkit-inner-spin-button` 关掉，Appearance 也置 textfield，窄框才不会被微调按钮撑爆）。归一化函数 `dateBound(vals, side)`：按 `DATE_PAD` 逐档补零/补边界，**从左往右第一个留空的档及其后面全部取边界值**（最小补 `0000-01-01 00:00`、最大补 `9999-12-31 23:59`），即"留空＝这一档及之后不设限"，大档留空时小档输入不起作用；数值做范围夹取（月 1–12、日 1–31、时 0–23、分 0–59、年 ≥1）。比较用**字符串大小**——这列存的是定宽 `"YYYY-MM-DD HH:mm"`（`extractPublishTime` 用 `toISOString`，所以是 **UTC**；用户明确选"按列里显示的那串字符"，**不改时区**），定宽串字典序＝时间序，含端点。空 publish_time 的记录在设了区间时**淘汰**（与数字列同一口径）。`matchFilters` 里日期列走独立分支并 `continue`，不再做关键字匹配；`applyFilter` 里把五档原始值存进 `f.fromVals/toVals`（重开小窗能原样回填，也用来判断"是不是全空"），只有 `f.from/f.to` 参与比较；最小>最大时 `flash()` 提示一句「最小比最大还晚，这样一条都不会匹配」。筛选值依旧**不落盘**
  3. **两处改名**：筛选窗「清空本列」→**「去除本列筛选条件」**（现在它真的会把日期五档也清空，之前只清 text/min/max）；表格上方「清筛选」→**「去除所有筛选条件」**，`flash` 文案同步成「已去除所有筛选条件」，筛选无命中的空状态提示也跟着引用新名字
  4. **列最小宽 46→12px（"一个字，裁一半也行"）**：`COL_MIN_W = 12`，拖列宽、双击自适应、`restoreTable` 夹取三处共用；**序号列现在可拖窄**——`<th class="rank">` 里加了一根带 `data-col="rank"` 的 `.grip`，宽度存 `tableState.widths.rank`（默认 40，跟其它列一样持久化、参与 `syncTableWidth`），双击这根线按「序」+ 行数的位数自适应；拖/双击的 handler 改成**读 grip 自己的 `data-col`**（`dragColumn(e, key)` 签名从 th 元素改成 key），而排序/筛选的 click handler 仍只看 `th[data-col]`——序号列的 th 刻意不带 `data-col`，所以点它不排序、不弹筛选，`COLBYKEY` 也查不到它，`autoFit('rank')` 走单独的度量分支。**它依旧不进 `COLUMNS`、不进 chips、不进 CSV**（v1.13.0 的红线不变）。「打开」列 `ACTION_W=46` 不可拖、不参与显隐
  5. **顺带修一个潜伏 bug**：`render()` 里 `chEl.textContent = '当前频道：…'` 没走 `flashing` 闸门，所以任何 `flash()` 提示都会被紧随其后的 `render()` 立刻覆盖（新加的"最小>最大"提示实测就是被吃掉才发现）。现在这行包在 `if (!flashing)` 里，1.5 秒提示期内不被覆盖

- **v1.16.0（2026-10-05，「把 UTC 改成北京时间」——当时选方案 A：只改显示和筛选，底层不动；**同日即被 v1.17.0 的方案 B1 取代，换算层已删除**）**：
  1. **背景**：`extractPublishTime` 用 `toISOString()`，所以库里与 CSV 的 `publish_time` 一直是 **UTC** 定宽串 `"YYYY-MM-DD HH:mm"`，比北京时间早 8 小时。用户要求改成北京时间，我给了 4 个方案（A 只改显示筛选／B 全改含存储＋一次性迁移／C 库里加第二个时间字段（会牵动 CSV 列数）／D 只把显示加 8 小时但筛选仍按原串＝自欺），**用户点名选 A**。取舍理由：A **不需要数据迁移**（旧记录、旧导入的 CSV 一行不动，装上就生效）、**随时可逆**、CSV 这个"数据库"的格式继续永不漂移；代价是**懂行的人打开 CSV 会看到和界面差 8 小时**，所以界面里到处写清楚
  2. **实现＝两个换算函数 + 三个接入点**：模块级 `CN_OFF = 8*3600*1000`、`UTC_LIKE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/`、`fmt(d)`（`toISOString().replace('T',' ').slice(0,16)`）、**`toCn(utc)`**（串 → `Date.parse(s+'T'+':00Z')` → +8h → `fmt`）、**`toUtc(cn)`**（`...+08:00` → `fmt`）。接入点：① `rowHtml` 里 `col.date` 的单元格显示 `toCn(raw)`，`title` 提示同时给两个值「北京时间 …（库里与 CSV 存的是 UTC …）」；② `applyFilter` 的日期分支把 `dateBound(...)` 的**北京串再 `toUtc()`** 后才存进 `f.from/f.to`，比较仍走原来的字符串大小；`f.fromVals/toVals` 存的仍是用户填的**北京五档原值**，所以重开小窗回填的是北京值；③ 文案：表头 `.lab` 的悬停说明对日期列追加「显示北京时间，库里与 CSV 存 UTC」，筛选小窗标题变「筛选：发布时间（填北京时间）」，每个日期输入框的 `title` 都写"填北京时间"。**排序不用改**——北京串与 UTC 串是同一批值整体 +8h，单调，字典序一致
  3. **边界情形（都验过）**：跨日进位 `2026-10-03 23:59 UTC` → 显示 `2026-10-04 07:59`；筛选只填到「日」时北京 10‑04 00:00 → 换算成 UTC `2026-10-03 16:00`，所以这条仍能命中；**`dateBound` 的"不设限"哨兵不换算**（`CN_MIN_SENT='0000-01-01 00:00'`、`CN_MAX_SENT='9999-12-31 23:59'`，一换算会变成 `-0001` 年那种怪串）；不是 16 位标准串的值（空、旧的怪数据）**原样透传**，不硬凑
  4. **明确没动**：`extractPublishTime`（仍产 UTC）、CSV 的 10 列 `HEADER` 与 `publish_time` 取值（仍写库里那串 UTC）、导入逻辑（原样照抄，因此导入旧 CSV 也不会有二次换算的问题）。IndexedDB 无需升版本、无需迁移脚本

- **v1.17.0（2026-10-05，时区口径从方案 A 换成方案 B1：全链路只有北京时间一个口径）**：
  1. **为什么换**：用户追问"导出的 CSV 也改北京时间，再把这个 CSV 导回脚本会不会有逻辑问题"。分析结论是**方案 A 的代价（界面与 CSV 差 8 小时）是永久的**，而 B1 在数据模型上更干净；B1 的风险**全部来自旧备份**（CSV 里没有"我是哪个时区"的标记，旧 UTC 文件导回来会被当成北京时间静默污染，且判重键 `channel_post_id` 不含时间 → 不报错、条数正常）。用户明确**旧 CSV 全部作废**，风险前提消失，遂选 B1；**存量记录不做迁移**，由用户自己「清空数据 + 重新全量采集」代替
  2. **实现＝换算层整体删掉 + 采集端一次 +8**：`extractPublishTime` 改成 `fmt(new Date(ts * 1000 + CN_OFF))`（`data-timestamp` 是 UTC 秒，直接产出北京定宽串 `"YYYY-MM-DD HH:mm"`）；**删除** v1.16.0 的 `toCn`/`toUtc`/`UTC_LIKE`/`CN_MIN_SENT`/`CN_MAX_SENT`（模块级只留 `CN_OFF` 与 `fmt`）；`rowHtml` 的日期单元格回到显示 `raw` 本身，`title` 简化成「北京时间 …」；`applyFilter` 的日期分支回到 `f.from = dateEmpty(fv) ? '' : dateBound(fv, 'min')`（不再换算）；文案三处同步——表头 `.lab` 悬停改「显示与筛选都是北京时间，CSV 也是」、筛选窗标题仍是「筛选：发布时间（填北京时间）」、`HEADER` 上方加了一行注释声明这列从 v1.17.0 起是北京时间。**净减 11 行**
  3. **逻辑上不用改的地方（已验证成立）**：排序（定宽串字典序＝时间序，全表同一口径即可）；`dateBound` 的"不设限"哨兵（`0000-01-01 00:00`/`9999-12-31 23:59` 现在直接参与北京串比较，不再有"哨兵不能换算"的例外）；`matchFilters` 日期分支；CSV 导出（本来就写库里的原串）；**导入**（本来就原样照抄，所以"导出→导入"往返幂等，不会二次 +8）。**代价＝不可逆**：库里一旦存北京串就找不回 UTC 原值
  4. **⚠️ 用户侧必须做的一次操作**：装上 v1.17.0 后**先点「清空数据 → 全部清空」再重新采集**。不清的话，旧记录仍是 UTC 串、新采集的是北京串，两种格式混在同一列里 → 旧记录看起来早 8 小时、日期排序与区间筛选会错乱（这正是 B1 唯一还活着的翻车路径，对话里已明确告知用户）
  5. **顺带记一个测试方法坑**：后台标签的 `setTimeout` 被 Chrome 限到约 1 秒，**带 `await` 的两次单击间隔会超过 300ms 双击判定窗口**，看起来像"双击表头没弹筛选"。harness 里必须在同一个脚本内**同步连点两次**（`th.click(); th.click();`）才能触发 `openFilter`

- **v1.18.0（2026-10-05，用户一次性点名的 4 项：删关闭链 / 导入编码嗅探 / 快照恢复 / 版本号与命名）**：
  1. **删除「×」关闭整个插件（整条链，用户明确"整条链一起删，代码干净"）**：面板头 markup 的 `data-act="close"` 按钮、`.tcc-head` 点击分支、`closePlugin()`、`unplug()`、状态位 `pluginClosed` 以及它在 `scanCurrentPane`/`render`/`scheduleRender`/`renderNow` 四处的拦截全部移除（`grep -E "pluginClosed|closePlugin|unplug|插件已关闭"` 零残留，只剩筛选小窗自己的 `data-f="close"`，那是收起筛选窗、与插件卸载无关）。**停止采集仍靠「停止」按钮和「边滚边采·停」**，面板不再能被移除，只留「–」最小化
  2. **导入前的 UTF-8 嗅探（宁可拒绝也不写脏数据）**：`CSVExporter` 新增 `decodeCsv(buf)`，导入端从 `await f.text()` 改成 `CSVExporter.decodeCsv(await f.arrayBuffer())`。规则＝**`new TextDecoder('utf-8', { fatal: true })` 解码失败（Excel/WPS 另存的 ANSI/GBK 必然不是合法 UTF-8）→ 整份拒绝**；解码成功但正文里**出现 1 个 U+FFFD 也整份拒绝**（历史上"先乱码入库、之后正确文件因判重跳过"的翻车就是这么堵住的）。两条都直接 `throw`，由原 `catch` 走 `flash('导入失败：…')`，**一条记录都不会写进库**；不再额外补时区提示（用户明确不要）。注意 `fatal:true` 时 TextDecoder 不会自己产出 U+FFFD，所以第二个检查针对的是"已经是乱码的 UTF-8 文件"
  3. **导入/清空前的内存快照 + 一键恢复**（用户逐条确认：只存内存刷新即没、叫「恢复本次导入前的数据」、清空也纳入、导入前库是空的则恢复＝清空全部、只留最近一次）：模块级 `snapshot = { kind:'import'|'clear', at, count, records[] }`，`takeSnapshot()` 浅拷贝整张 `records`；接入点＝导入成功解码后 `takeSnapshot('import')`、`removeData()` 两个分支删除前 `takeSnapshot('clear')`（全部清空时库本就空着则不留快照）。`restoreSnapshot()` 清空 `records/byChannel/sessionKnown` 后用 `putRecord()` 逐条重建（顺带把 `byChannel` 索引和 `maxId` 一起复原），再 `StorageManager.clearRecords()` + `putMany(快照)` 让 IndexedDB 与内存一致。**UI**：表格上方 `.tcc-bar` 末尾新增 `[data-act=restore]` 按钮，`paintRestore()` 在每次 `render()` 里按快照有无切换 `hidden`，文案跟着 `kind` 走「恢复本次导入前的数据／恢复本次清空前的数据」，`title` 带上快照时间与条数；点击**复用原有确认条**（`prepCfm(txt, mode)` 统一处理：clear 模式显示「只清当前频道/全部清空」，restore 模式显示「确认恢复」，两者互斥隐藏，仍是 6 秒超时自动取消）
  4. **恢复的保护**：`askRestore()` 在 `activeTask || ScanManager.isRunning()` 时直接 `flash('请先停止采集，再执行恢复')` 不弹确认（避免边写边回滚）。实测要点：按下「停止」后 `ScanManager` 要等当前滚动步长睡完才真正退出，这段收尾期内点恢复仍会被拒，属预期行为
  5. **版本号单一来源 + 命名统一**：IIFE 开头 `const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.18.0';`，面板标题 `${CONFIG.ui.title} v${VERSION}`、悬浮球 `title` 前缀、加载日志都用它，并多打一条「版本号来源：油猴 @version／代码内置兜底常量」作为用户侧可核对的证据（`@grant none` 下 `GM_info` 是否可见我无法验证，等用户回报）。`@version` 与兜底常量必须同步改，这是新增的唯一人工一致性成本。**交付文件改名** `Telegram频道分析助手V1.18.0.user.js`（`mv`，内容连续；`@name`／IndexedDB 名 `tg-comment-stats`／localStorage 键 `tcc-settings-v1`／CSS 前缀 `tcc-` 全部不动，避免脚本被判新文件或库被清空）

- **v1.19.0（2026-10-05，「审查并优化 v1.18.0：简洁度/正确性/性能」——按用户流程要求先只交出审计清单，用户拍板 S4=B、缩写口径=A 后才动码）**：
  1. **S1 任务异常必复位**：`runInitial`/`runIncremental` 整段包 `try / catch / finally`，`finally` 里 `activeTask = null; UIManager.render()`。旧写法在 `ScrollSimulator.run()` 起手 throw（右侧没打开频道、找不到容器）时把 `activeTask` 永久留在 `'init'`——面板按钮常亮绿、「边滚边采」「恢复快照」「页内跳转」从此一直被"采集进行中"拒掉
  2. **S2 频道锚点**：两个任务各自记 `anchorCh`（起手为空则由第一轮扫描补锚），每步比对 `currentChannel.username`，切频道即停并写清停止原因；`scanCurrentPane` 里那句「已切换到频道 X，本次采集结束」加了 `!!prevCh && ScanManager.isRunning()` 双条件——否则刚进页面的第一次扫描（prevCh 还是空串）会把面板状态刷成"切换了频道"，这个回归是我自己改出来的，harness 起手就撞到并当场修掉
  3. **S3 评论数解析**：`extractCommentCount` 先要求 `bubble.with-replies`，数字正则不再用 `^` 锚定（真实文案词序不固定，`1,234 Comments` 与 `Comments 1,234` 都得认），匹配不到数字（"Leave a comment"）记 0 而不是 null
  4. **S4（方案 B）已有帖子也刷新数字**：新增 `MessageParser.buildRecord(bubble, channel, keepContent)` + `fillFromOld(rec, old)`（新值缺失时沿用库里的，绝不清空）+ `statsChanged(old, rec)`（只比 comment_count/views/reactions/reactions_total/publish_time/content/channel_title，**不比 collected_at**）。每屏对已有帖子重读那几个数字，`statsChanged` 为假就 `continue`——**不写库、不 dataVersion++、不重绘**。代价（用户已知悉并选择）：已知帖子的**正文改动不再重读**（`keepContent` 直接沿用库里的），因为重新克隆整棵 `.message` 子树是每屏最贵的一次 DOM 操作
  5. **S5 双实例守卫**：`if (window.__tccLoaded) { console.warn(...); return; }` 放在 Settings 之后（要用 `LOG`）。两个实例会各起一个 ScrollSimulator 抢同一个消息容器、双写同一个库
  6. **S6 空屏不再空转**：`ScanManager` 顶部 `EMPTY_PANE_REASON`，全量看「已到顶且 `seenIds.size===0` 连续 3 轮」、增量看「`seenIds.size===0` 连续 3 轮」即停。旧写法靠 `mn===Infinity` 永远凑不满 stable/dup 条件，空频道会一路滚到 `maxSteps=3000`（约 1.5 小时）才停。**顺带**：增量因空屏停止时不再把 `meta.initialized` 置真（否则下次进页面显示"已完成全量"，误导用户跳过全量）
  7. **S7 写库失败会补写**：模块级 `pendingPersist` Set 记住"内存有、库里没有"的 key，`scanCurrentPane` 每轮把这些一起 `putMany`，成功才清空；`importCSV` 的分块写库失败也登记未写部分。写库只在 `StorageManager.hasDb()` 为真时尝试（内存模式不再每 5 秒假报"写入失败"）。提示语改成「…下轮扫描会自动补写」
  8. **M1 增量边界改成"整屏都在库里"**：旧写法屏上有 1 个已知帖就算重复，而步长仅 60–140px、约 10 步才一屏高，新帖尚未挂载时会被误判成"已到边界"→**漏帖**。现在 `allKnown = seenIds.size>0 && knownVisible===seenIds.size`，连续 10 次才停
  9. **M3 空闲低频补采**：`setInterval` 5 秒调 `scanCurrentPane(false)`（`document.hidden` 或采集运行中跳过）。MutationObserver 只听 `childList`，Telegram 更新评论数/浏览量往往只改已有节点的文本，抓不到——空闲期靠这轮补扫。**`countDup=false`**：挂机一小时不给「重复」格虚涨几千次
  10. **M4/M5 快照与恢复真的原子**：`takeSnapshot` 改 async 并连带捕获 `meta`（三态：对象＝当时值／`null`＝确实没有／`undefined`＝没读到，恢复时不碰 meta 免得误删）；`StorageManager.replaceAll(list, meta)` 把 **clear + 整批 put + meta 写回放进同一个跨 store 事务**，全成或全败；`restoreSnapshot` **先落库、成功后才动内存、失败原样保住快照**并提示"可以再点一次恢复"；恢复入口除 `askRestore` 外，真正执行前再查一次 `activeTask || isRunning()`（确认条 6 秒窗口内可能点了采集）
  11. **M6–M8**：`removeData` 每个分支只发一条 `flash`（旧代码成功/失败连着两条，后一条把前一条盖掉）；`importCSV` 分块 `CHUNK=2000` 落库并回调进度（旧写法几万行塞一个事务，主线程被占死几十秒）；CSV 导入的数字列统一走 `parseCompact`（千分位 `1,234`→1234、缩写 `1.2K`→1200；旧的 `replace(/\D/g,'')` 会把 `-5` 读成 5、`1.5K` 读成 15）；**新增 `normTime`**：`publish_time` 只认 `"YYYY-MM-DD HH:mm"`（纯日期补 `00:00`），且必须是真实时刻——`2024-13-99 99:99` 这种形状对日子错的值进库后，排序与时分区间筛选都会算出 NaN
  12. **P1/P2 渲染节流**：采集运行中表格重绘降到 1.5 秒一次（统计数字仍即时）；收成悬浮球后 `render()` 在更新角标之后**直接 return**，不再重建 500 行 DOM，`expand()` 里清 `renderedSig` 补画
  13. **L1–L7 清理**：列宽拖动先读 `tableState.widths[key`（不再有从 0 起算的跳变）；频道下拉指纹带上标题（频道改名后文案会跟着刷新）；`seekPostInChannel` 循环内每步查 `ScanManager.isRunning()`，采集一旦开始就中断跳转而不是继续抢容器；删除 `stats.total` 与 `ScanManager.activeMode` 两个从未被读取的死字段（grep 确认过零读取）；手动停止的文案从"已停止：已手动停止"收成「已停止：手动停止」
  14. **明确没做（避免越界）**：P3 频道提取缓存（收益极小、标题易变旧）、P4 导出侧内存/复制削减（动到 CSV 正确性）、P5 增量快照语义重构（要单独拍板）。`parseCSV` 仍是一次性同步解析（分块只覆盖了写库阶段）

### 已完成模块（均在 v1.19.0 内）
- **CONFIG**：`db`（`tg-comment-stats` v2）、`scrollConfig`（speedMin-Max/intervalMin-Max/内部 maxSteps 3000/maxRuntime 60min；**已无「方向」**）、`scanConfig`（maxDuplicateCount 10、initialEndStableRounds 5、bubbleSelector）、`ui`（标题、`rowCap:500` 渲染行上限、`defaultWidth:520`）
- **Settings**：localStorage `tcc-settings-v1`，存 `scroll` / `monitoring` / `panel`（left,top,w,h）/ `table`（widths,hidden,mode,sort）/ `orb`（悬浮球 left,top）；**`sortMode` 已废**，排序方式改存 `table.sort`（任意列 + 升降序）
- **表格状态层 `COLUMNS`/`tableState`**：列定义（key/label/默认宽/`num` 数字列/`date` 日期列，目前只有 `publish_time` 是 `date`）+ 列宽 + 显隐 + 每列筛选（text/min/max，日期列是 from/to）+ 全局匹配模式 + 排序；配套 `saveTable/restoreTable/COLBYKEY/activeColumns/hasFilters/numOf/textMatch/dateBound/dateEmpty/matchFilters`（**时区换算层已在 v1.17.0 整体删除**——模块级只剩 `CN_OFF=8*3600*1000` 与 `fmt(d)` 两个常量/工具，且只在采集端用一次；库里、界面、CSV 全是同一串北京时间），`dataVersion` 每次 `putRecord` 自增供渲染指纹用；筛选条件**不持久化**（只在本次会话生效，避免用户切回来发现列表被悄悄过滤）。表格列宽常量：**`COL_MIN_W=12`（一个字宽，v1.15.0 起）**/`COL_MAX_W=640`/`ACTION_W=46`（「打开」列，固定不可拖）/**`RANK_W=40`（序号列默认宽；不在 `COLUMNS` 内，但 v1.15.0 起可拖窄、宽度存 `tableState.widths.rank`）**
- **State**：`records`(Map) + `byChannel`(频道索引) + `sessionKnown`(Set，**本次扫描开始前就已存在的 key**，增量边界与「重复」计数依据) + `pendingPersist`(Set，v1.19.0 S7：写库失败欠下的 key，每轮扫描补写直到真落库) + `monitoring` + `activeTask` + `uiBusy` + `channelFilter` + `snapshot`(v1.18.0 内存快照，v1.19.0 起连带 `meta`) + `stats`；统一入口 `putRecord(rec)` 写内存并维护索引。**`pluginClosed` 已在 v1.18.0 随「×」功能整体删除**
- **StorageManager**：IndexedDB 双 store（`records` keyPath=`key`、`meta` keyPath=`k`）；`putMany()`/`deleteMany()` 各一个事务批量写/删；**`hasDb()`**（内存降级模式下不再假装写库）、**`replaceAll(list, meta)`**（v1.19.0 M4：clear + 整批 put + meta 写回放进**同一个跨 store 事务**，快照恢复全成或全败）
- **MessageParser**：只读 `#column-center`；channel/post_id/comment_count/content/publish_time/views/reactions 七类字段提取（reactions 属性优先、textContent 兜底，见 v1.11.0；**`extractPublishTime` 现在是 `fmt(new Date(ts*1000 + CN_OFF))` → `publish_time` 是北京时间定宽串 `"YYYY-MM-DD HH:mm"`（v1.17.0，方案 B1；此前 v1.16.0 及更早存的是 UTC）**）；**v1.19.0 新增 `buildRecord(bubble, channel, keepContent)`（S4=B：`keepContent` 时正文直接沿用库里那一版，不重新克隆 `.message` 子树）、`fillFromOld(rec, old)`（新读不到的字段一律沿用旧值，绝不清空）、`statsChanged(old, rec)`（只比 comment_count/views/reactions/reactions_total/publish_time/content/channel_title，**不比 collected_at**——为假就不写库、不 dataVersion++、不重绘）、`parseCompact`（千分位 `1,234`→1234、缩写 `1.2K`→1200、`1.2万`→12000，采集端与导入端共用；口径 A＝CSV 永远存纯整数）**；`extractCommentCount` 先要求 `bubble.with-replies`、数字正则不锚 `^`、无数字（"Leave a comment"）记 0（S3）；`findScroller()` 带 WeakMap 缓存；`findBubbleByPostId()` + `centerBubble()` 供页内定位
- **scanCurrentPane(countDup = true)**：采集核心，返回 `{ added, seenIds, knownVisible }`。`data-mid` 前置判重 → 已有帖子走 S4 刷新分支 → 每屏一次 `putMany`（`hasDb()` 为真才试，失败进 `pendingPersist`）→ `scheduleRender`；`countDup=false` 是 v1.19.0 空闲补采专用（不把「重复」格刷爆）
- **ScrollSimulator**：只滚 `.bubbles-scrollable`；步长/间隔在用户给定区间内随机 + 10% 概率阅读停顿；maxRuntime/maxSteps 双上限；run/stop/pause；两个采集任务固定 `run('up')`
- **ScanManager**：`runInitial`（全量，含 v1.1.3 防误停：归顶 + 等 2s + 最小 ID 连续 5 轮不变）/ `runIncremental`（**v1.19.0 M1：改判「整屏都在库里」** `allKnown = seenIds.size>0 && knownVisible===seenIds.size`，连续 N=10 次才停——旧写法屏上有 1 个已知帖就算重复，步长 60–140px 时新帖还没挂上就会误停漏帖）；两任务 **v1.19.0 各自 `try/catch/finally`（S1，异常必复位 `activeTask`）、起手记 `anchorCh` 逐步比对频道（S2，切频道即停）、`EMPTY_PANE_REASON` 空屏连续 3 轮自停（S6，不再空转到 maxSteps=3000；且因空屏停止时不置 `meta.initialized`）**
- **CSVExporter**：`exportCSV(channel, ignoreFilter)`（单频道/全部合并/分频道批量，UTF-8 BOM 10 列）+ 导入（`decodeCsv` 严格 UTF-8 嗅探 → `parseCSV` 状态机 → `importCSV` 批量写回，v1.18.0）。**v1.19.0 的导入端**：数字列统一 `MessageParser.parseCompact`（M7）、`publish_time` 走 **`normTime`**（只认 `"YYYY-MM-DD HH:mm"`，纯日期补 `00:00`，时刻不真实如 `2024-13-99` 一律当空；写库分块 `CHUNK = 2000` + 进度回调，失败的那一块及之后全部登记进 `pendingPersist`）；与库里旧记录冲突时仍是「不覆盖、只补全」——`fillFromOld` + `statsChanged` 判过才 push（`新增/更新/跳过` 三种计数；`dbError` 非空时提示语是「已进内存 N 条但没落库，刷新页面会丢」，M5）。**`publish_time` 这一列从 v1.17.0 起是北京时间**（导出写库里的原串、导入原样照抄，所以"导出→导入"往返幂等）；**v1.17.0 之前导出的 CSV 备份（那一列是 UTC）一律作废，不要再导入**（用户已确认）
- **UIManager**：深色面板（拖动＋靠边吸附＋拉角调尺寸，默认 520 宽，`box-sizing:border-box`，显式尺寸时 CSS 上限放开到 `calc(100v*-20px)` 与 JS 硬限制一致）、**11 个功能按钮**（全绿状态机，「排序」按钮已在 v1.14.0 删除）、四计数 + 状态/停止原因、**表格区**（**序号列「序」** + colgroup 定宽 + **表头单击排序/双击筛选** + 拖列宽（**最小 12px，序号列也能拖**）+ 双击自适应 + **所有列可隐藏** chips + **对齐：表头居中、内容全部靠左、序号列居中** + 「匹配 N / 共 M 条」+ rowCap 截断提示 + 筛选无命中/全列隐藏两种空状态）、**筛选小浮窗 `.tcc-fpop`（216px fixed，挂在表头下方，`closeFilter()` + 点外面收起；文本列＝模式三钮+关键字，数字列＝另加最小/最大，日期列＝隐藏模式与关键字、改成两行「年月日时分」）**、按钮文案「去除本列筛选条件」/「去除所有筛选条件」、最小化悬浮球（角标条数、拖动吸边，球 `title` 带版本）、表格上方的「恢复本次导入/清空前的数据」按钮（有快照才出现）、复用式确认条（清空模式＝只清当前频道/全部清空/取消，恢复模式＝确认恢复/取消）、rAF+定时器+可见性三路渲染 + **渲染节流（v1.19.0 P1/P2）：`renderedSig` 指纹没变不碰 DOM；采集任务运行中表格重绘最快 1.5 秒一次（`lastTablePaint`，统计四格仍即时）；收成悬浮球后 `render()` 更新完角标直接 return，`expand()` 清 `renderedSig` 补画**。**面板标题＝`CONFIG.ui.title + ' v' + VERSION`，v1.18.0 起已无「×」卸载入口**
- **数据维护**：`clearAll()` 全清（含 meta，并清 `pendingPersist`）、`removeData(scope)` 按频道清（两者删除前都 `takeSnapshot('clear')`；M6：每个分支只发一条 `flash`）、`takeSnapshot()`（**v1.19.0 改 async，连带捕获 `meta`，三态：对象＝当时值／`null`＝确实没有／`undefined`＝没读到则恢复时不碰 meta**）与 `restoreSnapshot()`（**先 `StorageManager.replaceAll` 落库、成功才动内存；失败原样保住快照并提示可再点一次**；执行前二次确认 `activeTask || ScanManager.isRunning()`）、`jumpToMessage`/`seekPostInChannel`（**M8：循环内每步查 `ScanManager.isRunning()`，采集一开就中断跳转**）页内定位

### 计数语义（用户询问过，勿混淆）

- **总数**：当前频道视图下（由频道下拉决定）去重后的帖子记录数——**不受表头筛选影响**，筛选后另有「匹配 N 条 / 共 M 条」
- **新增**：本次扫描任务新入库的帖子数
- **重复**：累计命中次数——每次扫描屏幕时"任务开始前已知"的帖子逐个 +1，可远大于总数（48 步滚动 ≈235 次属正常）；同时是增量停止依据。**v1.19.0 起空闲补采（`scanCurrentPane(false)`）不计入**，只有采集任务和边滚边采会涨
- **滚动**：本次滚动步数
- **悬浮球角标**＝当前视图「总数」（与面板同口径，不受筛选影响）

### 已实测验证的关键事实（勿凭记忆改动）

- K 版 DOM 三栏：`#column-left`（禁采）/ `#column-center`（唯一采集区）/ `#column-right`
- `data-mid = 真实post_id + 2³²`（实测 4294979839 → 12543）；`data-mid<=0` 排除 service 日期条与广告帖
- 评论链 `bubble.with-replies → .replies-footer-text → .i18n`；浏览量 `time > .post-views`（两处取第一个有数字的，空=关闭）；反应在 `reactions-element .reaction`
- **虚拟列表到顶≠加载完成**：旧消息异步插入需 1~2 秒，边界判定必须"归顶+等待+多轮稳定"
- Telegram 页面 CSS 会重置原生 input/checkbox 外观——面板控件必须自绘
- **祖先上的 `scrollbar-color`/`scrollbar-width` 会让 Chromium 忽略 `::-webkit-scrollbar`**（scrollbar-color 可继承；实测槽宽卡在 15px，删掉标准属性后自定义 8px 才生效）
- 面板 UI/几何改动可用**本地 file:// harness** 实测：写一个含 `#column-center` 的空页面引入脚本，`evaluate_script` 里派发 `PointerEvent`（**必须带 `pointerId: 1`**）模拟拖动/拉伸并量 rect；`take_screenshot` 仍不可用；**2026-10-04 起内置浏览器已有真实布局视口（实测 1161×617），不要再伪造 `innerWidth/innerHeight`**（详见上一条 ③）
- CSV 解析器已用含 BOM/引号/内嵌逗号换行的样例通过
- 所有解析函数曾在真实页面（@changsha_GKB 长沙公开榜）内联运行验证
- **面板空白根因（v1.12.0 修）**：`scheduleRender()` 只有 `requestAnimationFrame`，Chrome 在后台标签不触发 rAF → 期间数据变了但 DOM 没画，用户看到"只有列表空了、且不会自己恢复"。修法＝rAF + 800ms `setTimeout` 双路（先跑的先画）+ `visibilitychange`/`focus` 时 `renderNow()` 强制补画。**harness 里把 `requestAnimationFrame` 换成空函数即可复现**，实测约 1.1s 后列表补画成功
- **harness 实测补充（2026-10-04）**：browser-use 导航会**丢掉 URL 里的 hash**，频道 username 取不到 → 必须在页面内 `location.hash='@testchannel'`；（当时伪造 `innerWidth` 才产生的问题：JS 夹取按 1440 算、CSS `vw` 按真实视口算，两套上限不一致，`max-width:94vw` 会把面板压到 `min-width:250px` —— 这正是 v1.14.0 缩放 bug 的镜像，现在 harness 直接用真实视口，不再伪造）内置浏览器 **file:// 下 IndexedDB 可用**，测试前必须 `indexedDB.deleteDatabase('tg-comment-stats') + localStorage.clear()`，否则会读到上一轮残留记录（曾因此误判正文列混进浏览量）
- **列宽相关实测**：`<col>` 改 width 即时生效（`table-layout:fixed`），拖 84→144、双击自适应 57/588px（canvas `measureText` + 14px 内边距，46~640 夹取）；`min-width:100%` 保证列少时铺满、列多时由 `.tcc-tablewrap` 横向滚动；`th` 用 `position:sticky` 同时充当 `.grip` 的定位父元素（sticky 属于已定位元素），`th` 的 `overflow:hidden` 要求 grip 用 `right:0` 而不是负值
- （2026-10-04 实测，XLSX 代码已回档但结论留着有用）纯前端可不依赖任何库生成 Excel 可开文件：ZIP 用 **store（不压缩）**即可，中央目录固定头 **46 字节**（extra/comment/disk/internal 各 2 字节 + external 4 字节；少写 2 字节会让 Info-ZIP 报 `expected central file header signature not found`）；工作表用 `t="inlineStr"` 可免写 sharedStrings；校验容器可用 Git Bash 自带的 `unzip -t`，无需打开 Excel

## 2. 当前开发阶段

- 原计划 4 阶段 + 全部追加需求（正文、views/时间/反应、模拟滚动、增量、分频道、CSV 导入导出、按钮状态、设置持久化、页内跳转、性能精简、悬停说明、吸附与拉伸）、2026-10-04 的 6 项表格/筛选/最小化/确认/两项 bug 需求（v1.12.0）、序号列（v1.13.0）与 1 修 4 新的交互批次（v1.14.0）**均已实现**
- **当前无进行中任务**：v1.19.0（审查优化）已改完、`node --check` 通过、本地 harness 逐项实测通过，等待用户安装并实测（**装完仍要先「清空数据 → 全部清空」再重新采集**，因为 v1.17.0 的时区口径变更用户尚未执行）；v1.8.0～v1.19.0 用户侧均未回报
- 用户实测确认过的最近版本：v1.1.3（初始化不再提前停止，见当时截图）

### 重要否决记录（勿再提议实现）

- 「数据库只存消息 ID、完整字段仅内存」：实施后被用户要求**还原**（零残留回退），现仍为整条记录持久化
- JSON 格式数据库导出/导入（v1.2.0）：用户要求删除，已删；**勿再主动提议 ID-only 存储或 JSON 备份**
- 后端/Rust/服务器方案：用户明确否决
- 改脚本 `@name`：会令 Tampermonkey 认成新脚本、两条并存重复采集，冻结不改
- **XLSX 导出（曾写到 v1.12.0）**：2026-10-04 实现过完整的 `XLSXExporter`（手写 ZIP store + SpreadsheetML，两个面板按钮），用户随即要求「回档」，已逐条逆改、grep 零残留、`node --check` 通过、行数回到 1303。**做之前没先征求确认，是本可避免的返工**——再次遇到"导出 Excel"类需求先问清格式与是否要做，别直接写码
- **滚屏设置里的「方向」下拉**：v1.5.0 加入、v1.12.0 **按用户决定删除**（「干脆把方向从滚屏设置里删掉，采集本来就该朝历史走」）。别再提议加回来；两个采集任务现在硬编码 `run('up')`
- **「×」关闭整个插件**：v1.12.0 加入、**v1.18.0 按用户要求整条链删除**（`pluginClosed`/`unplug`/`closePlugin` 零残留）。别再提议"关闭插件"或"悬浮重开入口"——用户当时明确「不要留重开入口」，现在连关闭按钮本身也不要了；停止采集只走「停止」/「边滚边采·停」
- **把序号列写进 CSV**：v1.13.0 用户点名「序号栏……**不写入 csv**」。序号列因此**刻意不进 `COLUMNS`**（只在 `buildHead`/`rowHtml` 里硬写），别顺手把它做成一列加进 `HEADER` 或列显隐 chips——那会破坏 CSV 与数据库（导入判重基准）的 10 列格式

### 下一步建议（未开始，仅供决策）

1. 删除废弃文件 `telegram-comment-counter.user.js`
2. 用户安装 v1.14.0 实测：拉右下角缩放是否跟手（4K 小视口下尤其要看）、表头单击排序/双击筛选、筛选小浮窗位置、序号列、悬浮球、关闭卸载、清空确认
3. 可选：时间范围过滤、「重复」改去重帖数、全量模式提前停（见待办）、真实页面上核对正文列的 DOM 结构

## 3. 未完成任务列表

- [ ] 用户安装 **v1.19.0** 实测（**先看标题是不是「Telegram频道分析助手 v1.19.0」**，再看 console 那条「版本号来源」是"油猴 @version"还是"内置兜底"——这条能证实 `@grant none` 下 `GM_info` 到底可不可见，本地只能验到兜底分支）。重点核对本地验不了的四件事：① **已有帖子的数字会被刷新**（找一条浏览量涨过的老帖，采完再看该行浏览量是否变了；正文改动**不会**重读，是 S4=B 的既定代价）；② **增量不再提前停**（M1）——日常「增量采集」应当在真的没有新帖时才停，停止原因应写「已达到历史边界（连续 10 屏帖子都在库里）」；③ **正文列在真实 DOM 里是否混进了评论数/浏览量文案**（harness 结构是我自造的，真实页面若混入需按 DOM 调整 `extractContent` 的剔除选择器）；④ 付费反应那一组的计数对不对（属性名未证实）。另：**装完仍要先「清空数据 → 全部清空」再重新全量采集**，v1.17.0 的时区口径变更用户至今未执行
- [ ] **v1.19.0 交付名**：`Telegram频道分析助手V1.19.0.user.js`（磁盘上 v1.18.0 那个文件名已 `mv` 掉，目录里只剩一份权威文件；`telegram-comment-counter.user.js` 与 `userscript/` 仍是废弃旧文件，待用户确认后删除）。Tampermonkey 里应**编辑原来那一条**、整份替换代码，不要新建脚本（新建＝两条并存重复采集，虽然 v1.19.0 已加 `window.__tccLoaded` 守卫，同页面第二份会自己退出并打 warn）
- [ ] 用户安装 **v1.17.0** 实测：⚠️ **第一步必须「清空数据 → 全部清空」再重新全量采集**（不清就会新旧两种时区的串混在一列）。然后核对：发布时间列与 Telegram 页面显示的时间**一致**、鼠标悬停提示是「北京时间 …」、双击该列表头填的年/月/日/时/分（**按北京时间理解**）能筛到目标帖、拿某帖页面显示的本地时间去筛应当命中、**导出的 CSV 里 `publish_time` 与界面显示完全相同**（不再差 8 小时）；以及 v1.15.0 遗留项：数字列靠左/表头居中/序号居中、日期五档筛选与「留空＝不设限」、两个改名按钮、列可拖到 12px 与序号列可拖窄
- [ ] **时区口径（v1.17.0 定为方案 B1：全链路只有北京时间）**：`data-timestamp`（UTC 秒）在采集端 +8 换成定宽串，此后库/界面/筛选/CSV 用的都是同一串，**代码里没有任何换算层了**（勿再往显示层塞 +8，那会造成二次 +8＝差 16 小时）。**旧 UTC 口径的 CSV 备份全部作废**，若用户拿旧文件来导，先提醒他那批文件是 UTC。若他以后又要求"库里存 UTC、只看北京"＝退回方案 A，属数据格式变更，必须先确认；若他报"时间差 8 小时/差 16 小时"，先问清他有没有在升级后清过库、导过哪一批旧 CSV
- [ ] **v1.12.0～v1.17.0 的表格与交互只在本地 harness（伪造 `#column-center` 气泡）验证过，未在真实 Telegram 页面实测**：真实页面里 `.message` 内部结构更复杂（正文列可能带链接/引用块），若正文列显示异常需按实际 DOM 调整；真实视口缩放比 harness 更极端，缩放跟手一项必须以用户回报为准
- [ ] 筛选条件目前**只在本页会话内有效**（不写 localStorage），刷新即清——这是有意为之（防止用户切回来发现列表被悄悄过滤），若用户要求记住筛选再加
- [ ] **v1.11.0 用的属性名（`data-emoji`/`data-count`/`title`/`aria-label` 等）未在真实页面实测**：内置浏览器进不了用户已登录页，8 个用例是用桩元素在 Node 里跑通的。若某频道反应仍不对，请用户提供一个带反应帖子右键「检查」里 `<div class="reaction" …>` 的起始标签原文，再据实调整属性顺序
- [ ] 跨频道「消息 ID」跳转：`hash = '#@' + channel + '/' + postId` 格式**未经证实**（v1.6.0 猜错过一次）。若用户回报跳不到，先索取「点『打开』后新标签地址栏 URL」作为证据再改，不要猜
- [ ] 完整跑通一次全量（滚到最早帖自动停止并置 `initialized=true`）后未回报
- [ ] 双脚本并存风险：旧连字符文件未删除
- [ ] 贴纸表情显示为 `[表情]`（blob 贴纸无字符可取）——未立项
- [ ] 「重复」计数是否改为去重后的重复帖子数——等用户决定
- [ ] 全量模式停止条件不看 ID，重复跑全量会把整段历史再滚一遍（不重复入库但白跑）；已建议「连续 N 屏 ID 全在库中即提前停」，用户未答复
- [ ] XLSX/Excel 导出：**已实现后按用户要求回档，当前代码里没有**。若用户重新点名要做再开工，动手前先确认两点：① 要真 `.xlsx` 还是「Excel 能打开就行」（CSV 已能满足，且是现行的数据库格式）；② 面板按键现有 **11 个**（含「导出全部」，「排序」按钮已在 v1.14.0 删除），新增按钮是否替换/合并现有导出按钮；③ 新格式是否也要能「导入回库」（CSV 即数据库的判重基准会被分裂）

## 4. 当前代码状态

- **语法检查**：`node --check` 通过（v1.19.0，2276 行）
- **v1.19.0 harness 实测（2026-10-05，file:// + 自造 Web K 骨架；`IDBObjectStore.prototype.put/clear` 打桩抛 `DOMException` 模拟写库失败）**：
  - **通过**：空频道全量 3 步内自停（不再空转 3000 步）且不置 `initialized`；混合新旧帖 `1,234 Comments`→1234、`2.1K views`→2100、`1.2万`→12000、`Leave a comment`→0、`views=abc`→空；普通反应 `👍12 + ❤️3` 与**付费 ✦✦✦（无计数器按连写字符数=3）**合计 18；无/坏 `data-timestamp` →「—」；统计量异步变化（改已有节点的文本，MutationObserver 抓不到）在 ≤6 秒的空闲补采里刷新到位且**正文沿用库里的旧值**（keepContent 生效）、`新增` 不涨；虚拟列表重复渲染（dropPost + 重新 mkPost）不产生重复行；CSV 多行正文+转义引号往返正确、**同一份文件二次导入 `新增0 更新0 跳过4` 幂等**；GBK 与含 2 个 U+FFFD 的文件都整份拒绝且 0 入库；写库失败 → 提示「数据仍在内存，别刷新页面，下轮扫描会自动补写」，恢复闸后**直接查 IndexedDB 确认 501/502 已补落库**；快照恢复在 `clear` 抛错时提示「恢复失败…库和内存都没动，快照还在，可以再点一次恢复」且按钮不消失，重试成功（`已恢复到清空前的 3 条`）+ 刷新后仍在库；异常退出（拆掉 `#column-center`）全量/增量都走「全量失败/增量失败：未找到消息滚动容器」且按钮绿灯熄灭；增量在频道切换后按「已切换频道，本次任务结束」停止、原频道数据不受影响；手动停止/暂停（`pausebtn` 变绿、滚动步数冻结、恢复后继续、停止后复位）；页内跳转命中「已定位到 #802」、不在屏上时「未找到 #703」、采集运行中点跳转被拒；导出（打桩 `createObjectURL`+`a.click` 读回 Blob）首三字节 `EF BB BF`、`text/csv;charset=utf-8`、仍是 10 列且刷新后的数字进得去；连续再注入同一份脚本两次 → `#tcc-panel` 始终只有 1 个；最小化期间 `tbody.innerHTML` 长度冻结而球上角标照常 8→9，展开（`PointerEvent` 带 `pointerId:1`，裸 `click` 不生效）补画出 9 行；面板文本全程不含左侧诱饵内容，`grep column-left|scrollTo(|document.scrollTop` 只剩注释
  - **未实测（只能在真实登录页面判定的项）**：真实 `.message` 内部结构下的正文边界（harness 把回复页脚塞进了 `.message`，所以那里看到的"正文混了 Comments/views"是桩数据的问题，不代表真实行为）、`data-mid` 打包值与 `data-mid<=0` 排除、`.i18n` 真实文案词序、`reactions-element` 真实属性名与付费组 DOM、hash 路由格式、真实虚拟列表的异步挂载节奏
  - **测试坑（新增）**：每次 reload 后 harness 的消息容器是空的，只有重新 `mkPost` 的帖子才"在屏上"——老记录虽然在库/在 `sessionKnown` 里但没渲染，「重复」自然是 0，别误判成补采失效
- **v1.18.0 之前的实测记录见下（仍是有效证据，只是版本号旧）**
- **v1.18.0 harness 实测（2026-10-05，file:// + 4 条假帖 + 左侧诱饵气泡；导入用 `DataTransfer` 造 `File` 塞进隐藏 input，并把 `HTMLInputElement.prototype.click` 打桩避免原生文件框）**：**①「×」链已消失**——`[data-act=close]` 查不到、标题变「Telegram频道分析助手 v1.18.0」、最小化→悬浮球（球 `title` 带 v1.18.0）→pointerdown/up 恢复面板 4 行照常；**版本号兜底路径生效**——页面里 `GM_info` 不存在，console 明确打「版本号来源：代码内置兜底常量」，标题仍显示 v1.18.0；**② 编码嗅探**——手工拼一条 GBK 字节（`D6 D0 CE F1`）的行 → `flash`「导入失败：这份文件不是 UTF-8 编码（多半是表格软件存成了 ANSI/GBK）…」，总数仍 4、列表 ID 一字未变；再喂一条含 1 个 U+FFFD 的合法 UTF-8 → 「这份文件里有 1 处乱码字符，已整份拒绝导入（一条都没写进库）」，同样 0 入库、恢复按钮不出现；**③ 快照与恢复**——导合格的 CSV（新增 #900 + 一条与已有 #101 撞判重的行）→ 总数 4→5、`导入完成：新增1 补全0 跳过1`、按钮出现且文案「恢复本次导入前的数据」、`title` 带快照时间与 4 条；点它 → 确认条打开且「只清当前频道/全部清空」隐藏、「确认恢复」可见 → 点确认 → 总数回 4、#900 消失、按钮隐藏；**直接查 IndexedDB**（另开连接 `getAll`）：导入前 4 键、导入后 5 键、恢复后回到 4 键，回滚真的落库；**清空路径**——点「清空数据」确认条显示的是清空三钮（恢复钮隐藏）、`全部清空` → 总数 0 + 按钮文案「恢复本次清空前的数据」→ 恢复 → 总数 4 且提示「已恢复到清空前的 4 条」；**④ 采集保护**——`全量采集` 运行中点恢复 → 被拒「请先停止采集，再执行恢复」且确认条不打开；等 `ScanManager` 收尾（`[data-act=init]` 绿灯熄灭）后再点 → 确认条正常打开。全程 console 仅 3 条日志、**零报错**
- **v1.17.0 harness 实测（2026-10-05，5 条假帖：给的 `data-timestamp` 全是 UTC 秒——`2026-10-01 00:00`/`2026-10-03 16:00`/`2026-10-03 23:59`/`2026-10-04 16:00`/无时间戳）**：**采集端一次换算到位**——IndexedDB 里存的就是 `2026-10-01 08:00`、`2026-10-04 00:00`（跨日边界 UTC16:00→北京次日 00:00 ✓）、`2026-10-04 07:59`、`2026-10-05 00:00`，无时间戳的仍是空串；**显示＝存储同一串**（单元格文本与 `title`「北京时间 …」逐条相等，无二次 +8）；**日期五档筛选按北京串直接比**——min `2026-10-04`（时/分留空）→ 命中 3 条且**含 `10-04 00:00` 那条端点**、min `10-04 07:59` → 2 条、min `10-04 08:00` → 1 条、只 max `2026-10-04` → 3 条（含 `10-01`，`10-05` 落掉）；**回填**仍是用户填的北京五档；**表头 `.lab` 悬停**＝「…；显示与筛选都是北京时间，CSV 也是」；**排序** desc/asc 正常、空值排在末尾；**数字列筛选不受影响**（评论数最小 10 → 只剩 43/11 两条，`筛选：评论数` 标题正常）；**导出 CSV**：仍 10 列、第 7 列逐条等于界面显示值（不再是 UTC 串）；**导入自己导出的 CSV 往返幂等**——条数仍 5（判重生效）、时间串一字不变（**没有二次 +8**）；**刷新页面**后 5 条时间串不变（无累积偏移）；console 共 3 条日志（含 `v1.17.0 已加载…`）**零报错**
- **v1.16.0 harness 实测（2026-10-05，5 条假帖，UTC 分别 09‑30 15:20 / 10‑01 08:30 / 10‑02 00:00 / 10‑03 23:59 / 无）**：**零迁移验证**——上一版留下的 IndexedDB（5 条 UTC 记录）直接加载，界面即变北京时间，无需清库；**显示换算**——读到 `2026-09-30 23:20`、`10-01 16:30`、`10-02 08:00`、**`10-03 23:59 UTC → 10-04 07:59`（跨日进位）**，空值仍是「—」，`title` 同时给两个口径；**筛选换算**（填的都是北京时间）——min `10-02 08:00` → 命中 #3,#4（**含端点**）；min `10-02 08:01` → 只剩 #4；max `10-01 16:30` → 命中 #1,#2；**只填到「日」** min `10-04` → 命中 #4（北京 10-04 00:00 ＝ UTC 10-03 16:00，那条 UTC 23:59 的帖在范围内 ✓）；**重开小窗回填的仍是用户填的北京五档**（年=2026 月=10 日=4 时/分空），筛选状态未被重开动作清掉；**表头标题**＝「筛选：发布时间（填北京时间）」，表头 `.lab` 悬停说明带「显示北京时间，库里与 CSV 存 UTC」；**排序不变**（publish_time asc 顺序 —, 09‑30, 10‑01, 10‑02, 10‑04，整体 +8h 单调）；**CSV 仍 10 列、第 7 列 `publish_time` 的值仍是 `2026-09-30 15:20` 这种 UTC 串**（导出没被换算污染）；console 3 条日志（v1.16.0）零报错。**注：这一版的换算层已在 v1.17.0 删除，此条仅作历史证据**
- **v1.15.0 harness 实测通过项（2026-10-05，file:// + 5 条假帖子，发布时间跨 2026‑09‑30 ~ 10‑03，最后一条无时间戳）**：**对齐**——`getComputedStyle` 读到 `th` = center、`td.num` = left、`td.rank` = center；**发布时间筛选**——小窗标题「筛选：发布时间」、`fmodes`/`ftext` 均 hidden、`fnums` hidden、`fdates` 显示 10 个输入框（`min.y/mo/d/h/mi` + `max.*`，占位符年/月/日/时/分），窗宽 216、`scrollWidth` 214 不溢出；区间语义逐条验过：min=2026/10/2 → 匹配 2 条（10‑02、10‑03，**无时间戳那条被淘汰**）；max=2026/10/1 8:30 → 匹配含端点的 10‑01 08:30 本身；min 只填到「时=9」→ 08:30 被排除；**大档留空则小档无效**（年空、月 13 → 按「不设限」处理且月被夹到 12）；min=2027 + max=2025 → 匹配 0 条 + 空状态提示 + `flash` 提示语成功显示出来（顺带证明 `flashing` 闸门修好了）；「去除本列筛选条件」把 10 个框全清空、`th.on` 消失、恢复「共 5 条」；**数字列不受影响**（评论数 min=20 → 匹配 4 条，模式按钮与关键字行照常显示）；**列宽**——正文拖到 **12px** 并被夹住、`colgroup` 与 `table.style.width`(510px) 同步、写入 `localStorage.table.widths.content`；**序号列可拖窄**——拖 rank 的 grip：40 → +30 → 70px、再往左拖 40 → **夹在 12px**，`widths.rank` 落盘，双击这根线自适应成 26px（「序」宽 + 14 内边距），**点序号列表头两次既不排序也不弹筛选**（`th` 无 `data-col`）；**刷新后** rank=26px、content=12px 保持，筛选按设计被清空；**CSV 仍 10 列**、无序号、5 行数据；console 3 条日志（v1.15.0）零报错
- **harness 新坑（v1.15.0 发现，测表头双击必踩）**：单击表头会 `render()` → `buildHead()` **重建整个 `<thead>`**，之前缓存的 `th` 变量成了游离节点；在游离节点上派发第二次 `click` 冒泡不到 `theadEl`，**双击永远判不出来**。正确写法是每次点击前重新 `document.querySelector('th[data-col=...]')`（真实用户点的本来就是新节点，所以这不是产品 bug）
- **v1.14.0 harness 实测通过项（2026-10-04，file://）**：**缩放跟手**——拉手 `pointerdown` 后每一步 `style.width/height` 与 `getBoundingClientRect()` 完全相等（旧版在 auto 高度顶到 82vh 时二者分离），继续下拉能从 506px 长到 `innerHeight-top-EDGE`=537px（旧版卡死），松手后 `localStorage.panel` ＝渲染值＝style 值，刷新后三者仍相等；**表头单击循环**——评论数/浏览量/发布时间三列都走 降→升→默认（`post_id:desc`）；**300ms 双击**——第二次点击把 `tableState.sort` 还原成 `publish_time:asc` 快照并弹出小窗（顺带验证：单击后弹窗会改排序，所以撤销是必须的）；**筛选小浮窗**——宽 216px、`left` 与被点表头 `left` 相同（451）、`top`＝表头 `bottom+4`（491），`document.elementFromPoint` 命中的是 `DIV.tcc-fpop`（证明没被面板 `overflow:hidden` 裁掉），文本列不显示 min/max，模式行「同时包含」为 active；**筛选生效**——正文含「长沙」→匹配 2 条且序号重编 1,2，评论数 min=20→匹配 2 条，表头变橙 `th.on`，「总数」不受影响；**全列可隐藏**——含正文列，`colgroup` 只剩 `[40px,46px]`、`table.style.width=86px`、显示提示行，「总数」与导出不受影响，chips 可勾回；**11 个按钮**（已无「排序」）；**默认顺序** `#4,#3,#2,#1,#0`；拖列宽 240→300 并存档、双击 `.grip` 自适应 300→280；最小化→悬浮球角标 46→pointerdown/up 点球展开（裸 `click` 不展开，因为展开写在 `trackPointer` 的 onEnd 里）；关闭后面板/球/小窗都不在 DOM、后续新增气泡不再入库；导出 CSV **仍是 10 列、无序号**，文件名 `testchannel测试频道261004.csv`；console 仅 3 条日志（v1.14.0）、零报错
- **本轮 harness 三个新坑（改几何/交互测试前必读）**：① **后台标签 `setTimeout` 被节流到约 1 秒**，用 `sleep(70)` 隔开两次点击实测间隔 995ms，双击永远判不出来——必须在同一个 `evaluate_script` 里同步连发两次 `click`，别用定时器分隔；② **合成 `PointerEvent` 必须带 `pointerId: 1`**，`setPointerCapture` 对不存在的 pointer 抛 `NotFoundError` 并静默终止拖拽，表现为"拖完 localStorage 里根本没有 `table` 键"；③ 内置浏览器视口已可用真实尺寸（1161×617），**不要再伪造 `innerWidth`**——JS 夹取值与 CSS `vw` 夹取值一旦不是同一个视口，就会出现 rect 1141 / style 1206 的假"不跟手"，误判成 bug 复发
- **序号列 harness 实测（2026-10-04）**：表头读到 `["序","消息ID","评论数↑","浏览量","反应","发布时间","正文",null]`；`colgroup` 宽 `["40px","84px","74px","84px","68px","116px","240px","46px"]`、`table.style.width` 752px；排序切到评论数↓/↑ 与筛选（min=40）后序号都**从 1 重新编号**；点「序」表头不开筛选面板也不改排序（无 `data-col`，拖拽/双击自适应同样跳过）；隐藏一个列后行内单元格数 7、恢复后 8；空状态 `colspan` 8；**导出 CSV 仍是 10 列表头、没有序号**，文件名 `testchannel测试频道261004.csv`；console 仅 3 条日志、无报错
- **本地 harness 实测通过项（2026-10-04，**v1.12.0 时点记录**，file:// + 伪造 innerWidth + PointerEvent；其中「『排序』按钮三档循环」「正文列拒绝隐藏」两点已被 v1.14.0 取代，见上一条）**：5 条假气泡入库（服务消息 `data-mid=-1` 与 `#column-left` 里的诱饵气泡都没被采）；表头 6 列 + 46px 操作列；拖 `.grip` 84→144 且 `table.style.width` 同步 712→772；双击自适应 post_id=57 / content=588 并写入 `localStorage.table.widths`；三模式文本筛选（同时包含=1 条、任意一个=2 条、完整串=1 条，「总数」恒为未筛选值）；数字列 min=40→2 条、min+max=40~50→1 条（空值一律淘汰）；排序箭头 ↓/↑（空值两个方向都排最后）与「排序」按钮三档循环（消息ID↓→评论数↓→评论数↑）；列显隐 chips（隐藏浏览量后 6 个 col、表头同步、正文列拒绝隐藏并提示）；最小化→悬浮球 `display:flex` + 角标＝条数，拖球改位置、点球恢复且列表重画；清空确认条（取消不动数据、只清当前频道后内存与 IndexedDB 同步归零）；「导出CSV」受筛选（2 行）、「导出全部」忽略筛选（5 行），文件名 `testchannel测试频道261004.csv`；rAF 置空后靠定时器兜底补画；点「×」后面板与球都不在 DOM 里、新增气泡与切频道均不再入库、console 无报错；刷新后列宽/显隐/模式/排序全部还原
- **回档校验（2026-10-04 上午，XLSX 那次）**：`grep -i xlsx` 零命中；与回档前备份逐行 diff 确认无附带损失；临时文件已删除
- **已知限制/注意点**：
  - views 为缩写解析（3.5K→3500），±百位级精度损失；用户已知悉
  - **S4=B 的代价（v1.19.0，用户选定的口径）**：已有帖子每轮刷新评论数/浏览量/反应，但**正文沿用库里那一版，页面后来改了正文不会重读**；`1.2K` 一律读成 1200 存进 CSV（纯整数，口径 A）
  - **`publish_time` 入库只认 `"YYYY-MM-DD HH:mm"` 且是真实时刻**（v1.19.0 的 `normTime`）：手工在表格里改成 `2024/10/1`、`10月1日`、`2024-13-99` 这类值，导入时按"没有这一格"处理（`fillFromOld` 会沿用库里的旧值），不会再把 NaN 带进排序和时分区间筛选
  - **写库失败会自动补写**（v1.19.0 `pendingPersist`）：内存先行、每轮扫描带上下一次欠的批次；但**在补写成功之前刷新页面仍会丢那几条**，提示语就是提醒这一点
  - 增量「重复停止数」按屏计数，非严格按帖数
  - 导入 CSV 的行视为"已采集"，其 comment_count 等是导出时点快照，非实时
  - 分频道批量导出依赖浏览器允许多文件下载，首次可能需允许
  - 面板位置尺寸存 localStorage，`w/h` 记录的是写入 style 的值（非 rect），避免每次重载漂 2px 边框
  - 列表一次最多渲染 `rowCap=500` 行（超出显示提示行）；**「总数」格与所有导出不受该上限影响**
  - 数字列筛选会淘汰空值行（无评论数/无浏览量的帖子在设了最小值时不显示）
  - **v1.18.0 起没有「关闭插件」按钮**（整条卸载链已删）；要停采集用「停止」/「边滚边采·停」，要界面消失只能最小化成悬浮球或刷新页面
  - **快照只在内存**（用户点名如此）：刷新页面/关标签后「恢复本次…前的数据」按钮消失，只保留**最近一次**导入或清空；恢复动作在采集任务运行期间会被拒绝
  - `@grant none`：无痕/存储受限时降级内存模式（console 警告）
  - Telegram 改版类名变化需重跑 DOM 实测流程更新选择器

## 5. 项目架构说明

```
Telegram频道分析助手V1.19.0.user.js（单文件 IIFE，零依赖，HTML/CSS 均为 JS 内字符串；v1.19.0 起文件名为此名；`window.__tccLoaded` 守卫使同页第二份注入自动退出）
 ├─ VERSION         v1.19.0：`GM_info.script.version` 优先、硬编码常量兜底（**改版本号时 `@version` 与兜底常量必须同步改**）；标题/悬浮球/加载日志共用
 ├─ CONFIG          常量与可调参数（滚屏两项可 UI 改，其余内部安全上限；rowCap/defaultWidth）
 ├─ Utils           sleep / rand / clampInt / pad2
 ├─ Settings        localStorage tcc-settings-v1（scroll / monitoring / panel / table / orb）
 ├─ COLUMNS + tableState  6 列定义（num/date 标记）+ 列宽/显隐/筛选/模式/排序（saveTable/restoreTable/dateBound/matchFilters）；序号列「序」独立于 COLUMNS（默认 40、可拖到 12，宽度存 widths.rank，仅显示行号，不进 CSV/不参与排序筛选）
 ├─ records(Map) + byChannel(索引) + sessionKnown(Set) + pendingPersist(Set, v1.19.0 S7) + channelFilter + snapshot(v1.18.0 内存快照，v1.19.0 带 meta)
 │                  putRecord() 统一写入（并 dataVersion++ 供渲染指纹），返回是否已存在
 ├─ StorageManager  IndexedDB records+meta；putMany / deleteMany 各一个事务；hasDb()；replaceAll(list, meta) 跨 store 单事务（快照恢复用）
 ├─ MessageParser   右侧聊天区定位 + 7 类字段提取（纯 DOM 读）+ scroller 缓存 + 气泡定位/居中
 │                  v1.19.0：buildRecord(bubble, channel, keepContent) / fillFromOld / statsChanged / parseCompact
 ├─ scanCurrentPane(countDup)  采集核心：data-mid 前置判重 → 新帖 buildRecord；已有帖走 S4=B 刷新数字（正文沿用库里的），statsChanged 为假直接 continue
 │                  → 脏记录 + pendingPersist 合并成 toWrite → hasDb() 为真才 putMany（失败记回 pendingPersist）→ scheduleRender
 ├─ ScrollSimulator 容器内模拟滚动（区间随机 + 双上限 + 暂停；两个任务固定 run('up') 朝历史；停止原因文案「手动停止」）
 ├─ ScanManager     EMPTY_PANE_REASON（空屏 3 轮自停）；runInitial/runIncremental 均 try-catch-finally（S1）+ anchorCh 频道锚点（S2）；
 │                  incremental 判定 allKnown（整屏都在库里）连续 10 次；空屏停止时不置 meta.initialized
 ├─ CSVExporter     exportCSV(channel, ignoreFilter) + 分频道批量（备份语义，永远忽略筛选）+ 导入（decodeCsv 严格 UTF-8 → parseCSV → importCSV(text, onProgress)：parseCompact + normTime + CHUNK=2000 分块写库 + dbError，CSV=数据库）
 ├─ viewRecords / sortRecords / SORT_DEFAULT  当前视图（未筛选）与排序，「总数」与列表分别取数；默认＝{post_id,desc}（表头排序循环的终点）
 ├─ clearAll / removeData(scope) / takeSnapshot(async) / restoreSnapshot   全清 / 按频道清 / 导入·清空前的内存快照（含 meta）与原子一键回退
 ├─ seekPostInChannel / jumpToMessage         页内定位（同频道滚动查找；每步检查 ScanManager.isRunning()）
 └─ UIManager       面板构建 / 几何（拖拽+吸附+拉手拉伸：box-sizing:border-box + uncaps() 解顶，style 值＝渲染值）/
                    表格（序号列+colgroup+拖列宽(最小 12px，序号列也可拖)+双击自适应+所有列可隐藏 chips+两种空状态；表头居中/内容靠左/序号居中）/
                    表头单击排序 cycleSort() 与 300ms 双击 openFilter()/closeFilter()（headTap 快照撤销排序）/
                    216px fixed 筛选小浮窗 .tcc-fpop（文本列=模式+关键字，数字列=最小最大，日期列=两行「年月日时分」）/ 确认条 / 悬浮球 / 11 按钮状态机 /
                    rAF+定时器+visibility 三路渲染 + renderedSig 指纹 + 采集期 1.5s 表格重绘节流 + 悬浮球期间不重建表格（expand 时清指纹）

数据流：MutationObserver(仅 #column-center 内新增 bubble，300ms 防抖) → scanCurrentPane
        空闲补采：setInterval 5s → (ScanManager.isRunning() || document.hidden 时跳过) → scanCurrentPane(false) → 刷新当前屏数字
        任务模式：ScanManager → ScrollSimulator.run('up') → 每步 await scanCurrentPane → 频道锚点/空屏/边界判定
持久流：putMany（脏记录 + 上次欠写的 pendingPersist，一次事务）→ IndexedDB（刷新不丢）；meta 记录 initialized/lastScanTime/lastPostId；内存降级模式不假装写库
界面流：Settings(localStorage) ←→ 面板控件；面板几何与表格状态（列宽/显隐/模式/排序）同库保存
交换流：导出 CSV（BOM 10 列；筛选后可导，另有「导出全部」）←→ 导入 CSV（decodeCsv 先验 UTF-8，非 UTF-8/含乱码整份拒绝 → 按 channel_postId 合并回库；导入前留快照）
```

安全边界（最高优先级，不可违反）：
- 只读已渲染 DOM；禁止 Telegram API / MTProto / Bot API / 抓包 / 模拟登录 / 自动发消息 / 自动加频道
- 只处理 `#column-center`；`#column-left` 会话列表禁止采集分析；不进入评论区/讨论组页面
- 模拟滚动只操作用户自己页面的消息容器（`.bubbles-scrollable`），不访问任何网络

## 6. 下一次继续开发时的操作步骤

1. 打开本文件 + 项目 memory（`project-tg-comment-analyzer.md`）恢复上下文
2. 读 `Telegram频道分析助手V<版本>.user.js` 最新版（以文件为准，勿以对话记忆为准；目录里同时只有一个是权威的，其余是废弃旧文件）
3. 涉及 DOM 选择器/URL 路由格式：先 browser-use `evaluate_script` 在真实页面实测再写码；内置浏览器进不了用户已登录页，必要时向用户索取证据（地址栏 URL、截图）
4. 涉及面板新控件：默认自绘样式，不依赖原生 input/checkbox 外观；滚动区只写 `::-webkit-scrollbar`，别混用 `scrollbar-color/width`
5. UI 几何/布局类改动：用本地 `file://` harness + 派发 `PointerEvent`（`pointerId: 1`）实测；**视口已是真实尺寸，不要再伪造 `innerWidth/innerHeight`**（截图仍不可用；hash 要在页面内设置；测前清 IndexedDB；后台标签 `setTimeout` 会被节流到 ~1s，双击一类的时序判定要在同一段脚本里同步连发）。测完把 `_harness.html` 删掉，别留在项目里
6. 架构性大改（存储模型等）：先给方案等用户确认再动码；**新导出格式/新数据模型这类「格式取舍」需求也要先问一句再做，不要直接写完交付**。用户说「还原/回档」时的流程：先确认回档范围（全部/只撤 UI/只撤逻辑）→ 改前 `cp` 一份临时备份 → 逐条逆编辑 → `grep -i 关键字` 验证零残留 → `diff 备份 现文件` 确认没有附带损失 → `node --check` → 删除临时备份与临时测试文件
7. 增量修改 → `node --check` → 短格式汇报（修改文件/修改内容/测试方法）；**每次都提醒用户重新复制代码进 Tampermonkey**（磁盘更新不等于已安装）；console 前缀 `[频道分析]`，版本号写在加载日志里

## 7. 当前使用的技术方案和重要技术决定

| 决定 | 理由 |
|---|---|
| 纯油猴单文件原生 JS，无后端/Rust/服务器/框架 | 用户明确否决；HTML/CSS 都作为 JS 内字符串，零构建 |
| DOM 解析而非 API | 最高安全约束：不碰私有接口，账号零风险 |
| `data-mid − 2³²` 还原 post_id | 实测得出；直接用 data-mid 会得到错误天文数字 |
| channel 取 URL hash + 顶栏 `.peer-title` | 消息内 t.me 链接是"引用帖"，不代表本频道 |
| IndexedDB 整条记录持久化 | 「只存 ID」重构被用户要求还原，维持现状 |
| **`publish_time` 全链路统一北京时间（v1.17.0，方案 B1）** | 用户先选 A（只改显示/筛选），追问"CSV 改北京时间后再导回来有没有逻辑问题"后改选 B1。**B1 的风险全部来自旧备份**：CSV 里没有时区标记，旧 UTC 文件导回新库会被当成北京时间静默错 8 小时，而判重键 `channel_post_id` 不含时间 → 不报错、条数正常；用户明确**旧 CSV 全部作废**、并用「清空数据＋重新全量采集」代替存量迁移，前提消除后才动手。收益：只剩一个口径（界面＝库＝CSV），换算层整块删掉（-11 行），"导出→导入"天然幂等，定宽串字典序＝时间序所以排序逻辑没改。代价：**不可逆**（北京串存进库就找不回 UTC 原值），以及以后任何写 `publish_time` 的代码都必须沿用同一口径、**严禁在显示层再加 +8**（会差 16 小时） |
| 去重键 `channel_postId` | 分频道天然隔离；虚拟滚动 DOM 复用/重建下唯一稳定 |
| `data-mid` 前置判重，命中且字段齐则不解析正文 | 滚动是热路径，克隆 DOM 解析正文是最贵的一步 |
| 每屏一次 IndexedDB 事务（`putMany`） | 逐条事务在长任务里 IO 开销过大 |
| `byChannel` 频道索引（keys/title/maxId） | 渲染、导出、最大 ID 不再每次全表扫描 |
| 渲染走 `scheduleRender`（rAF + 800ms 定时器兜底）+ `visibilitychange`/`focus` 强制补画 + boot 首屏同步 render | 后台标签 rAF 不触发曾让列表一片空白且不自恢复；三路兜底 + 首屏同步是完整修法 |
| 列表渲染指纹 `dataVersion` + 列/排序/筛选/条数 | 高频扫描下"没变化就不碰 DOM"，避免上万条时反复重写；`putRecord` 一处自增即可覆盖新增/补全 |
| 列表用 `<table>` + `colgroup` 定宽，不用 `<li>` | 用户要「拖动分栏调宽」；`table-layout:fixed` 下改一个 `<col>` 的 width 就即时生效，拖拽期间完全不重建表格 |
| 双击自适应列宽用 canvas `measureText` | 插隐藏探针量 offsetWidth 会强制重排、上千行时极慢；canvas 一次性量完，46~640px 夹取 |
| 「总数」取未筛选视图，列表/导出取筛选结果 | 用户明确要求：筛选是看数据的窗口，不能让人误以为数据变少了 |
| 筛选条件不持久化、匹配模式持久化 | 记住"怎么匹配"是偏好；记住"过滤掉什么"会让下次打开时列表莫名其妙少一半 |
| 导出 CSV 默认走筛选 + 单独「导出全部」按钮 | 用户选的"筛完就导才顺手"，同时保留备份出口 |
| 最小化＝悬浮球（角标条数、可拖吸边）；**「×」关闭插件功能已于 v1.18.0 整条删除** | 用户先要求"关闭后不留重开入口"（v1.12.0 用 `pluginClosed` 全链路拦截实现），v1.18.0 又要求连按钮一起去掉；停止采集统一走「停止」/「边滚边采·停」 |
| 采集任务固定 `run('up')`，删除方向设置 | 「方向」语义曾判反（选「最新消息」却往上滚），且采集本就只该朝历史走 |
| 清空数据走面板内自绘确认条（6 秒自动取消、可只清单个频道） | 不用 `confirm()`（Telegram 页面样式/自动化环境不可靠）；单频道删除用 `deleteMany` 保住其他频道数据 |
| MutationObserver 只挂 `#column-center` | 比 `document.body` 少触发大量无关变更；也符合"永不读左侧"红线 |
| CSV 兼作交换/备份格式（CSV=数据库） | 用户决定：导入按 channel+post_id 识别，作为增量/全量判重基准 |
| 导入冲突策略：不覆盖、只补全缺字段的旧记录 | 信息只增不减，避免旧 CSV 把新数据降级 |
| 分频道批量导出每文件间隔 500ms | 浏览器会拦截连续自动下载 |
| 界面参数与面板几何存 localStorage `tcc-settings-v1` | `@grant none` 下同源可用、无授权弹窗，刷新/切标签不丢 |
| 面板位置用 style.left/top + 靠近 20px 内吸边（留 10px 缝隙） | 用户要求自动吸附；窗口变小后自动拉回可视区防丢失 |
| 拉伸用自绘右下角手柄而非 CSS `resize` | 需可测、可见、并能在拉近边缘时贴住；CSS resize 手柄在深色背景几乎不可见 |
| 按键区 `grid auto-fill minmax(84px,1fr)` + 限高滚动 | 面板变窄自动减列，不撑破布局 |
| 按钮文案：全量采集/增量采集/边滚边采·开停/排序:xxx | 用户要求"按你的想法改"，取直白短名；旧称见版本历史 |
| `@name` 冻结不改（仍为「Telegram 评论统计助手」） | Tampermonkey 按 name+namespace 认脚本，改名会变两条并存、重复采集 |
| 面板控件自绘样式，不用原生 checkbox/input 外观 | Telegram 全局 CSS 重置原生控件（v1.1.2 教训） |
| 按钮绿色语义：持续性=任务运行期间常亮；复位性=按下闪 350ms | 用户明确要求的交互约定 |
| 模拟滚动只动 `.bubbles-scrollable` | `window.scrollTo` 在 K 版无效且越界；实测该容器为真实滚动节点 |
| 随机步长/间隔区间 + 10% 阅读停顿，双上限兜底 | 拟人化浏览节奏，maxRuntime/maxSteps 防失控 |
| 增量停止依据 `sessionKnown` | 区分"本次任务前已知"与"本次新采"，避免误停 |
| 全量到顶判定：归顶 + 等 2s + 最小 ID 连续 5 轮稳定 | v1.1.3：虚拟列表异步加载导致"假稳定"误停 |
| 表情反应：属性优先、textContent 兜底 | 文本里混零宽字符/换行且与计数挤在一起；属性（`data-emoji`/`data-count` 等）给出干净值。用户明确要求不允许只依赖 textContent |
| `title/aria-label` 需「短且无空格无数字」才采信 | 这两个属性可能是"Hans、Anna 和其他 12 人赞了"这类长句，直接当表情名会污染 CSV |
| 页内跳转：同频道用容器滚动查找，跨频道才走 hash 路由 | 实测 `#@channel/id` 格式不可靠（猜翻过一次） |
| 导出格式只有 CSV，不做 XLSX | 2026-10-04 完整实现过手写 xlsx（ZIP store + SpreadsheetML）并被用户要求回档；CSV 带 BOM 已能在 Excel 打开，且 CSV 同时充当数据库，多一个格式会分裂判重基准 |
| 导入前用 `TextDecoder('utf-8',{fatal:true})` 严格解码 + U+FFFD 计数，任一不合格**整份拒绝**（v1.18.0） | 2026-10-05 实际翻车：用户用 Excel/WPS 另存成 ANSI(GBK) 的 CSV 回灌，中文正文全变 U+FFFD；乱码行"正文非空"，之后再导正确文件也会被判重跳过，只能清库。所以选择拒绝而不是尽力解析（GBK 解码需要 gb18030 表，且用户拿到的正确文件本就该是 UTF-8） |
| 快照只存内存、只留最近一次，恢复复用确认条、采集运行期拒绝（v1.18.0） | 用户逐条点名：不要落盘、刷新即失效、按钮叫「恢复本次导入前的数据」、清空也纳入、边采边回滚要挡住 |
| 版本号 `GM_info.script.version` 优先 + 硬编码常量兜底（v1.18.0） | 用户要求"复制进油猴保存后自动识别版本并显示在标题"。`@grant none` 下 `GM_info` 是否可见我无法本地验证（harness 只能验到兜底分支），故双保险并在 console 打出来源 |
| 交付文件名跟随 UI 标题与版本号（`Telegram频道分析助手V1.18.0.user.js`） | 用户点名"文件名跟着改成一致"。脚本内部标识（`@name`/DB 名/localStorage 键/CSS 前缀）一律不动，避免被 Tampermonkey 判成新脚本 |
| CSV 带 BOM + 全字段转义；文件名 `{channel}{channel_title}{YYMMDD}.csv` | Excel 中文不乱码；用户指定的命名，过滤 Windows 非法字符 |
| 正文保留换行、媒体只留 `[媒体]` | 用户要求保留原格式、不保留媒体文件 |
