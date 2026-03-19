(() => {
  'use strict';

  /**********************************************************************
   * Google Chat Always Open Format Toolbar
   *
   * 目的:
   * - Google Chat のメッセージ入力欄の「書式設定ツールバー」を
   *   常に開いた状態に保つ
   *
   * 今回の改善点:
   * - 開閉ループ防止
   * - 現在アクティブな composer 周辺だけを対象にする
   * - click後のクールダウンを長めにする
   * - toolbar が存在するなら絶対に再クリックしない
   **********************************************************************/

  const DEBUG = false;
  const LOG_PREFIX = '[GChatFormatAutoOpen]';

  const DEBOUNCE_MS = 180;
  const CLICK_COOLDOWN_MS = 1200;
  const PERIODIC_CHECK_MS = 4000;

  let observer = null;
  let debounceTimer = null;
  let periodicTimer = null;

  let lastClickAt = 0;
  let lastFocusedComposer = null;

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

  /**
   * 編集中の入力欄らしい要素を探す。
   * Google Chat は contenteditable な composer を使うことが多いので、
   * role=textbox や contenteditable を優先して探す。
   */
  function findActiveComposer() {
    const active = document.activeElement;

    if (active instanceof HTMLElement) {
      const composerFromActive = active.closest(
        '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
      );
      if (composerFromActive instanceof HTMLElement) {
        lastFocusedComposer = composerFromActive;
        return composerFromActive;
      }
    }

    if (lastFocusedComposer && document.contains(lastFocusedComposer)) {
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
   * composer からその周辺の入力エリアコンテナを探す。
   * ここを root にしてボタンや toolbar を探すことで、
   * 画面上の別 composer 候補への誤爆を減らす。
   */
  function findComposerRoot(composer) {
    if (!(composer instanceof HTMLElement)) return null;

    let node = composer;
    for (let i = 0; i < 6 && node; i += 1) {
      const parent = node.parentElement;
      if (!parent) break;

      const hasButtons = parent.querySelectorAll('button, [role="button"]').length;
      const width = parent.offsetWidth;
      if (hasButtons >= 2 && width > 200) {
        node = parent;
      } else {
        break;
      }
    }

    return node;
  }

  function isLikelyFormatButtonByLabel(el) {
    if (!(el instanceof HTMLElement)) return false;

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

  function isLikelyFormatButton(el) {
    if (!(el instanceof HTMLElement)) return false;

    const role = el.getAttribute('role');
    const isButtonLike =
      el.tagName === 'BUTTON' ||
      role === 'button' ||
      typeof el.click === 'function';

    if (!isButtonLike) return false;
    if (!isVisible(el)) return false;

    return isLikelyFormatButtonByLabel(el);
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

    // aria-expanded を持つものを優先
    buttons.sort((a, b) => {
      const aExpanded = a.hasAttribute('aria-expanded') ? 1 : 0;
      const bExpanded = b.hasAttribute('aria-expanded') ? 1 : 0;
      return bExpanded - aExpanded;
    });

    return buttons[0] || null;
  }

  /**
   * toolbar が既に開いているかを、composer root 内だけで判定する。
   * ここが甘いと開閉ループになるので、かなり慎重に false を返す。
   */
  function isToolbarOpenInRoot(root, button) {
    if (!(root instanceof HTMLElement)) return false;

    if (button instanceof HTMLElement) {
      const expanded = button.getAttribute('aria-expanded');
      if (expanded === 'true') {
        return true;
      }

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

  function shouldSkipBecauseCooldown() {
    return Date.now() - lastClickAt < CLICK_COOLDOWN_MS;
  }

  function ensureToolbarOpen() {
    const composer = findActiveComposer();
    if (!(composer instanceof HTMLElement)) {
      log('No active composer found.');
      return;
    }

    const root = findComposerRoot(composer) || composer;
    const button = findFormatButtonInRoot(root);

    if (!(button instanceof HTMLElement)) {
      log('No format button found near active composer.');
      return;
    }

    const open = isToolbarOpenInRoot(root, button);

    log('Composer check:', {
      composer,
      root,
      buttonLabel: button.getAttribute('aria-label') || button.getAttribute('title'),
      expanded: button.getAttribute('aria-expanded'),
      open,
      cooldown: shouldSkipBecauseCooldown()
    });

    if (open) {
      return;
    }

    if (shouldSkipBecauseCooldown()) {
      return;
    }

    lastClickAt = Date.now();
    log('Clicking format button to open toolbar.', button);
    button.click();
  }

  function scheduleEnsureToolbarOpen() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = window.setTimeout(() => {
      ensureToolbarOpen();
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
      ensureToolbarOpen();
    }, PERIODIC_CHECK_MS);
  }

  function boot() {
    log('Booting Google Chat format-toolbar auto-open extension.');
    startObserver();
    startPeriodicCheck();

    scheduleEnsureToolbarOpen();

    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target;
        if (target instanceof HTMLElement) {
          const composer = target.closest(
            '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
          );
          if (composer instanceof HTMLElement) {
            lastFocusedComposer = composer;
            scheduleEnsureToolbarOpen();
          }
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
        }
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
