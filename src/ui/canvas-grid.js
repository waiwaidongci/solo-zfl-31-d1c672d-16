/* canvas-grid.js — 画布与指针交互助手(桌面鼠标拖动 + 手机点选/滑动,均用 Pointer Events) */
(function () {
  "use strict";
  const ZFL = (window.ZFL = window.ZFL || {});

  /** 创建适配设备像素比的画布;返回 {canvas, ctx, scale} */
  ZFL.makeCanvas = function (canvas, cssWidth, cssHeight) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = cssWidth + "px";
    canvas.style.height = cssHeight + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { canvas, ctx, dpr, width: cssWidth, height: cssHeight };
  };

  /**
   * 网格指针交互:
   *  - 鼠标:按下即进入拖动,移动触发 onDrag,抬起触发 onDrop。
   *  - 触屏/触控笔:轻点 = onTap(不拦截页面滚动);长按 350ms 进入拖动。
   * 所有回调收到相对画布的 css 像素坐标。
   */
  ZFL.pointerGrid = function (canvas, handlers) {
    const LONG_PRESS_MS = 350;
    const SLOP = 7;
    let state = null; // {pointerId, x0, y0, mode:'maybe'|'drag', longPressTimer, pointerType}

    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener("pointerdown", (e) => {
      if (state) return;
      const p = pos(e);
      state = {
        pointerId: e.pointerId,
        x0: p.x, y0: p.y, x: p.x, y: p.y,
        mode: e.pointerType === "mouse" ? "drag" : "maybe",
        pointerType: e.pointerType,
        timer: null,
      };
      if (state.mode === "drag") {
        canvas.setPointerCapture(e.pointerId);
        handlers.onDragStart && handlers.onDragStart(p.x, p.y, e);
      } else {
        state.timer = setTimeout(() => {
          if (state && state.mode === "maybe") {
            state.mode = "drag";
            canvas.setPointerCapture(state.pointerId);
            handlers.onDragStart && handlers.onDragStart(state.x, state.y, e);
          }
        }, LONG_PRESS_MS);
      }
      e.preventDefault();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!state || e.pointerId !== state.pointerId) return;
      const p = pos(e);
      state.x = p.x; state.y = p.y;
      if (state.mode === "maybe") {
        if (Math.hypot(p.x - state.x0, p.y - state.y0) > SLOP) {
          clearTimeout(state.timer);
          state = null; // 视为滚动,不干预
          return;
        }
      } else if (state.mode === "drag") {
        handlers.onDrag && handlers.onDrag(p.x, p.y, e);
      }
    });

    function finish(e, cancelled) {
      if (!state || e.pointerId !== state.pointerId) return;
      const st = state;
      state = null;
      clearTimeout(st.timer);
      if (st.mode === "drag") {
        handlers.onDrop && handlers.onDrop(st.x, st.y, cancelled, e);
      } else if (!cancelled) {
        handlers.onTap && handlers.onTap(st.x, st.y, e);
      }
    }
    canvas.addEventListener("pointerup", (e) => finish(e, false));
    canvas.addEventListener("pointercancel", (e) => finish(e, true));
  };

  /**
   * DOM 列表拖动排序(鼠标拖 ≡ 手柄;触屏用行内 ▲▼ 按钮,由调用方渲染)。
   * hooks = { onStart(), onMove(from,to), onEnd() }。
   * 拖动中物理移动 DOM 节点,数据层在 onMove 里同步;onEnd 后由调用方重渲染对齐。
   */
  ZFL.listDrag = function (container, itemSelector, hooks) {
    let dragEl = null;
    container.addEventListener("pointerdown", (e) => {
      const grip = e.target.closest("[data-grip]");
      if (!grip || e.pointerType !== "mouse") return;
      const item = grip.closest(itemSelector);
      if (!item) return;
      dragEl = item;
      item.classList.add("dragging");
      container.setPointerCapture(e.pointerId);
      hooks.onStart && hooks.onStart();
      e.preventDefault();
    });
    container.addEventListener("pointermove", (e) => {
      if (!dragEl) return;
      const over = document.elementFromPoint(e.clientX, e.clientY);
      const target = over && over.closest(itemSelector);
      if (!target || target === dragEl || target.parentNode !== container) return;
      const items = Array.from(container.querySelectorAll(itemSelector));
      const from = items.indexOf(dragEl), to = items.indexOf(target);
      if (from < 0 || to < 0) return;
      if (from < to) container.insertBefore(dragEl, target.nextSibling);
      else container.insertBefore(dragEl, target);
      hooks.onMove && hooks.onMove(from, to);
    });
    ["pointerup", "pointercancel"].forEach((t) =>
      container.addEventListener(t, () => {
        if (!dragEl) return;
        dragEl.classList.remove("dragging");
        dragEl = null;
        hooks.onEnd && hooks.onEnd();
      })
    );
  };
})();
