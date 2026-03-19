(() => {
  'use strict';

  /**********************************************************************
   * Google Chat Format Toolbar Auto Open
   * Trigger: user click / focus / keydown near chat composer
   *
   * 方針:
   * - クリック後に「現在の composer」を再探索してから開く
   * - クリック対象が wrapper でも動くようにする
   * - ただしループ防止のため cooldown を入れる
   **********************************************************************/

  const DEBUG = false;
  const LOG_PREFIX = '[GChatFormatAutoOpen]';

  const POST_CLICK_DELAY_MS = 120;
  const COOLDOWN_MS = 900;

  let lastAutoOpenAt = 0;
  let lastHandledComposerRoot = null;

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
   * 現在アクティブな composer を探す。
   * まず activeElement ベースで探し、
   * ダメなら visible な textbox/contenteditable 候補の末尾を採用する。
   */
  function findCurrentComposer() {
    const active = document.activeElement;

    if (active instanceof HTMLElement) {
      const fromActive = active.closest(
        '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
      );
      if (fromActive instanceof HTMLElement && isVisible(fromActive)) {
        return fromActive;
      }
    }

    const candidates = Array.from(
      document.querySelectorAll(
        '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
      )
    ).filter((el) => el instanceof HTMLElement && isVisible(el));

    if (candidates.length === 0) return null;

    return candidates[candidates.length - 1];
  }

  /**
   * composer 周辺の入力エリア root を探す。
   */
  function findComposerRoot(composer) {
    if (!(composer instanceof HTMLElement)) return null;

    let node = composer;

    for (let i = 0; i < 8 && node; i += 1) {
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

  /**
   * Google Chat の書式設定ボタン判定。
   * 将来文言変更があれば keywords を修正。
   */
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
   * 既に書式ツールバーが開いているかを推定。
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

    const formattingButtons = Array.from(root.querySelectorAll('button,[role="button"]')).filter((el) => {
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

    return formattingButtons.length >= 2;
  }

  function isCooldownActive(root) {
    const now = Date.now();

    if (now - lastAutoOpenAt < COOLDOWN_MS) {
      return true;
    }

    if (lastHandledComposerRoot && root === lastHandledComposerRoot && now - lastAutoOpenAt < COOLDOWN_MS * 2) {
      return true;
    }

    return false;
  }

  function tryOpenToolbarFromCurrentComposer() {
    const composer = findCurrentComposer();
    if (!(composer instanceof HTMLElement)) {
      log('No current composer found.');
      return;
    }

    const root = findComposerRoot(composer) || composer;
    if (!(root instanceof HTMLElement)) return;

    const button = findFormatButtonInRoot(root);
    if (!(button instanceof HTMLElement)) {
      log('No format button found near current composer.');
      return;
    }

    if (isToolbarLikelyOpen(root, button)) {
      log('Toolbar already open.');
      return;
    }

    if (isCooldownActive(root)) {
      log('Cooldown active.');
      return;
    }

    lastAutoOpenAt = Date.now();
    lastHandledComposerRoot = root;

    log('Clicking format button.', {
      label: button.getAttribute('aria-label') || button.getAttribute('title')
    });

    button.click();
  }

  /**
   * クリックや focus の後、少し待ってから composer を再探索する。
   * これで wrapperクリックでも反応しやすくなる。
   */
  function scheduleTryOpen() {
    window.setTimeout(() => {
      tryOpenToolbarFromCurrentComposer();
    }, POST_CLICK_DELAY_MS);
  }

  function boot() {
    log('Booting click-triggered Google Chat format opener.');

    document.addEventListener(
      'click',
      () => {
        scheduleTryOpen();
      },
      true
    );

    document.addEventListener(
      'focusin',
      () => {
        scheduleTryOpen();
      },
      true
    );

    document.addEventListener(
      'keydown',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const isInputLike = !!target.closest(
          '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
        );

        if (isInputLike) {
          scheduleTryOpen();
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
