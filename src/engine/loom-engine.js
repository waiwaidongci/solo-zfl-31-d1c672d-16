/*
 * loom-engine.js — 上机织造纯计算引擎(与页面完全独立,零 DOM 依赖)
 *
 * 模型约定(在 UI 与测试中保持一致):
 *  - 纹样 pattern = { cols, rows, cells },cells[y*cols+x] 为色线序号。
 *  - 经线:每列纹样映射 repeatX 次得到本体经纱,左右各 edgeThreads 根边经。
 *    每根本体经纱有色(warpColors),穿在一片地综框上(draft),并按 perDent 穿筘。
 *  - 纬线:梭序 picks = [{row, color}],每投一纬;row 为纬向行(可因 repeatY 重复)。
 *  - 开口规则:第 p 投(色 c)在列 x 处,若纹样格 === c 则经沉纬浮(纬线露面),
 *    否则经浮纬沉。边经固定平纹(两片边综交替)。
 *  - 联查:综框容量 / 同筘同综(相邻经纱冲突)/ 受阻纬线 / 浮长 / 换梭顺序 / 提花线号重复。
 *  - 无解(autoDraft 失败)时报告受阻经纱与"最后安全筘齿",并给出原因码。
 *
 * 该文件同时支持:
 *  - 浏览器 <script src> 引入(挂到 window.LoomEngine,file:// 直接打开也能用)
 *  - Node require()(单元测试)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LoomEngine = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const EDGE_FRAMES = 2; // 边综固定两片(平纹边组织)
  const PLAN_VERSION = 2;

  // ---------------------------------------------------------------- 基础工具

  /** 纹样某绝对行(考虑 repeatY 平铺)某绝对列(考虑 repeatX 平铺)的色线序号 */
  function cellAt(pattern, cfg, absRow, absCol) {
    const r = ((absRow % pattern.rows) + pattern.rows) % pattern.rows;
    const c = ((absCol % pattern.cols) + pattern.cols) % pattern.cols;
    return pattern.cells[r * pattern.cols + c] | 0;
  }

  /** 本体经纱数(不含边经) */
  function bodyWarpCount(pattern, cfg) {
    return pattern.cols * (cfg.repeatX || 1);
  }

  /** 总经纱数(含两侧边经) */
  function totalWarpCount(pattern, cfg) {
    return bodyWarpCount(pattern, cfg) + 2 * cfg.edgeThreads;
  }

  /** 筘齿数(仅本体)与织幅 */
  function reedInfo(pattern, cfg) {
    const W = bodyWarpCount(pattern, cfg);
    const dents = Math.ceil(W / cfg.perDent);
    return { dents, widthCm: dents / cfg.dentsPerCm, dentOf: (w) => Math.floor(w / cfg.perDent) };
  }

  // ---------------------------------------------------------------- 默认编排

  /** 色线映射到经线:默认取每列出现次数最多的色线作为该列经线色 */
  function defaultWarpColors(pattern, repeatX) {
    const rep = repeatX || 1;
    const out = new Array(pattern.cols * rep);
    for (let x = 0; x < pattern.cols; x++) {
      const counts = new Map();
      for (let y = 0; y < pattern.rows; y++) {
        const v = pattern.cells[y * pattern.cols + x] | 0;
        counts.set(v, (counts.get(v) || 0) + 1);
      }
      let best = 0, bestN = -1;
      for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
      for (let k = 0; k < rep; k++) out[k * pattern.cols + x] = best;
    }
    return out;
  }

  /**
   * 默认梭序:每行按色线首次出现顺序取色,一色一投;行序保持不变。
   * 行内色序用回溯搜索全排列,使同一色梭相邻两投间隔全为奇数
   * (梭子才能回到本投出发侧);找不到全局合法序时退化为蛇形贪心,
   * 余下的换梭冲突由联查如实报告。
   */
  function defaultPicks(pattern, repeatY) {
    const rep = repeatY || 1;
    const totalRows = pattern.rows * rep;
    const rowColors = [];
    for (let r = 0; r < totalRows; r++) {
      const seen = [];
      const srcRow = r % pattern.rows;
      for (let x = 0; x < pattern.cols; x++) {
        const v = pattern.cells[srcRow * pattern.cols + x] | 0;
        if (!seen.includes(v)) seen.push(v);
      }
      rowColors.push(seen);
    }

    const picks = [];
    const lastUse = new Map();
    let nodes = 0;
    const NODE_LIMIT = 80000;

    function permsOf(arr) {
      // 色数多时只试正/反两序;色数少时全排列(自然序在前)
      if (arr.length > 4) return [arr, arr.slice().reverse()];
      const out = [];
      (function walk(prefix, rest) {
        if (!rest.length) { out.push(prefix); return; }
        for (let i = 0; i < rest.length; i++) {
          walk(prefix.concat(rest[i]), rest.slice(0, i).concat(rest.slice(i + 1)));
        }
      })([], arr);
      return out;
    }
    function fits(perm, start) {
      for (let i = 0; i < perm.length; i++) {
        const c = perm[i];
        if (lastUse.has(c) && (start + i - lastUse.get(c)) % 2 === 0) return false;
      }
      return true;
    }
    function dfs(r) {
      if (r >= totalRows) return true;
      if (++nodes > NODE_LIMIT) return false;
      for (const perm of permsOf(rowColors[r])) {
        const start = picks.length;
        if (!fits(perm, start)) continue;
        const snapshot = new Map(lastUse);
        perm.forEach((c, i) => lastUse.set(c, start + i));
        perm.forEach((c) => picks.push({ row: r, color: c }));
        if (dfs(r + 1)) return true;
        picks.length -= perm.length;
        lastUse.clear();
        for (const [k, v] of snapshot) lastUse.set(k, v);
      }
      return false;
    }

    if (dfs(0)) return picks;

    // 回退:蛇形贪心(可能存在换梭冲突,由联查报告)
    picks.length = 0;
    lastUse.clear();
    const evenGaps = (order, start) => {
      let bad = 0;
      const sim = new Map(lastUse);
      for (let i = 0; i < order.length; i++) {
        const c = order[i];
        if (sim.has(c) && (start + i - sim.get(c)) % 2 === 0) bad++;
        sim.set(c, start + i);
      }
      return bad;
    };
    for (let r = 0; r < totalRows; r++) {
      const seen = rowColors[r];
      const rev = seen.slice().reverse();
      const order = evenGaps(rev, picks.length) < evenGaps(seen, picks.length) ? rev : seen;
      for (const c of order) {
        lastUse.set(c, picks.length);
        picks.push({ row: r, color: c });
      }
    }
    return picks;
  }

  /** 默认配置:8 片地综(线号 1..8、容量 48)、每筘 2 入、筘密 4、边经 4、浮长上限 5 */
  function defaultConfig(pattern, overrides) {
    const cfg = {
      version: PLAN_VERSION,
      frames: Array.from({ length: 8 }, (_, i) => ({ lineNo: i + 1, capacity: 48 })),
      perDent: 2,
      dentsPerCm: 4,
      edgeThreads: 4,
      maxFloat: 5,
      repeatX: 1,
      repeatY: 1,
      draft: null, // null = 需要自动编排
    };
    Object.assign(cfg, overrides || {});
    // 经线色与梭序依赖最终重复次数:未被显式覆盖时按最终 repeat 生成
    if (!overrides || !Array.isArray(overrides.warpColors)) cfg.warpColors = defaultWarpColors(pattern, cfg.repeatX);
    if (!overrides || !Array.isArray(overrides.picks)) cfg.picks = defaultPicks(pattern, cfg.repeatY);
    return cfg;
  }

  // ---------------------------------------------------------------- 开口需求(位图)

  /**
   * 每根本体经纱的开口需求位图:第 p 位 = 1 表示第 p 投该经纱需提起。
   * 返回 { vectors: Uint32Array(W*words), words, W, P }。
   * 大量经纬线时用位图,后续分组、冲突检测都是字级运算。
   */
  function liftVectors(pattern, cfg) {
    const W = bodyWarpCount(pattern, cfg);
    const P = cfg.picks.length;
    const words = Math.max(1, Math.ceil(P / 32));
    const vectors = new Uint32Array(W * words);
    for (let p = 0; p < P; p++) {
      const pick = cfg.picks[p];
      const wWord = p >>> 5, wBit = 1 << (p & 31);
      for (let w = 0; w < W; w++) {
        const cell = cellAt(pattern, cfg, pick.row, w);
        if (cell !== (pick.color | 0)) vectors[w * words + wWord] |= wBit; // 经浮纬沉 → 提起
      }
    }
    return { vectors, words, W, P };
  }

  /** 边经开口:边经 j(0..edge-1)在第 p 投是否提起(平纹) */
  function edgeWarpUp(cfg, edgeIndex, pick) {
    return ((pick + edgeIndex) & 1) === 0;
  }

  // ---------------------------------------------------------------- 自动穿综编排

  /**
   * 自动穿综(填补式):开口需求完全相同的经纱可同综;同筘齿内的经纱不得同综框;
   * 每框不超过容量;综框不够时停在受阻经纱处,报告最后安全筘齿与原因。
   * existing:已有的手工穿综(可含 -1 表示未穿),已穿的经纱保持不动,
   *           只为未穿的经纱补位——拖动调整后立即重排即靠它完成。
   * 返回 { ok, draft, frames:[{warps:[...]}], failure? }
   * failure = { warp, dent, lastSafeDent, code, message }
   */
  function autoDraft(pattern, cfg, existing) {
    const { vectors, words, W } = liftVectors(pattern, cfg);
    const frames = cfg.frames;
    const maxFrames = frames.length;
    const { dentOf } = reedInfo(pattern, cfg);

    // 开口需求签名 → 便于同纹归并
    const sigOf = new Array(W);
    for (let w = 0; w < W; w++) {
      const parts = new Array(words);
      for (let k = 0; k < words; k++) parts[k] = vectors[w * words + k].toString(36);
      sigOf[w] = parts.join(".");
    }

    const assigned = []; // { sig, warps: [] } 与 cfg.frames 下标一一对应
    const draft = new Array(W).fill(-1);
    const dent = new Array(W);
    for (let w = 0; w < W; w++) dent[w] = dentOf(w);

    // 先登记手工已穿的经纱(越界框号视为未穿);同框签名不一致时该框锁定,不再补入
    const frameLocked = new Set();
    if (Array.isArray(existing) && existing.length === W) {
      for (let w = 0; w < W; w++) {
        const f = existing[w];
        if (f < 0 || f >= maxFrames) continue;
        if (!assigned[f]) assigned[f] = { sig: sigOf[w], warps: [] };
        if (assigned[f].sig !== sigOf[w]) frameLocked.add(f); // 手工冲突,留给联查报告
        assigned[f].warps.push(w);
        draft[w] = f;
      }
    }

    for (let w = 0; w < W; w++) {
      if (draft[w] >= 0) continue; // 手工已穿,保持不动
      const sig = sigOf[w];
      let chosen = -1, chosenLoad = Infinity;
      for (let f = 0; f < maxFrames; f++) {
        const fr = assigned[f];
        if (!fr) continue;
        if (frameLocked.has(f)) continue;
        if (fr.sig !== sig) continue;
        if (fr.warps.length >= frames[f].capacity) continue;
        // 同筘同综检查:该框里不能有与 w 同筘齿的经纱
        let dentClash = false;
        for (const u of fr.warps) if (dent[u] === dent[w]) { dentClash = true; break; }
        if (dentClash) continue;
        if (fr.warps.length < chosenLoad) { chosen = f; chosenLoad = fr.warps.length; }
      }
      if (chosen === -1) {
        // 找一片尚未使用的空框
        for (let f = 0; f < maxFrames; f++) {
          if (!assigned[f]) { assigned[f] = { sig, warps: [] }; chosen = f; break; }
        }
      }
      if (chosen === -1) {
        const lastSafeDent = w === 0 ? -1 : dent[w - 1];
        return {
          ok: false,
          draft,
          frames: assigned.map((f) => ({ warps: f ? f.warps.slice() : [] })),
          failure: {
            warp: w,
            dent: dent[w],
            lastSafeDent,
            code: "FRAMES_EXHAUSTED",
            message:
              "第 " + (w + 1) + " 根经纱(第 " + (dent[w] + 1) + " 筘齿)需要新的开口组合," +
              "但 " + maxFrames + " 片综框已全部登记占用;最后安全筘齿为第 " + (lastSafeDent + 1) + " 筘。",
          },
        };
      }
      assigned[chosen].warps.push(w);
      draft[w] = chosen;
    }
    return { ok: true, draft, frames: assigned.map((f) => ({ warps: f ? f.warps.slice() : [] })) };
  }

  // ---------------------------------------------------------------- 开口序列展开

  /**
   * 展开每投一纬的开口序列。
   * 返回 {
   *   P, F, frameLift: Uint8Array(P*F),   // 第 p 投第 f 框是否提起
   *   warpUp: Uint8Array(P*Wtot),         // 全幅(含边经)每交织点经纱是否在上
   *   Wtot, E, W
   * }
   */
  function shedding(pattern, cfg, draft) {
    const { vectors, words, W, P } = liftVectors(pattern, cfg);
    const F = cfg.frames.length;
    const E = cfg.edgeThreads;
    const Wtot = W + 2 * E;
    const frameLift = new Uint8Array(P * F);
    const warpUp = new Uint8Array(P * Wtot);

    // 本体:逐经纱展开位图
    for (let w = 0; w < W; w++) {
      const f = draft ? draft[w] : -1;
      for (let p = 0; p < P; p++) {
        const up = (vectors[w * words + (p >>> 5)] >>> (p & 31)) & 1;
        warpUp[p * Wtot + E + w] = up;
        if (up && f >= 0) frameLift[p * F + f] = 1;
      }
    }
    // 边经:平纹,两片边综
    for (let j = 0; j < E; j++) {
      for (let p = 0; p < P; p++) {
        const up = edgeWarpUp(cfg, j, p) ? 1 : 0;
        warpUp[p * Wtot + j] = up; // 左边经
        warpUp[p * Wtot + E + W + j] = up; // 右边经
      }
    }
    return { P, F, frameLift, warpUp, Wtot, E, W };
  }

  // ---------------------------------------------------------------- 联查

  /**
   * 联查:容量 / 同筘同综 / 受阻纬线 / 浮长 / 换梭顺序 / 提花线号。
   * draft 中 -1 表示该经纱尚未穿综(无解停在最后安全筘齿前的状态),
   * 联查对已穿部分照常进行,并报告首个未穿位置。
   * draft 为 null 或长度不符时,先尝试自动编排(结果暴露在 report.auto)。
   */
  function validate(pattern, cfg, draftOpt) {
    const W = bodyWarpCount(pattern, cfg);
    const P = cfg.picks.length;
    const F = cfg.frames.length;
    const { dentOf, dents, widthCm } = reedInfo(pattern, cfg);
    const { vectors, words } = liftVectors(pattern, cfg);

    let draft = draftOpt || cfg.draft;
    let auto = null;
    if (!draft || draft.length !== W) {
      auto = autoDraft(pattern, cfg);
      draft = auto.draft;
    }
    // 越界框号 → 未穿;-1 = 未穿综
    draft = draft.map((v) => (v >= 0 && v < F ? v : -1));

    const report = {
      ok: true,
      draft,
      auto: auto ? { ok: auto.ok, failure: auto.failure || null } : null,
      draftComplete: draft.every((v) => v >= 0),
      firstUnassignedWarp: draft.indexOf(-1),
      capacity: [],      // {frame, lineNo, used, capacity}
      adjacency: [],     // {dent, warps:[a,b], frame}
      blockedPicks: [],  // 投序号(0 起)
      blockedByFrame: {},// pick -> [frame...]
      firstBlockedPick: -1,
      floats: { limit: cfg.maxFloat, maxWarp: 0, maxWeft: 0, violations: [] }, // {kind,warp|pick,start,length}
      shuttle: { changes: 0, conflicts: [] }, // {pick, color, prev, gap}
      lineNos: { duplicates: [] },
      reed: { dents, widthCm, lastSafeDent: dents - 1 },
      errors: [],
      warnings: [],
    };
    if (auto && auto.failure) {
      report.reed.lastSafeDent = auto.failure.lastSafeDent;
      report.errors.push(auto.failure.message);
    } else if (!report.draftComplete) {
      const w0 = report.firstUnassignedWarp;
      report.reed.lastSafeDent = w0 === 0 ? -1 : dentOf(w0 - 1);
      report.errors.push(
        "第 " + (w0 + 1) + " 根经纱(第 " + (dentOf(w0) + 1) + " 筘齿)起未穿综;" +
        "停在最后安全筘齿第 " + (report.reed.lastSafeDent + 1) + " 筘前。"
      );
    }

    // 框 → 经纱
    const frameWarps = Array.from({ length: F }, () => []);
    for (let w = 0; w < W; w++) {
      const f = draft[w];
      if (f >= 0 && f < F) frameWarps[f].push(w);
    }

    // 1) 综框容量
    for (let f = 0; f < F; f++) {
      const used = frameWarps[f].length;
      if (used > cfg.frames[f].capacity) {
        report.capacity.push({ frame: f, lineNo: cfg.frames[f].lineNo, used, capacity: cfg.frames[f].capacity });
      }
    }

    // 2) 同筘同综(相邻经纱冲突)
    for (let d = 0; d < dents; d++) {
      const seen = new Map(); // frame -> warp
      const a = d * cfg.perDent, b = Math.min(W, a + cfg.perDent);
      for (let w = a; w < b; w++) {
        const f = draft[w];
        if (f < 0) continue;
        if (seen.has(f)) report.adjacency.push({ dent: d, warps: [seen.get(f), w], frame: f });
        else seen.set(f, w);
      }
    }

    // 3) 受阻纬线:同一框内经纱在某投要求不同开口 → 该投无法开口
    //    (draft 未穿完时,开口一致性无法判定,跳过;受阻原因已在头部报告)
    const blockedSet = new Set();
    if (report.draftComplete) {
      for (let f = 0; f < F; f++) {
        const ws = frameWarps[f];
        if (ws.length < 2) continue;
        for (let p = 0; p < P; p++) {
          const bit = (vectors[ws[0] * words + (p >>> 5)] >>> (p & 31)) & 1;
          for (let i = 1; i < ws.length; i++) {
            const b2 = (vectors[ws[i] * words + (p >>> 5)] >>> (p & 31)) & 1;
            if (b2 !== bit) {
              blockedSet.add(p);
              (report.blockedByFrame[p] = report.blockedByFrame[p] || []).push(f);
              break;
            }
          }
        }
      }
    }
    report.blockedPicks = Array.from(blockedSet).sort((a, b) => a - b);
    report.firstBlockedPick = report.blockedPicks.length ? report.blockedPicks[0] : -1;

    // 4) 浮长:经浮长 = 同一经纱连续提起;纬浮长 = 同一投内纬线连续浮于经上
    const limit = cfg.maxFloat;
    for (let w = 0; w < W; w++) {
      let run = 0, start = 0;
      for (let p = 0; p <= P; p++) {
        const up = p < P ? (vectors[w * words + (p >>> 5)] >>> (p & 31)) & 1 : 0;
        if (up) { if (run === 0) start = p; run++; }
        else {
          if (run > 0) {
            report.floats.maxWarp = Math.max(report.floats.maxWarp, run);
            if (run > limit) report.floats.violations.push({ kind: "warp", warp: w, start, length: run });
            run = 0;
          }
        }
      }
    }
    for (let p = 0; p < P; p++) {
      let run = 0, start = 0;
      for (let w = 0; w <= W; w++) {
        const down = w < W ? 1 - ((vectors[w * words + (p >>> 5)] >>> (p & 31)) & 1) : 0;
        if (down) { if (run === 0) start = w; run++; }
        else {
          if (run > 0) {
            report.floats.maxWeft = Math.max(report.floats.maxWeft, run);
            if (run > limit) report.floats.violations.push({ kind: "weft", pick: p, start, length: run });
            run = 0;
          }
        }
      }
    }

    // 5) 换梭顺序:同一梭(同色)相邻两次使用必须隔奇数投,
    //    否则梭子停在错误一侧,回不到本投的出发侧(需倒梭)。
    //    每种色首次使用不计——织工可在任意一侧梭箱预置该梭。
    const lastUse = new Map(); // color -> 上次使用的投序号
    for (let p = 0; p < P; p++) {
      const c = cfg.picks[p].color | 0;
      if (p > 0 && c !== (cfg.picks[p - 1].color | 0)) report.shuttle.changes++;
      if (lastUse.has(c)) {
        const prev = lastUse.get(c);
        const gap = p - prev;
        if (gap % 2 === 0) {
          report.shuttle.conflicts.push({ pick: p, color: c, prev, gap });
        }
      }
      lastUse.set(c, p);
    }

    // 首个受阻纬线 = 开口受阻与换梭受阻中最早的一投
    const shuttleFirst = report.shuttle.conflicts.length ? report.shuttle.conflicts[0].pick : -1;
    if (shuttleFirst >= 0 && (report.firstBlockedPick < 0 || shuttleFirst < report.firstBlockedPick)) {
      report.firstBlockedPick = shuttleFirst;
    }

    // 6) 提花线号重复
    const byLine = new Map();
    cfg.frames.forEach((fr, f) => {
      if (byLine.has(fr.lineNo)) byLine.get(fr.lineNo).push(f);
      else byLine.set(fr.lineNo, [f]);
    });
    for (const [lineNo, fs] of byLine) {
      if (fs.length > 1) report.lineNos.duplicates.push({ lineNo, frames: fs });
    }

    // 汇总
    if (report.capacity.length) report.errors.push("综框容量超限:" + report.capacity.map((c) => "线号" + c.lineNo + "(" + c.used + "/" + c.capacity + ")").join("、"));
    if (report.adjacency.length) report.errors.push("同筘同综 " + report.adjacency.length + " 处(相邻经纱会绞缠)");
    if (report.blockedPicks.length) report.errors.push("第 " + (report.blockedPicks[0] + 1) + " 投起共 " + report.blockedPicks.length + " 投开口受阻(同框经纱开口不一致)");
    if (report.shuttle.conflicts.length) report.errors.push("第 " + (report.shuttle.conflicts[0].pick + 1) + " 投换梭顺序冲突(同色梭间隔 " + report.shuttle.conflicts[0].gap + " 投为偶数,梭子回不到出发侧)");
    if (report.lineNos.duplicates.length) report.errors.push("提花线号重复:" + report.lineNos.duplicates.map((d) => d.lineNo).join("、"));
    if (report.floats.violations.length) report.warnings.push("浮长超上限 " + cfg.maxFloat + ":" + report.floats.violations.length + " 处(经浮最长 " + report.floats.maxWarp + "、纬浮最长 " + report.floats.maxWeft + ")");

    report.ok = report.errors.length === 0 && report.draftComplete;
    return report;
  }

  // ---------------------------------------------------------------- 织物模拟取色

  /**
   * 织物模拟:每个交织点的面色序号。
   * 经浮 → 该列经线色;纬浮 → 该投纬线色;边经 → 边经色(取经线 0 号色)。
   * 返回 Uint8Array(P * Wtot)。
   */
  function drawdownColors(pattern, cfg, draft) {
    const shed = shedding(pattern, cfg, draft);
    const { P, Wtot, E, W, warpUp } = shed;
    const out = new Uint8Array(P * Wtot);
    for (let p = 0; p < P; p++) {
      const weft = cfg.picks[p].color | 0;
      for (let x = 0; x < Wtot; x++) {
        let color;
        if (warpUp[p * Wtot + x]) {
          if (x < E || x >= E + W) color = cfg.warpColors[0] | 0; // 边经取首列经线色
          else color = cfg.warpColors[x - E] | 0;
        } else {
          color = weft;
        }
        out[p * Wtot + x] = color;
      }
    }
    return { colors: out, P, Wtot, E, W };
  }

  // ---------------------------------------------------------------- 导出 / 导入

  /** 导出完整方案(纹样 + 上机配置)为 JSON 字符串 */
  function exportPlan(pattern, cfg) {
    return JSON.stringify(
      {
        app: "zfl31-loom",
        version: PLAN_VERSION,
        exportedAt: "local",
        pattern: { cols: pattern.cols, rows: pattern.rows, cells: Array.from(pattern.cells) },
        loom: {
          frames: cfg.frames.map((f) => ({ lineNo: f.lineNo | 0, capacity: f.capacity | 0 })),
          perDent: cfg.perDent | 0,
          dentsPerCm: cfg.dentsPerCm,
          edgeThreads: cfg.edgeThreads | 0,
          maxFloat: cfg.maxFloat | 0,
          repeatX: cfg.repeatX | 0 || 1,
          repeatY: cfg.repeatY | 0 || 1,
          warpColors: Array.from(cfg.warpColors),
          picks: cfg.picks.map((p) => ({ row: p.row | 0, color: p.color | 0 })),
          draft: cfg.draft ? Array.from(cfg.draft) : null,
        },
      },
      null,
      2
    );
  }

  /**
   * 导入方案。兼容:
   *  - v2 完整方案 { pattern, loom }
   *  - 旧版纹样导出 { cols, rows, cells, usage? }(只含纹样 → 默认上机配置)
   * 返回 { pattern, config }。数据非法时抛错。
   */
  function importPlan(text) {
    let data;
    try {
      data = typeof text === "string" ? JSON.parse(text) : text;
    } catch (e) {
      throw new Error("文件不是合法 JSON");
    }
    if (!data || typeof data !== "object") throw new Error("方案内容为空");

    // 旧版纹样导出:顶层即 cols/rows/cells
    if (Array.isArray(data.cells) && Number.isInteger(data.cols) && Number.isInteger(data.rows)) {
      const pattern = sanitizePattern(data);
      return { pattern, config: defaultConfig(pattern) };
    }

    if (!data.pattern) throw new Error("缺少 pattern 字段");
    const pattern = sanitizePattern(data.pattern);
    const cfg = defaultConfig(pattern);
    const loom = data.loom || {};
    if (Array.isArray(loom.frames) && loom.frames.length >= 1 && loom.frames.length <= 32) {
      cfg.frames = loom.frames.map((f, i) => ({
        lineNo: Number.isInteger(f.lineNo) ? f.lineNo : i + 1,
        capacity: Number.isInteger(f.capacity) && f.capacity > 0 ? f.capacity : 48,
      }));
    }
    for (const k of ["perDent", "edgeThreads", "maxFloat", "repeatX", "repeatY"]) {
      if (Number.isInteger(loom[k]) && loom[k] > 0) cfg[k] = loom[k];
    }
    if (Number.isFinite(loom.dentsPerCm) && loom.dentsPerCm > 0) cfg.dentsPerCm = loom.dentsPerCm;
    const W = bodyWarpCount(pattern, cfg);
    if (Array.isArray(loom.warpColors) && loom.warpColors.length === W) cfg.warpColors = loom.warpColors.map((v) => v | 0);
    else cfg.warpColors = defaultWarpColors(pattern, cfg.repeatX);
    if (Array.isArray(loom.picks) && loom.picks.length > 0 && loom.picks.every((p) => Number.isInteger(p.row) && Number.isInteger(p.color))) {
      cfg.picks = loom.picks.map((p) => ({ row: p.row | 0, color: p.color | 0 }));
    } else {
      cfg.picks = defaultPicks(pattern, cfg.repeatY);
    }
    if (Array.isArray(loom.draft) && loom.draft.length === W && loom.draft.every((v) => Number.isInteger(v) && v >= 0 && v < cfg.frames.length)) {
      cfg.draft = loom.draft.map((v) => v | 0);
    }
    return { pattern, config: cfg };
  }

  function sanitizePattern(p) {
    const cols = p.cols | 0, rows = p.rows | 0;
    if (cols < 1 || rows < 1 || cols > 512 || rows > 512) throw new Error("纹样尺寸非法");
    if (!Array.isArray(p.cells) || p.cells.length !== cols * rows) throw new Error("纹样格数与尺寸不符");
    return { cols, rows, cells: p.cells.map((v) => Math.max(0, Math.min(255, v | 0))) };
  }

  // ---------------------------------------------------------------- 汇总用量

  /** 用线量:经线按列色统计(根数×纬向行数),纬线按梭序统计(投数×幅宽) */
  function usage(pattern, cfg) {
    const W = bodyWarpCount(pattern, cfg);
    const warp = new Map();
    for (let w = 0; w < W; w++) {
      const c = cfg.warpColors[w] | 0;
      warp.set(c, (warp.get(c) || 0) + 1);
    }
    const weft = new Map();
    for (const p of cfg.picks) weft.set(p.color | 0, (weft.get(p.color | 0) || 0) + 1);
    return { warp, weft, warpThreads: W, picks: cfg.picks.length };
  }

  return {
    EDGE_FRAMES,
    PLAN_VERSION,
    cellAt,
    bodyWarpCount,
    totalWarpCount,
    reedInfo,
    defaultWarpColors,
    defaultPicks,
    defaultConfig,
    liftVectors,
    edgeWarpUp,
    autoDraft,
    shedding,
    validate,
    drawdownColors,
    exportPlan,
    importPlan,
    usage,
  };
});
