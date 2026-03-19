(() => {
  'use strict';

  /**********************************************************************
   * Google Chat Always Open Format Toolbar
   *
   * 安定化方針:
   * - 同じ composer（入力欄インスタンス）には自動クリックを1回だけ行う
   * - composer が作り直された時だけ、新しい composer に対して再度1回だけ開く
   *
   * これにより、Google Chat のDOM揺れによる
   * 「開く→また click → 閉じる」のループを防ぐ
   **********************************************************************/

  const DEBUG = false;
  const LOG_PREFIX = '[GChatFormatAutoOpen]';

  const DEBOUNCE_MS = 180;
  const PERIODIC_CHECK_MS = 3000;
  const CLICK_DELAY_MS = 120;

  let observer = null;
  let debounceTimer = null;
  let periodicTimer = null;

  // 既に自動クリックした composer root を記録
  const autoOpenedComposerRoots = new WeakSet();

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
   * 現在使われている composer を探す。
   * Google Chat では contenteditable / role=textbox が使われることが多い。
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
      // 末尾の候補を優先すると、現在表示中の composer を拾いやすい
      lastFocusedComposer = candidates[candidates.length - 1];
      return lastFocusedComposer;
    }

    return null;
  }

  /**
   * composer 周辺の root を探す。
   * この root 単位で「既に自動で開いたか」を記録する。
   */
  function findComposerRoot(composer) {
    if (!(composer instanceof HTMLElement)) return null;

    let node = composer;

    for (let i = 0; i < 7 && node; i += 1) {
      const parent = node.parentElement;
      if (!parent) break;

      const width = parent.offsetWidth;
      const buttonCount = parent.querySelectorAll('button, [role="button"]').length;

      if (width > 200 && buttonCount >= 2) {
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

    // aria-expanded を持つものを優先
    buttons.sort((a, b) => {
      const aScore = a.hasAttribute('aria-expanded') ? 1 : 0;
      const bScore = b.hasAttribute('aria-expanded') ? 1 : 0;
      return bScore - aScore;
    });

    return buttons[0] || null;
  }

  /**
   * 既に toolbar が開いているなら click しない。
   * ただし、今回の本丸は「同じcomposerへの複数クリック禁止」なので、
   * この判定は補助的な安全装置として扱う。
   */
  function isToolbarLikelyOpen(root, button) {
    if (!(root instanceof HTMLElement)) return false;

    if (button instanceof HTMLElement) {
      const expanded = button.getAttribute('aria-expanded');
      if (expanded === 'true') return true;

      const controlsId = button.getAttribute('aria-controls');
      if (controlsId) {
        const controlled = document.getElementById(controlsId);
        if (controlled && isVisible(controlled)) return true;
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
   * 現在の composer に対して、
   * まだ一度も自動で開いていなければ1回だけ click する。
   */
  function ensureToolbarOpenForCurrentComposer() {
    const composer = findActiveComposer();
    if (!(composer instanceof HTMLElement)) {
      log('No active composer.');
      return;
    }

    const root = findComposerRoot(composer) || composer;
    if (!(root instanceof HTMLElement)) {
      return;
    }

    // 同じ composer root に対しては一度しか自動クリックしない
    if (autoOpenedComposerRoots.has(root)) {
      log('Already auto-opened for this composer root. Skipping.');
      return;
    }

    const button = findFormatButtonInRoot(root);
    if (!(button instanceof HTMLElement)) {
      log('No format button found in current composer root.');
      return;
    }

    // すでに開いているなら、クリックせず「開いた扱い」にして以後スキップ
    if (isToolbarLikelyOpen(root, button)) {
      autoOpenedComposerRoots.add(root);
      log('Toolbar already open. Marking composer root as handled.');
      return;
    }

    window.setTimeout(() => {
      // timeout 後にまだ同じ root が存在するか確認
      if (!document.contains(root) || !document.contains(button)) {
        return;
      }

      // timeout 中に別処理で開いていたら、それも handled にする
      if (isToolbarLikelyOpen(root, button)) {
        autoOpenedComposerRoots.add(root);
        log('Toolbar became open before click. Marking as handled.');
        return;
      }

      log('Clicking format button once for this composer root.', button);
      button.click();

      // クリック成否に関わらず、同じ root では二度と自動クリックしない
      // これがループ防止の本体
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

  /**
   * 不要になった composer root は WeakSet なので明示削除不要。
   * DOMから消えればGC対象になる。
   */

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

  function boot() {
    log('Booting stable Google Chat format-toolbar auto-open extension.');

    startObserver();
    startPeriodicCheck();
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
