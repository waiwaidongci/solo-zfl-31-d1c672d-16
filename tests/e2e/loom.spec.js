// 真实浏览器录制:合法编排 / 拖动冲突 / 自动重排 / 换梭冲突 / 无解 / 导出导入 / 旧纹样回归
// 桌面用鼠标拖动,手机用点选(同一套断言);全程录像与截图存入 recordings/
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const RECORD_DIR = path.join(__dirname, "..", "..", "recordings");

// 演示纹样 A:6 列 × 4 行,6 种开口,默认方案完全合法(引擎已验证)
const PATTERN_A = {
  cols: 6,
  rows: 4,
  cells: [
    1, 1, 0, 0, 2, 2,
    1, 1, 0, 0, 2, 2,
    0, 0, 2, 2, 1, 1,
    0, 0, 2, 2, 1, 1,
  ],
};

// 穿综图几何(与 src/ui/loom-tab.js 的 DRAFT 常量一致)
const DRAFT = { gut: 70, head: 22, cw: 13, rh: 19 };

async function shot(page, testInfo, name) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  await page.screenshot({ path: path.join(RECORD_DIR, `${name}-${testInfo.project.name}.png`) });
}

/** 装入纹样并切到上机织造页,等待重算完成 */
async function setupLoom(page, pattern) {
  await page.goto("/");
  await page.evaluate((p) => window.ZFL.patternTab.applyPattern(p), pattern);
  await page.click("#tabBtnLoom");
  await expect(page.locator("#loomBanner")).toHaveClass(/show/);
}

const loomState = (page) => page.evaluate(() => {
  const L = window.ZFL.loomTab.state();
  return {
    draft: L.cfg.draft.slice(),
    frames: L.cfg.frames.length,
    edge: L.cfg.edgeThreads,
    picks: L.cfg.picks.map((p) => p.color),
    firstBlockedPick: L.report.firstBlockedPick,
    errors: L.report.errors.slice(),
    replayPick: L.replay.pick,
    autoFailure: L.autoFailure ? L.autoFailure.code : null,
  };
});

async function draftCell(page, warp, frame, state) {
  const cv = page.locator("#draftCanvas");
  await cv.scrollIntoViewIfNeeded(); // 原始 mouse 事件不自动滚动,先保证画布在视口内
  const box = await cv.boundingBox();
  return {
    x: box.x + DRAFT.gut + (state.edge + warp) * DRAFT.cw + DRAFT.cw / 2,
    y: box.y + DRAFT.head + frame * DRAFT.rh + DRAFT.rh / 2,
  };
}

test.afterEach(async ({ page, context }, testInfo) => {
  await context.close();
  const video = page.video();
  if (video) {
    const name = testInfo.title.replace(/[^\w一-龥]+/g, "-");
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    await video.saveAs(path.join(RECORD_DIR, `${name}-${testInfo.project.name}.webm`)).catch(() => {});
  }
});

test("合法编排:自动穿综通过,开口序列与回放正常", async ({ page }, testInfo) => {
  await setupLoom(page, PATTERN_A);
  const banner = page.locator("#loomBanner");
  await expect(banner).toHaveClass(/ok/);
  await expect(banner).toContainText("编排合法");
  const st = await loomState(page);
  expect(st.errors).toEqual([]);
  expect(st.firstBlockedPick).toBe(-1);
  expect(new Set(st.draft).size).toBe(6); // 6 种开口各占一框
  // 联查报告各节通过
  const report = page.locator("#loomReport");
  await expect(report).toContainText("综框容量");
  await expect(report).toContainText("相邻经纱");
  await expect(report).toContainText("受阻纬线");
  await expect(report).toContainText("浮长");
  await expect(report).toContainText("换梭");
  await expect(report).not.toContainText("首个受阻纬线");
  // 回放:播放后织口推进
  await page.click("#replayPlay");
  await page.waitForFunction(() => window.ZFL.loomTab.state().replay.pick >= 2, null, { timeout: 5000 });
  await page.click("#replayPlay"); // 暂停
  const cur = await page.locator("#pickList .pick-row.current").count();
  expect(cur).toBe(1);
  await shot(page, testInfo, "01-合法编排");
});

test("拖动经纱制造冲突:立即指出首个受阻纬线", async ({ page }, testInfo) => {
  await setupLoom(page, PATTERN_A);
  await expect(page.locator("#loomBanner")).toHaveClass(/ok/);
  const st = await loomState(page);
  // 纹样 A:列 0/1 同纹、列 2/3 同纹、列 4/5 同纹。
  // 把经纱 0 拖到经纱 2 所在的框 → 同框两种开口 → 受阻
  const from = await draftCell(page, 0, st.draft[0], st);
  const to = await draftCell(page, 0, st.draft[2], st);
  if (testInfo.project.name === "mobile") {
    await page.touchscreen.tap(from.x, from.y); // 点选经纱
    await page.touchscreen.tap(to.x, to.y); // 点目标综框
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForFunction(() => window.ZFL.loomTab.state().report.firstBlockedPick >= 0);
  await expect(page.locator("#loomBanner")).toHaveClass(/err/);
  await expect(page.locator("#loomReport")).toContainText("首个受阻纬线");
  const after = await loomState(page);
  expect(after.draft[0]).toBe(st.draft[2]); // 拖放生效
  await shot(page, testInfo, "02-拖动冲突");
});

test("自动重排:冲突后一键恢复合法", async ({ page }, testInfo) => {
  await setupLoom(page, PATTERN_A);
  const st = await loomState(page);
  // 先制造冲突(等价于拖动后的状态:经纱 0 并入经纱 2 的框)并重算,确认受阻出现
  await page.evaluate(([f]) => {
    const Z = window.ZFL;
    Z.loomTab.state().cfg.draft[0] = f;
    Z.loomTab.recompute();
  }, [st.draft[2]]);
  await page.waitForFunction(() => window.ZFL.loomTab.state().report.firstBlockedPick >= 0);
  await expect(page.locator("#loomReport")).toContainText("首个受阻纬线");
  // 点「自动编排(重排)」→ 恢复合法
  await page.click("#autoDraftBtn");
  await page.waitForFunction(() => window.ZFL.loomTab.state().report.errors.length === 0);
  await expect(page.locator("#loomBanner")).toHaveClass(/ok/);
  await expect(page.locator("#loomReport")).not.toContainText("首个受阻纬线");
  await shot(page, testInfo, "03-自动重排");
});

test("换梭顺序:拖动梭序造成同色梭偶数间隔,立即受阻", async ({ page }, testInfo) => {
  await setupLoom(page, PATTERN_A);
  await expect(page.locator("#loomBanner")).toHaveClass(/ok/);
  // 把第 1 投下移一位 → 色 1 间隔变偶数
  await page.locator("#pickList .pick-row").first().locator("[data-down]").click();
  await page.waitForFunction(() => window.ZFL.loomTab.state().report.errors.length > 0);
  await expect(page.locator("#loomBanner")).toHaveClass(/err/);
  await expect(page.locator("#loomBanner")).toContainText("换梭");
  await expect(page.locator("#loomReport")).toContainText("首个受阻纬线");
  await shot(page, testInfo, "04-换梭冲突");
});

test("无解:综框不足时停在最后安全筘齿前并说明原因", async ({ page }, testInfo) => {
  await setupLoom(page, PATTERN_A);
  await expect(page.locator("#loomBanner")).toHaveClass(/ok/);
  // 纹样 A 需要 6 种开口;删掉 3 片综框只剩 5 片 → 无解
  for (let i = 0; i < 3; i++) {
    await page.locator("#frameList .frame-row:not(.edge) [data-del]").last().click();
  }
  await page.waitForFunction(() => {
    const f = window.ZFL.loomTab.state().autoFailure;
    return f && f.code === "FRAMES_EXHAUSTED";
  });
  const banner = page.locator("#loomBanner");
  await expect(banner).toHaveClass(/err/);
  await expect(banner).toContainText("无解");
  await expect(banner).toContainText("最后安全筘齿");
  const st = await loomState(page);
  expect(st.frames).toBe(5);
  await shot(page, testInfo, "05-无解停筘");
});

test("导出方案再导入:编排状态完整还原", async ({ page }, testInfo) => {
  await setupLoom(page, PATTERN_A);
  await expect(page.locator("#loomBanner")).toHaveClass(/ok/);
  const before = await loomState(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportPlanBtn"),
  ]);
  const file = await download.path();
  expect(fs.existsSync(file)).toBeTruthy();
  // 打乱状态:删两片综框
  await page.locator("#frameList .frame-row:not(.edge) [data-del]").last().click();
  await page.locator("#frameList .frame-row:not(.edge) [data-del]").last().click();
  expect((await loomState(page)).frames).toBe(6);
  // 导入还原
  await page.setInputFiles("#importFile", file);
  await page.waitForFunction(() => window.ZFL.loomTab.state().cfg.frames.length === 8);
  await expect(page.locator("#loomBanner")).toHaveClass(/ok/);
  const after = await loomState(page);
  expect(after.draft).toEqual(before.draft);
  expect(after.picks).toEqual(before.picks);
  await shot(page, testInfo, "06-导出导入");
});

test("旧纹样页:绘制、统计、撤销、保存与导出仍然可用", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator("#tab-pattern")).toBeVisible();
  const cells = page.locator("#grid .cell");
  expect(await cells.count()).toBe(18 * 14);
  // 绘制三笔(绘制会重建网格 DOM,用 dispatchEvent 直发 pointerdown——应用的真实绘制事件)
  for (const i of [0, 1, 20]) {
    await page.locator("#grid .cell").nth(i).dispatchEvent("pointerdown");
  }
  const painted = await page.evaluate(() => window.ZFL.pattern.cells.filter((v) => v === 1).length);
  expect(painted).toBe(3);
  await expect(page.locator("#stats")).toContainText("色线1");
  // 撤销一笔
  await page.click("#undoBtn");
  expect(await page.evaluate(() => window.ZFL.pattern.cells.filter((v) => v === 1).length)).toBe(2);
  // 保存并刷新后仍在
  await page.click("#saveBtn");
  await page.reload();
  expect(await page.evaluate(() => window.ZFL.pattern.cells.filter((v) => v === 1).length)).toBe(2);
  // 旧格式导出
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportBtn")]);
  const text = fs.readFileSync(await download.path(), "utf8");
  const data = JSON.parse(text);
  expect(data.cols).toBe(18);
  expect(data.rows).toBe(14);
  expect(data.cells.length).toBe(18 * 14);
  expect(Array.isArray(data.usage)).toBeTruthy();
  await shot(page, testInfo, "07-旧纹样回归");
});

test("旧纹样可导入织造页并自动编排", async ({ page }, testInfo) => {
  await page.goto("/");
  // 在纹样页画一个 2 色条带
  await page.evaluate(() => {
    const Z = window.ZFL;
    for (let y = 0; y < Z.pattern.rows; y++) {
      for (let x = 0; x < 6; x++) Z.pattern.cells[y * Z.pattern.cols + x] = y % 2 === 0 ? 1 : 2;
    }
    Z.pattern.notify();
  });
  await page.click("#tabBtnLoom");
  await expect(page.locator("#loomBanner")).toHaveClass(/show/);
  // 条带纹样可编排(可能有换梭警示,但穿综应完成)
  const st = await loomState(page);
  expect(st.draft.every((v) => v >= 0)).toBeTruthy();
  await shot(page, testInfo, "08-纹样联动");
});
