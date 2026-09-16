/* boot.js — 标签页切换与启动 */
(function () {
  "use strict";
  const ZFL = window.ZFL;
  const $ = (id) => document.getElementById(id);

  function showTab(name) {
    $("tab-pattern").hidden = name !== "pattern";
    $("tab-loom").hidden = name !== "loom";
    $("tabBtnPattern").classList.toggle("active", name === "pattern");
    $("tabBtnLoom").classList.toggle("active", name === "loom");
    if (name === "loom") ZFL.loomTab.recompute();
  }

  ZFL.bootPatternTab();
  ZFL.loomTab.boot();
  $("tabBtnPattern").onclick = () => showTab("pattern");
  $("tabBtnLoom").onclick = () => showTab("loom");
  ZFL.showTab = showTab;
})();
