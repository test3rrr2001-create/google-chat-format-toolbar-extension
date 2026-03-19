(() => {
  'use strict';

  /**********************************************************************
   * Google Chat Always Open Format Toolbar
   *
   * 目的:
   * - Google Chat でルーム遷移後も書式設定ツールバーを自動再オープンする
   * - ただし開閉ループは防ぐ
   *
   * 設計:
   * - 同じ composer root には自動クリックを1回だけ
   * - URL（ルーム）が変わったら、その記録をリセット
   * - 新ルームの composer に対して再度1回だけ自動クリック
   *
   * Google側DOM変更時に見直す場所:
   * 1. findActiveComposer()
   * 2. findComposerRoot()
   * 3. isLikelyFormatButton()
   * 4. findFormatButtonInRoot()
   **********************************************************************/

  const DEBUG = false;
  const LOG_PREFIX = '[GChatFormatAutoOpen]';

  const DEBOUNCE_MS = 180;
  const PERIODIC_CHECK_MS = 2500;
  const CLICK_DELAY_MS = 120;
  const URL_WATCH_MS = 500;

  let observer = null;
  let debounceTimer = null;
  let periodicTimer = null;
  let urlWatchTimer = null;

  let lastFocusedComposer = null;
  let currentRouteKey = location.pathname + location.search + location.hash;

  // 現在のルーム/URL単位で「既に自動オープンした composer root」を管理
  let autoOpenedComposerRoots = new WeakSet();

  function log(...args) {
    if (DEBUG) {
      console.log(LOG_PREFIX, ...args);
    }
  }

  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
    return true;
  }

  function getRouteKey() {
    return location.pathname + location.search + location.hash;
  }

  function resetRouteState(reason) {
    autoOpenedComposerRoots = new WeakSet();
    lastFocusedComposer = null;
    currentRouteKey = getRouteKey();
    log('Route state reset:', reason, currentRouteKey);

    // ルーム遷移後、新composer描画のため少し待ってから確認
    window.setTimeout(() => {
      scheduleEnsureToolbarOpen();
    }, 250);

    window.setTimeout(() => {
      scheduleEnsureToolbarOpen();
    }, 800);
  }

  function onPotentialRouteChange(source) {
    const nextRouteKey = getRouteKey();
    if (nextRouteKey !== currentRouteKey) {
      resetRouteState(source);
    }
  }

  /**
   * 現在使われている composer を探す。
   * Google Chat は role=textbox / contenteditable を使うことが多い。
   */
  function findActiveComposer() {
    const active = document.activeElement;

    if (active instanceof HTMLElement) {
      const fromActive = active.closest(
        '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
      );
      if (fromActive instanceof HTMLElement && isVisible(fromActive)) {
        lastFocusedComposer = fromActive;
        return fromActive;
      }
    }

    if (lastFocusedComposer && document.contains(lastFocusedComposer) && isVisible(lastFocusedComposer)) {
      return lastFocusedComposer;
    }

    const candidates = Array.from(
      document.querySelectorAll(
        '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
      )
    ).filter((el) => el instanceof HTMLElement && isVisible(el));

    if (candidates.length > 0) {
      lastFocusedComposer = candidates[candidates.length - 1];
      return lastFocusedComposer;
    }

    return null;
  }

  /**
   * composer 周辺の root を探す。
   * この root 単位で「既に自動クリックしたか」を管理する。
   */
  function findComposerRoot(composer) {
    if (!(composer instanceof HTMLElement)) return null;

    let node = composer;

    for (let i = 0; i < 7 && node; i += 1) {
      const parent = node.parentElement;
      if (!parent) break;

      const width = parent.offsetWidth;
      const buttonCount = parent.querySelectorAll('button, [role="button"]').length;

      if (width > 220 && buttonCount >= 2) {
        node = parent;
      } else {
        break;
      }
    }

    return node;
  }

  function isLikelyFormatButton(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (!isVisible(el)) return false;

    const role = el.getAttribute('role');
    const isButtonLike =
      el.tagName === 'BUTTON' ||
      role === 'button' ||
      typeof el.click === 'function';

    if (!isButtonLike) return false;

    const texts = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-tooltip'),
      el.textContent
    ]
      .filter(Boolean)
      .map(normalizeText);

    const keywords = [
      '書式設定',
      'format',
      'format options',
      'formatting',
      'format message'
    ];

    return texts.some((text) => keywords.some((keyword) => text.includes(keyword)));
  }

  function findFormatButtonInRoot(root) {
    if (!(root instanceof HTMLElement)) return null;

    const selector = [
      'button[aria-label]',
      'button[title]',
      'button[data-tooltip]',
      '[role="button"][aria-label]',
      '[role="button"][title]',
      '[role="button"][data-tooltip]'
    ].join(',');

    const buttons = Array.from(root.querySelectorAll(selector)).filter(isLikelyFormatButton);

    buttons.sort((a, b) => {
      const aScore = a.hasAttribute('aria-expanded') ? 1 : 0;
      const bScore = b.hasAttribute('aria-expanded') ? 1 : 0;
      return bScore - aScore;
    });

    return buttons[0] || null;
  }

  /**
   * toolbar が開いているかの補助判定。
   * ここに完全依存しないようにしているが、
   * 開いている時に余計な click を避けるための安全装置として使う。
   */
  function isToolbarLikelyOpen(root, button) {
    if (!(root instanceof HTMLElement)) return false;

    if (button instanceof HTMLElement) {
      const expanded = button.getAttribute('aria-expanded');
      if (expanded === 'true') return true;

      const controlsId = button.getAttribute('aria-controls');
      if (controlsId) {
        const controlled = document.getElementById(controlsId);
        if (controlled && isVisible(controlled)) {
          return true;
        }
      }
    }

    const toolbar = root.querySelector('[role="toolbar"]');
    if (toolbar && isVisible(toolbar)) {
      return true;
    }

    const richButtons = Array.from(root.querySelectorAll('button,[role="button"]')).filter((el) => {
      if (el === button) return false;
      if (!(el instanceof HTMLElement) || !isVisible(el)) return false;

      const label = normalizeText(
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('data-tooltip') ||
        el.textContent
      );

      return [
        'bold', 'italic', 'underline',
        '太字', '斜体', '下線',
        'bulleted', 'numbered',
        '箇条書き', '番号付き'
      ].some((keyword) => label.includes(keyword));
    });

    return richButtons.length >= 2;
  }

  /**
   * 現在のルーム・現在の composer に対して、
   * まだ自動クリックしていなければ1回だけ click する。
   */
  function ensureToolbarOpenForCurrentComposer() {
    onPotentialRouteChange('ensure-check');

    const composer = findActiveComposer();
    if (!(composer instanceof HTMLElement)) {
      log('No active composer.');
      return;
    }

    const root = findComposerRoot(composer) || composer;
    if (!(root instanceof HTMLElement)) return;

    if (autoOpenedComposerRoots.has(root)) {
      log('Already handled for this route/root.');
      return;
    }

    const button = findFormatButtonInRoot(root);
    if (!(button instanceof HTMLElement)) {
      log('No format button found in current composer root.');
      return;
    }

    // 開いていれば click せず handled 扱い
    if (isToolbarLikelyOpen(root, button)) {
      autoOpenedComposerRoots.add(root);
      log('Toolbar already open. Marking handled.');
      return;
    }

    window.setTimeout(() => {
      if (!document.contains(root) || !document.contains(button)) {
        return;
      }

      // timeout後にルームが変わっていたら中止
      if (getRouteKey() !== currentRouteKey) {
        return;
      }

      if (autoOpenedComposerRoots.has(root)) {
        return;
      }

      if (isToolbarLikelyOpen(root, button)) {
        autoOpenedComposerRoots.add(root);
        log('Toolbar became open before click. Marking handled.');
        return;
      }

      log('Clicking format button once for this route/root.', {
        route: currentRouteKey,
        buttonLabel: button.getAttribute('aria-label') || button.getAttribute('title')
      });

      button.click();

      // ループ防止のため、同じ route + root では以後 click しない
      autoOpenedComposerRoots.add(root);
    }, CLICK_DELAY_MS);
  }

  function scheduleEnsureToolbarOpen() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = window.setTimeout(() => {
      ensureToolbarOpenForCurrentComposer();
    }, DEBOUNCE_MS);
  }

  function startObserver() {
    if (!document.body) return;

    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver((mutations) => {
      let shouldCheck = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
            shouldCheck = true;
            break;
          }
        }

        if (mutation.type === 'attributes') {
          const target = mutation.target;
          if (
            target instanceof HTMLElement &&
            (
              target.hasAttribute('aria-expanded') ||
              target.hasAttribute('aria-label') ||
              target.hasAttribute('title')
            )
          ) {
            shouldCheck = true;
            break;
          }
        }
      }

      if (shouldCheck) {
        scheduleEnsureToolbarOpen();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded', 'aria-label', 'title']
    });
  }

  function startPeriodicCheck() {
    if (periodicTimer) {
      clearInterval(periodicTimer);
    }

    periodicTimer = window.setInterval(() => {
      ensureToolbarOpenForCurrentComposer();
    }, PERIODIC_CHECK_MS);
  }

  function startUrlWatcher() {
    if (urlWatchTimer) {
      clearInterval(urlWatchTimer);
    }

    urlWatchTimer = window.setInterval(() => {
      onPotentialRouteChange('interval-url-watch');
    }, URL_WATCH_MS);
  }

  function patchHistoryMethods() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      window.setTimeout(() => onPotentialRouteChange('pushState'), 0);
      return result;
    };

    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      window.setTimeout(() => onPotentialRouteChange('replaceState'), 0);
      return result;
    };

    window.addEventListener('popstate', () => {
      onPotentialRouteChange('popstate');
    });
  }

  function boot() {
    log('Booting route-aware Google Chat format-toolbar auto-open extension.');

    patchHistoryMethods();
    startObserver();
    startPeriodicCheck();
    startUrlWatcher();

    scheduleEnsureToolbarOpen();

    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const composer = target.closest(
          '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
        );

        if (composer instanceof HTMLElement) {
          lastFocusedComposer = composer;
          scheduleEnsureToolbarOpen();
        }
      },
      true
    );

    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const composer = target.closest(
          '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
        );

        if (composer instanceof HTMLElement) {
          lastFocusedComposer = composer;
          scheduleEnsureToolbarOpen();
          return;
        }

        // ルーム一覧クリック時もURL変更前後で再評価したいので軽く予約
        scheduleEnsureToolbarOpen();
      },
      true
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
