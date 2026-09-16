/* pattern-tab.js — 纹样绘制页(原有功能完整保留:绘制/统计/撤销重做/保存/导出)
 * 同时把纹样暴露为共享 store,供上机织造页联查。 */
(function () {
  "use strict";
  const ZFL = (window.ZFL = window.ZFL || {});
  const colors = (ZFL.COLORS = ["#f7e7c4", "#a6322d", "#1f5f78", "#d6a437", "#355b38", "#713d7b", "#1e1b18", "#e98c52"]);
  const STORAGE_KEY = "zfl31Pattern";

  const listeners = new Set();
  const store = (ZFL.pattern = {
    cols: 18,
    rows: 14,
    cells: [],
    onChange(cb) { listeners.add(cb); },
    notify() { listeners.forEach((cb) => cb()); },
    snapshot() { return { cols: store.cols, rows: store.rows, cells: store.cells.slice() }; },
  });

  let active = 1, block = "dot", dragging = false;
  let undo = [], redo = [];
  let cellEls = []; // 缓存格子元素:填色时就地更新,不重建整个网格

  const $ = (id) => document.getElementById(id);

  function init(loadSaved = true) {
    const saved = loadSaved && JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && saved.cells && saved.cells.length === saved.cols * saved.rows) {
      store.cols = saved.cols; store.rows = saved.rows; store.cells = saved.cells;
    } else {
      store.cols = Number($("cols").value);
      store.rows = Number($("rows").value);
      store.cells = Array(store.cols * store.rows).fill(0);
    }
    $("cols").value = store.cols;
    $("rows").value = store.rows;
    render();
    store.notify();
  }

  function render() {
    const palette = $("palette");
    palette.innerHTML = colors.map((c, i) => '<button type="button" class="swatch ' + (i === active ? "active" : "") + '" data-color="' + i + '" style="background:' + c + '" aria-label="色线' + i + '"></button>').join("");
    palette.querySelectorAll("[data-color]").forEach((el) => (el.onclick = () => { active = Number(el.dataset.color); renderPalette(); }));

    const grid = $("grid");
    grid.style.gridTemplateColumns = "repeat(" + store.cols + ", 1fr)";
    grid.innerHTML = "";
    cellEls = store.cells.map((v, i) => {
      const el = document.createElement("div");
      el.className = "cell";
      el.dataset.i = i;
      el.style.background = colors[v];
      el.onpointerdown = () => { dragging = true; paint(i); };
      el.onpointerenter = () => { if (dragging) paint(i); };
      grid.appendChild(el);
      return el;
    });
    window.onpointerup = () => (dragging = false);
    renderStats();
  }

  function renderPalette() {
    $("palette").querySelectorAll("[data-color]").forEach((el) => el.classList.toggle("active", Number(el.dataset.color) === active));
  }

  function snapshot() { undo.push(store.cells.slice()); redo = []; if (undo.length > 50) undo.shift(); }

  function paint(i) {
    snapshot();
    patternOf(i).forEach((t) => {
      if (t >= 0 && t < store.cells.length) {
        store.cells[t] = active;
        cellEls[t].style.background = colors[active]; // 就地更新,保持元素不脱离 DOM
      }
    });
    renderStats();
    store.notify();
  }

  function patternOf(i) {
    const x = i % store.cols, y = Math.floor(i / store.cols);
    if (block === "cross") return [i, idx(x - 1, y), idx(x + 1, y), idx(x, y - 1), idx(x, y + 1)].filter((v) => v !== null);
    if (block === "diamond") return [idx(x, y - 1), idx(x - 1, y), i, idx(x + 1, y), idx(x, y + 1)].filter((v) => v !== null);
    return [i];
  }
  function idx(x, y) { return x < 0 || x >= store.cols || y < 0 || y >= store.rows ? null : y * store.cols + x; }

  function renderStats() {
    const counts = colors.map((_, i) => store.cells.filter((v) => v === i).length);
    $("stats").innerHTML = counts.map((n, i) => '<div class="stat"><span><span style="display:inline-block;width:14px;height:14px;background:' + colors[i] + '"></span> 色线' + i + '</span><b>' + n + "</b></div>").join("");
    $("preview").innerHTML = Array.from({ length: 36 }, (_, i) => '<div class="mini" style="background:' + (colors[store.cells[(i % 6) + Math.floor(i / 6) * store.cols]] || colors[0]) + '"></div>').join("");
    const riskRows = [];
    for (let y = 0; y < store.rows; y++) {
      let switches = 0;
      for (let x = 1; x < store.cols; x++) if (store.cells[y * store.cols + x] !== store.cells[y * store.cols + x - 1]) switches++;
      if (switches > store.cols * 0.62) riskRows.push(y + 1);
    }
    $("risk").innerHTML = riskRows.length ? '<p class="warning">第' + riskRows.join("、") + "行换色过密,可能断线。</p>" : "<p>暂无明显断线风险。</p>";
  }

  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(store.snapshot())); }

  ZFL.patternTab = {
    init,
    save,
    /** 旧格式导出:{cols, rows, cells, usage} —— 保持与历史版本一致 */
    exportJSON() {
      const data = {
        cols: store.cols,
        rows: store.rows,
        cells: store.cells.slice(),
        usage: colors.map((color, i) => ({ color, count: store.cells.filter((v) => v === i).length })),
      };
      download("brocade-pattern.json", JSON.stringify(data, null, 2));
    },
    /** 导入(来自织造页的方案导入):替换纹样并刷新 */
    applyPattern(p) {
      store.cols = p.cols; store.rows = p.rows; store.cells = p.cells.slice();
      undo = []; redo = [];
      $("cols").value = p.cols; $("rows").value = p.rows;
      render();
      store.notify();
      save();
    },
    undo() { if (!undo.length) return; redo.push(store.cells.slice()); store.cells = undo.pop(); render(); store.notify(); },
    redo() { if (!redo.length) return; undo.push(store.cells.slice()); store.cells = redo.pop(); render(); store.notify(); },
    newGrid() { undo = []; redo = []; init(false); },
    setBlock(b) { block = b; },
  };

  function download(name, text) {
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  ZFL.download = download;

  ZFL.bootPatternTab = function () {
    document.querySelectorAll("[data-block]").forEach((btn) => (btn.onclick = () => (block = btn.dataset.block)));
    $("newBtn").onclick = () => ZFL.patternTab.newGrid();
    $("undoBtn").onclick = () => ZFL.patternTab.undo();
    $("redoBtn").onclick = () => ZFL.patternTab.redo();
    $("saveBtn").onclick = save;
    $("exportBtn").onclick = () => ZFL.patternTab.exportJSON();
    init();
  };
})();
