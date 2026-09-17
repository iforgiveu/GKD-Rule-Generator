// ==UserScript==
// @name         GKD Snapshot 规则生成器
// @namespace    https://i.gkd.li/
// @version      1.20.0
// @description  在 i.gkd.li 快照页添加：🔆 生成规则复制到剪贴板；🔰 粘贴进所在 app-panel 的编辑框；❌ 清空该编辑框；🔱 切换 text/desc 匹配模式 + fastQuery 开关（可快速查询的目标不写节点名，弱目标恒写）+ 仅生成 rule 项开关 + 🔀 关系选择器锚点（模拟点击读取锚点真实属性精确归属，目标恒在末尾，弱中间节点折叠为精确深度 >K；跨树追踪拆分为上/下索引：兄侧强锚点 +(m) / 弟侧强锚点 -(m) 跳兄弟后 >K 下行到目标，_pid/index 交叉校验方向）+ 📐 弱目标几何约束开关（默认关；开后仅在存在同名兄弟歧义时追加 width/height，缺失才回退 left/top，保持精简）+ 💭 打开 GKD 匹配符与参数教程（含 action 点击类型与 position 章节）+ 📏 position 生成器（快照图选点生成 action/position 片段，可复制/粘贴进规则编辑框）
// @match        https://i.gkd.li/snapshot/*
// @match        https://i.gkd.li/i/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  const BTN_ID = 'gkd-rule-gen-btn'; 
  const BTN_PASTE_ID = 'gkd-rule-paste-btn'; 
  const BTN_CLEAR_ID = 'gkd-rule-clear-btn'; 
  const BTN_MODE_ID = 'gkd-rule-mode-btn'; 
  const BTN_HELP_ID = 'gkd-rule-help-btn'; 
  const BTN_GEO_ID = 'gkd-rule-geo-btn'; 
  let selReady = false; 
  function updateSelState() {
    selReady = !!readProps();
    return selReady;
  }
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
  function esc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
  function escBacktick(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  }
  const MODE_KEY = 'gkd_match_mode_v1';
  const MODES = [
    { key: 'exact', op: '', label: '精确 =', tip: '完全等于' },
    { key: 'contains', op: '*', label: '包含 *=', tip: '包含该文本' },
    { key: 'startsWith', op: '^', label: '前缀 ^=', tip: '以该文本开头' },
    { key: 'endsWith', op: '$', label: '后缀 $=', tip: '以该文本结尾' },
    { key: 'regex', op: '~', label: '正则 ~=', tip: 'Java 正则匹配' },
  ];
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
    } catch (e) {  }
  }
  function saveMode() {
    try {
      localStorage.setItem(MODE_KEY, JSON.stringify({
        ...matchMode, fastQuery: fastQueryOn, ruleOnly: ruleOnlyOn, relation: relationMode, geo: geoOn,
      }));
    } catch (e) {  }
  }
  function buildMatchExpr(attr, value, modeKey) {
    const mode = MODES.find(m => m.key === modeKey) || MODES[0];
    if (mode.op === '~=') {
      return `[${attr}~=\`${escBacktick(value)}\`]`;
    }
    return `[${attr}${mode.op}="${esc(value)}"]`;
  }
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
  function readPropsFor(nodeId) {
    if (nodeId == null) return null;
    for (const tb of document.querySelectorAll('table.n-table')) {
      const p = parseTable(tb);
      if (p && String(p._id) === String(nodeId)) return p;
    }
    return null;
  }
  function readProps() {
    const sel = document.querySelector('.n-tree-node--selected');
    const p = sel ? readPropsFor(sel.dataset.nodeId) : null;
    if (p) return p;
    return parseTable(document.querySelector('table.n-table'));
  }
  function clickTreeNode(el) {
    el.querySelector('.n-tree-node-content')?.click();
  }
  async function waitPropsFor(nodeId, timeout = 1500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const p = readPropsFor(nodeId);
      if (p) return p;
      await new Promise(r => setTimeout(r, 40));
    }
    return null;
  }
  async function resolveNodeProps(infos) {
    const out = new Map();
    if (!infos || !infos.length) return out;
    const sel = document.querySelector('.n-tree-node--selected');
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
      if (sel && document.body.contains(sel)) {
        clickTreeNode(sel);
        await waitPropsFor(sel.dataset.nodeId, 600);
      }
    }
    return out;
  }
  const IDENT_RE = /^[_a-zA-Z][_a-zA-Z0-9]*$/;
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
  function isStrongExpr(expr) {
    return /\[(?:vid|id|text|desc)[!~^$*|]?=/.test(expr || '');
  }
  function hasSameNameSibling() {
    const sel = document.querySelector('.n-tree-node--selected');
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
  function getTreeContext() {
    const sel = document.querySelector('.n-tree-node--selected');
    if (!sel) return null;
    const nodes = [...document.querySelectorAll('.n-tree-node')];
    const selIdx = nodes.indexOf(sel);
    if (selIdx < 0) return null;
    const selDepth = treeNodeDepth(sel);
    const ancestors = [];
    let expect = selDepth - 1;
    for (let i = selIdx - 1; i >= 0 && expect >= 0; i--) {
      const d = treeNodeDepth(nodes[i]);
      if (d === expect) {
        ancestors.push(nodeToInfo(nodes[i]));
        expect--;
      } else if (d < expect) break;
    }
    const prevSiblings = [];
    for (let i = selIdx - 1; i >= 0; i--) {
      const d = treeNodeDepth(nodes[i]);
      if (d < selDepth) break;
      if (d === selDepth) prevSiblings.push(nodeToInfo(nodes[i]));
    }
    const nextSiblings = [];
    for (let i = selIdx + 1; i < nodes.length; i++) {
      const d = treeNodeDepth(nodes[i]);
      if (d < selDepth) break;
      if (d === selDepth) nextSiblings.push(nodeToInfo(nodes[i]));
    }
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
      } else if (/^android:id\
        parts.push(`[id="${esc(t)}"]`);
      } else {
        parts.push(`[vid="${esc(t)}" || text="${esc(t)}" || desc="${esc(t)}"]`);
      }
    } else if (info.childCount >= 2) {
      parts.push(`[childCount=${info.childCount}]`);
    }
    const expr = (shortName || '') + parts.join('');
    return expr || null;
  }
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
  async function tryApplyRelation(baseExpr, p, hasRealDistinction) {
    if (relationMode === 'off' || !baseExpr) return null;
    if (relationMode === 'auto' && hasRealDistinction) return null;
    const ctx = getTreeContext(); 
    if (!ctx) return null;
    const parentValid = (info) => info && (info.nodeId == null || p._pid == null || String(info.nodeId) === String(p._pid));
    const prevAnchor = async () => {
      const pick = ctx.prevSiblings.find(s => s.tail);
      if (!pick) return null;
      const gap = ctx.prevSiblings.indexOf(pick) + 1;
      const pm = await resolveNodeProps([pick]);
      const a = buildAnchorExpr(pick, pm.get(String(pick.nodeId)));
      if (!a) return null;
      return gap === 1 ? `${a} + ${baseExpr}` : `${a} +(${gap}) ${baseExpr}`;
    };
    const nextAnchor = async () => {
      const pick = ctx.nextSiblings.find(s => s.tail);
      if (!pick) return null;
      const gap = ctx.nextSiblings.indexOf(pick) + 1;
      const pm = await resolveNodeProps([pick]);
      const a = buildAnchorExpr(pick, pm.get(String(pick.nodeId)));
      if (!a) return null;
      return gap === 1 ? `${a} - ${baseExpr}` : `${a} -(${gap}) ${baseExpr}`;
    };
    const vertAnchor = async () => {
      if (!ctx.ancestors.length) return null;
      let pick = ctx.ancestors.findIndex(x => x.tail);
      if (pick < 0) pick = 0;
      const info = ctx.ancestors[pick];
      if (pick === 0) {
        if (!parentValid(info)) return null;
        const pm = await resolveNodeProps([info]);
        const a = buildAnchorExpr(info, pm.get(String(info.nodeId)));
        return a ? `${a} > ${baseExpr}` : null;
      }
      if (!parentValid(ctx.ancestors[0])) {
        const pm = await resolveNodeProps([info]);
        const a = buildAnchorExpr(info, pm.get(String(info.nodeId)));
        return a ? `${a} >n ${baseExpr}` : null;
      }
      const seq = [info, ...ctx.ancestors.slice(0, pick).reverse()];
      const pm = await resolveNodeProps(seq.filter(x => x.tail));
      const a = buildAnchorExpr(info, pm.get(String(info.nodeId)));
      if (!a) return null;
      return collapseChain(seq, a, baseExpr, pm);
    };
    const descAnchor = async () => {
      const pick = ctx.descendants.find(s => s.tail);
      if (!pick) return null;
      const pm = await resolveNodeProps([pick]);
      const a = buildAnchorExpr(pick, pm.get(String(pick.nodeId)));
      if (!a) return null;
      const direct = pick.depth === ctx.selfDepth + 1;
      return direct ? `${a} <n ${baseExpr}` : `${a} <<n ${baseExpr}`;
    };
    const crossTreeAnchor = async (dir) => {
      if (ctx.ancestors.length && !parentValid(ctx.ancestors[0])) return null;
      const nodes = [...document.querySelectorAll('.n-tree-node')];
      if (!nodes.length) return null;
      const infos = nodes.map(nodeToInfo);
      const idxById = new Map();
      nodes.forEach((el, i) => {
        const id = el?.dataset?.nodeId;
        if (id != null) idxById.set(String(id), i);
      });
      const mounts = [];
      const selfIdx = ctx.self.nodeId != null ? idxById.get(String(ctx.self.nodeId)) : undefined;
      if (selfIdx != null) mounts.push({ info: ctx.self, idx: selfIdx, upSteps: 0 });
      for (const anc of ctx.ancestors) {
        if (anc.nodeId == null) continue;
        const i = idxById.get(String(anc.nodeId));
        if (i == null) continue;
        let contiguous = true;
        for (let d = ctx.selfDepth - 1, t = 0; d >= anc.depth; d--, t++) {
          if (!ctx.ancestors[t] || ctx.ancestors[t].depth !== d) { contiguous = false; break; }
        }
        if (contiguous) mounts.push({ info: anc, idx: i, upSteps: ctx.selfDepth - anc.depth });
      }
      if (!mounts.length) return null;
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
      const sameParentRun = (i, j) => {
        if (i === j) return true;
        const d = infos[i].depth;
        if (infos[j].depth !== d) return false;
        const lo = Math.min(i, j), hi = Math.max(i, j);
        for (let t = lo + 1; t < hi; t++) if (infos[t].depth < d) return false;
        return true;
      };
      const excluded = new Set(mounts.map(m => String(m.info.nodeId)));
      for (const dsc of ctx.descendants) {
        if (dsc.nodeId != null) excluded.add(String(dsc.nodeId));
      }
      const cands = [];
      for (let i = 0; i < infos.length; i++) {
        const s = infos[i];
        if (!s.tail) continue;
        if (s.nodeId != null && excluded.has(String(s.nodeId))) continue;
        const up = [{ info: s, idx: i }];
        let expect = s.depth - 1;
        for (let j = i - 1; j >= 0 && expect >= 0; j--) {
          if (infos[j].depth === expect) { up.push({ info: infos[j], idx: j }); expect--; }
          else if (infos[j].depth < expect) break;
        }
        for (let k = 0; k < up.length; k++) {
          const a = up[k];
          for (const mt of mounts) {
            if (a.idx === mt.idx) continue;
            if (!sameParentRun(a.idx, mt.idx)) continue;
            const oa = ordAt(a.idx), ob = ordAt(mt.idx);
            if (dir === 'up' ? oa >= ob : oa <= ob) continue;
            const m = Math.abs(ob - oa);
            if (m < 1) continue;
            cands.push({ sIdx: i, k, up, a, mount: mt, m, cost: k + m + mt.upSteps });
          }
        }
      }
      if (!cands.length) return null;
      cands.sort((x, y) => x.cost - y.cost || x.m - y.m || x.k - y.k);
      for (const c of cands.slice(0, 4)) {
        const sInfo = infos[c.sIdx];
        const aInfo = c.a.info;
        const bInfo = c.mount.info;
        const isSelfMount = c.mount.upSteps === 0; 
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
        if (aProps && bProps && aProps._pid != null && bProps._pid != null
          && String(aProps._pid) !== String(bProps._pid)) continue;
        let m = c.m;
        if (aProps && bProps && typeof aProps.index === 'number' && typeof bProps.index === 'number') {
          m = Math.abs(bProps.index - aProps.index);
          const aBefore = aProps.index < bProps.index;
          if (dir === 'up' ? !aBefore : aBefore) continue;
        }
        if (m < 1) continue;
        const sExpr = buildAnchorExpr(sInfo, sProps);
        if (!sExpr) continue;
        const weakMid = (info, props) => buildAnchorExpr(info, props) || '*';
        let out = sExpr;
        if (c.k >= 1) {
          for (let t = 1; t < c.k; t++) out += ' <n ' + weakMid(c.up[t].info, null);
          out += ' <n ' + weakMid(aInfo, aProps);
        }
        const hop = (m === 1 ? (dir === 'up' ? ' + ' : ' - ') : ` ${dir === 'up' ? '+' : '-'}(${m}) `);
        if (isSelfMount) {
          out += hop + baseExpr;
        } else {
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
    return (await prevAnchor()) || (await vertAnchor())
      || (await crossTreeAnchor('up')) || (await crossTreeAnchor('down'))
      || (await descAnchor()) || (await nextAnchor());
  }
  async function buildMatches(p) {
    const parts = [];
    let shortName = '';
    if (p.name && !fastQueryOn) {
      const tail = String(p.name).split('.').pop();
      if (IDENT_RE.test(tail)) {
        shortName = tail;
      } else {
        parts.push(`[name="${esc(p.name)}"]`);
      }
    }
    if (p.vid) parts.push(`[vid="${esc(p.vid)}"]`);
    else if (p.id) parts.push(`[id="${esc(p.id)}"]`);
    if (p.text != null) parts.push(buildMatchExpr('text', p.text, matchMode.text));
    if (p.desc != null) parts.push(buildMatchExpr('desc', p.desc, matchMode.desc));
    const hasRealDistinction = !!(
      p.vid || p.id
      || (p.text && String(p.text) !== '')
      || (p.desc && String(p.desc) !== '')
    );
    const base = (shortName ? shortName : '') + parts.join('');
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
    if (relationMode !== 'off') {
      const rel = await tryApplyRelation(hasRealDistinction ? base : weakExpr(), p, hasRealDistinction);
      if (rel) return rel;
    }
    if (!hasRealDistinction) return weakExpr();
    return base;
  }
  function getActivityId() {
    const divs = document.querySelectorAll('div.gkd_code div');
    const texts = [...divs].map((d) => d.innerText.trim()).filter(Boolean);
    let act = texts.find((t) => /^\.[\w$]+(\.[\w$]+)+$/.test(t));
    if (act) return act;
    act = texts.find((t) => /^[a-z][\w]*(\.[\w]+)*\.[A-Z][\w$]*$/.test(t));
    if (act) return act;
    return texts.find((t) => /^[a-z]+(\.[a-z0-9_]+){1,}$/.test(t)) || '';
  }
  async function buildRule() {
    const p = readProps(); 
    if (!p) return null;
    const activityId = getActivityId();
    const label = p.text || p.desc || (p.name ? p.name.split('.').pop() : '目标控件');
    const ruleItem = {
      key: 0,
      name: `关闭${label}`,
      matches: [await buildMatches(p)],
    };
    if (activityId) {
      ruleItem.activityIds = [activityId];
    }
    if (ruleOnlyOn) {
      return JSON.stringify(ruleItem, null, 2);
    }
    const rule = {
      key: 0,
      name: `关闭${label}`,
      desc: `关闭${label}`,
      actionMaximum: 1,
    };
    if (fastQueryOn) rule.fastQuery = true;
    rule.rules = [ruleItem];
    return JSON.stringify(rule, null, 2);
  }
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
  function toast(msg, type = 'ok') {
    const bg = type === 'ok' ? '#18a058' : type === 'warn' ? '#f0a020' : '#d03050';
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed',
      'z-index:9999999',
      'left:50%',
      'top:20px',
      'transform:translateX(-50%)',
      'padding:8px 16px',
      `background:${bg}`,
      'color:#fff',
      'border-radius:4px',
      'font-size:13px',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)',
      'transition:opacity .3s',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
    }, 1500);
    setTimeout(() => t.remove(), 1900);
  }
  function removeMenu() {
    document.getElementById('gkd-mode-menu')?.remove();
  }
  function menuSectionLabel(text) {
    const section = document.createElement('div');
    section.style.cssText = 'padding:4px 10px 2px;font-size:11px;color:#888;border-bottom:none;';
    section.textContent = text;
    return section;
  }
  function menuToggleRow(labelText, isOn, onText, offText, onToggle) {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex',
      'justify-content:space-between',
      'align-items:center',
      'padding:6px 10px',
      'border-radius:4px',
      'cursor:pointer',
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
  function menuOptionRow(selected, labelText, tipText, onSelect) {
    const item = document.createElement('div');
    item.style.cssText = [
      'padding:6px 10px',
      'border-radius:4px',
      'cursor:pointer',
      'display:flex',
      'justify-content:space-between',
      'align-items:center',
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
      'position:fixed',
      'z-index:9999998',
      'min-width:230px',
      'max-height:calc(100vh - 16px)',
      'overflow-y:auto',
      'overflow-x:hidden',
      'background:#fff',
      'border:1px solid #e0e0e6',
      'border-radius:6px',
      'box-shadow:0 4px 16px rgba(0,0,0,.15)',
      'padding:4px',
      'font-size:13px',
      'color:#333',
    ].join(';');
    const title = document.createElement('div');
    title.textContent = '规则生成器设置';
    title.style.cssText = 'padding:6px 10px;font-weight:600;color:#666;font-size:12px;border-bottom:1px solid #eee;margin-bottom:4px;';
    menu.appendChild(title);
    menu.appendChild(menuSectionLabel('生成内容'));
    menu.appendChild(menuToggleRow(
      '⚡ fastQuery',
      fastQueryOn,
      '✅ 开启（可查目标不写节点名）',
      '⛔ 关闭（一律写节点名）',
      () => {
        fastQueryOn = !fastQueryOn;
        saveMode();
        toast(fastQueryOn ? '✅ fastQuery 开启：可快速查询的目标不写节点名（弱目标仍写，零损失）' : '✅ fastQuery 关闭：不含 fastQuery，所有目标写节点名');
        removeMenu();
        updateModeBtnTitle();
        refreshAll();
      }
    ));
    menu.appendChild(menuToggleRow(
      '🧩 仅生成 rule 项',
      ruleOnlyOn,
      '✅ 开启（只输出 rules[0]）',
      '⛔ 关闭（完整规则组）',
      () => {
        ruleOnlyOn = !ruleOnlyOn;
        saveMode();
        toast(ruleOnlyOn ? '✅ 仅生成 rule 项：输出内层规则对象（key/name/matches/activityIds）' : '✅ 完整规则组：输出含 actionMaximum/fastQuery/rules 的完整对象');
        removeMenu();
        updateModeBtnTitle();
        refreshAll();
      }
    ));
    menu.appendChild(menuToggleRow(
      '📐 弱目标几何约束',
      geoOn,
      '✅ 开启（仅同名兄弟歧义时加 w/h）',
      '⛔ 关闭（精简，只 index 兜底）',
      () => {
        geoOn = !geoOn;
        saveMode();
        toast(geoOn ? '✅ 几何约束开启：仅当弱目标存在同名兄弟时追加 width/height（缺失才回退 left/top），保持精简' : '✅ 几何约束关闭：弱目标仅 节点名+visibleToUser+index+空串约束，最精简');
        removeMenu();
        updateModeBtnTitle();
        refreshAll();
      }
    ));
    const sep1 = document.createElement('div');
    sep1.style.cssText = 'border-bottom:1px solid #eee;margin:4px 0;';
    menu.appendChild(sep1);
    menu.appendChild(menuSectionLabel('🔀 关系选择器锚点（目标恒在末尾）'));
    RELATION_MODES.forEach((m) => {
      menu.appendChild(menuOptionRow(
        relationMode === m.key,
        m.label,
        m.tip,
        () => {
          relationMode = m.key;
          saveMode();
          removeMenu();
          updateModeBtnTitle();
          toast(`✅ 关系锚点切换为 ${m.label}`);
        }
      ));
    });
    const sep2 = document.createElement('div');
    sep2.style.cssText = 'border-bottom:1px solid #eee;margin:4px 0;';
    menu.appendChild(sep2);
    ['text', 'desc'].forEach((attr) => {
      menu.appendChild(menuSectionLabel(attr === 'text' ? 'text 匹配模式' : 'desc 匹配模式'));
      MODES.forEach((m) => {
        menu.appendChild(menuOptionRow(
          matchMode[attr] === m.key,
          m.label,
          m.tip,
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
    btn.title = `生成器设置（点击切换）\ntext: ${t.label} — ${t.tip}\ndesc: ${d.label} — ${d.tip}\nfastQuery: ${fastQueryOn ? '开启（可查目标不写节点名，弱目标恒写）' : '关闭（写节点名）'}\n仅生成 rule 项: ${ruleOnlyOn ? '开启（只输出 rules[0]）' : '关闭（完整规则组）'}\n弱目标几何约束: ${geoOn ? '开启（仅同名兄弟歧义时加 width/height）' : '关闭（精简）'}\n关系锚点: ${r.label} — ${r.tip}`;
  }
  function removeHelp() {
    document.getElementById('gkd-help-panel')?.remove();
    document.getElementById('gkd-help-mask')?.remove();
  }
  function buildHelpPanel() {
    removeHelp();
    const CFG = {
      panelMaxWidth: 1100,   
      vwPercent: 94,         
      panelMaxHeightVh: 92,  
      panelTopVh: 4,         
      fsTitle: 24,           
      fsHead: 21,            
      fsBody: 18,            
      fsCode: 16,            
      fsTable: 17,           
      fsFootnote: 16,        
      fsLink: 16,            
      fsCloseBtn: 17,        
      lhBody: 1.8,           
      lhPre: 1.7,            
    };
    const mask = document.createElement('div');
    mask.id = 'gkd-help-mask';
    mask.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:rgba(0,0,0,.35)',
      'z-index:9999990',
    ].join(';');
    mask.addEventListener('click', removeHelp);
    document.body.appendChild(mask);
    const panel = document.createElement('div');
    panel.id = 'gkd-help-panel';
    panel.style.cssText = [
      'position:fixed',
      'z-index:9999991',
      `top:${CFG.panelTopVh}vh`,
      'left:50%',
      'transform:translateX(-50%)',
      `width:min(${CFG.panelMaxWidth}px,${CFG.vwPercent}vw)`,
      `max-height:${CFG.panelMaxHeightVh}vh`,
      'background:#fff',
      'border-radius:10px',
      'box-shadow:0 8px 32px rgba(0,0,0,.28)',
      'display:flex',
      'flex-direction:column',
      'font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    ].join(';');
    const head = document.createElement('div');
    head.style.cssText = [
      'padding:16px 20px',
      'border-bottom:1px solid #eee',
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'flex:none',
    ].join(';');
    head.innerHTML = `
      <div style="font-weight:600;font-size:${CFG.fsTitle}px;color:#333;">📖 GKD 选择器 · 匹配符与参数教程</div>
      <div style="display:flex;gap:14px;align-items:center;">
        <a href="https:
        <button id="gkd-help-close" style="border:none;background:#f3f3f5;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:${CFG.fsCloseBtn}px;">✕ 关闭</button>
      </div>
    `;
    panel.appendChild(head);
    head.querySelector('#gkd-help-close').addEventListener('click', removeHelp);
    const body = document.createElement('div');
    body.style.cssText = [
      'padding:16px 22px',
      'overflow:auto',
      'flex:1',
      'min-height:0',
      `font-size:${CFG.fsBody}px`,
      `line-height:${CFG.lhBody}`,
      'color:#333',
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
      <p>📌 <code style="${codeStyle}">@</code> 标记"要点击的目标节点"，没有 <code style="${codeStyle}">@</code> 时默认取<b>最后一个</b>属性选择器——本脚本所有锚点模式（含跨树上/下索引）均把目标固定在末尾，因此无需 <code style="${codeStyle}">@</code>。节点名可简写：<code style="${codeStyle}">TextView</code> 等价于 <code style="${codeStyle}">[name='TextView' || name$='.TextView']</code>；<code style="${codeStyle}">*</code> 表示任意 name。</p>
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
        <tr><td style="${tdStyle}"><code style="${codeStyle}">&gt;</code></td><td style="${tdStyle}">A 是 B 的祖先（按 depth 约束，&gt;n 表示任意祖先）</td><td style="${tdStyle}"><code style="${codeStyle}">LinearLayout &gt; ImageView</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">&lt;</code></td><td style="${tdStyle}">A 是 B 的直接子节点（<code>&lt;</code> 限首个子节点，<code>&lt;n</code> 任意位置，<code>&lt;3</code> 第 3 个）</td><td style="${tdStyle}"><code style="${codeStyle}">FrameLayout[vid='content'] &lt;n ImageView</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">+</code></td><td style="${tdStyle}">A 是 B 的前置兄弟（+(n) 表示前面第 n 个）</td><td style="${tdStyle}"><code style="${codeStyle}">ViewGroup + LinearLayout[vid='item']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">-</code></td><td style="${tdStyle}">A 是 B 的后置兄弟（-(n) 表示后面第 n 个）</td><td style="${tdStyle}"><code style="${codeStyle}">[vid='cover'] - [vid='title']</code></td></tr>
        <tr><td style="${tdStyle}"><code style="${codeStyle}">&lt;&lt;n</code></td><td style="${tdStyle}">A 是 B 的任意层级后代（B 是 A 的祖先）</td><td style="${tdStyle}"><code style="${codeStyle}">@[text='跳过'] &lt;&lt;n [vid='root']</code></td></tr>
      </table>
      <p>支持 <code style="${codeStyle}">&gt;n</code>（任意祖先）、<code style="${codeStyle}">&gt;3</code>、<code style="${codeStyle}">+(2,4,6)</code> 元组等写法，参考 CSS <code style="${codeStyle}">:nth(an+b)</code>。四种关系的官方语义（以 A 在左、B 在右）：</p>
      <pre style="${preStyle}">A +(an+b) B : A.index = B.index-(an+b) → A 在 B 前面
A -(an+b) B : A.index = B.index+(an+b) → A 在 B 后面
A &gt; B : A 是 B 的祖先
A &lt; B : A 是 B 的直接子节点（且 A.index=0）</pre>
      <p>🔀 本脚本 🔱 菜单的"关系锚点"会自动为目标附加父/兄弟/祖先/后代锚点，生成策略：<b>目标属性选择器恒定在末尾</b>（<code style="${codeStyle}">锚点 +(n) 目标</code> / <code style="${codeStyle}">锚点 -(n) 目标</code> / <code style="${codeStyle}">锚点 &gt; 强中间 &gt;K 目标</code> / <code style="${codeStyle}">锚点 &lt;n·&lt;&lt;n 目标</code>），作为快速查询入口，因此无需 <code style="${codeStyle}">@</code> 标记；锚点属性通过模拟点击读取真实属性表精确归属（vid/desc/text 不再靠猜），读取失败时回退 <code style="${codeStyle}">[vid='x' || text='x' || desc='x']</code> 兜底；含强属性的中间节点保留，仅类名/[childCount] 的弱中间节点折叠为精确深度 <code style="${codeStyle}">&gt;K</code>。</p>
      <p>🔀 v1.15 新增<b>跨树追踪锚点</b>（拆分为上/下索引两方向），专治目标及其祖先全无特征、但旁支子树里存在强节点的场景：设目标在 b 的子树中，强节点在 b 的兄 a 的子树（上索引）或弟 c 的子树（下索引）里，生成——</p>
      <pre style="${preStyle}">上索引（兄侧）：[强锚点] &lt;n 弱中间… &lt;n a +(m) 挂载b &gt;K 目标
下索引（弟侧）：[强锚点] &lt;n 弱中间… &lt;n c -(m) 挂载b &gt;K 目标</pre>
      <p>其中 m 为 a/c 与 b 的真实兄弟间隔（中间夹的其它兄弟也计入），上下行代差任意（<code style="${codeStyle}">&lt;n</code> 逐级上行 / <code style="${codeStyle}">&gt;K</code> 精确深度下行）；a/b 兄弟关系经点击读取双方 <code style="${codeStyle}">_pid</code>/<code style="${codeStyle}">index</code> 交叉校验，方向不符自动换次优候选；目标恒在末尾，目标自身带 vid/text 时照常享受快速查询，弱目标时 fastQuery 静默回退普通遍历（不报错）。</p>
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
      <pre style="${preStyle}">[id='abc']  [vid='abc']  [text='abc']  [text^='abc']  [text*='abc']  [text$='abc']</pre>
      <p>用 <code style="${codeStyle}">||</code> 连接上述结构也算符合。如果末尾选择器不符合这些格式，fastQuery 会被忽略（自动回退普通遍历，不会报错）。另外 vid/id/text 表达式必须放在 <code style="${codeStyle}">[]</code> 内<b>第一个</b>位置：<code style="${codeStyle}">C[id='x'][childCount=2]</code> ✅、<code style="${codeStyle}">C[childCount=2][id='x']</code> ❎。此外 <code style="${codeStyle}">&lt;&lt;n</code> 链条支持分段快速查询（如 <code style="${codeStyle}">C[id='x'] &lt;&lt;n D</code> 会先快速查 C 再在其子树内搜 D）。</p>
      <p>💡 本脚本的 🔱 菜单"生成内容"分组里有三个开关：<b>⚡ fastQuery</b>——开启时规则组输出 <code style="${codeStyle}">"fastQuery": true</code> 且可快速查询的目标不写节点名（仅空 text 的弱目标仍写节点名，因其无法快速查询，写了零损失）；关闭时不输出 fastQuery，所有目标写节点名简写。<b>🧩 仅生成 rule 项</b>——开启时只输出内层规则对象（key/name/matches/activityIds），适合直接粘进已有规则的 rules 数组；关闭时输出含 actionMaximum/fastQuery/rules 的完整规则组。<b>📐 弱目标几何约束</b>（v1.18，默认关）——开启后仅当弱目标存在<b>同名兄弟</b>（同步扫树检测到的真实歧义）时追加 <code style="${codeStyle}">[width=..][height=..]</code>，w/h 缺失才回退 left/top；无同名兄弟时 index 一条即可区分，什么都不加，保持精简。🔀 所有关系锚点模式（含跨树上/下索引）均把目标放在末尾：目标强则末尾即快速查询入口；跨树模式遇到弱目标时 fastQuery 被静默忽略、回退普通遍历，链本身完全有效。</p>
      <div style="${hStyle}">7️⃣ 实战小技巧</div>
      <ul style="margin:6px 0 10px 24px;padding:0;">
        <li>广告"关闭"按钮文字常变化 → 用 <code style="${codeStyle}">[text*='关闭']</code> 或 <code style="${codeStyle}">[text~='关闭(广告|弹窗)?']</code></li>
        <li>"跳过 X 秒"按钮 → 用 <code style="${codeStyle}">[text~='跳过\\\\s*\\\\d+']</code> 而不是精确匹配</li>
        <li>节点没有可用属性 → 用父/祖先关系+位置兜底：<code style="${codeStyle}">[vid='ad_root'] &gt; ImageView[index=2]</code>；若全链无特征但旁支子树里有强节点，用 🔱 菜单的 🔀 跨树上/下索引锚点自动生成追踪链</li>
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
      <pre style="${preStyle}">{
  matches: '[vid="ad_container"]',
  action: 'clickCenter',
  position: { right: 'width*0.1', top: 'height*0.1' },  
}</pre>
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
      <pre style="${preStyle}">
{ left: 'width/2', top: 'height/2' }
{ left: 0, top: 0 }
{ right: 'width*0.1352', top: 'width*0.0852' }
{ x: 'screenWidth/2', y: 'screenHeight/2' }</pre>
      <p>💡 与本工具的联动：生成器命中的常是大容器（如 <code style="${codeStyle}">[vid='ad_root']</code>），而真正的关闭按钮往往在容器的某个角落且本身无特征——此时不必费力选择更深的子节点，直接在 rules 项里追加 <code style="${codeStyle}">action: 'clickCenter'</code> + <code style="${codeStyle}">position: { right: 'width*0.1', top: 'height*0.1' }</code>（按快照里关闭按钮的实际相对位置调整系数）即可命中角落热区。另一类场景是目标卡片 <code style="${codeStyle}">clickable=false</code>、热区在内部子节点上，用 position 精确点热区可绕过不可点限制。本工具新增的 <b>📏 position 生成器</b>（按钮在左侧工具栏 🔱 下方和各面板 🔆 🔰 中间）就是干这个的：点开 📏 出现小面板，把光标移到快照大图目标点上单击，即自动读取悬浮层右下角的归一化坐标（xper/yper）生成 <code style="${codeStyle}">"action": 'clickCenter', "position": { left: 'width*xper', bottom: 'height*yper' }</code> 片段，🖋 复制或 📝 直粘进规则编辑框（已有文本时自动插到 "activityIds" 行之前，夹在 matches 与 activityIds 中间）。</p>
      <div style="margin-top:16px;padding:12px 16px;background:#f6ffed;border:1px solid #b7eb8f;border-radius:6px;font-size:${CFG.fsFootnote}px;color:#555;">
        📌 以上内容整理自
        <a href="https:
        <a href="https:
        <a href="https:
        <a href="https:
        <a href="https:
        完整语法以官方文档为准。
      </div>
    `;
    panel.appendChild(body);
    document.body.appendChild(panel);
  }
  const GEO_PANEL_ID = 'gkd-geo-panel';
  let positionText = ''; 
  let geoDocClickHandler = null;
  function removeGeoPanel() {
    document.getElementById(GEO_PANEL_ID)?.remove();
    if (geoDocClickHandler) {
      document.removeEventListener('click', geoDocClickHandler, true);
      geoDocClickHandler = null;
    }
  }
  function findScreenshotImg() {
    return document.querySelector('img[class*="max-w-[calc"]')
      || document.querySelector('body > div:nth-child(1) > div > div:nth-child(2) > img')
      || null;
  }
  function readHoverXY() {
    const overlay = document.querySelector('div.MiniHoverImg.app-panel');
    if (!overlay) return null;
    const box = overlay.children[3]; 
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
  function pastePositionIntoEditor() {
    if (!positionText) { toast('⚠️ 尚未生成 position，请先在快照图上选点', 'warn'); return; }
    const panels = [...document.querySelectorAll('div.app-panel')];
    const target = panels.find(p => p.innerText.includes('规则静态诊断'))
      || panels.find(p => p.querySelector(`#${BTN_ID}`));
    if (!target) { toast('❌ 未找到含「规则静态诊断」的 app-panel', 'err'); return; }
    const ta = target.querySelector('textarea.n-input__textarea-el');
    if (!ta) { toast('❌ 该面板内没有编辑框，请先打开编辑界面', 'err'); return; }
    const cur = ta.value;
    let newText, caretPos;
    if (cur.trim() === '') {
      newText = positionText;
      caretPos = newText.length;
    } else {
      const lines = cur.split('\n');
      const idx = lines.findIndex(l => l.includes('"activityIds"'));
      if (idx >= 0) {
        lines.splice(idx, 0, positionText); 
        newText = lines.join('\n');
        let off = 0;
        for (let i = 0; i < idx; i++) off += lines[i].length + 1;
        caretPos = off + positionText.length;
      } else {
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
      'position:fixed',
      'z-index:9999992',
      'right:16px',
      'top:64px',
      'width:360px',
      'max-width:92vw',
      'background:#fff',
      'border:1px solid #e0e0e6',
      'border-radius:8px',
      'box-shadow:0 4px 16px rgba(0,0,0,.15)',
      'padding:10px 12px',
      'font-size:13px',
      'color:#333',
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
      'background:#f6f6f8',
      'border-radius:6px',
      'padding:8px 10px',
      'white-space:pre-wrap',
      'word-break:break-all',
      'margin:0 0 8px',
      'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
      'font-size:13px',
      'line-height:1.6',
      'min-height:52px',
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
      if (!positionText) { toast('⚠️ 尚未生成 position，请先在快照图上选点', 'warn'); return; }
      const ok = await copyText(positionText);
      toast(ok ? '✅ position 已复制到剪贴板' : '❌ 复制失败', ok ? 'ok' : 'err');
    }));
    row.appendChild(mkBtn('📝 粘贴到编辑框', '#2080f0', () => pastePositionIntoEditor()));
    panel.appendChild(row);
    document.body.appendChild(panel);
    updateGeoPanelContent();
    geoDocClickHandler = (e) => {
      if (e.target.closest(`#${GEO_PANEL_ID}`)) return; 
      const img = findScreenshotImg();
      if (!img) return;
      if (e.target !== img && !img.contains(e.target)) return; 
      const xy = readHoverXY();
      if (!xy) { toast('❌ 未能读取悬浮层坐标（MiniHoverImg 不存在或数据缺失）', 'err'); return; }
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
      updateSelState();
      if (!selReady) {
        toast('⚠️ 请先在左侧快照树中选中一个节点', 'warn');
        return;
      }
      if (document.getElementById(GEO_PANEL_ID)) { removeGeoPanel(); return; }
      buildGeoPanel();
    });
    return btn;
  }
  function styleBtn(btn) {
    btn.style.cssText = [
      'width:36px',
      'height:36px',
      'border:none',
      'background:transparent',
      'font-size:18px',
      'line-height:1',
      'cursor:pointer',
      'border-radius:4px',
      'opacity:.85',
      'transition:opacity .2s, background .2s',
      'padding:0',
      'flex:none',
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'user-select:none',
      'margin-left:0',
    ].join(';');
    btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = '#f3f3f5'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
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
      updateSelState();
      const ruleText = await buildRule();
      if (!ruleText) {
        toast('⚠️ 请先在左侧快照树中选中一个节点', 'warn');
        refreshAll(); 
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
  function refreshAll() {
    updateSelState(); 
    document.querySelectorAll(`#${BTN_ID}, #${BTN_PASTE_ID}, #${BTN_GEO_ID}`).forEach((btn) => {
      btn.disabled = !selReady;
      btn.style.opacity = selReady ? '1' : '.35';
      btn.style.cursor = selReady ? 'pointer' : 'not-allowed';
    });
    updateModeBtnTitle();
    document.querySelectorAll(`#${BTN_CLEAR_ID}`).forEach((btn) => {
      const panel = btn.closest('div.app-panel');
      const hasEditor = !!(panel && panel.querySelector('textarea.n-input__textarea-el'));
      btn.disabled = !hasEditor;
      btn.style.opacity = hasEditor ? '1' : '.35';
      btn.style.cursor = hasEditor ? 'pointer' : 'not-allowed';
    });
  }
  function injectSidebar() {
    const bar = document.querySelector('div[class*="--svg-h:24px"]');
    if (!bar) return;
    let copyBtn = bar.querySelector(`#${BTN_ID}`);
    if (!copyBtn) {
      copyBtn = createCopyBtn();
      bar.appendChild(copyBtn);
    }
    let modeBtn = bar.querySelector(`#${BTN_MODE_ID}`);
    if (!modeBtn) {
      modeBtn = createModeBtn();
      copyBtn.after(modeBtn);
    } else if (modeBtn.previousElementSibling !== copyBtn) {
      copyBtn.after(modeBtn);
    }
    let geoBtn = bar.querySelector(`#${BTN_GEO_ID}`);
    if (!geoBtn) {
      geoBtn = createGeoBtn();
      modeBtn.after(geoBtn);
    } else if (geoBtn.previousElementSibling !== modeBtn) {
      modeBtn.after(geoBtn);
    }
    let helpBtn = bar.querySelector(`#${BTN_HELP_ID}`);
    if (!helpBtn) {
      helpBtn = createHelpBtn();
      geoBtn.after(helpBtn);
    } else if (helpBtn.previousElementSibling !== geoBtn) {
      geoBtn.after(helpBtn);
    }
  }
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
      if (!copyBtn) {
        tag.after(createCopyBtn());
      } else if (copyBtn.previousElementSibling !== tag) {
        tag.after(copyBtn);
      }
      const copyEl = panel.querySelector(`#${BTN_ID}`);
      if (!geoBtn) {
        copyEl.after(createGeoBtn());
      } else if (geoBtn.previousElementSibling !== copyEl) {
        copyEl.after(geoBtn);
      }
      const geoEl = panel.querySelector(`#${BTN_GEO_ID}`);
      if (!pasteBtn) {
        geoEl.after(createPasteBtn());
      } else if (pasteBtn.previousElementSibling !== geoEl) {
        geoEl.after(pasteBtn);
      }
      const pasteEl = panel.querySelector(`#${BTN_PASTE_ID}`);
      if (!clearBtn) {
        pasteEl.after(createClearBtn());
      } else if (clearBtn.previousElementSibling !== pasteEl) {
        pasteEl.after(clearBtn);
      }
    });
  }
  function injectAll() {
    injectSidebar();
    injectAppPanels();
    refreshAll();
  }
  let injectPending = false;
  function scheduleInject() {
    if (injectPending) return;
    injectPending = true;
    requestAnimationFrame(() => {
      injectPending = false;
      injectAll();
    });
  }
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest?.('.n-tree-node') || t.closest?.('table.n-table')
      || (t.tagName === 'IMG' || t.closest?.('img'))) {
      setTimeout(refreshAll, 300);
      setTimeout(refreshAll, 800);
    }
  }, true);
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
  loadMode(); 
  const boot = () => {
    injectAll();
    new MutationObserver(() => scheduleInject()).observe(document.body, {
      childList: true,
      subtree: true,
    });
  };
  boot();
})();
