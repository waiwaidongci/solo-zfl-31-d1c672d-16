// 引擎自动化测试:node --test tests/
// 覆盖:合法编排 / 综框容量 / 相邻经纱冲突 / 首个受阻纬线 / 换梭顺序 /
//       浮长 / 无解(最后安全筘齿+原因)/ 导出导入 / 旧格式兼容 / 大规模性能
const test = require("node:test");
const assert = require("node:assert/strict");
const Engine = require("../src/engine/loom-engine.js");

// ---------- 测试纹样 ----------
// 6 列 × 4 行:第 0 列全色 1,第 1 列全色 2,第 2 列棋盘,其余地色 0
function samplePattern() {
  const cols = 6, rows = 4;
  const cells = new Array(cols * rows).fill(0);
  for (let y = 0; y < rows; y++) {
    cells[y * cols + 0] = 1;
    cells[y * cols + 1] = 2;
    cells[y * cols + 2] = y % 2 === 0 ? 1 : 2;
  }
  return { cols, rows, cells };
}

// 需要 5 种不同开口的纹样(每列开口向量不同)
function fiveWayPattern() {
  const cols = 5, rows = 4;
  const cells = new Array(cols * rows).fill(0);
  // 每列在不同行出现色 1 → 每列开口向量唯一
  for (let x = 0; x < cols; x++) cells[(x % rows) * cols + x] = 1;
  // 让列 4 的向量与列 0..3 都不同:再改一行
  cells[3 * cols + 4] = 1;
  return { cols, rows, cells };
}

function cfgOf(pattern, overrides) {
  return Engine.defaultConfig(pattern, overrides);
}

// ---------- 基础模型 ----------

test("默认配置:梭序逐行逐色生成,经线色取列主色", () => {
  const p = samplePattern();
  const cfg = cfgOf(p);
  // 每行颜色集合:{0,1,2} → 每行 3 投,共 12 投
  assert.equal(cfg.picks.length, 12);
  assert.deepEqual(cfg.picks.slice(0, 3).map((k) => k.color), [1, 2, 0]);
  assert.equal(cfg.picks[0].row, 0);
  assert.equal(cfg.warpColors.length, 6);
  assert.equal(cfg.warpColors[0], 1); // 第 0 列主色为 1
  assert.equal(cfg.warpColors[3], 0);
  assert.equal(Engine.bodyWarpCount(p, cfg), 6);
  assert.equal(Engine.totalWarpCount(p, cfg), 6 + 2 * cfg.edgeThreads);
});

test("穿筘:筘齿数与幅宽计算", () => {
  const p = samplePattern();
  const cfg = cfgOf(p, { perDent: 2, dentsPerCm: 4 });
  const info = Engine.reedInfo(p, cfg);
  assert.equal(info.dents, 3);
  assert.equal(info.widthCm, 0.75);
});

// ---------- 合法编排 ----------

test("合法编排:自动穿综成功,开口序列与纹样一致,无冲突", () => {
  const p = samplePattern();
  const cfg = cfgOf(p);
  const draftRes = Engine.autoDraft(p, cfg);
  assert.equal(draftRes.ok, true);
  cfg.draft = draftRes.draft;

  const report = Engine.validate(p, cfg, cfg.draft);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.blockedPicks.length, 0);
  assert.equal(report.adjacency.length, 0);
  assert.equal(report.capacity.length, 0);
  assert.equal(report.floats.violations.length, 0);
  assert.equal(report.shuttle.conflicts.length, 0);

  // 开口序列抽查:第 0 投色 1 → 色 1 的格子经沉(纬浮),其余经浮
  const shed = Engine.shedding(p, cfg, cfg.draft);
  const E = cfg.edgeThreads, W = 6;
  // 行 0: cells = [1,2,1,0,0,0];投 0 色 1 → 列 0、2 经沉(0),其余经浮(1)
  const row0 = Array.from({ length: W }, (_, w) => shed.warpUp[0 * shed.Wtot + E + w]);
  assert.deepEqual(row0, [0, 1, 0, 1, 1, 1]);
});

test("边组织:边经平纹,左右边交替起落", () => {
  const p = samplePattern();
  const cfg = cfgOf(p, { edgeThreads: 4 });
  const draftRes = Engine.autoDraft(p, cfg);
  const shed = Engine.shedding(p, cfg, draftRes.draft);
  // 左边经第 0 根:投 0 提起,投 1 沉下(平纹)
  assert.equal(shed.warpUp[0 * shed.Wtot + 0], 1);
  assert.equal(shed.warpUp[1 * shed.Wtot + 0], 0);
  // 左边经第 1 根相反
  assert.equal(shed.warpUp[0 * shed.Wtot + 1], 0);
  assert.equal(shed.warpUp[1 * shed.Wtot + 1], 1);
});

// ---------- 综框容量 ----------

test("综框容量:同纹经纱超过单框容量时自动分框", () => {
  const p = samplePattern();
  // 容量 1:列 3、4、5 开口向量相同(全地色行行为一致),需分到 3 个框
  const cfg = cfgOf(p, {
    frames: Array.from({ length: 8 }, (_, i) => ({ lineNo: i + 1, capacity: 1 })),
  });
  const res = Engine.autoDraft(p, cfg);
  assert.equal(res.ok, true);
  const used = new Set(res.draft);
  assert.ok(used.size >= 4, "同纹经纱被分到多个综框");
  const report = Engine.validate(p, cfg, res.draft);
  assert.equal(report.capacity.length, 0);
});

test("综框容量:手排超容被联查指出", () => {
  const p = samplePattern();
  const cfg = cfgOf(p, {
    frames: Array.from({ length: 8 }, (_, i) => ({ lineNo: i + 1, capacity: 2 })),
  });
  const draft = [0, 1, 2, 0, 0, 3]; // 框 0 装 3 根 > 容量 2
  const report = Engine.validate(p, cfg, draft);
  assert.equal(report.ok, false);
  assert.equal(report.capacity.length, 1);
  assert.equal(report.capacity[0].frame, 0);
  assert.equal(report.capacity[0].used, 3);
});

// ---------- 相邻经纱冲突 ----------

test("相邻经纱冲突:同筘齿内同综框被检出", () => {
  const p = samplePattern();
  const cfg = cfgOf(p, { perDent: 2 });
  // 经纱 0、1 同筘(筘 0),都穿框 0 → 冲突
  const draft = [0, 0, 1, 2, 3, 4];
  const report = Engine.validate(p, cfg, draft);
  assert.equal(report.ok, false);
  assert.equal(report.adjacency.length, 1);
  assert.equal(report.adjacency[0].dent, 0);
  assert.deepEqual(report.adjacency[0].warps, [0, 1]);
});

// ---------- 首个受阻纬线 ----------

test("受阻纬线:同框经纱开口需求不同 → 定位首个受阻投", () => {
  const p = samplePattern();
  const cfg = cfgOf(p);
  // 列 0(全色1)与列 2(棋盘)开口向量不同,强穿同框 0
  const draft = [0, 1, 0, 2, 3, 4];
  const report = Engine.validate(p, cfg, draft);
  assert.equal(report.ok, false);
  assert.ok(report.blockedPicks.length > 0);
  // 默认梭序:每行 3 投(色 1、2、0)。投 0..2(行0):列0 与列2 需求一致;
  // 投 3(行1 色1):列0 经沉、列2 该行为色2 → 经浮,需求冲突 → 首个受阻投为 3
  assert.equal(report.firstBlockedPick, 3);
  assert.ok(report.blockedByFrame[3].includes(0));
});

// ---------- 换梭顺序 ----------

test("换梭顺序:同色梭两次使用须隔奇数投,否则梭子回不到出发侧", () => {
  const p = samplePattern();
  const cfg = cfgOf(p);
  // 手工梭序:色 1 在第 0、2 投使用,间隔 2(偶数)→ 第 2 投受阻
  cfg.picks = [
    { row: 0, color: 1 },
    { row: 0, color: 2 },
    { row: 0, color: 1 },
  ];
  const draftRes = Engine.autoDraft(p, cfg);
  const report = Engine.validate(p, cfg, draftRes.draft);
  assert.equal(report.ok, false);
  assert.equal(report.shuttle.conflicts.length, 1);
  assert.equal(report.shuttle.conflicts[0].pick, 2);
  assert.equal(report.shuttle.conflicts[0].color, 1);
  assert.equal(report.shuttle.conflicts[0].gap, 2);
  assert.equal(report.firstBlockedPick, 2);
});

test("换梭顺序:同色连投与奇数间隔均合法,统计换梭次数", () => {
  const p = samplePattern();
  const cfg = cfgOf(p);
  // 色1: 投0,1,6,7(间隔1,5,1 皆奇);色2: 投2,3;色0: 投4,5 → 全部合法
  cfg.picks = [
    { row: 0, color: 1 },
    { row: 0, color: 1 },
    { row: 0, color: 2 },
    { row: 0, color: 2 },
    { row: 0, color: 0 },
    { row: 0, color: 0 },
    { row: 0, color: 1 },
    { row: 0, color: 1 },
  ];
  const draftRes = Engine.autoDraft(p, cfg);
  const report = Engine.validate(p, cfg, draftRes.draft);
  assert.equal(report.shuttle.conflicts.length, 0);
  assert.equal(report.shuttle.changes, 3);
});

// ---------- 浮长 ----------

test("浮长:超过上限的经浮被列出", () => {
  // 列 0 全色 1,列 1 全色 0;手工梭序 8 投全色 0
  // → 列 0 经纱连续 8 投提起(经浮 8 > 上限 3);列 1 每投纬浮 1
  const cols = 2, rows = 4;
  const cells = new Array(cols * rows).fill(0);
  for (let y = 0; y < rows; y++) cells[y * cols] = 1;
  const p = { cols, rows, cells };
  const cfg = cfgOf(p, { maxFloat: 3 });
  cfg.picks = Array.from({ length: 8 }, () => ({ row: 0, color: 0 }));
  const draftRes = Engine.autoDraft(p, cfg);
  const report = Engine.validate(p, cfg, draftRes.draft);
  assert.equal(report.floats.maxWarp, 8);
  assert.ok(report.floats.violations.some((v) => v.kind === "warp" && v.warp === 0 && v.length === 8));
  assert.ok(report.warnings.length > 0);
  // 浮长是警示而非阻塞:无其他错误时整体仍可通过
  assert.equal(report.ok, true);
});

// ---------- 无解:停在最后安全筘齿前 ----------

test("无解:开口组合超过综框数,报告受阻经纱与最后安全筘齿", () => {
  const p = fiveWayPattern();
  // 验证该纹样确有 ≥5 种开口向量
  const cfgAll = cfgOf(p, { frames: Array.from({ length: 8 }, (_, i) => ({ lineNo: i + 1, capacity: 48 })) });
  const full = Engine.autoDraft(p, cfgAll);
  assert.equal(full.ok, true);
  const distinct = new Set(full.draft).size;
  assert.ok(distinct >= 5, "纹样需要至少 5 种开口,实际 " + distinct);

  // 只登记 4 片综框 → 无解
  const cfg = cfgOf(p, { frames: Array.from({ length: 4 }, (_, i) => ({ lineNo: i + 1, capacity: 48 })) });
  const res = Engine.autoDraft(p, cfg);
  assert.equal(res.ok, false);
  assert.equal(res.failure.code, "FRAMES_EXHAUSTED");
  assert.equal(res.failure.warp, 4); // 第 5 根经纱需要第 5 种开口
  assert.equal(res.failure.dent, 2); // perDent=2 → 经纱 4 在第 3 筘(下标 2)
  assert.equal(res.failure.lastSafeDent, 1); // 最后安全筘齿 = 经纱 3 所在筘
  assert.match(res.failure.message, /综框/);

  // validate 也报告同一无解位置
  const report = Engine.validate(p, cfg, res.draft);
  assert.equal(report.ok, false);
  assert.equal(report.draftComplete, false);
  assert.equal(report.reed.lastSafeDent, 1);
});

// ---------- 导出 / 导入 ----------

test("导出再导入:方案完整往返,校验结果一致", () => {
  const p = samplePattern();
  const cfg = cfgOf(p, { perDent: 3, dentsPerCm: 5, maxFloat: 4 });
  cfg.frames[0].lineNo = 21;
  const draftRes = Engine.autoDraft(p, cfg);
  cfg.draft = draftRes.draft;

  const text = Engine.exportPlan(p, cfg);
  const back = Engine.importPlan(text);
  assert.deepEqual(back.pattern, p);
  assert.equal(back.config.perDent, 3);
  assert.equal(back.config.dentsPerCm, 5);
  assert.equal(back.config.maxFloat, 4);
  assert.equal(back.config.frames[0].lineNo, 21);
  assert.deepEqual(back.config.picks, cfg.picks);
  assert.deepEqual(back.config.draft, cfg.draft);

  const r1 = Engine.validate(p, cfg, cfg.draft);
  const r2 = Engine.validate(back.pattern, back.config, back.config.draft);
  assert.equal(r1.ok, r2.ok);
  assert.deepEqual(r1.blockedPicks, r2.blockedPicks);
});

test("导入兼容旧纹样导出格式(仅 cols/rows/cells)", () => {
  const old = JSON.stringify({ cols: 6, rows: 4, cells: samplePattern().cells, usage: [] });
  const back = Engine.importPlan(old);
  assert.equal(back.pattern.cols, 6);
  assert.ok(back.config.frames.length >= 1);
  assert.ok(back.config.picks.length > 0);
});

test("导入拒绝坏数据", () => {
  assert.throws(() => Engine.importPlan("not json"));
  assert.throws(() => Engine.importPlan(JSON.stringify({ cols: 0, rows: 0, cells: [] })));
  assert.throws(() => Engine.importPlan(JSON.stringify({ pattern: { cols: 2, rows: 2, cells: [1] } })));
});

// ---------- 纹样重复(大量经纬线) ----------

test("重复单元:经向重复后开口向量按模平铺", () => {
  const p = samplePattern();
  const cfg = cfgOf(p, { repeatX: 3, repeatY: 2 });
  assert.equal(Engine.bodyWarpCount(p, cfg), 18);
  assert.equal(cfg.picks.length, 24); // 8 行 × 每行 3 色
  const shed0 = Engine.shedding(p, cfg, Engine.autoDraft(p, cfg).draft);
  // 经纱 w 与 w+6(同一纹样列)开口一致
  const E = cfg.edgeThreads;
  for (let pk = 0; pk < 24; pk++) {
    assert.equal(
      shed0.warpUp[pk * shed0.Wtot + E + 0],
      shed0.warpUp[pk * shed0.Wtot + E + 6]
    );
  }
});

// ---------- 填补式重排与未穿综 ----------

test("填补式重排:保留手工已穿经纱,只为未穿补位", () => {
  const p = samplePattern();
  const cfg = cfgOf(p);
  const full = Engine.autoDraft(p, cfg);
  // 手工把经纱 0、1(开口不同)都穿到框 1 → 该框锁定;其余置未穿
  const manual = full.draft.map(() => -1);
  manual[0] = 1;
  manual[1] = 1;
  const res = Engine.autoDraft(p, cfg, manual);
  assert.equal(res.ok, true);
  assert.equal(res.draft[0], 1, "手工穿综保持不动");
  assert.equal(res.draft[1], 1, "手工穿综保持不动");
  assert.ok(res.draft.every((v) => v >= 0), "未穿的全部补位");
  assert.ok(res.draft.slice(2).every((v) => v !== 1), "锁定框不再补入");
  // 锁定框(同框两种开口)在联查中报告受阻,而不是被静默改掉
  const report = Engine.validate(p, cfg, res.draft);
  assert.ok(report.blockedPicks.length > 0);
});

test("未穿综:联查报告首个未穿经纱与最后安全筘齿", () => {
  const p = samplePattern();
  const cfg = cfgOf(p);
  const draft = [0, 1, 2, -1, -1, -1];
  const report = Engine.validate(p, cfg, draft);
  assert.equal(report.draftComplete, false);
  assert.equal(report.firstUnassignedWarp, 3);
  assert.equal(report.reed.lastSafeDent, 1); // 经纱 2 在筘 1(perDent=2)
  assert.equal(report.ok, false);
  assert.ok(report.errors[0].includes("未穿综"));
});

// ---------- 性能 ----------

test("性能:576 经 × 512 纬 自动编排+联查+开口展开在 1.5s 内完成", () => {
  const cols = 32, rows = 32;
  const cells = new Array(cols * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) cells[y * cols + x] = (x * 7 + y * 3) % 4;
  const p = { cols, rows, cells };
  const cfg = cfgOf(p, {
    repeatX: 18, // 32*18 = 576 经
    repeatY: 16, // 512 行 → 每行 ≤4 色 → 最多 2048 投;截到 512 投内验证规模
    frames: Array.from({ length: 16 }, (_, i) => ({ lineNo: i + 1, capacity: 96 })),
  });
  cfg.picks = cfg.picks.slice(0, 512);
  const t0 = process.hrtime.bigint();
  const res = Engine.autoDraft(p, cfg);
  const report = Engine.validate(p, cfg, res.draft);
  const shed = Engine.shedding(p, cfg, res.draft);
  const colors = Engine.drawdownColors(p, cfg, res.draft);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(shed.warpUp.length === 512 * (576 + 2 * cfg.edgeThreads));
  assert.ok(colors.colors.length === 512 * (576 + 2 * cfg.edgeThreads));
  assert.ok(ms < 1500, "耗时 " + ms.toFixed(1) + "ms 超限");
  assert.equal(typeof report.ok, "boolean");
});
