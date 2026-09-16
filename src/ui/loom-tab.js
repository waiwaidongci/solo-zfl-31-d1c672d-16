/* loom-tab.js — 上机织造页:经线映射 / 综框登记 / 穿筘 / 梭序 / 穿综图拖动 /
 * 开口序列展开 / 联查报告 / 织物模拟回放。计算全部委托给 LoomEngine(纯计算,与页面独立)。 */
(function () {
  "use strict";
  const ZFL = (window.ZFL = window.ZFL || {});
  const Engine = window.LoomEngine;
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "zfl31Loom";

  const L = {
    cfg: null,
    report: null,
    shed: null,
    dd: null,
    autoFailure: null,
    replay: { pick: 0, playing: false, timer: null },
    sel: { warp: -1 },
    hover: null, // 拖动中的目标 {frame} 或 {insertAt}
    drag: null,
    undo: [],
    redo: [],
    warpColor: 1, // 经线映射当前色
    prevDims: "",
    layouts: {},
    inited: false,
  };

  const pattern = () => ZFL.pattern;
  const W = () => Engine.bodyWarpCount(pattern(), L.cfg);
  const P = () => L.cfg.picks.length;

  // ---------------------------------------------------------------- 启动与持久化

  function boot() {
    loadConfig();
    bindSettings();
    bindCanvases();
    bindToolbar();
    ZFL.pattern.onChange(onPatternChange);
    L.inited = true;
    recompute();
  }

  function loadConfig() {
    const p = pattern();
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) { cfg = null; }
    const fresh = Engine.defaultConfig({ cols: p.cols, rows: p.rows, cells: p.cells });
    if (!cfg || !Array.isArray(cfg.frames) || !cfg.frames.length) {
      L.cfg = fresh;
    } else {
      L.cfg = Object.assign(fresh, cfg);
      // 纹样尺寸变了 → 梭序与经线映射按新纹样重建
      if (cfg.patternCols !== p.cols || cfg.patternRows !== p.rows) {
        L.cfg.picks = fresh.picks;
        L.cfg.warpColors = fresh.warpColors;
        L.cfg.draft = null;
      }
    }
    sanitizeCfg();
    L.prevDims = p.cols + "x" + p.rows;
  }

  function sanitizeCfg() {
    const c = L.cfg, p = pattern();
    c.repeatX = clampInt(c.repeatX, 1, 8, 1);
    c.repeatY = clampInt(c.repeatY, 1, 8, 1);
    c.perDent = clampInt(c.perDent, 1, 4, 2);
    c.edgeThreads = clampInt(c.edgeThreads, 0, 16, 4);
    c.maxFloat = clampInt(c.maxFloat, 2, 12, 5);
    c.dentsPerCm = clampNum(c.dentsPerCm, 1, 12, 4);
    c.frames = c.frames.slice(0, 16).map((f, i) => ({
      lineNo: Number.isInteger(f.lineNo) ? f.lineNo : i + 1,
      capacity: clampInt(f.capacity, 1, 999, 48),
    }));
    if (!c.frames.length) c.frames = [{ lineNo: 1, capacity: 48 }];
    const wCount = Engine.bodyWarpCount(p, c);
    if (!Array.isArray(c.warpColors) || c.warpColors.length !== wCount) {
      c.warpColors = tileTo(Engine.defaultWarpColors(p, 1), wCount);
    }
    const maxRow = p.rows * c.repeatY;
    if (!Array.isArray(c.picks) || !c.picks.length || c.picks.some((k) => k.row < 0 || k.row >= maxRow)) {
      c.picks = Engine.defaultPicks(p, c.repeatY);
    }
    if (!Array.isArray(c.draft) || c.draft.length !== wCount) c.draft = null;
  }

  function saveConfig() {
    const p = pattern();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign({}, L.cfg, { patternCols: p.cols, patternRows: p.rows })));
  }

  function clampInt(v, lo, hi, dflt) { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; }
  function clampNum(v, lo, hi, dflt) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; }
  function tileTo(arr, n) { const out = new Array(n); for (let i = 0; i < n; i++) out[i] = arr[i % arr.length]; return out; }

  // ---------------------------------------------------------------- 重算管线(任何调整后立即联查)

  let recomputeQueued = false;
  function recompute() {
    if (recomputeQueued) return;
    recomputeQueued = true;
    requestAnimationFrame(() => {
      recomputeQueued = false;
      if (!L.inited) return;
      doRecompute();
    });
  }

  function doRecompute() {
    const p = pattern();
    const wCount = Engine.bodyWarpCount(p, L.cfg);
    const invalid =
      !Array.isArray(L.cfg.draft) ||
      L.cfg.draft.length !== wCount ||
      L.cfg.draft.some((v) => v < 0 || v >= L.cfg.frames.length);
    if (invalid) {
      // 填补式自动编排:保留手工已穿的经纱,只为未穿的补位
      const res = Engine.autoDraft(p, L.cfg, L.cfg.draft);
      L.cfg.draft = res.draft;
      L.autoFailure = res.ok ? null : res.failure;
    } else {
      L.autoFailure = null;
    }
    L.report = Engine.validate(p, L.cfg, L.cfg.draft);
    L.shed = Engine.shedding(p, L.cfg, L.cfg.draft);
    L.dd = Engine.drawdownColors(p, L.cfg, L.cfg.draft);
    L.replay.pick = Math.min(L.replay.pick, Math.max(0, P() - 1));
    renderSettings();
    renderReport();
    drawDraft();
    drawShed();
    drawFabric();
    saveConfig();
  }

  function onPatternChange() {
    const p = pattern();
    const dims = p.cols + "x" + p.rows;
    if (dims !== L.prevDims) {
      L.prevDims = dims;
      L.cfg.picks = Engine.defaultPicks(p, L.cfg.repeatY);
      L.cfg.warpColors = tileTo(Engine.defaultWarpColors(p, 1), Engine.bodyWarpCount(p, L.cfg));
      L.cfg.draft = null;
    }
    recompute();
  }

  // ---------------------------------------------------------------- 撤销 / 重做

  function pushUndo() {
    L.undo.push(JSON.stringify(L.cfg));
    L.redo = [];
    if (L.undo.length > 50) L.undo.shift();
  }
  function restore(text) {
    L.cfg = JSON.parse(text);
    sanitizeCfg();
    recompute();
  }
  function undo() { if (!L.undo.length) return; L.redo.push(JSON.stringify(L.cfg)); restore(L.undo.pop()); }
  function redo() { if (!L.redo.length) return; L.undo.push(JSON.stringify(L.cfg)); restore(L.redo.pop()); }

  /** 所有修改的统一入口:先存撤销快照,再变更,再立即重排联查 */
  function commit(mutate) {
    pushUndo();
    mutate();
    recompute();
  }

  // ---------------------------------------------------------------- 设置区渲染

  function bindSettings() {
    // 经线映射色板
    $("warpPalette").innerHTML = ZFL.COLORS.map((c, i) => '<button type="button" class="swatch" data-wc="' + i + '" style="background:' + c + '" aria-label="经线色' + i + '"></button>').join("");
    $("warpPalette").querySelectorAll("[data-wc]").forEach((el) => {
      el.onclick = () => { L.warpColor = Number(el.dataset.wc); markWarpPalette(); };
    });
    markWarpPalette();
    $("warpAutoBtn").onclick = () => commit(() => {
      L.cfg.warpColors = tileTo(Engine.defaultWarpColors(pattern(), 1), W());
    });

    $("addFrameBtn").onclick = () => commit(() => {
      if (L.cfg.frames.length >= 16) return;
      const maxLine = Math.max(0, ...L.cfg.frames.map((f) => f.lineNo));
      L.cfg.frames.push({ lineNo: maxLine + 1, capacity: 48 });
    });

    // 穿筘与边组织输入(各自取值范围)
    const num = (id, key, min, max, isFloat) => {
      $(id).addEventListener("change", () => commit(() => {
        L.cfg[key] = isFloat ? clampNum($(id).value, min, max, L.cfg[key]) : clampInt($(id).value, min, max, L.cfg[key]);
        if (key === "repeatX") {
          L.cfg.warpColors = tileTo(L.cfg.warpColors, Engine.bodyWarpCount(pattern(), L.cfg));
          L.cfg.draft = null; // 经纱总数变化,重排
        }
        if (key === "repeatY") {
          L.cfg.picks = Engine.defaultPicks(pattern(), L.cfg.repeatY);
          L.cfg.draft = null;
        }
        // perDent / edgeThreads / maxFloat / dentsPerCm 不影响已有穿综,仅联查结果变化
      }));
    };
    num("perDent", "perDent", 1, 4);
    num("dentsPerCm", "dentsPerCm", 1, 12, true);
    num("edgeThreads", "edgeThreads", 0, 16);
    num("maxFloat", "maxFloat", 2, 12);
    num("repeatX", "repeatX", 1, 8);
    num("repeatY", "repeatY", 1, 8);

    $("addPickBtn").onclick = () => commit(() => {
      const last = L.cfg.picks[L.cfg.picks.length - 1] || { row: 0, color: 0 };
      L.cfg.picks.push({ row: last.row, color: last.color });
      L.cfg.draft = null;
    });
    $("resetPicksBtn").onclick = () => commit(() => {
      L.cfg.picks = Engine.defaultPicks(pattern(), L.cfg.repeatY);
      L.cfg.draft = null;
    });
  }

  function markWarpPalette() {
    $("warpPalette").querySelectorAll("[data-wc]").forEach((el) => el.classList.toggle("active", Number(el.dataset.wc) === L.warpColor));
  }

  function renderSettings() {
    const c = L.cfg, p = pattern();
    $("perDent").value = c.perDent;
    $("dentsPerCm").value = c.dentsPerCm;
    $("edgeThreads").value = c.edgeThreads;
    $("maxFloat").value = c.maxFloat;
    $("repeatX").value = c.repeatX;
    $("repeatY").value = c.repeatY;
    const reed = Engine.reedInfo(p, c);
    $("reedInfo").textContent =
      "本体经纱 " + W() + " 根 · 筘齿 " + reed.dents + " · 织幅约 " + reed.widthCm.toFixed(2) +
      " cm · 边经 " + c.edgeThreads + "×2 · 总投数 " + P();
    if (!L.listDragging) { // 拖动中保持列表 DOM 稳定,松手后对齐
      renderFrames();
      renderPicks();
    }
    drawWarpMap();
  }

  function renderFrames() {
    const c = L.cfg;
    const used = new Array(c.frames.length).fill(0);
    (L.cfg.draft || []).forEach((f) => { if (f >= 0 && f < used.length) used[f]++; });
    const el = $("frameList");
    el.innerHTML = "";
    c.frames.forEach((fr, i) => {
      const row = document.createElement("div");
      row.className = "frame-row";
      const over = used[i] > fr.capacity;
      row.innerHTML =
        '<span class="grip" title="拖动换序">≡</span>' +
        '<span class="fname">框' + (i + 1) + "</span>" +
        '<input type="number" min="1" max="999" value="' + fr.lineNo + '" data-line title="提花线号">' +
        '<input type="number" min="1" max="999" value="' + fr.capacity + '" data-cap title="综丝容量">' +
        '<button type="button" class="secondary mini-btn" data-up title="上移">▲</button>' +
        '<button type="button" class="secondary mini-btn" data-down title="下移">▼</button>' +
        '<button type="button" class="secondary mini-btn" data-del title="删除">✕</button>' +
        '<span class="usedbar' + (over ? " over" : "") + '" title="占用 ' + used[i] + "/" + fr.capacity + '"><i style="width:' + Math.min(100, (100 * used[i]) / fr.capacity) + '%"></i></span>';
      row.querySelector("[data-line]").addEventListener("change", (e) => commit(() => { fr.lineNo = clampInt(e.target.value, 1, 999, fr.lineNo); }));
      row.querySelector("[data-cap]").addEventListener("change", (e) => commit(() => { fr.capacity = clampInt(e.target.value, 1, 999, fr.capacity); }));
      row.querySelector("[data-up]").onclick = () => moveFrame(i, i - 1);
      row.querySelector("[data-down]").onclick = () => moveFrame(i, i + 1);
      row.querySelector("[data-del]").onclick = () => commit(() => {
        if (L.cfg.frames.length <= 1) return;
        L.cfg.frames.splice(i, 1);
        L.cfg.draft = L.cfg.draft.map((f) => (f === i ? -1 : f > i ? f - 1 : f));
      });
      el.appendChild(row);
    });
    // 边综(固定 2 片,平纹边组织)
    const maxLine = Math.max(0, ...c.frames.map((f) => f.lineNo));
    ["边综甲", "边综乙"].forEach((name, k) => {
      const row = document.createElement("div");
      row.className = "frame-row edge";
      row.innerHTML = '<span></span><span class="fname">' + name + "</span>" +
        '<input type="number" value="' + (maxLine + 1 + k) + '" disabled title="边综线号自动顺延">' +
        '<input type="text" value="平纹" disabled title="边组织">' +
        "<span></span><span></span><span></span>" +
        '<span class="usedbar"><i style="width:' + Math.min(100, (100 * c.edgeThreads) / 16) + '%"></i></span>';
      el.appendChild(row);
    });
    $("addFrameBtn").disabled = c.frames.length >= 16;
  }

  function moveFrame(from, to) {
    if (to < 0 || to >= L.cfg.frames.length) return;
    commit(() => reorderFrames(from, to));
  }

  /** 综框换序:frames 数组重排,draft 下标同步重映射 */
  function reorderFrames(from, to) {
    const c = L.cfg;
    const order = c.frames.map((_, i) => i);
    order.splice(to, 0, order.splice(from, 1)[0]);
    c.frames = order.map((i) => c.frames[i]);
    const remap = new Array(order.length);
    order.forEach((oldIdx, newIdx) => (remap[oldIdx] = newIdx));
    c.draft = c.draft.map((f) => (f >= 0 ? remap[f] : f));
  }

  function renderPicks() {
    const el = $("pickList");
    const blocked = blockedPickSet();
    el.innerHTML = "";
    L.cfg.picks.forEach((pick, i) => {
      const row = document.createElement("div");
      row.className = "pick-row" + (i === L.replay.pick ? " current" : "") + (blocked.has(i) ? " blocked" : "");
      row.dataset.pick = i;
      row.innerHTML =
        '<span class="grip" data-grip title="拖动调序">≡</span>' +
        '<span>#' + (i + 1) + "</span>" +
        '<input type="number" min="0" max="' + (pattern().rows * L.cfg.repeatY - 1) + '" value="' + pick.row + '" data-row title="纬向行号">' +
        '<select data-color title="纬线色">' + ZFL.COLORS.map((c, ci) => '<option value="' + ci + '"' + (ci === pick.color ? " selected" : "") + ">色" + ci + "</option>").join("") + "</select>" +
        '<span class="sw" style="background:' + ZFL.COLORS[pick.color] + '"></span>' +
        '<button type="button" class="secondary mini-btn" data-up title="上移">▲</button>' +
        '<button type="button" class="secondary mini-btn" data-down title="下移">▼</button>' +
        '<button type="button" class="secondary mini-btn" data-del title="删除">✕</button>';
      row.querySelector("[data-row]").addEventListener("change", (e) => commit(() => {
        pick.row = clampInt(e.target.value, 0, pattern().rows * L.cfg.repeatY - 1, pick.row);
        L.cfg.draft = null;
      }));
      row.querySelector("[data-color]").addEventListener("change", (e) => commit(() => {
        pick.color = clampInt(e.target.value, 0, ZFL.COLORS.length - 1, pick.color);
        L.cfg.draft = null;
      }));
      row.querySelector("[data-up]").onclick = () => movePick(i, i - 1);
      row.querySelector("[data-down]").onclick = () => movePick(i, i + 1);
      row.querySelector("[data-del]").onclick = () => commit(() => {
        if (L.cfg.picks.length <= 1) return;
        L.cfg.picks.splice(i, 1);
        L.cfg.draft = null;
      });
      el.appendChild(row);
    });
  }

  function movePick(from, to) {
    if (to < 0 || to >= L.cfg.picks.length) return;
    commit(() => {
      L.cfg.picks.splice(to, 0, L.cfg.picks.splice(from, 1)[0]);
      L.cfg.draft = null;
      L.replay.pick = to;
    });
  }

  function blockedPickSet() {
    const set = new Set(L.report ? L.report.blockedPicks : []);
    if (L.report) L.report.shuttle.conflicts.forEach((c) => set.add(c.pick));
    return set;
  }

  // ---------------------------------------------------------------- 经线映射条

  function drawWarpMap() {
    const cv = $("warpMap");
    const wCount = W();
    const cw = Math.max(6, Math.min(18, Math.floor(560 / Math.max(1, wCount))));
    const { ctx } = ZFL.makeCanvas(cv, wCount * cw, 26);
    for (let w = 0; w < wCount; w++) {
      ctx.fillStyle = ZFL.COLORS[L.cfg.warpColors[w] % ZFL.COLORS.length];
      ctx.fillRect(w * cw, 0, cw - 1, 26);
      if ((w + 1) % L.cfg.perDent === 0) {
        ctx.fillStyle = "rgba(40,32,24,.55)";
        ctx.fillRect((w + 1) * cw - 1, 0, 1, 26);
      }
    }
    cv.dataset.cw = cw;
  }

  // ---------------------------------------------------------------- 穿综图

  const DRAFT = { gut: 70, head: 22, cw: 13, rh: 19 };

  function draftLayout() {
    const c = L.cfg, E = c.edgeThreads, wCount = W();
    const F = c.frames.length;
    return {
      E, F, wCount,
      width: DRAFT.gut + (wCount + 2 * E) * DRAFT.cw + 8,
      height: DRAFT.head + (F + 2) * DRAFT.rh + 8,
    };
  }

  function drawDraft() {
    const cv = $("draftCanvas");
    const c = L.cfg, p = pattern();
    const lay = draftLayout();
    L.layouts.draft = lay;
    const { ctx } = ZFL.makeCanvas(cv, lay.width, lay.height);
    const { E, F, wCount } = lay;
    const report = L.report;
    const adjWarps = new Set();
    (report ? report.adjacency : []).forEach((a) => a.warps.forEach((w) => adjWarps.add(w)));
    const overFrames = new Set((report ? report.capacity : []).map((x) => x.frame));
    const stopWarp = L.autoFailure ? L.autoFailure.warp : -1;

    // 表头:筘齿号
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "#8a7d6f";
    ctx.textAlign = "center";
    const dents = Math.ceil(wCount / c.perDent);
    for (let d = 0; d < dents; d++) {
      const x = DRAFT.gut + (E + d * c.perDent) * DRAFT.cw + (c.perDent * DRAFT.cw) / 2;
      if (d % Math.ceil(dents / 24 || 1) === 0) ctx.fillText(String(d + 1), x, 14);
    }
    // 筘齿分隔线
    ctx.strokeStyle = "rgba(120,100,80,.25)";
    for (let d = 1; d < dents; d++) {
      const x = DRAFT.gut + (E + d * c.perDent) * DRAFT.cw;
      ctx.beginPath(); ctx.moveTo(x, DRAFT.head); ctx.lineTo(x, DRAFT.head + (F + 2) * DRAFT.rh); ctx.stroke();
    }

    // 无解:最后安全筘齿之后的区域灰掉 + 红线
    if (stopWarp >= 0) {
      const xStop = DRAFT.gut + (E + stopWarp) * DRAFT.cw;
      ctx.fillStyle = "rgba(90,80,70,.18)";
      ctx.fillRect(xStop, DRAFT.head, lay.width - xStop, (F + 2) * DRAFT.rh);
      ctx.strokeStyle = "#a03a2e";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xStop, DRAFT.head - 4); ctx.lineTo(xStop, DRAFT.head + (F + 2) * DRAFT.rh); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = "#a03a2e";
      ctx.textAlign = "left";
      ctx.fillText("◀ 停在第 " + (L.autoFailure.dent + 1) + " 筘前", xStop + 4, DRAFT.head - 6);
    }

    // 综框行
    const frameNames = c.frames.map((f, i) => "框" + (i + 1) + "·线" + f.lineNo).concat(["边甲", "边乙"]);
    for (let r = 0; r < F + 2; r++) {
      const y = DRAFT.head + r * DRAFT.rh;
      ctx.fillStyle = overFrames.has(r) ? "#a03a2e" : "#5d5245";
      ctx.textAlign = "left";
      ctx.fillText((r < F ? "≡ " : "") + frameNames[r], 4, y + DRAFT.rh - 6);
      ctx.strokeStyle = "rgba(120,100,80,.35)";
      ctx.beginPath(); ctx.moveTo(0, y + DRAFT.rh); ctx.lineTo(lay.width, y + DRAFT.rh); ctx.stroke();
      if (L.hover && L.hover.frame === r && r < F) {
        ctx.fillStyle = "rgba(214,164,55,.18)";
        ctx.fillRect(DRAFT.gut, y, lay.width - DRAFT.gut, DRAFT.rh);
      }
    }

    // 边经(灰底)
    ctx.fillStyle = "rgba(120,100,80,.10)";
    ctx.fillRect(DRAFT.gut, DRAFT.head, E * DRAFT.cw, (F + 2) * DRAFT.rh);
    ctx.fillRect(DRAFT.gut + (E + wCount) * DRAFT.cw, DRAFT.head, E * DRAFT.cw, (F + 2) * DRAFT.rh);
    // 边经穿边综(平纹)
    ctx.fillStyle = "#71675c";
    for (let j = 0; j < E; j++) {
      const row = F + (j % 2);
      const y = DRAFT.head + row * DRAFT.rh;
      ctx.fillRect(DRAFT.gut + j * DRAFT.cw + 2, y + 3, DRAFT.cw - 4, DRAFT.rh - 6);
      ctx.fillRect(DRAFT.gut + (E + wCount + j) * DRAFT.cw + 2, y + 3, DRAFT.cw - 4, DRAFT.rh - 6);
    }

    // 本体经纱穿综
    for (let w = 0; w < wCount; w++) {
      const f = c.draft ? c.draft[w] : -1;
      const x = DRAFT.gut + (E + w) * DRAFT.cw;
      if (f >= 0) {
        const y = DRAFT.head + f * DRAFT.rh;
        ctx.fillStyle = ZFL.COLORS[c.warpColors[w] % ZFL.COLORS.length];
        ctx.fillRect(x + 1, y + 2, DRAFT.cw - 2, DRAFT.rh - 4);
        ctx.strokeStyle = adjWarps.has(w) ? "#a03a2e" : "rgba(40,32,24,.6)";
        ctx.lineWidth = adjWarps.has(w) ? 2 : 1;
        ctx.strokeRect(x + 1, y + 2, DRAFT.cw - 2, DRAFT.rh - 4);
        ctx.lineWidth = 1;
      }
      if (L.sel.warp === w) {
        ctx.strokeStyle = "#d6a437";
        ctx.lineWidth = 2;
        ctx.strokeRect(x, DRAFT.head, DRAFT.cw, F * DRAFT.rh);
        ctx.lineWidth = 1;
      }
    }
  }

  function draftHit(x, y) {
    const lay = L.layouts.draft;
    const c = L.cfg;
    const row = Math.floor((y - DRAFT.head) / DRAFT.rh);
    const col = Math.floor((x - DRAFT.gut) / DRAFT.cw);
    const warp = col - lay.E;
    return {
      onGutter: x < DRAFT.gut,
      row: row >= 0 && row < lay.F + 2 ? row : -1,
      frame: row >= 0 && row < lay.F ? row : -1,
      warp: warp >= 0 && warp < lay.wCount ? warp : -1,
    };
  }

  function bindDraftCanvas() {
    const cv = $("draftCanvas");
    ZFL.pointerGrid(cv, {
      onDragStart(x, y) {
        const hit = draftHit(x, y);
        if (hit.onGutter && hit.frame >= 0) L.drag = { type: "frame", frame: hit.frame };
        else if (hit.warp >= 0) L.drag = { type: "warp", warp: hit.warp };
        else L.drag = null;
      },
      onDrag(x, y) {
        if (!L.drag) return;
        const hit = draftHit(x, y);
        if (L.drag.type === "warp") L.hover = hit.frame >= 0 ? { frame: hit.frame } : null;
        else if (L.drag.type === "frame") L.hover = hit.frame >= 0 ? { insertAt: hit.frame } : null;
        drawDraft();
      },
      onDrop(x, y, cancelled) {
        const drag = L.drag;
        L.drag = null;
        const hover = L.hover;
        L.hover = null;
        if (!drag || cancelled) { drawDraft(); return; }
        const hit = draftHit(x, y);
        if (drag.type === "warp" && hit.frame >= 0 && L.cfg.draft[drag.warp] !== hit.frame) {
          commit(() => { L.cfg.draft[drag.warp] = hit.frame; });
        } else if (drag.type === "frame" && hover && hover.insertAt != null && hover.insertAt !== drag.frame) {
          commit(() => reorderFrames(drag.frame, hover.insertAt));
        } else drawDraft();
      },
      onTap(x, y) {
        const hit = draftHit(x, y);
        if (L.sel.warp < 0) {
          // 未选中:点经纱选中
          if (hit.warp >= 0) { L.sel.warp = hit.warp; drawDraft(); }
          return;
        }
        const cur = L.cfg.draft[L.sel.warp];
        if (hit.warp === L.sel.warp && hit.frame === cur) {
          L.sel.warp = -1; // 点当前格:取消选中
          drawDraft();
        } else if (hit.frame >= 0) {
          const w = L.sel.warp; // 点其他综框行:落综
          commit(() => { L.cfg.draft[w] = hit.frame; });
          L.sel.warp = -1;
        } else {
          L.sel.warp = -1; // 点空白处:取消
          drawDraft();
        }
      },
    });
  }

  // ---------------------------------------------------------------- 开口序列

  const SHED = { gut: 64, head: 20, cw: 17, rh: 15 };

  function shedLayout() {
    const F = L.cfg.frames.length, pCount = P();
    return {
      F, pCount,
      width: SHED.gut + (F + 2) * SHED.cw + 8,
      height: SHED.head + pCount * SHED.rh + 8,
    };
  }

  function drawShed() {
    const cv = $("shedCanvas");
    const lay = shedLayout();
    L.layouts.shed = lay;
    const { ctx } = ZFL.makeCanvas(cv, lay.width, lay.height);
    const c = L.cfg, F = lay.F, pCount = lay.pCount;
    const lift = L.shed.frameLift;
    const blocked = blockedPickSet();

    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let f = 0; f < F + 2; f++) {
      ctx.fillStyle = "#8a7d6f";
      const label = f < F ? String(c.frames[f].lineNo) : f === F ? "甲" : "乙";
      ctx.fillText(label, SHED.gut + f * SHED.cw + SHED.cw / 2, 13);
    }
    for (let pI = 0; pI < pCount; pI++) {
      const y = SHED.head + (pCount - 1 - pI) * SHED.rh;
      // 左 gutter:投号 + 纬色
      ctx.fillStyle = blocked.has(pI) ? "#a03a2e" : "#8a7d6f";
      ctx.textAlign = "right";
      ctx.fillText("#" + (pI + 1), SHED.gut - 22, y + SHED.rh - 4);
      ctx.fillStyle = ZFL.COLORS[c.picks[pI].color % ZFL.COLORS.length];
      ctx.fillRect(SHED.gut - 18, y + 2, 12, SHED.rh - 4);
      if (pI === L.replay.pick) {
        ctx.fillStyle = "rgba(214,164,55,.25)";
        ctx.fillRect(0, y, lay.width, SHED.rh);
      }
      if (L.report && L.report.firstBlockedPick === pI) {
        ctx.strokeStyle = "#a03a2e";
        ctx.lineWidth = 2;
        ctx.strokeRect(1, y + 1, lay.width - 2, SHED.rh - 2);
        ctx.lineWidth = 1;
      }
      for (let f = 0; f < F; f++) {
        if (lift[pI * F + f]) {
          ctx.fillStyle = "#3d332a";
          ctx.fillRect(SHED.gut + f * SHED.cw + 1, y + 1, SHED.cw - 2, SHED.rh - 2);
        }
      }
      // 边综:平纹
      for (let e = 0; e < 2; e++) {
        if ((pI + e) % 2 === 0) {
          ctx.fillStyle = "#9a8d7d";
          ctx.fillRect(SHED.gut + (F + e) * SHED.cw + 1, y + 1, SHED.cw - 2, SHED.rh - 2);
        }
      }
    }
  }

  function bindShedCanvas() {
    const cv = $("shedCanvas");
    ZFL.pointerGrid(cv, {
      onTap(x, y) {
        const lay = L.layouts.shed;
        const row = Math.floor((y - SHED.head) / SHED.rh);
        if (row < 0 || row >= lay.pCount) return;
        setReplayPick(lay.pCount - 1 - row);
      },
    });
  }

  // ---------------------------------------------------------------- 织物模拟

  function drawFabric() {
    const cv = $("fabricCanvas");
    const dd = L.dd;
    const scale = Math.max(2, Math.min(6, Math.floor(640 / Math.max(1, dd.Wtot))));
    const width = dd.Wtot * scale, height = dd.P * scale;
    const { ctx } = ZFL.makeCanvas(cv, width, height);
    // 基图:1px/交织点 → 放大
    const off = document.createElement("canvas");
    off.width = dd.Wtot; off.height = dd.P;
    const octx = off.getContext("2d");
    const img = octx.createImageData(dd.Wtot, dd.P);
    for (let pI = 0; pI < dd.P; pI++) {
      const yImg = dd.P - 1 - pI; // 第 0 投在布底
      for (let x = 0; x < dd.Wtot; x++) {
        const col = ZFL.COLORS[dd.colors[pI * dd.Wtot + x] % ZFL.COLORS.length];
        const o = (yImg * dd.Wtot + x) * 4;
        img.data[o] = parseInt(col.slice(1, 3), 16);
        img.data[o + 1] = parseInt(col.slice(3, 5), 16);
        img.data[o + 2] = parseInt(col.slice(5, 7), 16);
        img.data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, width, height);
    // 未织部分蒙版 + 织口线
    const wovenRows = L.replay.pick + 1;
    const unwoven = dd.P - wovenRows;
    if (unwoven > 0) {
      ctx.fillStyle = "rgba(243,239,231,.82)";
      ctx.fillRect(0, 0, width, unwoven * scale);
    }
    ctx.fillStyle = "#d6a437";
    ctx.fillRect(0, unwoven * scale - 1, width, 2);
  }

  // ---------------------------------------------------------------- 回放

  function setReplayPick(i) {
    L.replay.pick = Math.max(0, Math.min(P() - 1, i));
    drawShed();
    drawFabric();
    // 就地更新梭序高亮,避免整表重建
    const rows = $("pickList").children;
    for (let k = 0; k < rows.length; k++) rows[k].classList.toggle("current", k === L.replay.pick);
    const cur = $("pickList").querySelector(".pick-row.current");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function stopReplay() {
    L.replay.playing = false;
    if (L.replay.timer) clearInterval(L.replay.timer);
    L.replay.timer = null;
    $("replayPlay").textContent = "▶";
  }

  function toggleReplay() {
    if (L.replay.playing) { stopReplay(); return; }
    L.replay.playing = true;
    $("replayPlay").textContent = "⏸";
    const step = () => {
      if (L.replay.pick >= P() - 1) { stopReplay(); return; }
      setReplayPick(L.replay.pick + 1);
    };
    if (L.replay.pick >= P() - 1) setReplayPick(0);
    L.replay.timer = setInterval(step, Number($("replaySpeed").value));
  }

  // ---------------------------------------------------------------- 联查报告

  function renderReport() {
    const r = L.report, c = L.cfg;
    const banner = $("loomBanner");
    banner.className = "banner show";
    if (L.autoFailure) {
      const f = L.autoFailure;
      banner.classList.add("err");
      banner.textContent = "🚫 无解:" + f.message + " 已停在最后安全筘齿前,其后的经纱未分配综框。";
    } else if (!r.draftComplete) {
      banner.classList.add("err");
      banner.textContent = "⛔ " + (r.errors[0] || "存在未穿综的经纱");
    } else if (r.errors.length) {
      banner.classList.add("err");
      banner.textContent = "⛔ " + r.errors[0] + (r.errors.length > 1 ? "(共 " + r.errors.length + " 项)" : "");
    } else if (r.warnings.length) {
      banner.classList.add("warn");
      banner.textContent = "⚠️ 可上机,但有警示:" + r.warnings[0];
    } else {
      banner.classList.add("ok");
      banner.textContent = "✅ 编排合法,可上机织造。共 " + W() + " 经、" + P() + " 投,换梭 " + r.shuttle.changes + " 次。";
    }

    const el = $("loomReport");
    const used = new Array(c.frames.length).fill(0);
    (c.draft || []).forEach((f) => { if (f >= 0 && f < used.length) used[f]++; });
    const ok = (b) => (b ? '<span class="good">✓ 通过</span>' : "");
    let html = "";

    html += '<div class="report-block"><h4>综框容量</h4>';
    c.frames.forEach((fr, i) => {
      const over = used[i] > fr.capacity;
      html += '<div>框' + (i + 1) + "·线" + fr.lineNo + " " + used[i] + "/" + fr.capacity +
        '<div class="capbar' + (over ? " over" : "") + '"><i style="width:' + Math.min(100, (100 * used[i]) / fr.capacity) + '%"></i></div></div>';
    });
    html += r.capacity.length ? '<div class="bad">超限:' + r.capacity.map((x) => "线号" + x.lineNo).join("、") + "</div>" : ok(true) + "</div>";

    html += '<div class="report-block"><h4>相邻经纱(同筘同综)</h4>';
    html += r.adjacency.length
      ? '<ul>' + r.adjacency.slice(0, 6).map((a) => "<li>第 " + (a.dent + 1) + " 筘齿:经纱 " + (a.warps[0] + 1) + " 与 " + (a.warps[1] + 1) + " 同穿框" + (a.frame + 1) + "</li>").join("") + (r.adjacency.length > 6 ? "<li>…共 " + r.adjacency.length + " 处</li>" : "") + "</ul>"
      : ok(true);
    html += "</div>";

    html += '<div class="report-block"><h4>受阻纬线</h4>';
    if (r.firstBlockedPick >= 0) {
      const frames = (r.blockedByFrame[r.firstBlockedPick] || []).map((f) => "框" + (f + 1)).join("、");
      html += '<div class="bad">首个受阻纬线:第 ' + (r.firstBlockedPick + 1) + " 投</div><ul>";
      if (r.blockedPicks.length) html += "<li>开口受阻 " + r.blockedPicks.length + " 投" + (frames ? "(涉及 " + frames + ")" : "") + "</li>";
      r.shuttle.conflicts.slice(0, 4).forEach((s) => { html += "<li>第 " + (s.pick + 1) + " 投色" + s.color + ":与第 " + (s.prev + 1) + " 投间隔 " + s.gap + "(偶数),梭子回不到出发侧</li>"; });
      html += "</ul>";
    } else html += ok(true);
    html += "</div>";

    html += '<div class="report-block"><h4>浮长(上限 ' + c.maxFloat + ")</h4>";
    html += "<div>经浮最长 " + r.floats.maxWarp + " · 纬浮最长 " + r.floats.maxWeft + "</div>";
    html += r.floats.violations.length
      ? '<div class="bad">超限 ' + r.floats.violations.length + " 处,如:" + r.floats.violations.slice(0, 3).map((v) => (v.kind === "warp" ? "经纱" + (v.warp + 1) + " 浮 " + v.length : "第" + (v.pick + 1) + " 投纬浮 " + v.length)).join(";") + "</div>"
      : ok(true);
    html += "</div>";

    html += '<div class="report-block"><h4>换梭顺序</h4>';
    html += "<div>换梭 " + r.shuttle.changes + " 次</div>";
    html += r.shuttle.conflicts.length ? '<div class="bad">冲突 ' + r.shuttle.conflicts.length + " 处</div>" : ok(true);
    html += "</div>";

    html += '<div class="report-block"><h4>提花线号</h4>';
    html += r.lineNos.duplicates.length
      ? '<div class="bad">线号重复:' + r.lineNos.duplicates.map((d) => d.lineNo + "(框" + d.frames.map((f) => f + 1).join("、框") + ")").join(";") + "</div>"
      : ok(true);
    html += "</div>";

    html += '<div class="report-block"><h4>穿筘</h4>';
    html += "<div>筘齿 " + r.reed.dents + " · 织幅约 " + r.reed.widthCm.toFixed(2) + " cm · 每筘 " + c.perDent + " 入</div>";
    if (!r.draftComplete) html += '<div class="bad">停在最后安全筘齿:第 ' + (r.reed.lastSafeDent + 1) + " 筘,其后经纱未编排</div>";
    html += "</div>";

    el.innerHTML = html;

    // 用线量
    const u = Engine.usage(pattern(), c);
    const rows = [];
    u.warp.forEach((n, ci) => rows.push('<div class="stat"><span><span style="display:inline-block;width:14px;height:14px;background:' + ZFL.COLORS[ci % ZFL.COLORS.length] + '"></span> 经·色' + ci + "</span><b>" + n + " 根</b></div>"));
    u.weft.forEach((n, ci) => rows.push('<div class="stat"><span><span style="display:inline-block;width:14px;height:14px;background:' + ZFL.COLORS[ci % ZFL.COLORS.length] + '"></span> 纬·色' + ci + "</span><b>" + n + " 投</b></div>"));
    $("loomUsage").innerHTML = rows.join("");
  }

  // ---------------------------------------------------------------- 工具栏 / 导入导出

  function bindToolbar() {
    $("autoDraftBtn").onclick = () => commit(() => { L.cfg.draft = null; });
    $("loomUndoBtn").onclick = undo;
    $("loomRedoBtn").onclick = redo;
    $("replayPlay").onclick = toggleReplay;
    $("replayFirst").onclick = () => { stopReplay(); setReplayPick(0); };
    $("replayPrev").onclick = () => { stopReplay(); setReplayPick(L.replay.pick - 1); };
    $("replayNext").onclick = () => { stopReplay(); setReplayPick(L.replay.pick + 1); };
    $("replaySpeed").onchange = () => { if (L.replay.playing) { stopReplay(); toggleReplay(); } };

    $("exportPlanBtn").onclick = () => {
      ZFL.download("brocade-loom-plan.json", Engine.exportPlan(pattern(), L.cfg));
    };
    $("importPlanBtn").onclick = () => $("importFile").click();
    $("importFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const plan = Engine.importPlan(reader.result);
          pushUndo();
          ZFL.patternTab.applyPattern(plan.pattern);
          L.cfg = plan.config;
          sanitizeCfg();
          L.prevDims = plan.pattern.cols + "x" + plan.pattern.rows;
          recompute();
        } catch (err) {
          const banner = $("loomBanner");
          banner.className = "banner show err";
          banner.textContent = "🚫 导入失败:" + err.message;
        }
      };
      reader.readAsText(file);
    });

    // 拖动重排(鼠标):拖动中物理移动行,数据同步;一次拖动一条撤销记录
    const listHooks = (mutate) => ({
      onStart() { L.listDragging = true; pushUndo(); },
      onMove(from, to) { mutate(from, to); recompute(); },
      onEnd() { L.listDragging = false; recompute(); },
    });
    ZFL.listDrag($("pickList"), ".pick-row", listHooks((from, to) => {
      L.cfg.picks.splice(to, 0, L.cfg.picks.splice(from, 1)[0]);
      L.cfg.draft = null;
    }));
    ZFL.listDrag($("frameList"), ".frame-row:not(.edge)", listHooks((from, to) => reorderFrames(from, to)));
  }

  function bindCanvases() {
    bindDraftCanvas();
    bindShedCanvas();
    // 经线映射条:点击/拖动改色
    const cv = $("warpMap");
    const paintAt = (x) => {
      const cw = Number(cv.dataset.cw) || 8;
      const w = Math.floor(x / cw);
      if (w < 0 || w >= W()) return;
      commit(() => { L.cfg.warpColors[w] = L.warpColor; });
    };
    ZFL.pointerGrid(cv, {
      onTap(x) { paintAt(x); },
      onDragStart(x) { paintAt(x); },
      onDrag(x) {
        const cw = Number(cv.dataset.cw) || 8;
        const w = Math.floor(x / cw);
        if (w >= 0 && w < W() && L.cfg.warpColors[w] !== L.warpColor) {
          L.cfg.warpColors[w] = L.warpColor;
          drawWarpMap();
        }
      },
      onDrop(x, y, cancelled) { if (!cancelled) recompute(); },
    });
  }

  ZFL.loomTab = { boot, recompute, state: () => L };
})();
