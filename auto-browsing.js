// ==UserScript==
// @name         鼠标中键自动滚动浏览
// @namespace    https://local.userscript/middle-click-autoscroll
// @version      1.2.1
// @description  按下鼠标中键或点击悬浮面板的开始按钮后，页面自动向下滚动一屏；面板可调节滚动速度，滚动到底部（含懒加载内容）后提示「已经浏览结束」
// @author       likoosong
// @license      AGPL
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// @icon         https://foruda.gitee.com/avatar/1789528396687884544/10442853_likoosong_1789528396.png
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================ 配置 ============================ */
  const DEFAULT_INTERVAL = 3000;    // 默认滚动间隔：3000ms 滚动一次
  const MIN_INTERVAL = 100;         // 最快档：100ms 滚动一次
  const MAX_INTERVAL = 3000;        // 最慢档：3000ms 滚动一次
  const INTERVAL_STEP = 100;        // 滑块调节粒度
  const VIEWPORT_RATIO = 0.8;       // 单次滚动距离 = 视口高度 × 0.8
  const MIN_STEP = 200;             // 单次滚动的最小像素，避免小视口下几乎不动
  const STABLE_WINDOW = 5000;       // 位置与总高度持续 5 秒无变化，判定浏览结束
  const TARGET_REFRESH_TICKS = 12;  // 每 12 次滚动重新探测一次滚动容器，适配动态布局

  /* ========================== 运行状态 ========================== */
  let timerId = null;      // 下一次滚动的定时器句柄
  let running = false;     // 是否处于自动滚动中
  let stableSince = 0;     // 进入「位置与总高度均无变化」状态的起始时间戳，0 表示未进入
  let lastTop = -1;        // 上一轮的滚动位置
  let lastTotal = -1;      // 上一轮的页面总高度
  let tickCount = 0;       // 已执行滚动次数
  let target = null;       // 缓存的滚动容器
  let scrollInterval = DEFAULT_INTERVAL;  // 当前滚动间隔，由面板滑块调节
  let startBtn = null;     // 控制面板「开始」按钮
  let stopBtn = null;      // 控制面板「结束」按钮

  /* ========================== 滚动容器 ========================== */

  /** 判断元素是否为文档级滚动根节点 */
  function isRoot(el) {
    return el === document.scrollingElement || el === document.documentElement || el === document.body;
  }

  /** 读取滚动容器的位置、可视高度与内容总高度 */
  function readMetrics(el) {
    if (isRoot(el)) {
      const doc = document.scrollingElement || document.documentElement;
      return {
        top: window.scrollY || doc.scrollTop || 0,
        view: window.innerHeight,
        total: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0)
      };
    }
    return { top: el.scrollTop, view: el.clientHeight, total: el.scrollHeight };
  }

  /** 判断元素当前是否还能向下滚动 */
  function canScroll(el) {
    if (!el) return false;
    if (isRoot(el)) {
      const doc = document.scrollingElement || document.documentElement;
      return doc.scrollHeight - window.innerHeight > 4;
    }
    if (!el.isConnected) return false;
    if (el.scrollHeight - el.clientHeight <= 4) return false;
    const overflowY = getComputedStyle(el).overflowY;
    return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  }

  /**
   * 探测真正承担滚动的容器：
   * 优先使用文档根节点；文档不可滚动时（部分 SPA 把滚动交给内部容器），
   * 从视口中心元素沿祖先链向上查找，避免遍历整棵 DOM。
   */
  function findScrollTarget() {
    const root = document.scrollingElement || document.documentElement;
    if (canScroll(root)) return root;

    let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    while (el && el !== document.documentElement) {
      if (canScroll(el)) return el;
      el = el.parentElement;
    }
    return root;
  }

  /** 获取滚动容器，必要时重新探测（容器消失、不可滚动或到达刷新周期） */
  function getTarget(force) {
    if (force || !canScroll(target) || tickCount % TARGET_REFRESH_TICKS === 0) {
      target = findScrollTarget();
    }
    return target;
  }

  /** 将容器向下滚动指定像素，并夹在最大可滚动位置内 */
  function scrollStep(el, step) {
    const m = readMetrics(el);
    const maxTop = Math.max(0, m.total - m.view);
    const nextTop = Math.min(m.top + step, maxTop);

    // 显式指定 instant，避免页面 scroll-behavior: smooth 造成的异步滚动干扰结束判定
    try {
      if (isRoot(el)) {
        window.scrollTo({ top: nextTop, left: window.scrollX, behavior: 'instant' });
      } else {
        el.scrollTo({ top: nextTop, left: el.scrollLeft, behavior: 'instant' });
      }
    } catch (err) {
      if (isRoot(el)) {
        window.scrollTo(window.scrollX, nextTop);
      } else {
        el.scrollTop = nextTop;
      }
    }
  }

  /* ========================== 主循环 ========================== */

  /** 单次滚动：滚动一屏后判定是否已到页面底部 */
  function tick() {
    if (!running) return;

    const el = getTarget();
    const before = readMetrics(el);
    const step = Math.max(MIN_STEP, Math.round(before.view * VIEWPORT_RATIO));

    scrollStep(el, step);

    const after = readMetrics(el);

    // 位置与页面总高度都未变化 → 已到底且没有新内容加载进来
    if (after.top === lastTop && after.total === lastTotal) {
      if (stableSince === 0) stableSince = Date.now();
    } else {
      stableSince = 0;
    }
    lastTop = after.top;
    lastTotal = after.total;
    tickCount += 1;

    if (stableSince !== 0 && Date.now() - stableSince >= STABLE_WINDOW) {
      finish();
      return;
    }
    timerId = window.setTimeout(tick, scrollInterval);
  }

  /* ========================== 启停控制 ========================== */

  function start() {
    if (running) return;
    running = true;
    stableSince = 0;
    tickCount = 0;
    lastTop = -1;
    lastTotal = -1;
    target = null;
    syncButtons();
    showToast('自动滚动已开始，再次按鼠标中键可停止', 2400);
    tick();
  }

  function stop() {
    running = false;
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
    syncButtons();
  }

  function finish() {
    stop();
    showToast('已经浏览结束', 5000);
  }

  function toggle() {
    if (running) {
      stop();
      showToast('已停止自动滚动', 2000);
    } else {
      start();
    }
  }

  /* ========================== 提示浮层 ========================== */

  /** 顶部居中提示，使用 Shadow DOM 隔离页面样式 */
  function showToast(text, duration) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;left:0;right:0;top:0;z-index:2147483647;pointer-events:none;';

    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      '.toast{',
      '  margin:24px auto 0;width:max-content;max-width:80vw;padding:12px 22px;',
      '  border-radius:10px;background:rgba(17,24,39,.92);color:#f9fafb;',
      '  font-size:15px;line-height:1.5;',
      '  font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;',
      '  box-shadow:0 6px 24px rgba(0,0,0,.3);',
      '  opacity:0;transform:translateY(-8px);',
      '  transition:opacity .2s ease,transform .2s ease;',
      '}',
      '.toast.show{opacity:1;transform:translateY(0);}'
    ].join('');

    const box = document.createElement('div');
    box.className = 'toast';
    box.textContent = text;

    root.append(style, box);
    (document.body || document.documentElement).appendChild(host);

    requestAnimationFrame(function () {
      box.classList.add('show');
    });

    window.setTimeout(function () {
      box.classList.remove('show');
      window.setTimeout(function () {
        host.remove();
      }, 300);
    }, Math.max(800, duration || 2400));
  }

  /* ========================== 控制面板 ========================== */

  /** 根据运行状态刷新按钮可用性 */
  function syncButtons() {
    if (!startBtn || !stopBtn) return;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
  }

  /** 右下角悬浮的「开始 / 结束」+ 速度滑块控制面板，使用 Shadow DOM 隔离页面样式 */
  function createPanel() {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483646;';

    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      '.panel{',
      '  display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;',
      '  background:rgba(17,24,39,.88);box-shadow:0 6px 24px rgba(0,0,0,.3);',
      '  font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;',
      '}',
      'button{',
      '  all:unset;cursor:pointer;padding:6px 14px;border-radius:6px;',
      '  font-size:13px;line-height:1.4;color:#f9fafb;background:#2563eb;',
      '}',
      'button.stop{background:#dc2626;}',
      'button:disabled{opacity:.45;cursor:not-allowed;}',
      '.speed{display:flex;align-items:center;gap:6px;color:#e5e7eb;font-size:12px;}',
      '.speed input{',
      '  all:unset;-webkit-appearance:none;appearance:none;',
      '  width:90px;height:4px;border-radius:2px;background:#4b5563;cursor:pointer;',
      '}',
      '.speed input::-webkit-slider-thumb{',
      '  -webkit-appearance:none;appearance:none;width:13px;height:13px;',
      '  border-radius:50%;background:#60a5fa;border:2px solid #f9fafb;',
      '}',
      '.speed .val{min-width:52px;text-align:right;color:#93c5fd;',
      '  font-variant-numeric:tabular-nums;}'
    ].join('');

    const panel = document.createElement('div');
    panel.className = 'panel';

    startBtn = document.createElement('button');
    startBtn.textContent = '开始';
    startBtn.addEventListener('click', function () {
      start();
    });

    stopBtn = document.createElement('button');
    stopBtn.className = 'stop';
    stopBtn.textContent = '结束';
    stopBtn.addEventListener('click', function () {
      if (!running) return;
      stop();
      showToast('已停止自动滚动', 2000);
    });

    panel.append(startBtn, stopBtn);

    // 速度滑块：数值即滚动间隔（毫秒），越小越快
    const speed = document.createElement('label');
    speed.className = 'speed';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(MIN_INTERVAL);
    slider.max = String(MAX_INTERVAL);
    slider.step = String(INTERVAL_STEP);
    // 滑块方向反转：向右为「更快」，符合直觉
    slider.value = String(MAX_INTERVAL + MIN_INTERVAL - scrollInterval);

    const value = document.createElement('span');
    value.className = 'val';

    /** 显示当前速度档位，如「500ms/次」 */
    function renderSpeed() {
      value.textContent = scrollInterval + 'ms/次';
    }

    slider.addEventListener('input', function () {
      scrollInterval = MAX_INTERVAL + MIN_INTERVAL - Number(slider.value);
      renderSpeed();
    });

    renderSpeed();
    speed.append(document.createTextNode('速度'), slider, value);

    panel.append(speed);
    root.append(style, panel);
    (document.body || document.documentElement).appendChild(host);
    syncButtons();
  }

  /* ========================== 事件绑定 ========================== */

  /** 鼠标中键按下：拦截默认行为并切换自动滚动 */
  function onMouseDown(event) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    toggle();
  }

  /** 拦截中键点击默认行为（链接新标签页等），避免干扰自动滚动 */
  function onAuxClick(event) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
  }

  /** Esc 键作为停止的备用方式 */
  function onKeyDown(event) {
    if (event.key === 'Escape' && running) {
      event.preventDefault();
      stop();
      showToast('已停止自动滚动', 2000);
    }
  }

  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('auxclick', onAuxClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('pagehide', stop);

  createPanel();
})();
