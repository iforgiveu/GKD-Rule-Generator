// ==UserScript==
// @name         GKD Snapshot 规则生成器
// @namespace    https://i.gkd.li/
// @version      1.22.3
// @description  在 i.gkd.li 快照页添加：🔆 生成规则复制到剪贴板；🔰 粘贴进所在 app-panel 的编辑框；❌ 清空该编辑框；🔱 切换 text/desc 匹配模式 + fastQuery 开关 + 仅生成 rule 项开关 + 🔀 关系选择器锚点（目标恒在末尾，跨树上/下索引）+ 📐 弱目标几何约束开关 + 💭 GKD 匹配符与参数教程 + 📏 position 生成器 + 📍 初始锚点（固定链路起点并高亮）；⚡ v1.22：fastQuery 开启时若目标不可快速查询，自动反转链路——@目标在前、以可快速查询的亲属锚点（vid/id/text，📍 固定锚点优先）收尾作为快速查询入口；🔧 v1.22.1：📍 已设置时 fq 反转绝不自动搜索顶替；🔧 v1.22.2：📍 跨树关系时先尝试整链反转（@目标在前、锚点收尾当 fq 入口，关系符逐段互换：<n⇄>、+(m)⇄-(m)、>K 展开逐级 <n），反转不可行才回退 📍 正向跨树链；🔧 v1.22.3：修复 buildFqCrossChain ③ 段末位与锚点之间漏写 > 关系符的 bug（k≥1 时以 ' > ' 连接锚点，k=0 时 hop 后直接追加）
// @match        https://i.gkd.li/snapshot/*
// @match        https://i.gkd.li/i/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BTN_ID = 'gkd-rule-gen-btn'; // 🔆
  const BTN_PASTE_ID = 'gkd-rule-paste-btn'; // 🔰
  const BTN_CLEAR_ID = 'gkd-rule-clear-btn'; // ❌
  const BTN_MODE_ID = 'gkd-rule-mode-btn'; // 🔱
  const BTN_HELP_ID = 'gkd-rule-help-btn'; // 💭
  const BTN_GEO_ID = 'gkd-rule-geo-btn'; // 📏
  const BTN_ANCHOR_ID = 'gkd-rule-anchor-btn'; // 📍
  const ANCHOR_HL_CLS = 'gkd-anchor-highlight'; // 📍 锚点高亮类

  /* ════════════════════════════════════════════════════════════
     ★ 单一状态源（v1.20 核心重构）★
     「是否选中了树节点」是全局唯一状态（selReady），全脚本只有
     updateSelState() 一处读取它；🔆/🔰/📏 三个生成按钮的可用性
     全部由 refreshAll() 消费这一个变量统一设置，任何按钮内部
     不再各自检测，彻底杜绝多套检测互相冲突 / 时机错乱：
       - MutationObserver 触发 injectAll → refreshAll（rAF 防抖）
       - 点击树节点 / 快照图 / 属性表后延迟补刷两次（属性表异步
         渲染完成后状态必然刷新，按钮不会卡在错误状态）
       - 按钮点击处理器开头再实时调一次 updateSelState()，显示
         状态与实际执行永远一致
     ════════════════════════════════════════════════════════════ */
  let selReady = false; // 唯一状态：当前是否选中了带属性表的树节点

  function updateSelState() {
    selReady = !!readProps();
    return selReady;
  }

  /* 📍 固定初始锚点状态（会话内有效）：
     { nodeId, depth, name, tail, childCount,
       chain: [锚点的祖先链快照，由近及远]，供跨树链路构建使用 } */
  let anchorState = null;

  /* ---------------- 工具函数 ---------------- */

  // 表格里的值是渲染后的字符串，需要还原成真实类型
  function parseVal(raw) {
    if (raw == null) return null;
    const t = raw.trim();
    if (t === '' || t === 'null') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  }

  // 转义 GKD 选择器普通字符串里的特殊字符（双引号包裹）
  function esc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // 转义 GKD 反引号正则字符串里的特殊字符（正则模式用）
  function escBacktick(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  }

  /* ---------------- 匹配模式 + fastQuery + ruleOnly + relation + geo 开关（🔱 记忆） ---------------- */

  const MODE_KEY = 'gkd_match_mode_v1';

  // 支持的模式：op 是 GKD 操作符，label 是菜单显示，tip 是简短说明
  const MODES = [
    { key: 'exact', op: '', label: '精确 =', tip: '完全等于' },
    { key: 'contains', op: '*', label: '包含 *=', tip: '包含该文本' },
    { key: 'startsWith', op: '^', label: '前缀 ^=', tip: '以该文本开头' },
    { key: 'endsWith', op: '$', label: '后缀 $=', tip: '以该文本结尾' },
    { key: 'regex', op: '~', label: '正则 ~=', tip: 'Java 正则匹配' },
  ];

  // 🔀 关系选择器模式
  // ⚡ 设计原则：所有模式目标属性选择器恒定放在选择器末尾（无需 @ 标记）——
  // GKD 默认取最后一个属性选择器为目标；目标自带 vid/text 时末尾即快速查询入口
  // （官方 optimize 文档：以「末尾属性选择器的第一个表达式」为入口）：
  //   prev:  锚点 +(n) 目标 A +(an+b) B : A.index = B.index-(an+b)
  //   next:  锚点 -(n) 目标 A -(an+b) B : A.index = B.index+(an+b)
  //   vert:  锚点 > 强中间 >K 目标 : A 是 B 的祖先
  //   desc:  锚点 <n / <<n 目标 A <(m) B : A 是 B 的直接子节点且 A.index=m-1
  //          （裸 < 仅匹配首个子节点，任意位置须写 <n）
  // 跨树追踪（v1.15 拆分为上/下索引两方向）：目标全链无特征、但旁支子树里
  // 存在强节点时，以旁支强锚点开头、目标恒收尾，上下行代差任意：
  //   crossUp:   强锚点 <n 弱中间… <n a +(m) 挂载b >K 目标（a 是 b 的兄，前旁支）
  //   crossDown: 强锚点 <n 弱中间… <n a -(m) 挂载b >K 目标（a 是 b 的弟，后旁支）
  // a 是强锚点的祖先/自身，b 是目标的祖先/自身，a 与 b 互为兄弟；
  // m 为兄弟间隔（中间夹的 x/y 兄弟也计入，其子树强节点同样可作候选）；
  // 弱目标时 fastQuery 被静默忽略（回退普通遍历，不报错），链本身完全有效
  // ⚡ v1.22：fastQuery 开启且目标不可快速查询时，改走「反转链路」逻辑
  //（@目标在前、fq 锚点收尾），不再强制目标在末尾，见 tryApplyFqEnd；
  // 🔧 v1.22.1：📍 已设置时 fq 反转的自动搜索被禁用，📍 意图永远最高优先
  // 🔧 v1.22.2：📍 跨树关系时先尝试整链反转成 fq 收尾（buildFqCrossChain），
  // 反转不可行才回退 📍 正向跨树链（目标收尾），fastQuery 静默忽略
  // 🔧 v1.22.3：修复 buildFqCrossChain ③ 段末位与锚点之间漏写 > 的 bug
  const RELATION_MODES = [
    { key: 'off', label: '❌ 关闭', tip: '不加关系锚点' },
    { key: 'auto', label: '🤖 自动兜底', tip: '无法定位时附加（空 text 触发且保留为约束）' },
    { key: 'prev', label: '⬅️ 前兄弟锚点', tip: '锚点 +(n) 目标' },
    { key: 'next', label: '➡️ 后兄弟锚点', tip: '锚点 -(n) 目标（目标在末尾）' },
    { key: 'parent', label: '⬆️ 祖先锚点', tip: '锚点 > 强中间 >K 目标' },
    { key: 'crossUp', label: '🔀 跨树·上索引（兄侧）', tip: '前旁支强锚点 +(m) 跳兄弟，目标在末尾' },
    { key: 'crossDown', label: '🔀 跨树·下索引（弟侧）', tip: '后旁支强锚点 -(m) 跳兄弟，目标在末尾' },
    { key: 'desc', label: '⬇️ 后代锚点', tip: '锚点 <n / <<n 目标（目标在末尾）' },
  ];

  // 默认：text 精确，desc 精确，fastQuery 开启，仅生成 rule 项关闭，关系锚点关闭，几何约束关闭
  let matchMode = { text: 'exact', desc: 'exact' };
  let fastQueryOn = true;
  let ruleOnlyOn = false;
  let relationMode = 'off';
  let geoOn = false;

  function loadMode() {
    try {
      const raw = localStorage.getItem(MODE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          if (MODES.some(m => m.key === saved.text)) matchMode.text = saved.text;
          if (MODES.some(m => m.key === saved.desc)) matchMode.desc = saved.desc;
          if (typeof saved.fastQuery === 'boolean') fastQueryOn = saved.fastQuery;
          if (typeof saved.ruleOnly === 'boolean') ruleOnlyOn = saved.ruleOnly;
          if (RELATION_MODES.some(m => m.key === saved.relation)) relationMode = saved.relation;
          if (typeof saved.geo === 'boolean') geoOn = saved.geo;
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  function saveMode() {
    try {
      localStorage.setItem(MODE_KEY, JSON.stringify({
        ...matchMode,
        fastQuery: fastQueryOn,
        ruleOnly: ruleOnlyOn,
        relation: relationMode,
        geo: geoOn,
      }));
    } catch (e) { /* 忽略 */ }
  }

  // 根据模式生成 text/desc 匹配表达式
  function buildMatchExpr(attr, value, modeKey) {
    const mode = MODES.find(m => m.key === modeKey) || MODES[0];
    if (mode.op === '~=') {
      // 正则模式：GKD 使用反引号包裹 Java 正则字符串
      return `[${attr}~=\`${escBacktick(value)}\`]`;
    }
    return `[${attr}${mode.op}="${esc(value)}"]`;
  }

  /* ---------------- 选中节点统一检测（唯一入口，v1.21） ---------------- */
  // 被选中的树节点恒带 .n-tree-node--selected，所有检测/读取一律走这里，
  // 避免各处重复 document.querySelector 造成状态口径不一致
  function getSelectedNodeEl() {
    return document.querySelector('.n-tree-node--selected');
  }
  function getSelectedNodeId() {
    return getSelectedNodeEl()?.dataset?.nodeId ?? null;
  }

  /* ---------------- 读取属性表 ---------------- */

  // 解析单张属性表 → props 对象
  function parseTable(table) {
    if (!table) return null;
    const props = {};
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 2) return;
      const k = tds[0].innerText.trim();
      if (!k) return;
      props[k] = parseVal(tds[1].innerText);
    });
    return props.name ? props : null;
  }

  // 页面可能同时存在多张属性表（当前节点 + 其他节点），
  // 按表内 _id 字段与 nodeId 精确匹配，不依赖表顺序
  function readPropsFor(nodeId) {
    if (nodeId == null) return null;
    for (const tb of document.querySelectorAll('table.n-table')) {
      const p = parseTable(tb);
      if (p && String(p._id) === String(nodeId)) return p;
    }
    return null;
  }

  function readProps() {
    const sel = getSelectedNodeEl(); // ⚡ v1.21：统一走选中节点入口
    const p = sel ? readPropsFor(sel.dataset.nodeId) : null;
    if (p) return p;
    return parseTable(document.querySelector('table.n-table'));
  }

  // ---- 🔀 异步锚点属性解析（模拟点击 → 等表刷新 → 读 → 还原选中） ----
  function clickTreeNode(el) {
    el.querySelector('.n-tree-node-content')?.click();
  }

  // 轮询等待某 nodeId 的属性表出现（超时返回 null）
  async function waitPropsFor(nodeId, timeout = 1500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const p = readPropsFor(nodeId);
      if (p) return p;
      await new Promise(r => setTimeout(r, 40));
    }
    return null;
  }

  // 依次点击 infos 里的节点读取真实属性，结束后还原原选中节点
  // 返回 Map<String(nodeId) → props>；失败的节点不在 Map 里（调用方回退 OR 兜底）
  async function resolveNodeProps(infos) {
    const out = new Map();
    if (!infos || !infos.length) return out;
    const sel = getSelectedNodeEl();
    toast('🔍 正在读取锚点节点属性…', 'warn');
    try {
      for (const info of infos) {
        if (info?.nodeId == null) continue;
        const el = document.querySelector(
          `.n-tree-node[data-node-id="${CSS.escape(String(info.nodeId))}"]`
        );
        if (!el) continue;
        clickTreeNode(el);
        const p = await waitPropsFor(info.nodeId);
        if (p) out.set(String(info.nodeId), p);
      }
    } finally {
      // 还原选中态（尽力而为，不阻塞结果）
      if (sel && document.body.contains(sel)) {
        clickTreeNode(sel);
        await waitPropsFor(sel.dataset.nodeId, 600);
      }
    }
    return out;
  }

  /* ---------------- 🔀 树结构解析 v7（跨树上/下索引 + 模拟点击精确归属 + 弱节点折叠） ---------------- */

  // GKD 节点简写名必须是合法标识符
  const IDENT_RE = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

  // 解析树节点标签："RelativeLayout [2] : splash_root" → { name, childCount, tail }
  // tail 是 vid / 完整 id / desc / text 之一（显示优先级 desc > vid > id，
  // 归属需通过异步点击读属性表确认）；[n] 是 childCount（≥2 才显示）
  function parseNodeLabel(text) {
    const t = String(text || '').trim();
    if (!t) return { name: '', childCount: null, tail: null };
    let name = t, tail = null;
    const sep = t.indexOf(' : ');
    if (sep >= 0) {
      tail = t.slice(sep + 3).trim();
      name = t.slice(0, sep).trim();
    } else {
      const m2 = t.match(/:\s(.+)$/);
      if (m2) {
        tail = m2[1].trim();
        name = t.slice(0, m2.index).trim();
      }
    }
    let childCount = null;
    const m3 = name.match(/\[(\d+)\]$/);
    if (m3) {
      childCount = Number(m3[1]);
      name = name.slice(0, m3.index).trim();
    }
    return { name, childCount, tail };
  }

  // 树节点深度（缩进层数，排除叶子连接线）
  function treeNodeDepth(el) {
    return el.querySelectorAll('.n-tree-node-indent:not(.n-tree-node-indent--is-leaf)').length;
  }

  function nodeToInfo(el) {
    return {
      nodeId: el?.dataset?.nodeId ?? null,
      depth: el ? treeNodeDepth(el) : null,
      ...parseNodeLabel(el?.querySelector('.n-tree-node-content__text')?.innerText || ''),
    };
  }

  // 锚点表达式是否含强定位属性（vid/id/text/desc）
  // 仅节点简写 / [childCount=n] / [visibleToUser=true] / [index=n] 均视为弱定位
  // 注意：OR 兜底表达式 [vid="x" || text="x" || desc="x"] 开头是 [vid=，仍判强
  function isStrongExpr(expr) {
    return /\[(?:vid|id|text|desc)[!~^$*|]?=/.test(expr || '');
  }

  // 同名兄弟检测（同步扫 DOM，零点击开销）：选中节点左右同深度邻居里
  // 是否存在相同 name 的节点 —— 有才说明这个弱目标在兄弟间真的有歧义，
  // 此时几何约束（width/height）才值得追加（v1.18 精简门槛）
  function hasSameNameSibling() {
    const sel = getSelectedNodeEl(); // ⚡ v1.21：统一走选中节点入口
    if (!sel) return false;
    const nodes = [...document.querySelectorAll('.n-tree-node')];
    const i = nodes.indexOf(sel);
    if (i < 0) return false;
    const d = treeNodeDepth(sel);
    const myName = parseNodeLabel(sel.querySelector('.n-tree-node-content__text')?.innerText || '').name;
    if (!myName) return false;
    const nameOf = (el) => parseNodeLabel(el.querySelector('.n-tree-node-content__text')?.innerText || '').name;
    for (let j = i - 1; j >= 0; j--) {
      const dj = treeNodeDepth(nodes[j]);
      if (dj < d) break;
      if (dj === d && nameOf(nodes[j]) === myName) return true;
    }
    for (let j = i + 1; j < nodes.length; j++) {
      const dj = treeNodeDepth(nodes[j]);
      if (dj < d) break;
      if (dj === d && nameOf(nodes[j]) === myName) return true;
    }
    return false;
  }

  // 收集选中节点的完整上下文（在锚点解析点击前快照，不受后续点击影响）：
  //   ancestors —— 祖先链，由近及远（[0] 是父节点）
  //   prevSiblings / nextSiblings —— 全部前/后兄弟，由近及远
  //   descendants —— 全部后代（DOM 顺序≈深度先序，由近及远）
  // 注：左侧树是 naive-ui 虚拟列表，滚出视口的节点不在 DOM 里；
  // 祖先在选中节点上方基本总可见，折叠的子树会使后代拿不全
  function getTreeContext() {
    const sel = getSelectedNodeEl(); // ⚡ v1.21：统一走选中节点入口
    if (!sel) return null;
    const nodes = [...document.querySelectorAll('.n-tree-node')];
    const selIdx = nodes.indexOf(sel);
    if (selIdx < 0) return null;
    const selDepth = treeNodeDepth(sel);
    // 祖先链：从选中节点向上逐级收集（遇虚拟列表截断即停）
    const ancestors = [];
    let expect = selDepth - 1;
    for (let i = selIdx - 1; i >= 0 && expect >= 0; i--) {
      const d = treeNodeDepth(nodes[i]);
      if (d === expect) {
        ancestors.push(nodeToInfo(nodes[i]));
        expect--;
      } else if (d < expect) break;
    }
    // 全部前兄弟（由近及远）
    const prevSiblings = [];
    for (let i = selIdx - 1; i >= 0; i--) {
      const d = treeNodeDepth(nodes[i]);
      if (d < selDepth) break;
      if (d === selDepth) prevSiblings.push(nodeToInfo(nodes[i]));
    }
    // 全部后兄弟（由近及远）
    const nextSiblings = [];
    for (let i = selIdx + 1; i < nodes.length; i++) {
      const d = treeNodeDepth(nodes[i]);
      if (d < selDepth) break;
      if (d === selDepth) nextSiblings.push(nodeToInfo(nodes[i]));
    }
    // 全部后代（由近及远）
    const descendants = [];
    for (let i = selIdx + 1; i < nodes.length; i++) {
      const d = treeNodeDepth(nodes[i]);
      if (d <= selDepth) break;
      descendants.push(nodeToInfo(nodes[i]));
    }
    return {
      self: nodeToInfo(sel),
      selfDepth: selDepth,
      ancestors, prevSiblings, nextSiblings, descendants,
    };
  }

  // 把树节点信息转成锚点选择器
  // props 来自异步点击读取的真实属性表（可能为 null）：
  //   有 props → 精确归属：vid > desc/text（与 tail 比对确认）> 完整 id
  //   无 props → 标签启发式兜底：android:id/ 系统id 可确定；其余 OR 连接
  //     vid/text/desc（属性为 null 时 [x="..."] 为 false，OR 不会误命中；
  //     锚点不在末尾，不影响 fastQuery 资格）
  function buildAnchorExpr(info, props) {
    if (!info) return null;
    const parts = [];
    let shortName = '';
    if (info.name) {
      const tail = String(info.name).split('.').pop();
      if (IDENT_RE.test(tail)) shortName = tail;
      else parts.push(`[name="${esc(info.name)}"]`);
    }
    const t = info.tail;
    if (t) {
      if (props) {
        if (props.vid) parts.push(`[vid="${esc(props.vid)}"]`);
        else if (props.desc != null && String(props.desc) === t) parts.push(`[desc="${esc(props.desc)}"]`);
        else if (props.text != null && String(props.text) === t) parts.push(`[text="${esc(props.text)}"]`);
        else if (props.id) parts.push(`[id="${esc(props.id)}"]`);
        else parts.push(`[vid="${esc(t)}" || text="${esc(t)}" || desc="${esc(t)}"]`);
      } else if (/^android:id\//.test(t)) {
        parts.push(`[id="${esc(t)}"]`);
      } else {
        parts.push(`[vid="${esc(t)}" || text="${esc(t)}" || desc="${esc(t)}"]`);
      }
    } else if (info.childCount >= 2) {
      // 裸布局锚点：树标签 [n] 即 childCount（≥2 才显示），用于收敛
      parts.push(`[childCount=${info.childCount}]`);
    }
    const expr = (shortName || '') + parts.join('');
    return expr || null;
  }

  // 路径折叠成选择器链：seq[0] 为起点，seq[1..] 全部视为中间节点
  // 强中间节点（含 vid/id/text/desc）保留，弱中间节点合并进精确深度间隔 >K
  // 输出：startExpr >[k] 强mid ... >[finalGap] endExpr
  // ⚡ 性能说明：逐级与跨代的验证开销都在 O(depth) 量级（指针逐级核对），
  // 真正的开销大头是快速查询入口的候选数量，因此按精确性/健壮性选择折叠策略
  function collapseChain(seq, startExpr, endExpr, propsMap) {
    const kept = [];
    let skipped = 0;
    for (let i = 1; i < seq.length; i++) {
      skipped++;
      const mid = buildAnchorExpr(seq[i], propsMap?.get(String(seq[i].nodeId)));
      if (mid && isStrongExpr(mid)) {
        kept.push({ gap: skipped, expr: mid });
        skipped = 0;
      }
    }
    const finalGap = skipped + 1;
    let out = startExpr;
    for (const k of kept) out += (k.gap === 1 ? ' > ' : ` >${k.gap} `) + k.expr;
    out += (finalGap === 1 ? ' > ' : ` >${finalGap} `) + endExpr;
    return out;
  }

  // 🔀 依据 relationMode 生成带锚点的表达式，失败返回 null
  // 所有模式目标属性选择器恒在末尾（无需 @）：
  //   prev:  锚点 +(n) 目标
  //   next:  锚点 -(n) 目标
  //   vert:  远锚点 >[k] 强中间... >[K] 目标（链完整）；锚点 >n 目标（断链退化）
  //   desc:  锚点 <n 目标（直接子级）；锚点 <<n 目标（任意层级子孙）
  //   crossUp/crossDown: 强锚点 <n 弱中间… <n a ±(m) 挂载b >K 目标（v1.15）
  // ⚡ 锚点属性通过模拟点击读取（resolveNodeProps），读不到时回退 OR 兜底
  async function tryApplyRelation(baseExpr, p, hasRealDistinction) {
    if (relationMode === 'off' || !baseExpr) return null;

    // 🤖 自动兜底：目标存在真正可定位的辨别项（vid/id/非空 text/非空 desc）时不加锚点；
    // 仅有 [text=""] 这类空字符串"辨别项"时视为不可定位，仍触发附加
    if (relationMode === 'auto' && hasRealDistinction) return null;

    const ctx = getTreeContext(); // 点击前快照，后续点击不影响 ctx
    if (!ctx) return null;

    // 父节点需与属性表 _pid 交叉校验，防止虚拟列表截断导致认错父级
    const parentValid = (info) => info && (info.nodeId == null || p._pid == null || String(info.nodeId) === String(p._pid));

    // ⬅️ 前兄弟：锚点 +(n) 目标 —— 官方语义 A +(an+b) B : A.index = B.index-(an+b)，
    // 即锚点在目标前面第 n 个；优先找最近的带可区分 tail 的兄弟
    const prevAnchor = async () => {
      const pick = ctx.prevSiblings.find(s => s.tail);
      if (!pick) return null;
      const gap = ctx.prevSiblings.indexOf(pick) + 1;
      const pm = await resolveNodeProps([pick]);
      const a = buildAnchorExpr(pick, pm.get(String(pick.nodeId)));
      if (!a) return null;
      return gap === 1 ? `${a} + ${baseExpr}` : `${a} +(${gap}) ${baseExpr}`;
    };

    // ➡️ 后兄弟：锚点 -(n) 目标 —— 官方语义 A -(an+b) B : A.index = B.index+(an+b)，
    // 即锚点在目标后面第 n 个，目标天然位于末尾
    // （v1.8~v1.11 写成「目标 -(n) 锚点」，方向颠倒导致选择器永不命中，v1.12 修正）
    const nextAnchor = async () => {
      const pick = ctx.nextSiblings.find(s => s.tail);
      if (!pick) return null;
      const gap = ctx.nextSiblings.indexOf(pick) + 1;
      const pm = await resolveNodeProps([pick]);
      const a = buildAnchorExpr(pick, pm.get(String(pick.nodeId)));
      if (!a) return null;
      return gap === 1 ? `${a} - ${baseExpr}` : `${a} -(${gap}) ${baseExpr}`;
    };

    // ⬆️ 祖先：远锚点 >[k] 强中间... >[K] 目标（目标在末尾当快速查询入口）
    const vertAnchor = async () => {
      if (!ctx.ancestors.length) return null;
      let pick = ctx.ancestors.findIndex(x => x.tail);
      if (pick < 0) pick = 0;
      const info = ctx.ancestors[pick];
      if (pick === 0) {
        // 直接父节点
        if (!parentValid(info)) return null;
        const pm = await resolveNodeProps([info]);
        const a = buildAnchorExpr(info, pm.get(String(info.nodeId)));
        return a ? `${a} > ${baseExpr}` : null;
      }
      // 直接父节点与属性表 _pid 对不上 → 链不可信，退化为任意祖先匹配
      if (!parentValid(ctx.ancestors[0])) {
        const pm = await resolveNodeProps([info]);
        const a = buildAnchorExpr(info, pm.get(String(info.nodeId)));
        return a ? `${a} >n ${baseExpr}` : null;
      }
      // 祖先链在可视范围内总是连续的（虚拟列表只会在顶部截断），
      // 生成精确路径：远锚点 >[k] 强中间... >[K] 目标
      const seq = [info, ...ctx.ancestors.slice(0, pick).reverse()];
      const pm = await resolveNodeProps(seq.filter(x => x.tail));
      const a = buildAnchorExpr(info, pm.get(String(info.nodeId)));
      if (!a) return null;
      return collapseChain(seq, a, baseExpr, pm);
    };

    // ⬇️ 后代：锚点 <n / <<n 目标 —— 官方语义 A <(m) B : A 是 B 的直接子节点且
    // A.index = m-1（裸 < 仅匹配首个子节点，任意位置须写 <n）；
    // A <<n B : A 是 B 的任意层级后代；目标天然位于末尾
    // 快速查询入口恒为末尾选择器：目标强则查目标
    const descAnchor = async () => {
      const pick = ctx.descendants.find(s => s.tail);
      if (!pick) return null;
      const pm = await resolveNodeProps([pick]);
      const a = buildAnchorExpr(pick, pm.get(String(pick.nodeId)));
      if (!a) return null;
      const direct = pick.depth === ctx.selfDepth + 1;
      return direct ? `${a} <n ${baseExpr}` : `${a} <<n ${baseExpr}`;
    };

    // 🔀 跨树追踪锚点（v1.15 拆分为上/下索引两方向）：目标自身及其全链
    // 祖先均无特征、但旁支子树（目标某祖先的兄弟的后代）里存在带特征强节点时，
    // 以旁支强锚点开头、目标恒定收尾（无需 @，与其它模式风格统一）：
    //   上索引（兄侧）：强锚点 <n 弱中间… <n a +(m) 挂载b >K 目标
    //   下索引（弟侧）：强锚点 <n 弱中间… <n a -(m) 挂载b >K 目标
    // a 是强锚点的祖先/自身，b 是目标的祖先/自身，a 与 b 互为兄弟；
    // m 为兄弟间隔（axbyc 里夹的 x/y 兄弟计入 m，其子树强节点同样可作候选）。
    // ⚡ 上行段因 GKD 无多层 < 语法逐级列出 <n；下行段弱中间折叠为精确深度 >K；
    // a/b 兄弟关系经点击读取双方属性表 _pid 交叉校验，index 复核方向
    // （DOM 序号被虚拟列表截断算错时弃选换次优候选）；
    // 弱目标时 fastQuery 被静默忽略（回退普通遍历，不报错），链完全有效
    const crossTreeAnchor = async (dir) => {
      // 目标直接父级需与属性表 _pid 对得上（下行段层数可信的前提）
      if (ctx.ancestors.length && !parentValid(ctx.ancestors[0])) return null;

      // 在当前渲染的树上重建扁平节点序列（跨树配对需要全局视野）
      const nodes = [...document.querySelectorAll('.n-tree-node')];
      if (!nodes.length) return null;
      const infos = nodes.map(nodeToInfo);
      const idxById = new Map();
      nodes.forEach((el, i) => {
        const id = el?.dataset?.nodeId;
        if (id != null) idxById.set(String(id), i);
      });

      // 目标侧挂载点：目标自身 + 各祖先；upSteps = 目标到该挂载点的层数
      const mounts = [];
      const selfIdx = ctx.self.nodeId != null ? idxById.get(String(ctx.self.nodeId)) : undefined;
      if (selfIdx != null) mounts.push({ info: ctx.self, idx: selfIdx, upSteps: 0 });
      for (const anc of ctx.ancestors) {
        if (anc.nodeId == null) continue;
        const i = idxById.get(String(anc.nodeId));
        if (i == null) continue;
        // 祖先链到该深度必须逐级连续（否则下行 >K 会算错层数）
        let contiguous = true;
        for (let d = ctx.selfDepth - 1, t = 0; d >= anc.depth; d--, t++) {
          if (!ctx.ancestors[t] || ctx.ancestors[t].depth !== d) {
            contiguous = false;
            break;
          }
        }
        if (contiguous) mounts.push({ info: anc, idx: i, upSteps: ctx.selfDepth - anc.depth });
      }
      if (!mounts.length) return null;

      // 兄弟序号（父内 0 起位置）：沿扁平列表向左穿过更深节点统计同深度节点数
      const ordCache = new Array(infos.length).fill(null);
      const ordAt = (i) => {
        if (ordCache[i] != null) return ordCache[i];
        const d = infos[i].depth;
        let j = i, ord = 0;
        while (j > 0 && infos[j - 1].depth >= d) {
          if (infos[j - 1].depth === d) ord++;
          j--;
        }
        return (ordCache[i] = ord);
      };

      // 同父判定：同深度且两节点之间无更浅节点（处于同一段兄弟序列）
      const sameParentRun = (i, j) => {
        if (i === j) return true;
        const d = infos[i].depth;
        if (infos[j].depth !== d) return false;
        const lo = Math.min(i, j), hi = Math.max(i, j);
        for (let t = lo + 1; t < hi; t++) if (infos[t].depth < d) return false;
        return true;
      };

      // 排除目标自身/祖先（⬆️ 职责）与目标后代（⬇️ 职责），只留旁支子树
      const excluded = new Set(mounts.map(m => String(m.info.nodeId)));
      for (const dsc of ctx.descendants) {
        if (dsc.nodeId != null) excluded.add(String(dsc.nodeId));
      }

      // 枚举强锚点候选：树标签带 tail 且不在目标自身/祖先链/子树上
      const cands = [];
      for (let i = 0; i < infos.length; i++) {
        const s = infos[i];
        if (!s.tail) continue;
        if (s.nodeId != null && excluded.has(String(s.nodeId))) continue;

        // 向上链：up[0] = s 自身，up[k] = 第 k 级祖先（遇虚拟列表截断即止）
        const up = [{ info: s, idx: i }];
        let expect = s.depth - 1;
        for (let j = i - 1; j >= 0 && expect >= 0; j--) {
          if (infos[j].depth === expect) {
            up.push({ info: infos[j], idx: j });
            expect--;
          } else if (infos[j].depth < expect) break;
        }

        // 挂载配对：a = s 自身或其祖先，b = 目标自身或其祖先，a 与 b 互为兄弟
        for (let k = 0; k < up.length; k++) {
          const a = up[k];
          for (const mt of mounts) {
            if (a.idx === mt.idx) continue;
            if (!sameParentRun(a.idx, mt.idx)) continue;
            const oa = ordAt(a.idx), ob = ordAt(mt.idx);
            // 方向过滤：上索引只要 a 在 b 前（兄侧），下索引只要 a 在 b 后（弟侧）
            if (dir === 'up' ? oa >= ob : oa <= ob) continue;
            const m = Math.abs(ob - oa);
            if (m < 1) continue;
            // 总代价 = 锚点上行层数 + 兄弟间隔 + 目标下行层数，优先最短追踪链
            cands.push({ sIdx: i, k, up, a, mount: mt, m, cost: k + m + mt.upSteps });
          }
        }
      }
      if (!cands.length) return null;
      cands.sort((x, y) => x.cost - y.cost || x.m - y.m || x.k - y.k);

      // 逐个候选尝试（最多 4 个）：点击读取 s/a/b 真实属性 → 校验兄弟关系 → 组装
      for (const c of cands.slice(0, 4)) {
        const sInfo = infos[c.sIdx];
        const aInfo = c.a.info;
        const bInfo = c.mount.info;
        const isSelfMount = c.mount.upSteps === 0; // 挂载点即目标自身（兄弟跳直达）

        const need = [];
        const seen = new Set();
        const addNeed = (info) => {
          if (info?.nodeId == null) return;
          const key = String(info.nodeId);
          if (seen.has(key)) return;
          seen.add(key);
          need.push({ nodeId: info.nodeId });
        };
        addNeed(sInfo);
        addNeed(aInfo);
        if (!isSelfMount) addNeed(bInfo);
        const pm = await resolveNodeProps(need);
        const sProps = sInfo.nodeId != null ? (pm.get(String(sInfo.nodeId)) || null) : null;
        const aProps = aInfo.nodeId != null ? (pm.get(String(aInfo.nodeId)) || null) : null;
        const bProps = isSelfMount ? p : (bInfo.nodeId != null ? (pm.get(String(bInfo.nodeId)) || null) : null);

        // 兄弟关系校验：双方 _pid 都已知时必须一致（防虚拟列表截断认错父级）
        if (aProps && bProps && aProps._pid != null && bProps._pid != null &&
            String(aProps._pid) !== String(bProps._pid)) continue;

        // 兄弟间隔：优先用属性表真实 index，并复核方向与模式一致
        let m = c.m;
        if (aProps && bProps && typeof aProps.index === 'number' && typeof bProps.index === 'number') {
          m = Math.abs(bProps.index - aProps.index);
          const aBefore = aProps.index < bProps.index;
          // 方向不符 → 该候选属另一模式，弃选
          if (dir === 'up' ? !aBefore : aBefore) continue;
        }
        if (m < 1) continue;

        const sExpr = buildAnchorExpr(sInfo, sProps);
        if (!sExpr) continue;

        // 弱中间节点表达式：简写名 / [name] / childCount / OR 兜底，全无则 *
        const weakMid = (info, props) => buildAnchorExpr(info, props) || '*';

        // ① 上行段：强锚点开头，经 s 与 a 之间的祖先逐级 <n（GKD 无多层 <，逐级列出）
        let out = sExpr;
        if (c.k >= 1) {
          for (let t = 1; t < c.k; t++) out += ' <n ' + weakMid(c.up[t].info, null);
          out += ' <n ' + weakMid(aInfo, aProps);
        }

        // ② 兄弟跳：上索引 a 在 b 前用 +(m)，下索引 a 在 b 后用 -(m)
        const hop = (m === 1 ? (dir === 'up' ? ' + ' : ' - ') : ` ${dir === 'up' ? '+' : '-'}(${m}) `);

        if (isSelfMount) {
          // ③ 挂载点即目标自身：兄弟跳直达目标，目标天然在末尾
          out += hop + baseExpr;
        } else {
          // ③ 下行段：b 到目标，弱中间折叠为精确深度 >K（目标恒在末尾）
          const bExpr = weakMid(bInfo, bProps);
          const downMids = ctx.ancestors.filter(x => x.depth > bInfo.depth).reverse();
          out += hop + collapseChain([bInfo, ...downMids], bExpr, baseExpr, pm);
        }
        return out;
      }
      return null;
    };

    if (relationMode === 'prev') return await prevAnchor();
    if (relationMode === 'next') return await nextAnchor();
    if (relationMode === 'parent') return await vertAnchor();
    if (relationMode === 'desc') return await descAnchor();
    if (relationMode === 'crossUp') return await crossTreeAnchor('up');
    if (relationMode === 'crossDown') return await crossTreeAnchor('down');
    // auto：前兄弟 → 祖先 → 跨树上索引 → 跨树下索引 → 后代 → 后兄弟，逐级兜底
    return (await prevAnchor()) || (await vertAnchor()) ||
           (await crossTreeAnchor('up')) || (await crossTreeAnchor('down')) ||
           (await descAnchor()) || (await nextAnchor());
  }

  /* ---------------- 📍 固定初始锚点（v1.21） ---------------- */

  // 锚点节点高亮（元素被虚拟列表重建后由 refreshAll 重新补挂类名）
  function applyAnchorHighlight() {
    document.querySelectorAll(`.${ANCHOR_HL_CLS}`).forEach((n) => n.classList.remove(ANCHOR_HL_CLS));
    if (!anchorState?.nodeId) return;
    document
      .querySelector(`.n-tree-node[data-node-id="${CSS.escape(String(anchorState.nodeId))}"]`)
      ?.classList.add(ANCHOR_HL_CLS);
  }

  // 📍 按钮激活态视觉（配合 styleBtn 的 dataset.activeBg）
  function updateAnchorBtnVisual() {
    document.querySelectorAll(`#${BTN_ANCHOR_ID}`).forEach((btn) => {
      if (anchorState) {
        btn.dataset.activeBg = '#f0a020';
        btn.style.background = '#f0a020';
        btn.style.color = '#fff';
        btn.title = `📍 初始锚点已设置：${anchorState.tail || anchorState.name || anchorState.nodeId}\n生成规则时优先以它为链路起点索引到目标（再次点击取消）`;
      } else {
        delete btn.dataset.activeBg;
        btn.style.background = 'transparent';
        btn.style.color = '';
        btn.title = '📍 设置初始锚点：选中树节点后点击，链式规则（祖先/兄弟/跨树）将优先从它出发（再次点击取消）';
      }
    });
  }

  // 单个节点异步读真实属性（模拟点击），失败返回 null
  async function readPropsById(nodeId) {
    if (nodeId == null) return null;
    const pm = await resolveNodeProps([{ nodeId }]);
    return pm.get(String(nodeId)) || null;
  }

  // 📍 以固定锚点为起点生成到目标的链路（目标恒在末尾），失败返回 null
  // 覆盖：祖先 / 后代 / 兄弟 / 跨树（锚点链与目标链存在互为兄弟的节点对）
  async function tryApplyFixedAnchor(baseExpr, p, hasRealDistinction) {
    if (!anchorState || !baseExpr) return null;
    const ctx = getTreeContext();
    if (!ctx) return null;
    const A = anchorState;
    // 锚点即目标自身 → 无需链路，交给默认逻辑
    if (A.nodeId != null && String(A.nodeId) === String(ctx.self.nodeId)) return null;
    const parentValid = (info) => info && (info.nodeId == null || p._pid == null || String(info.nodeId) === String(p._pid));
    const sameId = (x) => x.nodeId != null && String(x.nodeId) === String(A.nodeId);

    // ① 锚点是目标的祖先：锚点 >[k] 强mid... >[K] 目标
    const ancIdx = ctx.ancestors.findIndex(sameId);
    if (ancIdx >= 0) {
      const aExpr = buildAnchorExpr(A, await readPropsById(A.nodeId));
      if (!aExpr) return null;
      let contiguous = true;
      for (let t = 0; t <= ancIdx; t++) {
        if (!ctx.ancestors[t] || ctx.ancestors[t].depth !== ctx.selfDepth - 1 - t) { contiguous = false; break; }
      }
      // 链不可信（虚拟列表截断/父级对不上 _pid）→ 退化为任意祖先匹配
      if (!contiguous || !parentValid(ctx.ancestors[0])) return `${aExpr} >n ${baseExpr}`;
      const seq = [A, ...ctx.ancestors.slice(0, ancIdx).reverse()];
      const pm = await resolveNodeProps(seq.filter((x) => x.tail && x.nodeId != null));
      const aProps = pm.get(String(A.nodeId)) || null;
      return collapseChain(seq, buildAnchorExpr(A, aProps) || aExpr, baseExpr, pm);
    }

    // ② 锚点是目标的后代：锚点 <n / <<n 目标
    if (ctx.descendants.some(sameId)) {
      const aExpr = buildAnchorExpr(A, await readPropsById(A.nodeId));
      if (!aExpr) return null;
      return A.depth === ctx.selfDepth + 1 ? `${aExpr} <n ${baseExpr}` : `${aExpr} <<n ${baseExpr}`;
    }

    // ③ 锚点与目标互为兄弟：锚点 ±(n) 目标
    const prevIdx = ctx.prevSiblings.findIndex(sameId);
    if (prevIdx >= 0) {
      const gap = prevIdx + 1;
      const aExpr = buildAnchorExpr(A, await readPropsById(A.nodeId));
      return aExpr ? (gap === 1 ? `${aExpr} + ${baseExpr}` : `${aExpr} +(${gap}) ${baseExpr}`) : null;
    }
    const nextIdx = ctx.nextSiblings.findIndex(sameId);
    if (nextIdx >= 0) {
      const gap = nextIdx + 1;
      const aExpr = buildAnchorExpr(A, await readPropsById(A.nodeId));
      return aExpr ? (gap === 1 ? `${aExpr} - ${baseExpr}` : `${aExpr} -(${gap}) ${baseExpr}`) : null;
    }

    // ④ 跨树：a 在锚点祖先链上、b 在目标链上（含目标自身），a/b 互为兄弟
    if (ctx.ancestors.length && !parentValid(ctx.ancestors[0])) return null;

    const mounts = [{ info: ctx.self, down: 0 }]; // 目标侧挂载点（含下行层数）
    for (let t = 0; t < ctx.ancestors.length; t++) {
      let contiguous = true;
      for (let j = 0; j <= t; j++) {
        if (!ctx.ancestors[j] || ctx.ancestors[j].depth !== ctx.selfDepth - 1 - j) { contiguous = false; break; }
      }
      if (!contiguous) break;
      mounts.push({ info: ctx.ancestors[t], down: t + 1 });
    }

    const aCands = [{ info: A, up: 0 }, ...A.chain.map((c, i) => ({ info: c, up: i + 1 }))];
    const pairs = [];
    for (const ac of aCands) {
      for (const mt of mounts) {
        if (ac.info.depth !== mt.info.depth) continue;
        if (ac.info.nodeId != null && mt.info.nodeId != null &&
            String(ac.info.nodeId) === String(mt.info.nodeId)) continue;
        pairs.push({ a: ac.info, k: ac.up, b: mt.info, down: mt.down, cost: ac.up + mt.down });
      }
    }
    if (!pairs.length) return null;
    pairs.sort((x, y) => x.cost - y.cost);

    for (const pr of pairs.slice(0, 4)) {
      const need = [];
      const seen = new Set();
      const addNeed = (info) => {
        if (info?.nodeId == null) return;
        const key = String(info.nodeId);
        if (!seen.has(key)) { seen.add(key); need.push({ nodeId: info.nodeId }); }
      };
      addNeed(A); addNeed(pr.a); if (pr.down > 0) addNeed(pr.b);
      const pm = await resolveNodeProps(need);
      const aProps = pr.a.nodeId != null ? pm.get(String(pr.a.nodeId)) || null : null;
      const bProps = pr.down === 0 ? p : (pr.b.nodeId != null ? pm.get(String(pr.b.nodeId)) || null : null);

      // _pid 交叉校验兄弟关系；index 缺失无法定间隔/方向 → 换候选
      if (aProps && bProps && aProps._pid != null && bProps._pid != null &&
          String(aProps._pid) !== String(bProps._pid)) continue;
      if (!(typeof aProps?.index === 'number' && typeof bProps?.index === 'number')) continue;
      const m = Math.abs(bProps.index - aProps.index);
      if (m < 1) continue;
      const dir = aProps.index < bProps.index ? 'up' : 'down'; // up: 锚点侧在前 → +(m)

      const sExpr = buildAnchorExpr(A, pm.get(String(A.nodeId)) || null);
      if (!sExpr) continue;
      const weakMid = (info, props) => buildAnchorExpr(info, props) || '*';

      // 上行段：锚点 <n 逐级上行至 a（GKD 无多层 <，逐级列出）
      let out = sExpr;
      for (let t = 0; t < pr.k; t++) {
        const info = t === pr.k - 1 ? pr.a : A.chain[t];
        out += ' <n ' + weakMid(info, t === pr.k - 1 ? aProps : null);
      }
      const hop = m === 1 ? (dir === 'up' ? ' + ' : ' - ') : ` ${dir === 'up' ? '+' : '-'}(${m}) `;
      if (pr.down === 0) {
        out += hop + baseExpr; // 挂载点即目标自身
      } else {
        const bExpr = weakMid(pr.b, bProps);
        const downMids = ctx.ancestors.filter((x) => x.depth > pr.b.depth).reverse();
        out += hop + collapseChain([pr.b, ...downMids], bExpr, baseExpr, pm);
      }
      return out;
    }
    return null;
  }

  /* ---------------- ⚡ v1.22 fastQuery 反转链路（@目标在前 + fq锚点收尾） ---------------- */

  // 目标自身是否满足快速查询资格（末尾选择器首表达式须为 id/vid/text 之一，
  // 且 text 不能是正则模式——~= 不在快速查询支持的 6 种结构里）
  function isTargetFqEligible(p) {
    return !!(p.vid || p.id ||
      (p.text && String(p.text) !== '' && matchMode.text !== 'regex'));
  }

  // 由节点信息 + 真实属性生成「快速查询收尾选择器」（v1.22）：
  // ⚡ 按 fq 要求：不写节点名；首表达式只用 6 种可快速查询类型
  //（id / vid / text 的 = ^= *= $=；desc 不属于可快速查询类型，一律不用）
  // 无真实属性时用 tail 启发式，OR 兜底只连 vid||text（混入 desc 会破坏 fq 资格）
  function buildFqEndExpr(info, props) {
    if (!info) return null;
    if (props?.vid) return `[vid="${esc(props.vid)}"]`;
    if (props?.text && String(props.text) !== '') {
      return buildMatchExpr('text', props.text, matchMode.text === 'regex' ? 'exact' : matchMode.text);
    }
    if (props?.id) return `[id="${esc(props.id)}"]`;
    if (info.tail) {
      if (/^android:id\//.test(info.tail)) return `[id="${esc(info.tail)}"]`;
      return `[vid="${esc(info.tail)}" || text="${esc(info.tail)}"]`;
    }
    return null;
  }

  // 生成「@目标 … fq锚点收尾」链路（fq 锚点为末位选择器 = 快速查询入口），失败返回 null
  // kind: anc（fq 是目标祖先）/ desc（fq 是目标后代）/ prev（fq 在目标前）/ next（fq 在目标后）
  // ⚡ 快速查询语义：引擎对「末尾属性选择器的第一个表达式」调系统 API 拿候选，
  // 再反向校验整条链，因此 @ 目标可位于链中任意位置，不再强制放末尾：
  //   anc:  @目标 <n 中间… <n fq祖先（精确逐级） / @目标 <<n fq祖先（断链退化）
  //   desc: @目标 > fq直接子级（精确） / @目标 >n fq后代（深层退化）
  //   prev: @目标 -(n) fq兄弟（fq 在目标前面）
  //   next: @目标 +(n) fq兄弟（fq 在目标后面）
  async function buildFqEndChain(ctx, p, targetExpr, info, kind, dist) {
    if (!info || info.nodeId == null) return null;
    const props = await readPropsById(info.nodeId);
    const endExpr = buildFqEndExpr(info, props);
    if (!endExpr) return null;
    const at = '@' + targetExpr;

    // 兄弟：属性表 index 优先于 DOM 顺序（虚拟列表截断时 DOM 序号不可信），并复核方向
    if (kind === 'prev' || kind === 'next') {
      let gap = dist;
      if (props && typeof props.index === 'number' && typeof p.index === 'number') {
        // prev: fq 在目标前 → fq.index < 目标.index；next 反之
        const before = props.index < p.index;
        if (kind === 'prev' ? !before : before) return null;
        gap = Math.abs(p.index - props.index);
      }
      if (gap < 1) return null;
      return `${at} ${kind === 'prev' ? '-' : '+'}${gap === 1 ? ' ' : `(${gap}) `}${endExpr}`;
    }

    if (kind === 'anc') {
      // 直接父级：须与属性表 _pid 交叉校验；父级对不上时退化为任意祖先匹配
      if (dist === 1) {
        const pv = ctx.ancestors[0] && (p._pid == null ||
          String(ctx.ancestors[0].nodeId) === String(p._pid));
        if (!pv) return `${at} <<n ${endExpr}`;
        return `${at} <n ${endExpr}`;
      }
      // 多级祖先：祖先链逐级连续才生成精确路径 <n … <n，否则 <<n 任意层级
      let contiguous = true;
      for (let t = 0; t < dist; t++) {
        if (!ctx.ancestors[t] || ctx.ancestors[t].depth !== ctx.selfDepth - 1 - t) { contiguous = false; break; }
      }
      if (!contiguous) return `${at} <<n ${endExpr}`;
      let out = at;
      for (let t = dist - 2; t >= 0; t--) {
        const mid = buildAnchorExpr(ctx.ancestors[t], null) || '*';
        out += ` <n ${mid}`;
      }
      return out + ` <n ${endExpr}`;
    }

    if (kind === 'desc') {
      // 直接子级精确 >；更深层用 >n 任意祖先匹配（后代子树可能被虚拟列表截断，无法保证路径完整）
      return info.depth === ctx.selfDepth + 1 ? `${at} > ${endExpr}` : `${at} >n ${endExpr}`;
    }
    return null;
  }

  // 🔧 v1.22.2：📍 跨树关系的 fq 反转链
  // 正向链：S <n… a +(m) b >K 目标（S 开头、目标收尾，tryApplyFixedAnchor ④）
  // 反转链：@目标 <n… b -(m) a >… [S 的 fq 表达式]（目标开头带 @、锚点收尾当 fq 入口）
  // 关系反转规则：<n(1代) ⇄ > 、+(m) ⇄ -(m)（左右互换）、>K 展开为逐级 <n
  // pr: { a, k, b, down, m, dir }（dir: 'up'=正向 a+(m)b / 'down'=正向 a-(m)b）
  // 🔧 v1.22.3：修复 ③ 段末位与锚点 S 之间漏写 > 关系符的 bug——
  // k≥1 时 S 是 chain[0] 的直接子节点，必须以 ' > ' 连接锚点（此前输出空格
  // 生成非法/宽匹配选择器，如 "View[childCount=6] [text=..]"）；k=0 时
  // hop 后直接追加锚点（a 即 S 自身，中间不能再有关系符）
  async function buildFqCrossChain(ctx, p, targetExpr, A, pr, pm) {
    const sProps = pm.get(String(A.nodeId)) || null;
    const sFq = buildFqEndExpr(A, sProps);
    if (!sFq) return null; // 双保险：锚点不可查则不反转
    const at = '@' + targetExpr;
    const weakMid = (info, props) => buildAnchorExpr(info, props) || '*';

    // ① 目标 → b（上行 pr.down 代，逐级 <n；down=0 时 b 即目标自身，直接兄弟跳）
    let out = at;
    if (pr.down > 0) {
      for (let t = 0; t < pr.down - 1; t++) {
        out += ' <n ' + weakMid(ctx.ancestors[t], null); // 连续性已由 mounts 构建时保证
      }
      out += ' <n ' + weakMid(pr.b, pm.get(String(pr.b.nodeId)) || null);
    }

    // ② b → a（兄弟跳方向反转：正向 a+(m)b ⇔ 反转 b-(m)a；正向 a-(m)b ⇔ b+(m)a）
    const hop = pr.m === 1
      ? (pr.dir === 'up' ? ' - ' : ' + ')
      : (pr.dir === 'up' ? ` -(${pr.m}) ` : ` +(${pr.m}) `);
    out += hop;

    // ③ a → S（下行 k 代，逐级 >）
    if (pr.k >= 1) {
      out += weakMid(pr.a, pm.get(String(pr.a.nodeId)) || null);
      // A.chain 由近及远（chain[0] 是 S 的父），从 a 下行依次 chain[k-2]…chain[0]
      for (let t = pr.k - 2; t >= 0; t--) {
        out += ' > ' + weakMid(A.chain[t], null);
      }
      // 🔧 v1.22.3：chain[0] → S 是一段父子关系，必须用 > 连接（不可空格）
      out += ' > ' + sFq;
    } else {
      // k=0：a 即锚点 S 自身，hop 后直接追加锚点（中间不能再有关系符）
      out += sFq;
    }
    return out;
  }

  // ⚡ v1.22：fastQuery 开启且目标不可快速查询时的主入口。
  // 优先用 📍 固定锚点收尾（祖先/后代/兄弟四种关系）；
  // 🔧 v1.22.1：📍 已设置时绝不自动搜索顶替；
  // 🔧 v1.22.2：📍 为跨树关系时先尝试把 📍 跨树链整条反转（buildFqCrossChain，
  // @目标在前、锚点收尾当 fq 入口），反转不可行才交还 📍 正向跨树链（目标收尾）；
  // 自动搜索仅在未设置 📍 锚点时执行
  async function tryApplyFqEnd(targetExpr, p) {
    const ctx = getTreeContext();
    if (!ctx) return null;
    const sameAnchor = (x) => anchorState?.nodeId != null && x.nodeId != null &&
      String(x.nodeId) === String(anchorState.nodeId);

    // ① 📍 固定锚点优先
    if (anchorState?.nodeId != null &&
        String(anchorState.nodeId) !== String(ctx.self.nodeId)) {
      const A = anchorState;
      const ancIdx = ctx.ancestors.findIndex(sameAnchor);
      if (ancIdx >= 0) {
        const r = await buildFqEndChain(ctx, p, targetExpr, ctx.ancestors[ancIdx], 'anc', ancIdx + 1);
        if (r) return r;
      }
      const dsc = ctx.descendants.find(sameAnchor);
      if (dsc) {
        const r = await buildFqEndChain(ctx, p, targetExpr, dsc, 'desc', dsc.depth - ctx.selfDepth);
        if (r) return r;
      }
      const pi = ctx.prevSiblings.findIndex(sameAnchor);
      if (pi >= 0) {
        const r = await buildFqEndChain(ctx, p, targetExpr, ctx.prevSiblings[pi], 'prev', pi + 1);
        if (r) return r;
      }
      const ni = ctx.nextSiblings.findIndex(sameAnchor);
      if (ni >= 0) {
        const r = await buildFqEndChain(ctx, p, targetExpr, ctx.nextSiblings[ni], 'next', ni + 1);
        if (r) return r;
      }

      // 🔧 v1.22.2：📍 为跨树/无关关系 → 先尝试整链反转成 fq 收尾
      // 硬前提：锚点自身含 vid/text/id 可查属性（desc 不行）
      const sProps0 = await readPropsById(A.nodeId);
      const sFq0 = buildFqEndExpr(A, sProps0);
      if (sFq0) {
        // 锚点祖先链（含自身）与目标祖先链（含自身）找同深度兄弟对（同正向 ④ 的配对逻辑）
        const mounts = [{ info: ctx.self, down: 0 }];
        for (let t = 0; t < ctx.ancestors.length; t++) {
          let contiguous = true;
          for (let j = 0; j <= t; j++) {
            if (!ctx.ancestors[j] || ctx.ancestors[j].depth !== ctx.selfDepth - 1 - j) { contiguous = false; break; }
          }
          if (!contiguous) break;
          mounts.push({ info: ctx.ancestors[t], down: t + 1 });
        }
        const aCands = [{ info: A, up: 0 }, ...A.chain.map((c, i) => ({ info: c, up: i + 1 }))];
        const pairs = [];
        for (const ac of aCands) {
          for (const mt of mounts) {
            if (ac.info.depth !== mt.info.depth) continue;
            if (ac.info.nodeId != null && mt.info.nodeId != null &&
                String(ac.info.nodeId) === String(mt.info.nodeId)) continue;
            pairs.push({ a: ac.info, k: ac.up, b: mt.info, down: mt.down, cost: ac.up + mt.down });
          }
        }
        pairs.sort((x, y) => x.cost - y.cost);
        for (const pr of pairs.slice(0, 4)) {
          const need = [];
          const seen = new Set();
          const addNeed = (info) => {
            if (info?.nodeId == null) return;
            const key = String(info.nodeId);
            if (!seen.has(key)) { seen.add(key); need.push({ nodeId: info.nodeId }); }
          };
          addNeed(A); addNeed(pr.a); if (pr.down > 0) addNeed(pr.b);
          const pm = await resolveNodeProps(need);
          const aProps = pr.a.nodeId != null ? pm.get(String(pr.a.nodeId)) || null : null;
          const bProps = pr.down === 0 ? p : (pr.b.nodeId != null ? pm.get(String(pr.b.nodeId)) || null : null);
          // _pid / index 交叉校验（同正向），方向存入 pr.dir 供反转 hop 使用
          if (aProps && bProps && aProps._pid != null && bProps._pid != null &&
              String(aProps._pid) !== String(bProps._pid)) continue;
          if (!(typeof aProps?.index === 'number' && typeof bProps?.index === 'number')) continue;
          const m = Math.abs(bProps.index - aProps.index);
          if (m < 1) continue;
          pr.dir = aProps.index < bProps.index ? 'up' : 'down';
          pr.m = m;
          const r = await buildFqCrossChain(ctx, p, targetExpr, A, pr, pm);
          if (r) return r; // ✅ 反转成功：📍 跨树锚点 + fastQuery 兼得
        }
        console.warn('[GKD规则生成器] 📍 跨树反转失败（无有效兄弟配对），回退 📍 正向跨树链（目标在末尾，fastQuery 将被忽略）');
      } else {
        console.warn('[GKD规则生成器] 📍 锚点自身无 vid/text/id 可快速查询属性，无法作反转收尾；回退 📍 正向跨树链（fastQuery 将被忽略）');
      }
      // 📍 意图仍然最高：反转失败也绝不自动搜索顶替，交还 📍 正向链
      return null;
    }

    // ② 自动搜索：仅在未设置 📍 锚点时执行
    // 祖先 → 后代 → 前/后兄弟，按路径距离由近及远逐个尝试
    const cands = [];
    ctx.ancestors.forEach((a, i) => { if (a.tail) cands.push({ info: a, kind: 'anc', dist: i + 1 }); });
    ctx.descendants.forEach((d) => { if (d.tail) cands.push({ info: d, kind: 'desc', dist: d.depth - ctx.selfDepth }); });
    ctx.prevSiblings.forEach((s, i) => { if (s.tail) cands.push({ info: s, kind: 'prev', dist: i + 1 }); });
    ctx.nextSiblings.forEach((s, i) => { if (s.tail) cands.push({ info: s, kind: 'next', dist: i + 1 }); });
    cands.sort((x, y) => x.dist - y.dist);
    for (const c of cands.slice(0, 6)) {
      const r = await buildFqEndChain(ctx, p, targetExpr, c.info, c.kind, c.dist);
      if (r) return r;
    }
    return null;
  }

  /* ---------------- 生成 matches ---------------- */

  async function buildMatches(p) {
    const parts = [];

    // 节点名：仅在 fastQuery 关闭时输出末段简写（如 android.widget.TextView -> TextView）
    // fastQuery 开启时不写节点名，保证选择器第一个表达式是 [vid=...]/[text*=...] 这类
    // 可被快速查询识别的结构（弱目标例外：weakExpr 恒写节点名，因其无法快速查询，零损失）
    let shortName = '';
    if (p.name && !fastQueryOn) {
      const tail = String(p.name).split('.').pop();
      if (IDENT_RE.test(tail)) {
        shortName = tail;
      } else {
        // 末段含 $ 等非法字符（如内部类 MainActivity$1），退回完整 [name="..."] 兜底
        parts.push(`[name="${esc(p.name)}"]`);
      }
    }

    if (p.vid) parts.push(`[vid="${esc(p.vid)}"]`);
    else if (p.id) parts.push(`[id="${esc(p.id)}"]`);

    // text / desc 按当前模式生成
    if (p.text != null) parts.push(buildMatchExpr('text', p.text, matchMode.text));
    if (p.desc != null) parts.push(buildMatchExpr('desc', p.desc, matchMode.desc));

    // 真正可定位的辨别项：空字符串的 text/desc（生成 [text=""] 之类）没有定位价值，
    // 仅存在空字符串辨别项时视为不可定位 → auto 模式也触发锚点附加
    const hasRealDistinction = !!(
      p.vid || p.id ||
      (p.text && String(p.text) !== '') ||
      (p.desc && String(p.desc) !== '')
    );

    const base = (shortName ? shortName : '') + parts.join('');

    // 弱目标（无 vid/id/非空 text/desc）表达式 —— 默认精简形态：
    //   节点名 + visibleToUser（按属性表实值，v1.17 修正不再无脑追加 true；
    //   快照中不可见的置灰节点实值为 false，此时不加约束，clickNode 屏外也能点）
    //   + [text=""]/[desc=""]（实值为空串时，仍是有效约束）
    //   + [index=n]（父内序号，兄弟间的主区分手段）
    // 📐 几何约束（v1.18 三重门槛，保持精简）：
    //   ① 🔱 菜单开关开启（默认关闭）；② 存在同名兄弟（hasSameNameSibling 同步
    //   扫 DOM 判定真歧义，无同名兄弟时 index 已足够区分，一条都不加）；
    //   ③ 优先 width/height（相对稳定），仅当 w/h 缺失才回退 left/top（屏幕
    //   绝对坐标，随分辨率/旋转变化最脆弱）——一次最多补两条，不四条全上
    // ⚡ 排列顺序保证首个属性表达式恒为非 quickFind 格式（visibleToUser /
    // [width=100] 均不可快速查询）：若 [text=""] 打头，quickFind 会以空串调
    // findAccessibilityNodeInfosByText（空串被"包含于"任何文本，候选≈全部
    // 文本节点），反而劣化性能，故有意前置挡住 quickFind
    const weakExpr = () => {
      let s = '';
      if (p.name) {
        const t = String(p.name).split('.').pop();
        if (IDENT_RE.test(t)) s = t;
      }
      const extra = [];
      if (p.visibleToUser === true) extra.push('[visibleToUser=true]');
      if (typeof p.index === 'number') extra.push(`[index=${p.index}]`);
      if (p.text === '') extra.push('[text=""]');
      if (p.desc === '') extra.push('[desc=""]');

      let geoAdded = false;
      if (geoOn && hasSameNameSibling()) {
        if (typeof p.width === 'number') { extra.push(`[width=${p.width}]`); geoAdded = true; }
        if (typeof p.height === 'number') { extra.push(`[height=${p.height}]`); geoAdded = true; }
        // w/h 缺失时的回退：left/top 屏幕绝对坐标，跨设备最脆弱，仅兜底用
        if (typeof p.width !== 'number' && typeof p.left === 'number') { extra.push(`[left=${p.left}]`); geoAdded = true; }
        if (typeof p.height !== 'number' && typeof p.top === 'number') { extra.push(`[top=${p.top}]`); geoAdded = true; }
        if (geoAdded) {
          console.info('[GKD规则生成器] 检测到同名兄弟歧义，已附加几何约束（width/height 优先，left/top 仅兜底）；几何值随设备分辨率/旋转变化，跨设备使用请手动删改');
        }
      }

      if (p.visibleToUser === false) {
        console.warn('[GKD规则生成器] 目标节点 visibleToUser=false（快照中不可见），已省略该约束；若规则不触发请改用 clickNode 或重新截图');
      }
      return s + extra.join('');
    };

    const targetExpr = hasRealDistinction ? base : weakExpr();

    // ⚡ v1.22（最高优先）：fastQuery 开启且目标不可快速查询（弱目标 / 仅 desc /
    // text 正则模式）时，不再强制目标在末尾，而是反转链路：
    //   @目标 在前 + 可快速查询的亲属锚点（不写节点名，首表达式为 6 种 fq 类型之一）收尾
    // 📍 固定锚点优先充当收尾锚点；🔧 v1.22.2：📍 为跨树/无关关系时先尝试
    // 整链反转（buildFqCrossChain），反转不可行才交还下方 📍 主流程的跨树分支
    if (fastQueryOn && !isTargetFqEligible(p)) {
      const fqEnd = await tryApplyFqEnd(targetExpr, p);
      if (fqEnd) return fqEnd;
      // 未设置 📍 时自动搜索失败才提示
      if (!anchorState) {
        console.warn('[GKD规则生成器] fastQuery 开启但目标不可快速查询，且未找到可收尾的快速查询锚点，回退「目标在末尾」结构（fastQuery 将被静默忽略）');
      }
    }

    // 📍 固定初始锚点（v1.21）：以用户固定的锚点为链路起点索引到目标
    //（含跨树分支——锚点开头、目标收尾，fastQuery 静默忽略）
    if (anchorState) {
      const fixed = await tryApplyFixedAnchor(targetExpr, p, hasRealDistinction);
      if (fixed) return fixed;
      console.warn('[GKD规则生成器] 📍 固定锚点链路生成失败，回退默认生成逻辑');
    }

    // 🔀 关系锚点：仅空 text 时不把 [text=""] 传给锚点，改用弱目标表达式
    if (relationMode !== 'off') {
      const rel = await tryApplyRelation(targetExpr, p, hasRealDistinction);
      if (rel) return rel;
    }

    // 锚点不可用/关闭时的兜底
    if (!hasRealDistinction) return weakExpr();
    return base;
  }

  /* ---------------- 获取 activityIds ---------------- */

  function getActivityId() {
    const divs = document.querySelectorAll('div.gkd_code div');
    const texts = [...divs].map((d) => d.innerText.trim()).filter(Boolean);
    let act = texts.find((t) => /^\.[\w$]+(\.[\w$]+)+$/.test(t));
    if (act) return act;
    act = texts.find((t) => /^[a-z][\w]*(\.[\w]+)*\.[A-Z][\w$]*$/.test(t));
    if (act) return act;
    return texts.find((t) => /^[a-z]+(\.[a-z0-9_]+){1,}$/.test(t)) || '';
  }

  /* ---------------- 组装规则 JSON ---------------- */

  async function buildRule() {
    const p = readProps();
    // ⚡ 必须在锚点解析（会点击换选）之前读取目标属性
    if (!p) return null;
    const activityId = getActivityId();
    const label = p.text || p.desc || (p.name ? p.name.split('.').pop() : '目标控件');

    // rules[0] —— 内层规则项，两种输出模式共用
    const ruleItem = {
      key: 0,
      name: `关闭${label}`,
      matches: [await buildMatches(p)],
    };
    if (activityId) {
      ruleItem.activityIds = [activityId];
    }

    // ⚡ 仅生成 rule 项：只输出上面那个内层对象，适合粘贴进已有规则的 rules 数组里
    if (ruleOnlyOn) {
      return JSON.stringify(ruleItem, null, 2);
    }

    // 完整规则组
    const rule = {
      key: 0,
      name: `关闭${label}`,
      desc: `关闭${label}`,
      actionMaximum: 1,
    };
    // fastQuery 开启时，输出在 actionMaximum 下方（规则组层级）
    if (fastQueryOn) rule.fastQuery = true;
    rule.rules = [ruleItem];
    return JSON.stringify(rule, null, 2);
  }

  /* ---------------- 复制到剪贴板 ---------------- */

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    }
  }

  /* ---------------- 粘贴进编辑框（限定在所在 app-panel 内） ---------------- */

  function pasteIntoEditor(text, root) {
    const scope = root || document;
    const ta = scope.querySelector('textarea.n-input__textarea-el');
    if (!ta) return { ok: false, reason: 'not-found' };
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const cur = ta.value;
    let newText;
    let caretPos;
    if (cur.trim() === '') {
      newText = text;
      caretPos = text.length;
    } else if (start !== end) {
      newText = cur.slice(0, start) + text + cur.slice(end);
      caretPos = start + text.length;
    } else {
      const pos = Math.min(start, cur.length);
      newText = cur.slice(0, pos) + text + cur.slice(pos);
      caretPos = pos;
    }
    const proto = Object.getPrototypeOf(ta);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(ta, newText);
    } else {
      ta.value = newText;
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(caretPos, caretPos);
    return { ok: true, replaced: cur.trim() !== '' };
  }

  /* ---------------- toast ---------------- */

  function toast(msg, type = 'ok') {
    const bg = type === 'ok' ? '#18a058' : type === 'warn' ? '#f0a020' : '#d03050';
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', 'z-index:9999999', 'left:50%', 'top:20px',
      'transform:translateX(-50%)', 'padding:8px 16px', `background:${bg}`,
      'color:#fff', 'border-radius:4px', 'font-size:13px',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)', 'transition:opacity .3s', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; }, 1500);
    setTimeout(() => t.remove(), 1900);
  }

  /* ---------------- 🔱 模式切换菜单 ---------------- */

  function removeMenu() {
    document.getElementById('gkd-mode-menu')?.remove();
  }

  // 菜单里的一行小节标题
  function menuSectionLabel(text) {
    const section = document.createElement('div');
    section.style.cssText = 'padding:4px 10px 2px;font-size:11px;color:#888;border-bottom:none;';
    section.textContent = text;
    return section;
  }

  // 菜单里的一行开关（label + 状态文字，点击切换）
  function menuToggleRow(labelText, isOn, onText, offText, onToggle) {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex', 'justify-content:space-between', 'align-items:center',
      'padding:6px 10px', 'border-radius:4px', 'cursor:pointer',
    ].join(';');
    row.innerHTML = `
      <span style="font-weight:600;">${labelText}</span>
      <span style="font-size:12px;color:${isOn ? '#18a058' : '#999'};">
        ${isOn ? onText : offText}
      </span>`;
    row.addEventListener('mouseenter', () => { row.style.background = '#f3f3f5'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
    row.addEventListener('click', (e) => { e.stopPropagation(); onToggle(); });
    return row;
  }

  // 菜单里的单选项（模式选择用，选中的高亮）
  function menuOptionRow(selected, labelText, tipText, onSelect) {
    const item = document.createElement('div');
    item.style.cssText = [
      'padding:6px 10px', 'border-radius:4px', 'cursor:pointer',
      'display:flex', 'justify-content:space-between', 'align-items:center',
    ].join(';');
    if (selected) {
      item.style.background = '#18a058';
      item.style.color = '#fff';
      item.style.fontWeight = '600';
    } else {
      item.addEventListener('mouseenter', () => { item.style.background = '#f3f3f5'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
    }
    const left = document.createElement('span');
    left.textContent = labelText;
    const right = document.createElement('span');
    right.textContent = tipText;
    right.style.cssText = selected ? 'font-size:11px;opacity:.85;' : 'font-size:11px;color:#999;';
    item.appendChild(left);
    item.appendChild(right);
    item.addEventListener('click', (e) => { e.stopPropagation(); onSelect(); });
    return item;
  }

  function buildModeMenu(anchor) {
    removeMenu();
    const menu = document.createElement('div');
    menu.id = 'gkd-mode-menu';
    menu.style.cssText = [
      'position:fixed', 'z-index:9999998', 'min-width:230px',
      'max-height:calc(100vh - 16px)', 'overflow-y:auto', 'overflow-x:hidden',
      'background:#fff', 'border:1px solid #e0e0e6', 'border-radius:6px',
      'box-shadow:0 4px 16px rgba(0,0,0,.15)', 'padding:4px',
      'font-size:13px', 'color:#333',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '规则生成器设置';
    title.style.cssText = 'padding:6px 10px;font-weight:600;color:#666;font-size:12px;border-bottom:1px solid #eee;margin-bottom:4px;';
    menu.appendChild(title);

    /* ---- 分组一：生成内容 ---- */
    menu.appendChild(menuSectionLabel('生成内容'));

    // ⚡ fastQuery 开关
    menu.appendChild(menuToggleRow(
      '⚡ fastQuery', fastQueryOn,
      '✅ 开启（可查目标不写节点名）', '⛔ 关闭（一律写节点名）',
      () => {
        fastQueryOn = !fastQueryOn;
        saveMode();
        toast(fastQueryOn
          ? '✅ fastQuery 开启：可快速查询的目标不写节点名；目标不可查时自动反转链路（@目标在前、fq 锚点收尾；📍 已设置时优先用 📍，跨树链亦可反转）'
          : '✅ fastQuery 关闭：不含 fastQuery，所有目标写节点名');
        removeMenu();
        updateModeBtnTitle();
        refreshAll();
      }
    ));

    // 🧩 仅生成 rule 项 开关
    menu.appendChild(menuToggleRow(
      '🧩 仅生成 rule 项', ruleOnlyOn,
      '✅ 开启（只输出 rules[0]）', '⛔ 关闭（完整规则组）',
      () => {
        ruleOnlyOn = !ruleOnlyOn;
        saveMode();
        toast(ruleOnlyOn ? '✅ 仅生成 rule 项：输出内层规则对象（key/name/matches/activityIds）' : '✅ 完整规则组：输出含 actionMaximum/fastQuery/rules 的完整对象');
        removeMenu();
        updateModeBtnTitle();
        refreshAll();
      }
    ));

    // 📐 弱目标几何约束 开关（v1.18，默认关）
    menu.appendChild(menuToggleRow(
      '📐 弱目标几何约束', geoOn,
      '✅ 开启（仅同名兄弟歧义时加 w/h）', '⛔ 关闭（精简，只 index 兜底）',
      () => {
        geoOn = !geoOn;
        saveMode();
        toast(geoOn ? '✅ 几何约束开启：仅当弱目标存在同名兄弟时追加 width/height（缺失才回退 left/top），保持精简' : '✅ 几何约束关闭：弱目标仅 节点名+visibleToUser+index+空串约束，最精简');
        removeMenu();
        updateModeBtnTitle();
        refreshAll();
      }
    ));

    // 分组一分隔线
    const sep1 = document.createElement('div');
    sep1.style.cssText = 'border-bottom:1px solid #eee;margin:4px 0;';
    menu.appendChild(sep1);

    /* ---- 分组二：🔀 关系选择器 ---- */
    menu.appendChild(menuSectionLabel('🔀 关系选择器锚点（目标恒在末尾）'));
    RELATION_MODES.forEach((m) => {
      menu.appendChild(menuOptionRow(
        relationMode === m.key, m.label, m.tip,
        () => {
          relationMode = m.key;
          saveMode();
          removeMenu();
          updateModeBtnTitle();
          toast(`✅ 关系锚点切换为 ${m.label}`);
        }
      ));
    });

    // 分组二分隔线
    const sep2 = document.createElement('div');
    sep2.style.cssText = 'border-bottom:1px solid #eee;margin:4px 0;';
    menu.appendChild(sep2);

    /* ---- 分组三：匹配模式 ---- */
    // 为 text 和 desc 各列出所有模式；点击当前项即切换（选中的高亮）
    ['text', 'desc'].forEach((attr) => {
      menu.appendChild(menuSectionLabel(attr === 'text' ? 'text 匹配模式' : 'desc 匹配模式'));
      MODES.forEach((m) => {
        menu.appendChild(menuOptionRow(
          matchMode[attr] === m.key, m.label, m.tip,
          () => {
            matchMode[attr] = m.key;
            saveMode();
            removeMenu();
            updateModeBtnTitle();
            toast(`✅ ${attr} 切换为 ${m.label}`);
          }
        ));
      });
    });

    // 定位在 🔱 按钮右侧（顶部对齐；超高时 max-height + overflow 保证可见）
    const rect = anchor.getBoundingClientRect();
    document.body.appendChild(menu);
    const mrect = menu.getBoundingClientRect();
    let left = rect.right + 6;
    let top = rect.top;
    if (left + mrect.width > window.innerWidth - 8) left = rect.left - mrect.width - 6;
    if (top + mrect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mrect.height - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = top + 'px';
  }

  function updateModeBtnTitle() {
    const btn = document.getElementById(BTN_MODE_ID);
    if (!btn) return;
    const t = MODES.find(m => m.key === matchMode.text);
    const d = MODES.find(m => m.key === matchMode.desc);
    const r = RELATION_MODES.find(m => m.key === relationMode);
    btn.title = `生成器设置（点击切换）\ntext: ${t.label} — ${t.tip}\ndesc: ${d.label} — ${d.tip}\nfastQuery: ${fastQueryOn ? '开启（可查目标不写节点名；目标不可查时 @目标在前、fq 锚点收尾；📍 已设置时优先用 📍，跨树链亦可反转）' : '关闭（写节点名）'}\n仅生成 rule 项: ${ruleOnlyOn ? '开启（只输出 rules[0]）' : '关闭（完整规则组）'}\n弱目标几何约束: ${geoOn ? '开启（仅同名兄弟歧义时加 width/height）' : '关闭（精简）'}\n关系锚点: ${r.label} — ${r.tip}\n📍 初始锚点: ${anchorState ? `已设置（${anchorState.tail || anchorState.name || anchorState.nodeId}）` : '未设置（点击左侧树节点后按 📍 固定）'}`;
  }

  /* ---------------- 💭 教程面板 ---------------- */

  function removeHelp() {
    document.getElementById('gkd-help-panel')?.remove();
    document.getElementById('gkd-help-mask')?.remove();
  }

  function buildHelpPanel() {
    removeHelp();

    /* ══════════ 面板尺寸 / 字号配置（想调大小只改这里） ══════════ */
    const CFG = {
      panelMaxWidth: 1100,   // 面板最大宽度 px（小屏自动收缩到 vwPercent）
      vwPercent: 94,         // 小屏时面板宽度占视口百分比
      panelMaxHeightVh: 92,  // 面板最大高度（vh）
      panelTopVh: 4,         // 面板距顶部（vh）
      fsTitle: 24,           // 标题栏字号
      fsHead: 21,            // 小节标题（1️⃣2️⃣…）字号
      fsBody: 18,            // 正文字号
      fsCode: 16,            // 内联代码 / 代码块字号
      fsTable: 17,           // 表格字号
      fsFootnote: 16,        // 底部提示框字号
      fsLink: 16,            // 标题栏"官方文档"链接字号
      fsCloseBtn: 17,        // 关闭按钮字号
      lhBody: 1.8,           // 正文行高
      lhPre: 1.7,            // 代码块行高
    };
    /* ════════════════════════════════════════════════════════════ */

    // 遮罩
    const mask = document.createElement('div');
    mask.id = 'gkd-help-mask';
    mask.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,.35)', 'z-index:9999990',
    ].join(';');
    mask.addEventListener('click', removeHelp);
    document.body.appendChild(mask);

    // 主面板
    const panel = document.createElement('div');
    panel.id = 'gkd-help-panel';
    panel.style.cssText = [
      'position:fixed', 'z-index:9999991', `top:${CFG.panelTopVh}vh`,
      'left:50%', 'transform:translateX(-50%)',
      `width:min(${CFG.panelMaxWidth}px,${CFG.vwPercent}vw)`,
      `max-height:${CFG.panelMaxHeightVh}vh`,
      'background:#fff', 'border-radius:10px',
      'box-shadow:0 8px 32px rgba(0,0,0,.28)',
      'display:flex', 'flex-direction:column',
      'font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    ].join(';');

    // 标题栏
    const head = document.createElement('div');
    head.style.cssText = [
      'padding:16px 20px', 'border-bottom:1px solid #eee',
      'display:flex', 'align-items:center', 'justify-content:space-between', 'flex:none',
    ].join(';');
    head.innerHTML = `
      <div style="font-weight:600;font-size:${CFG.fsTitle}px;color:#333;">📖 GKD 选择器 · 匹配符与参数教程</div>
      <div style="display:flex;gap:14px;align-items:center;">
        <a href="https://gkd.li/guide/selector" target="_blank" rel="noopener" style="font-size:${CFG.fsLink}px;color:#2080F0;text-decoration:none;">官方文档 ↗</a>
        <button id="gkd-help-close" style="border:none;background:#f3f3f5;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:${CFG.fsCloseBtn}px;">✕ 关闭</button>
      </div>
    `;
    panel.appendChild(head);
    head.querySelector('#gkd-help-close').addEventListener('click', removeHelp);

    // 内容（可滚动）
    const body = document.createElement('div');
    body.style.cssText = [
      'padding:16px 22px', 'overflow:auto', 'flex:1', 'min-height:0',
      `font-size:${CFG.fsBody}px`, `line-height:${CFG.lhBody}`, 'color:#333',
    ].join(';');

    const codeStyle = `background:#f6f6f8;padding:2px 7px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:${CFG.fsCode}px;color:#c7254e;`;
    const preStyle = `background:#f6f6f8;padding:10px 14px;border-radius:6px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:${CFG.fsCode}px;line-height:${CFG.lhPre};margin:8px 0 12px;white-space:pre;`;
    const hStyle = `margin:22px 0 10px;font-size:${CFG.fsHead}px;font-weight:600;color:#18a058;border-bottom:2px solid #18a05833;padding-bottom:5px;`;
    const tblStyle = `width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:${CFG.fsTable}px;`;
    const tdStyle = 'border:1px solid #eee;padding:8px 12px;vertical-align:top;';

    body.innerHTML = `
      <div style="${hStyle}">1️⃣ 选择器基本结构</div>
      <p>一个选择器由 <b>属性选择器</b> 和 <b>关系选择器</b> 交叉组成，开头/末尾必须是属性选择器，属性选择器与关系选择器之间必须用空格隔开：</p>
      <pre style="${preStyle}">@TextView[id='btn_skip'] &lt; LinearLayout &lt; @FrameLayout[parent=null]</pre>
      <p>📌 <code style="${codeStyle}">@</code> 标记"要点击的目标节点"，没有 <code style="${codeStyle}">@</code> 时默认取<b>最后一个</b>属性选择器。节点名可简写：<code style="${codeStyle}">TextView</code> 等价于 <code style="${codeStyle}">[name='TextView' || name$='.TextView']</code>；<code style="${codeStyle}">*</code> 表示任意 name。</p>

      <div style="${hStyle}">2️⃣ 常用操作符（本脚本 🔱 切换的就是这里）</div>
      <table style="${tblStyle}">
        <tr style="background:#fafafc;font-weight:600;"><td style="${tdStyle}">操作符</td><td style="${tdStyle}">名称</td><td style="${tdStyle}">说明</td><td style="${tdStyle}">示例</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">=</code></td><td style="${tdStyle}">等于</td><td style="${tdStyle}">完全匹配（精确）</td><td style="${tdStyle}"><code style="${codeStyle}">[text='跳过']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">!=</code></td><td style="${tdStyle}">不等于</td><td style="${tdStyle}">排除</td><td style="${tdStyle}"><code style="${codeStyle}">[text!='取消']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">^=</code></td><td style="${tdStyle}">startsWith</td><td style="${tdStyle}">以…开头</td><td style="${tdStyle}"><code style="${codeStyle}">[text^='跳过']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">*=</code></td><td style="${tdStyle}">contains</td><td style="${tdStyle}">包含…（模糊匹配）</td><td style="${tdStyle}"><code style="${codeStyle}">[text*='广告']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">$=</code></td><td style="${tdStyle}">endsWith</td><td style="${tdStyle}">以…结尾</td><td style="${tdStyle}"><code style="${codeStyle}">[text$='按钮']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">~=</code></td><td style="${tdStyle}">matches</td><td style="${tdStyle}">正则匹配（Java 正则，需 v1.7.0+）</td><td style="${tdStyle}"><code style="${codeStyle}">[text~='\\d+秒']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">&gt; &gt;= &lt; &lt;=</code></td><td style="${tdStyle}">数值比较</td><td style="${tdStyle}">仅用于 int 类型</td><td style="${tdStyle}"><code style="${codeStyle}">[depth&gt;3]</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">!^= !*= !$= !~=</code></td><td style="${tdStyle}">取反系列</td><td style="${tdStyle}">不以…开头 / 不包含 / 不以…结尾 / 不匹配正则</td><td style="${tdStyle}"><code style="${codeStyle}">[text!*='关闭']</code></td></tr>
      </table>
      <p>⚠️ 字符串可用 <code style="${codeStyle}">'</code> <code style="${codeStyle}">"</code> <code style="${codeStyle}">\`</code> 三种引号包裹，内部转义用 <code style="${codeStyle}">\\</code>。<code style="${codeStyle}">~=</code> 正则模式一般用反引号写，例如 <code style="${codeStyle}">[text~=\`\\d+秒\`]</code>；除 <code style="${codeStyle}">=</code>/<code style="${codeStyle}">!=</code> 外，属性为 null 时表达式为 false。</p>

      <div style="${hStyle}">3️⃣ 逻辑组合</div>
      <ul style="margin:6px 0 10px 24px;padding:0;">
        <li><b>并列的 [] 等价于 &&</b>：<code style="${codeStyle}">[a=1][b=1]</code> ≡ <code style="${codeStyle}">[a=1&&b=1]</code></li>
        <li><code style="${codeStyle}">||</code> 或、<code style="${codeStyle}">&&</code> 与（优先级更高）、<code style="${codeStyle}">!(...)</code> 取反（感叹号后必须是括号）</li>
      </ul>
      <pre style="${preStyle}">[(text^='欢迎' || text^='你好') && clickable=true]</pre>

      <div style="${hStyle}">4️⃣ 关系选择器（连接多个属性选择器）</div>
      <table style="${tblStyle}">
        <tr style="background:#fafafc;font-weight:600;"><td style="${tdStyle}">符号</td><td style="${tdStyle}">含义</td><td style="${tdStyle}">示例</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">&gt;</code></td><td style="${tdStyle}">A 是 B 的祖先（按 depth 约束，&gt;n 表示任意祖先，&gt;3 精确跨 3 代）</td><td style="${tdStyle}"><code style="${codeStyle}">LinearLayout &gt; ImageView</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">&lt;</code></td><td style="${tdStyle}">A 是 B 的直接子节点（<code>&lt;</code> 限首个子节点，<code>&lt;n</code> 任意位置——注意 <code>&lt;n</code> 不跨代，跨代须逐级列出或用 <code>&lt;&lt;n</code>）</td><td style="${tdStyle}"><code style="${codeStyle}">FrameLayout[vid='content'] &lt;n ImageView</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">+</code></td><td style="${tdStyle}">A 是 B 的前置兄弟（+(n) 表示前面第 n 个）</td><td style="${tdStyle}"><code style="${codeStyle}">ViewGroup + LinearLayout[vid='item']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">-</code></td><td style="${tdStyle}">A 是 B 的后置兄弟（-(n) 表示后面第 n 个）</td><td style="${tdStyle}"><code style="${codeStyle}">[vid='cover'] - [vid='title']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">&lt;&lt;n</code></td><td style="${tdStyle}">A 是 B 的任意层级后代（B 是 A 的祖先）</td><td style="${tdStyle}"><code style="${codeStyle}">@[text='跳过'] &lt;&lt;n [vid='root']</code></td></tr>
      </table>
      <p>支持 <code style="${codeStyle}">&gt;n</code>（任意祖先）、<code style="${codeStyle}">&gt;3</code>（精确跨 3 代）、<code style="${codeStyle}">+(2,4,6)</code> 元组等写法，参考 CSS <code style="${codeStyle}">:nth(an+b)</code>。四种关系的官方语义（以 A 在左、B 在右）：</p>
      <pre style="${preStyle}">A +(an+b) B : A.index = B.index-(an+b) → A 在 B 前面 A -(an+b) B : A.index = B.index+(an+b) → A 在 B 后面 A &gt; B : A 是 B 的祖先 A &lt; B : A 是 B 的直接子节点（且 A.index=0）</pre>
      <p>🔀 本脚本 🔱 菜单的"关系锚点"会自动为目标附加父/兄弟/祖先/后代锚点，生成策略：<b>目标属性选择器恒定在末尾</b>（<code style="${codeStyle}">锚点 +(n) 目标</code> / <code style="${codeStyle}">锚点 -(n) 目标</code> / <code style="${codeStyle}">锚点 &gt; 强中间 &gt;K 目标</code> / <code style="${codeStyle}">锚点 &lt;n·&lt;&lt;n 目标</code>），作为快速查询入口，因此无需 <code style="${codeStyle}">@</code> 标记；锚点属性通过模拟点击读取真实属性表精确归属（vid/desc/text 不再靠猜），读取失败时回退 <code style="${codeStyle}">[vid='x' || text='x' || desc='x']</code> 兜底；含强属性的中间节点保留，仅类名/[childCount] 的弱中间节点折叠为精确深度 <code style="${codeStyle}">&gt;K</code>。</p>
      <p>🔀 v1.15 新增<b>跨树追踪锚点</b>（拆分为上/下索引两方向），专治目标及其祖先全无特征、但旁支子树里存在强节点的场景：设目标在 b 的子树中，强节点在 b 的兄 a 的子树（上索引）或弟 c 的子树（下索引）里，生成——</p>
      <pre style="${preStyle}">上索引（兄侧）：[强锚点] &lt;n 弱中间… &lt;n a +(m) 挂载b &gt;K 目标 下索引（弟侧）：[强锚点] &lt;n 弱中间… &lt;n c -(m) 挂载b &gt;K 目标</pre>
      <p>其中 m 为 a/c 与 b 的真实兄弟间隔（中间夹的其它兄弟也计入），上下行代差任意（<code style="${codeStyle}">&lt;n</code> 逐级上行——GKD 无多层 <code style="${codeStyle}">&lt;</code>，不能一个 <code style="${codeStyle}">&lt;n</code> 跨到底 / <code style="${codeStyle}">&gt;K</code> 精确深度下行）；a/b 兄弟关系经点击读取双方 <code style="${codeStyle}">_pid</code>/<code style="${codeStyle}">index</code> 交叉校验，方向不符自动换次优候选；目标恒在末尾，目标自身带 vid/text 时照常享受快速查询，弱目标时 fastQuery 静默回退普通遍历（不报错）。</p>
      <p>📍 <b>v1.21 新增「初始锚点」</b>：在左侧树选中任意节点后点击 📍，该节点被高亮（橙色描边）并固定为链路起点，📍 按钮同时变橙色表示锚点已激活；再次点击 📍 取消。设置后用 🔆/🔰 生成规则时<b>优先</b>以它为锚点索引到当前目标——锚点是目标的祖先/后代/兄弟时直接生成对应链；跨树场景则自动在锚点祖先链与目标祖先链之间寻找同深度兄弟节点对，生成 <code style="${codeStyle}">锚点 &lt;n… a ±(m) b &gt;K 目标</code> 追踪链（同样经 _pid/index 交叉校验）。🔧 v1.22.1 起固定锚点意图为全脚本最高优先：即使 fastQuery 开启、且存在更近的可快速查询亲属，也不会自动搜索顶替 📍 锚点；🔧 v1.22.2 起跨树关系的 📍 链在 fastQuery 开启时会先尝试<b>整链反转</b>（@目标在前、锚点收尾当快速查询入口），反转不可行（锚点无可查属性/配对校验失败）才回退正向链；🔧 v1.22.3 修正了反转链 ③ 段末位与锚点之间漏写 <code style="${codeStyle}">&gt;</code> 关系符的问题。</p>

      <div style="${hStyle}">5️⃣ 常用节点属性</div>
      <table style="${tblStyle}">
        <tr style="background:#fafafc;font-weight:600;"><td style="${tdStyle}">属性</td><td style="${tdStyle}">类型</td><td style="${tdStyle}">说明</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">id</code> / <code style="${codeStyle}">vid</code></td><td style="${tdStyle}">string</td><td style="${tdStyle}">完整 view-id / 去掉包名的 view-id，最精准的定位</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">name</code></td><td style="${tdStyle}">string</td><td style="${tdStyle}">Java 类名，如 <code style="${codeStyle}">android.widget.TextView</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">text</code> / <code style="${codeStyle}">desc</code></td><td style="${tdStyle}">string / null</td><td style="${tdStyle}">文本 / 无障碍描述</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">clickable</code> / <code style="${codeStyle}">focusable</code> / <code style="${codeStyle}">checkable</code> / <code style="${codeStyle}">checked</code> / <code style="${codeStyle}">editable</code> / <code style="${codeStyle}">visibleToUser</code></td><td style="${tdStyle}">boolean</td><td style="${tdStyle}">常用布尔特征</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">index</code></td><td style="${tdStyle}">int</td><td style="${tdStyle}">在父节点中的序号（从 0 开始），弱目标兄弟间的主区分手段</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">depth</code></td><td style="${tdStyle}">int</td><td style="${tdStyle}">树深度，根节点为 0</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">childCount</code></td><td style="${tdStyle}">int</td><td style="${tdStyle}">子节点个数</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">left / top / right / bottom / width / height</code></td><td style="${tdStyle}">int</td><td style="${tdStyle}">位置与尺寸（<b>随设备分辨率/旋转变化</b>；本工具 📐 开关开启且存在同名兄弟歧义时才按快照实值附加 width/height，缺失才回退 left/top）</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">parent</code></td><td style="${tdStyle}">node</td><td style="${tdStyle}">父节点，<code style="${codeStyle}">[parent=null]</code> 表示根节点</td></tr>
      </table>

      <div style="${hStyle}">6️⃣ 快速查询</div>
      <p>把规则里 <code style="${codeStyle}">fastQuery</code> 设为 <code style="${codeStyle}">true</code> 后，GKD 可以调用系统 API（findAccessibilityNodeInfosByViewId / ByText）直接查找节点，避免遍历整棵树，速度大幅提升。但要满足：<b>末尾属性选择器的第一个表达式</b>属于下面结构之一：</p>
      <pre style="${preStyle}">[id='abc'] [vid='abc'] [text='abc'] [text^='abc'] [text*='abc'] [text$='abc']</pre>
      <p>用 <code style="${codeStyle}">||</code> 连接上述结构也算符合。如果末尾选择器不符合这些格式，fastQuery 会被忽略（自动回退普通遍历，不会报错）。另外 vid/id/text 表达式必须放在 <code style="${codeStyle}">[]</code> 内<b>第一个</b>位置：<code style="${codeStyle}">C[id='x'][childCount=2]</code> ✅、<code style="${codeStyle}">C[childCount=2][id='x']</code> ❎。此外 <code style="${codeStyle}">&lt;&lt;n</code> 链条支持分段快速查询（如 <code style="${codeStyle}">C[id='x'] &lt;&lt;n D</code> 会先快速查 C 再在其子树内搜 D）。注意：快速查询资格只取决于末尾属性选择器，与 <code style="${codeStyle}">@</code> 标记在哪无关——<code style="${codeStyle}">@CheckBox &lt;&lt;n [vid='ll']</code> 照样触发快速查询。</p>
      <p>⚡ <b>v1.22：fastQuery 开启时目标不再强制放末尾</b>。开启 fastQuery 且目标自身不可快速查询（弱目标 / 仅 desc / text 正则模式）时，本工具会自动<b>反转链路</b>：<code style="${codeStyle}">@目标</code> 放在前，以可快速查询的节点收尾（不写节点名，首表达式只用上面 6 种类型），末位选择器即快速查询入口。收尾锚点的选取顺序（🔧 v1.22.1/1.22.2/1.22.3）：<b>未设置 📍 时</b>——自动的最近祖先 → 最近后代 → 最近前/后兄弟；<b>已设置 📍 时</b>——若 📍 锚点是目标的祖先/后代/兄弟且含可查属性，用它收尾；若 📍 锚点是跨树关系，先尝试把 📍 跨树链<b>整链反转</b>（<code style="${codeStyle}">锚点 &lt;n… a ±(m) b &gt;K 目标</code> ⇄ <code style="${codeStyle}">@目标 &lt;n… b ∓(m) a &gt;… [锚点]</code>，关系符逐段互换、末位与锚点间以 <code style="${codeStyle}">&gt;</code> 连接），锚点自身含 vid/text/id 时即可兼得 fastQuery 与 📍 意图；反转不可行才回退正向链（目标收尾，fastQuery 静默忽略）。<b>任何已设 📍 的场景都不会自动搜索顶替</b>。祖先链精确逐级 <code style="${codeStyle}">&lt;n</code>（断链退化为 <code style="${codeStyle}">&lt;&lt;n</code>），后代深层退化为 <code style="${codeStyle}">&gt;n</code>，兄弟用 <code style="${codeStyle}">±(n)</code> 并经属性表 index 复核方向与间隔。</p>
      <p>💡 本脚本的 🔱 菜单"生成内容"分组里有三个开关：<b>⚡ fastQuery</b>——开启时规则组输出 <code style="${codeStyle}">"fastQuery": true</code>，可快速查询的目标不写节点名，目标不可查时自动反转链路（见上）；关闭时不输出 fastQuery，所有目标写节点名简写。<b>🧩 仅生成 rule 项</b>——开启时只输出内层规则对象（key/name/matches/activityIds），适合直接粘进已有规则的 rules 数组；关闭时输出含 actionMaximum/fastQuery/rules 的完整规则组。<b>📐 弱目标几何约束</b>（v1.18，默认关）——开启后仅当弱目标存在<b>同名兄弟</b>时追加 <code style="${codeStyle}">[width=..][height=..]</code>，w/h 缺失才回退 left/top。🔀 所有关系锚点模式（含跨树上/下索引）与 📍 固定锚点均把目标放在末尾（fastQuery 反转链路时除外）。</p>

      <div style="${hStyle}">7️⃣ 实战小技巧</div>
      <ul style="margin:6px 0 10px 24px;padding:0;">
        <li>广告"关闭"按钮文字常变化 → 用 <code style="${codeStyle}">[text*='关闭']</code> 或 <code style="${codeStyle}">[text~='关闭(广告|弹窗)?']</code></li>
        <li>"跳过 X 秒"按钮 → 用 <code style="${codeStyle}">[text~='跳过\\\\s*\\\\d+']</code> 而不是精确匹配</li>
        <li>节点没有可用属性 → 用父/祖先关系+位置兜底：<code style="${codeStyle}">[vid='ad_root'] &gt; ImageView[index=2]</code>；若全链无特征但旁支子树里有强节点，用 🔱 菜单的 🔀 跨树上/下索引锚点自动生成追踪链，或先选中旁支强节点按 📍 固定为初始锚点再选中目标生成（fq 开启时若锚点含 vid/text/id，还会自动反转成 fq 收尾）</li>
        <li>目标不可快速查询但附近有 vid/text 节点 → 开着 fastQuery 直接生成即可（未设 📍 时），v1.22 会自动把该邻居放到末尾当快速查询入口（<code style="${codeStyle}">@目标 &lt;n [vid='x']</code> 之类）；但若已设 📍 锚点，生成结果以 📍 为准</li>
        <li>规则越精确越好，避免全局用 <code style="${codeStyle}">[text*='x']</code> 导致误点</li>
      </ul>

      <div style="${hStyle}">8️⃣ action 点击类型</div>
      <p>规则命中节点后执行什么操作由 <code style="${codeStyle}">action</code> 字段决定。不写 <code style="${codeStyle}">action</code> 时默认 <code style="${codeStyle}">click</code>；<b>写了 <code style="${codeStyle}">position</code> 时默认变为 <code style="${codeStyle}">clickCenter</code>，写了 <code style="${codeStyle}">swipeArg</code> 时默认变为 <code style="${codeStyle}">swipe</code></b>。全部取值如下：</p>
      <table style="${tblStyle}">
        <tr style="background:#fafafc;font-weight:600;"><td style="${tdStyle}">action 值</td><td style="${tdStyle}">含义</td><td style="${tdStyle}">前提 / 注意</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">click</code>（默认）</td><td style="${tdStyle}">智能点击：目标节点 <code style="${codeStyle}">clickable=true</code> 时用 clickNode，反之用 clickCenter；clickNode 未被应用接收时自动回退 clickCenter</td><td style="${tdStyle}">无特殊前提，首选值</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">clickNode</code></td><td style="${tdStyle}">直接向系统派发无障碍<b>节点点击</b>事件，节点在屏幕外或被遮挡也能命中</td><td style="${tdStyle}">目标必须 <code style="${codeStyle}">clickable=true</code>，否则应用通常不响应；极少数应用显示接收但不响应，此时改用 clickCenter</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">clickCenter</code></td><td style="${tdStyle}">计算节点中心坐标后派发<b>屏幕点击</b>事件；可配合 <code style="${codeStyle}">position</code> 自定义落点</td><td style="${tdStyle}">坐标在屏幕外时视为未匹配；节点被遮挡时会点到最上层节点（可能不是目标）</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">back</code></td><td style="${tdStyle}">向系统发送返回键事件，相当于按下返回键</td><td style="${tdStyle}">不依赖目标节点本身，命中即返回</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">longClick</code></td><td style="${tdStyle}">智能长按：目标 <code style="${codeStyle}">longClickable=true</code> 时用 longClickNode，反之 longClickCenter</td><td style="${tdStyle}">长按时长 400 毫秒</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">longClickNode</code></td><td style="${tdStyle}">向系统派发无障碍节点长按事件，与 clickNode 类似</td><td style="${tdStyle}">目标需 <code style="${codeStyle}">longClickable=true</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">longClickCenter</code></td><td style="${tdStyle}">与 clickCenter 类似，计算坐标后长按屏幕</td><td style="${tdStyle}">长按时长 400 毫秒，同样可配 position</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">swipe</code></td><td style="${tdStyle}">向系统发送滑动事件，滑动参数由 <code style="${codeStyle}">swipeArg</code> 定义</td><td style="${tdStyle}">需同时写 swipeArg（写了 swipeArg 时 action 默认即 swipe）</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">none</code></td><td style="${tdStyle}">什么都不做，仅作匹配标记</td><td style="${tdStyle}">常用于 preKeys 链式规则的"前一步触发标记"，不产生任何点击</td></tr>
      </table>
      <p>典型选择策略：<b>能点进节点就 <code style="${codeStyle}">clickNode</code></b>（不受遮挡/屏幕外影响，最稳）；<b>节点不可点但热区在其范围内（或用 position 偏移到热区）就 <code style="${codeStyle}">clickCenter</code></b>；<b>不需要点任何东西、只做流程标记就 <code style="${codeStyle}">none</code></b>。示例：</p>
      <pre style="${preStyle}">{ matches: '[vid="ad_container"]', action: 'clickCenter', position: { right: 'width*0.1', top: 'height*0.1' }, // 点容器右上角的关闭热区 }</pre>

      <div style="${hStyle}">9️⃣ position 自定义点击位置</div>
      <p><code style="${codeStyle}">position</code> 是一个对象，用来描述自定义点击位置，<b>坐标相对目标节点（不是相对屏幕）</b>，仅在 <code style="${codeStyle}">clickCenter</code>/<code style="${codeStyle}">longClickCenter</code> 时生效；不写 position 时默认点击节点中心。定位属性共 6 个，须<b>水平、垂直各选一个</b>组合使用：</p>
      <table style="${tblStyle}">
        <tr style="background:#fafafc;font-weight:600;"><td style="${tdStyle}">属性</td><td style="${tdStyle}">参照物</td><td style="${tdStyle}">说明</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">left</code></td><td style="${tdStyle}">目标节点左边</td><td style="${tdStyle}">距左边的距离，方向为边→中心；负数表示反方向（可点到节点外部）</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">right</code></td><td style="${tdStyle}">目标节点右边</td><td style="${tdStyle}">距右边的距离，方向为边→中心，负数同理</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">top</code> / <code style="${codeStyle}">bottom</code></td><td style="${tdStyle}">目标节点上边 / 下边</td><td style="${tdStyle}">距上/下边的距离，方向为边→中心，负数同理</td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">x</code> / <code style="${codeStyle}">y</code></td><td style="${tdStyle}">屏幕左侧 / 顶部</td><td style="${tdStyle}">距屏幕左/上的距离；小窗或分屏时坐标相对整块屏幕，可能点到应用窗口外</td></tr>
      </table>
      <p>合法组合为 <code style="${codeStyle}">left/right/x</code> 三选一 + <code style="${codeStyle}">top/bottom/y</code> 三选一。值支持数字或字符串（<code style="${codeStyle}">2.5</code> 等价 <code style="${codeStyle}">'2.5'</code>）；字符串还支持数学计算表达式，可直接引用快照属性面板上目标节点的 <code style="${codeStyle}">left/top/right/bottom/width/height</code> 六个属性，以及三个额外变量：<code style="${codeStyle}">random</code>（0-1 随机数，同一表达式内是固定值，所以 <code style="${codeStyle}">'random-random'=0</code>）、<code style="${codeStyle}">screenWidth</code>、<code style="${codeStyle}">screenHeight</code>（实时屏幕宽高，屏幕旋转时跟随变化）。官方四个示例：</p>
      <pre style="${preStyle}">// 点击目标节点的中心（即不写 position 的默认行为） { left: 'width/2', top: 'height/2' } // 点击目标节点的左上顶点 { left: 0, top: 0 } // 点击目标节点的右上区域（广告卡片右上角"X"的典型写法） { right: 'width*0.1352', top: 'width*0.0852' } // 点击屏幕中心（脱离目标节点，用 x/y） { x: 'screenWidth/2', y: 'screenHeight/2' }</pre>
      <p>💡 与本工具的联动：生成器命中的常是大容器（如 <code style="${codeStyle}">[vid='ad_root']</code>），而真正的关闭按钮往往在容器的某个角落且本身无特征——此时不必费力选择更深的子节点，直接在 rules 项里追加 <code style="${codeStyle}">action: 'clickCenter'</code> + <code style="${codeStyle}">position: { right: 'width*0.1', top: 'height*0.1' }</code>（按快照里关闭按钮的实际相对位置调整系数）即可命中角落热区。另一类场景是目标卡片 <code style="${codeStyle}">clickable=false</code>、热区在内部子节点上，用 position 精确点热区可绕过不可点限制。本工具新增的 <b>📏 position 生成器</b>（按钮在左侧工具栏 🔱 下方和各面板 🔆 🔰 中间）就是干这个的：点开 📏 出现小面板，把光标移到快照大图目标点上单击，即自动读取悬浮层右下角的归一化坐标（xper/yper）生成 <code style="${codeStyle}">"action": 'clickCenter', "position": { left: 'width*xper', bottom: 'height*yper' }</code> 片段，🖋 复制或 📝 直粘进规则编辑框（已有文本时自动插到 "activityIds" 行之前，夹在 matches 与 activityIds 中间）。</p>

      <div style="margin-top:16px;padding:12px 16px;background:#f6ffed;border:1px solid #b7eb8f;border-radius:6px;font-size:${CFG.fsFootnote}px;color:#555;">
        📌 以上内容整理自 <a href="https://gkd.li/guide/selector" target="_blank" style="color:#2080F0;">gkd.li/guide/selector</a>、
        <a href="https://gkd.li/guide/optimize" target="_blank" style="color:#2080F0;">gkd.li/guide/optimize</a>、
        <a href="https://gkd.li/guide/example" target="_blank" style="color:#2080F0;">gkd.li/guide/example</a>、
        <a href="https://gkd.li/api/interfaces/RawRuleProps.html" target="_blank" style="color:#2080F0;">RawRuleProps（action 定义）</a>、
        <a href="https://gkd.li/api/type-aliases/Position.html" target="_blank" style="color:#2080F0;">Position 类型说明</a>，
        完整语法以官方文档为准。
      </div>
    `;
    panel.appendChild(body);
    document.body.appendChild(panel);
  }

  /* ---------------- 📏 position 生成器（面板 aa） ---------------- */

  const GEO_PANEL_ID = 'gkd-geo-panel';
  let positionText = '';      // 最近一次生成的 position 片段
  let geoDocClickHandler = null;

  function removeGeoPanel() {
    document.getElementById(GEO_PANEL_ID)?.remove();
    if (geoDocClickHandler) {
      document.removeEventListener('click', geoDocClickHandler, true);
      geoDocClickHandler = null;
    }
  }

  // 定位快照大图（双选择器兜底）
  function findScreenshotImg() {
    return document.querySelector('img[class*="max-w-[calc"]')
      || document.querySelector('body > div:nth-child(1) > div > div:nth-child(2) > img')
      || null;
  }

  // 从 MiniHoverImg 悬浮层右下角信息块读取 xper / yper
  // div.MiniHoverImg.app-panel > div:nth-child(4) 的三个子 div：
  //   [0] = 0.392（无需）  [1] = "0.905, 0.095" → xper 取第一个值  [2] = "0.608" → yper
  function readHoverXY() {
    const overlay = document.querySelector('div.MiniHoverImg.app-panel');
    if (!overlay) return null;
    const box = overlay.children[3]; // :nth-child(4)
    if (!box) return null;
    const xRaw = box.children[1]?.innerText?.trim() || '';
    const yRaw = box.children[2]?.innerText?.trim() || '';
    const xper = parseFloat(xRaw.split(',')[0]);
    const yper = parseFloat(yRaw);
    if (!Number.isFinite(xper) || !Number.isFinite(yper)) return null;
    return { xper, yper };
  }

  function buildPosition(xper, yper) {
    return `"action": 'clickCenter',\n"position": { left: 'width*${xper}', bottom: 'height*${yper}' },`;
  }

  function updateGeoPanelContent() {
    const pre = document.querySelector(`#${GEO_PANEL_ID} #gkd-geo-bb`);
    if (!pre) return;
    pre.textContent = positionText || '（尚未选取坐标：把光标移到快照图上的目标点后单击）';
  }

  // 📝 将 position 片段粘贴进含「规则静态诊断」的 app-panel 编辑框；
  // 已有文本时优先插入到 "activityIds": 行的上一行（夹在 matches 与 activityIds 之间）
  function pastePositionIntoEditor() {
    if (!positionText) {
      toast('⚠️ 尚未生成 position，请先在快照图上选点', 'warn');
      return;
    }
    const panels = [...document.querySelectorAll('div.app-panel')];
    const target = panels.find(p => p.innerText.includes('规则静态诊断'))
      || panels.find(p => p.querySelector(`#${BTN_ID}`));
    if (!target) {
      toast('❌ 未找到含「规则静态诊断」的 app-panel', 'err');
      return;
    }
    const ta = target.querySelector('textarea.n-input__textarea-el');
    if (!ta) {
      toast('❌ 该面板内没有编辑框，请先打开编辑界面', 'err');
      return;
    }
    const cur = ta.value;
    let newText, caretPos;
    if (cur.trim() === '') {
      newText = positionText;
      caretPos = newText.length;
    } else {
      const lines = cur.split('\n');
      const idx = lines.findIndex(l => l.includes('"activityIds"'));
      if (idx >= 0) {
        lines.splice(idx, 0, positionText); // 插入到 activityIds 行之前
        newText = lines.join('\n');
        let off = 0;
        for (let i = 0; i < idx; i++) off += lines[i].length + 1;
        caretPos = off + positionText.length;
      } else {
        // 无 activityIds 行时退化为光标处插入
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? 0;
        newText = cur.slice(0, start) + positionText + cur.slice(end);
        caretPos = start + positionText.length;
      }
    }
    const proto = Object.getPrototypeOf(ta);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(ta, newText);
    else ta.value = newText;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(caretPos, caretPos);
    toast('✅ position 已粘贴进编辑框');
  }

  function buildGeoPanel() {
    removeGeoPanel();
    const panel = document.createElement('div');
    panel.id = GEO_PANEL_ID;
    panel.style.cssText = [
      'position:fixed', 'z-index:9999992', 'right:16px', 'top:64px',
      'width:360px', 'max-width:92vw',
      'background:#fff', 'border:1px solid #e0e0e6', 'border-radius:8px',
      'box-shadow:0 4px 16px rgba(0,0,0,.15)', 'padding:10px 12px',
      'font-size:13px', 'color:#333',
      'font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    ].join(';');

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';
    const title = document.createElement('span');
    title.textContent = '📏 position 生成器';
    title.style.fontWeight = '600';
    head.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'border:none;background:#f3f3f5;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:13px;';
    closeBtn.addEventListener('click', removeGeoPanel);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const tip = document.createElement('div');
    tip.style.cssText = 'color:#888;font-size:12px;margin-bottom:6px;';
    tip.textContent = '光标移到快照图目标点上单击，自动读取悬浮层坐标生成 position 片段';
    panel.appendChild(tip);

    const pre = document.createElement('pre');
    pre.id = 'gkd-geo-bb';
    pre.style.cssText = [
      'background:#f6f6f8', 'border-radius:6px', 'padding:8px 10px',
      'white-space:pre-wrap', 'word-break:break-all', 'margin:0 0 8px',
      'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
      'font-size:13px', 'line-height:1.6', 'min-height:52px',
    ].join(';');
    panel.appendChild(pre);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';
    const mkBtn = (txt, bg, fn) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = `flex:1;border:none;border-radius:4px;padding:6px 0;cursor:pointer;font-size:13px;color:#fff;background:${bg};`;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    row.appendChild(mkBtn('🖋 复制 position', '#18a058', async () => {
      if (!positionText) {
        toast('⚠️ 尚未生成 position，请先在快照图上选点', 'warn');
        return;
      }
      const ok = await copyText(positionText);
      toast(ok ? '✅ position 已复制到剪贴板' : '❌ 复制失败', ok ? 'ok' : 'err');
    }));
    row.appendChild(mkBtn('📝 粘贴到编辑框', '#2080f0', () => pastePositionIntoEditor()));
    panel.appendChild(row);

    document.body.appendChild(panel);
    updateGeoPanelContent();

    // 面板存在期间：捕获快照大图上的点击（capture，确保在站点逻辑前读取悬浮层数据）
    // ⚡ 只读数据 + 更新面板内容，不修改任何按钮状态（状态统一由 refreshAll 管理）
    geoDocClickHandler = (e) => {
      if (e.target.closest(`#${GEO_PANEL_ID}`)) return; // 面板内部点击忽略
      const img = findScreenshotImg();
      if (!img) return;
      if (e.target !== img && !img.contains(e.target)) return; // 仅快照图内点击
      const xy = readHoverXY();
      if (!xy) {
        toast('❌ 未能读取悬浮层坐标（MiniHoverImg 不存在或数据缺失）', 'err');
        return;
      }
      positionText = buildPosition(xy.xper, xy.yper);
      updateGeoPanelContent();
      toast(`✅ 已生成 position：xper=${xy.xper} yper=${xy.yper}`);
    };
    document.addEventListener('click', geoDocClickHandler, true);
  }

  function createGeoBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_GEO_ID;
    btn.type = 'button';
    btn.title = '📏 position 生成器：在快照图上选点生成 action/position 片段';
    btn.textContent = '📏';
    styleBtn(btn);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 实时校验唯一状态（与 🔆/🔰 同源，防止显示状态过期）
      updateSelState();
      if (!selReady) {
        toast('⚠️ 请先在左侧快照树中选中一个节点', 'warn');
        return;
      }
      if (document.getElementById(GEO_PANEL_ID)) {
        removeGeoPanel();
        return;
      }
      buildGeoPanel();
    });
    return btn;
  }

  /* ---------------- 📍 初始锚点按钮（v1.21） ---------------- */

  function createAnchorBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_ANCHOR_ID;
    btn.type = 'button';
    btn.title = '📍 设置初始锚点：选中树节点后点击，链式规则将优先从它出发（再次点击取消）';
    btn.textContent = '📍';
    styleBtn(btn);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      updateSelState();
      if (!selReady) { toast('⚠️ 请先在左侧快照树中选中一个节点', 'warn'); return; }
      // 已有锚点 → 再次点击取消
      if (anchorState) {
        anchorState = null;
        applyAnchorHighlight();
        updateAnchorBtnVisual();
        toast('📍 已取消初始锚点');
        return;
      }
      const el = getSelectedNodeEl();
      if (!el || el.dataset.nodeId == null) { toast('❌ 无法读取选中节点信息', 'err'); return; }
      const info = nodeToInfo(el);
      // 快照锚点的祖先链（由近及远），供跨树链路构建使用
      const nodes = [...document.querySelectorAll('.n-tree-node')];
      const i = nodes.indexOf(el);
      const chain = [];
      if (i >= 0) {
        let expect = info.depth - 1;
        for (let j = i - 1; j >= 0 && expect >= 0; j--) {
          const d = treeNodeDepth(nodes[j]);
          if (d === expect) { chain.push(nodeToInfo(nodes[j])); expect--; }
          else if (d < expect) break;
        }
      }
      anchorState = { ...info, chain };
      applyAnchorHighlight();
      updateAnchorBtnVisual();
      toast(`📍 已设初始锚点：${info.tail || info.name || info.nodeId}（再次点击取消）`);
    });
    return btn;
  }

  /* ---------------- 创建按钮 ---------------- */

  function styleBtn(btn) {
    btn.style.cssText = [
      'width:36px', 'height:36px', 'border:none', 'background:transparent',
      'font-size:18px', 'line-height:1', 'cursor:pointer', 'border-radius:4px',
      'opacity:.85', 'transition:opacity .2s, background .2s', 'padding:0', 'flex:none',
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'user-select:none', 'margin-left:0',
    ].join(';');
    btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = '#f3f3f5'; });
    // mouseleave 尊重激活态底色（📍 锚点激活时保持橙色）
    btn.addEventListener('mouseleave', () => { btn.style.background = btn.dataset.activeBg || 'transparent'; });
    return btn;
  }

  function createCopyBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.title = '生成 GKD 规则并复制到剪贴板';
    btn.textContent = '🔆';
    styleBtn(btn);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 实时校验唯一状态（与 🔰/📏 同源）
      updateSelState();
      const ruleText = await buildRule();
      if (!ruleText) {
        toast('⚠️ 请先在左侧快照树中选中一个节点', 'warn');
        refreshAll(); // 顺手把按钮显示状态同步到真实状态
        return;
      }
      const ok = await copyText(ruleText);
      toast(ok ? '✅ 规则已复制到剪贴板' : '❌ 复制失败', ok ? 'ok' : 'err');
      console.log('[GKD规则生成器]\n' + ruleText);
    });
    return btn;
  }

  function createPasteBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_PASTE_ID;
    btn.type = 'button';
    btn.title = '生成 GKD 规则并粘贴进本面板内的编辑框';
    btn.textContent = '🔰';
    styleBtn(btn);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 实时校验唯一状态（与 🔆/📏 同源）
      updateSelState();
      const ruleText = await buildRule();
      if (!ruleText) {
        toast('⚠️ 请先在左侧快照树中选中一个节点', 'warn');
        refreshAll();
        return;
      }
      const panel = btn.closest('div.app-panel');
      if (!panel) {
        toast('❌ 按钮不在任何 div.app-panel 内，无法定位编辑框', 'err');
        return;
      }
      const r = pasteIntoEditor(ruleText, panel);
      if (!r.ok) {
        if (r.reason === 'not-found') {
          toast('❌ 当前 app-panel 内没有编辑框，请先在该面板打开编辑界面', 'err');
        } else {
          toast('❌ 粘贴失败', 'err');
        }
        return;
      }
      console.log('[GKD规则生成器 → 编辑框]\n' + ruleText);
    });
    return btn;
  }

  function createClearBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_CLEAR_ID;
    btn.type = 'button';
    btn.title = '清空本面板内编辑框的内容';
    btn.textContent = '❌';
    styleBtn(btn);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 限定与 🔰 相同的作用域：所在 app-panel
      const panel = btn.closest('div.app-panel');
      if (!panel) {
        toast('❌ 按钮不在任何 div.app-panel 内，无法定位编辑框', 'err');
        return;
      }
      const ta = panel.querySelector('textarea.n-input__textarea-el');
      if (!ta) {
        toast('❌ 当前 app-panel 内没有编辑框，请先在该面板打开编辑界面', 'err');
        return;
      }
      if (ta.value.trim() === '') {
        toast('ℹ️ 编辑框已经是空的', 'warn');
        return;
      }
      // 走原生 setter + input/change 事件，确保前端框架（如 naive-ui）能感知到变更
      const proto = Object.getPrototypeOf(ta);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(ta, '');
      } else {
        ta.value = '';
      }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      ta.focus();
      ta.setSelectionRange(0, 0);
      toast('🗑️ 已清空编辑框内容');
    });
    return btn;
  }

  function createModeBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_MODE_ID;
    btn.type = 'button';
    btn.textContent = '🔱';
    styleBtn(btn);
    updateModeBtnTitle();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = document.getElementById('gkd-mode-menu');
      if (existing) {
        removeMenu();
        return;
      }
      buildModeMenu(btn);
    });
    return btn;
  }

  function createHelpBtn() {
    const btn = document.createElement('button');
    btn.id = BTN_HELP_ID;
    btn.type = 'button';
    btn.title = '查看 GKD 匹配符与参数教程';
    btn.textContent = '💭';
    styleBtn(btn);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = document.getElementById('gkd-help-panel');
      if (existing) {
        removeHelp();
        return;
      }
      buildHelpPanel();
    });
    return btn;
  }

  /* ---------------- 按钮状态统一维护 ---------------- */

  // ⚡ v1.20：全脚本只有这里读取选中状态（经 updateSelState），生成按钮
  // 🔆/🔰/📏 的可用性由同一个 selReady 变量一次循环统一设置——不存在
  // 各按钮各自检测、互相覆盖的问题。❌ 仍按面板内是否有编辑框判定。
  // ⚡ v1.21：📍 纳入统一管理；锚点高亮随虚拟列表重渲染自动补挂
  function refreshAll() {
    updateSelState(); // 唯一一次读取选中状态

    // 🔆 / 🔰 / 📏 / 📍 —— 生成/锚点按钮统一由 selReady 决定可用性
    document.querySelectorAll(`#${BTN_ID}, #${BTN_PASTE_ID}, #${BTN_GEO_ID}, #${BTN_ANCHOR_ID}`).forEach((btn) => {
      btn.disabled = !selReady;
      btn.style.opacity = selReady ? '1' : '.35';
      btn.style.cursor = selReady ? 'pointer' : 'not-allowed';
    });
    updateModeBtnTitle();
    applyAnchorHighlight();   // 虚拟列表重渲染后补挂锚点高亮
    updateAnchorBtnVisual();  // 同步 📍 激活态视觉与 title

    // ❌ 的可用性取决于其所在面板内是否有编辑框（与选中状态无关）
    document.querySelectorAll(`#${BTN_CLEAR_ID}`).forEach((btn) => {
      const panel = btn.closest('div.app-panel');
      const hasEditor = !!(panel && panel.querySelector('textarea.n-input__textarea-el'));
      btn.disabled = !hasEditor;
      btn.style.opacity = hasEditor ? '1' : '.35';
      btn.style.cursor = hasEditor ? 'pointer' : 'not-allowed';
    });
  }

  /* ---------------- 注入位置 1：左侧竖排工具栏 ---------------- */

  // 在 🔆 下方依次追加 🔱 📏 📍 💭；工具栏是纵向排列
  function injectSidebar() {
    const bar = document.querySelector('div[class*="--svg-h:24px"]');
    if (!bar) return;

    // 🔆
    let copyBtn = bar.querySelector(`#${BTN_ID}`);
    if (!copyBtn) {
      copyBtn = createCopyBtn();
      bar.appendChild(copyBtn);
    }

    // 🔱 —— 放在 🔆 下方（后插入即在其后）
    let modeBtn = bar.querySelector(`#${BTN_MODE_ID}`);
    if (!modeBtn) {
      modeBtn = createModeBtn();
      copyBtn.after(modeBtn);
    } else if (modeBtn.previousElementSibling !== copyBtn) {
      copyBtn.after(modeBtn);
    }

    // 📏 —— 放在 🔱 下方、📍 上方
    let geoBtn = bar.querySelector(`#${BTN_GEO_ID}`);
    if (!geoBtn) {
      geoBtn = createGeoBtn();
      modeBtn.after(geoBtn);
    } else if (geoBtn.previousElementSibling !== modeBtn) {
      modeBtn.after(geoBtn);
    }

    // 📍 —— 放在 📏 下方、💭 上方（v1.21）
    let anchorBtn = bar.querySelector(`#${BTN_ANCHOR_ID}`);
    if (!anchorBtn) {
      anchorBtn = createAnchorBtn();
      geoBtn.after(anchorBtn);
    } else if (anchorBtn.previousElementSibling !== geoBtn) {
      geoBtn.after(anchorBtn);
    }

    // 💭 —— 放在 📍 下方
    let helpBtn = bar.querySelector(`#${BTN_HELP_ID}`);
    if (!helpBtn) {
      helpBtn = createHelpBtn();
      anchorBtn.after(helpBtn);
    } else if (helpBtn.previousElementSibling !== anchorBtn) {
      anchorBtn.after(helpBtn);
    }
  }

  /* ---------------- 注入位置 2：app-panel 内 n-tag 右侧（🔆 + 📏 + 🔰 + ❌） ---------------- */

  function injectAppPanels() {
    document.querySelectorAll('div.app-panel').forEach((panel) => {
      const tag = panel.querySelector('div.n-tag');
      const copyBtn = panel.querySelector(`#${BTN_ID}`);
      const geoBtn = panel.querySelector(`#${BTN_GEO_ID}`);
      const pasteBtn = panel.querySelector(`#${BTN_PASTE_ID}`);
      const clearBtn = panel.querySelector(`#${BTN_CLEAR_ID}`);
      if (!tag) {
        copyBtn?.remove();
        geoBtn?.remove();
        pasteBtn?.remove();
        clearBtn?.remove();
        return;
      }
      // 🔆
      if (!copyBtn) {
        tag.after(createCopyBtn());
      } else if (copyBtn.previousElementSibling !== tag) {
        tag.after(copyBtn);
      }
      // 📏 —— 放在 🔆 与 🔰 中间
      const copyEl = panel.querySelector(`#${BTN_ID}`);
      if (!geoBtn) {
        copyEl.after(createGeoBtn());
      } else if (geoBtn.previousElementSibling !== copyEl) {
        copyEl.after(geoBtn);
      }
      // 🔰 —— 放在 📏 右侧
      const geoEl = panel.querySelector(`#${BTN_GEO_ID}`);
      if (!pasteBtn) {
        geoEl.after(createPasteBtn());
      } else if (pasteBtn.previousElementSibling !== geoEl) {
        geoEl.after(pasteBtn);
      }
      // ❌ —— 放在 🔰 右侧
      const pasteEl = panel.querySelector(`#${BTN_PASTE_ID}`);
      if (!clearBtn) {
        pasteEl.after(createClearBtn());
      } else if (clearBtn.previousElementSibling !== pasteEl) {
        pasteEl.after(clearBtn);
      }
    });
  }

  /* ---------------- 统一维护 ---------------- */

  function injectAll() {
    injectSidebar();
    injectAppPanels();
    refreshAll();
  }

  // rAF 防抖：MutationObserver 高频触发时每帧最多执行一次 injectAll
  let injectPending = false;
  function scheduleInject() {
    if (injectPending) return;
    injectPending = true;
    requestAnimationFrame(() => {
      injectPending = false;
      injectAll();
    });
  }

  /* ---------------- 状态同步触发点 ---------------- */

  // 点击树节点 / 快照图 / 属性表区域后，属性表是异步渲染的，
  // 延迟补刷两次，保证 selReady（按钮可用性）必然跟上真实选中状态，
  // 不会出现"已选中但按钮仍是灰色"或"已取消选中但按钮仍亮着"的错乱
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest?.('.n-tree-node') || t.closest?.('table.n-table') || (t.tagName === 'IMG' || t.closest?.('img'))) {
      setTimeout(refreshAll, 300);
      setTimeout(refreshAll, 800);
    }
  }, true);

  /* ---------------- 点击其他区域关闭菜单 ---------------- */

  document.addEventListener('click', (e) => {
    const menu = document.getElementById('gkd-mode-menu');
    if (menu && !menu.contains(e.target) && !e.target.closest(`#${BTN_MODE_ID}`)) {
      removeMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      removeMenu();
      removeHelp();
      removeGeoPanel();
    }
  });

  /* ---------------- 启动（SPA 页面可能延迟渲染） ---------------- */

  loadMode(); // 启动时读取记忆的匹配模式 + fastQuery + ruleOnly + relation + geo 状态

  const boot = () => {
    // 📍 锚点高亮样式（v1.21）
    const hl = document.createElement('style');
    hl.textContent = `.${ANCHOR_HL_CLS}{box-shadow:inset 0 0 0 2px #f0a020;border-radius:4px;}`;
    document.head.appendChild(hl);
    injectAll();
    new MutationObserver(() => scheduleInject()).observe(document.body, {
      childList: true, subtree: true,
    });
  };

  boot();
})();
