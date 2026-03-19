(() => {
  'use strict';

  /**********************************************************************
   * Google Chat Format Toolbar Auto Open On Composer Click
   *
   * 目的:
   * - Google Chat の chat入力欄をクリックした時に、
   *   書式設定ツールバーが閉じていれば自動で開く
   *
   * 方針:
   * - 常時無理に開こうとしない
   * - 入力欄クリックをトリガーにする
   * - すでに開いていれば何もしない
   * - 短い cooldown を入れて連打/ループを防ぐ
   *
   * DOM変更時に見直す場所:
   * 1. isComposerElement()
   * 2. findComposerRoot()
   * 3. isLikelyFormatButton()
   * 4. isToolbarLikelyOpen()
   **********************************************************************/

  const DEBUG = false;
  const LOG_PREFIX = '[GChatFormatOnClick]';

  const CLICK_DELAY_MS = 100;
  const COOLDOWN_MS = 800;

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
   * Google Chat の入力欄かどうか判定する。
   * DOMが変わった場合はここを見直す。
   */
  function isComposerElement(el) {
    if (!(el instanceof HTMLElement)) return false;

    const role = el.getAttribute('role');
    const contentEditable = el.getAttribute('contenteditable');

    return (
      role === 'textbox' ||
      contentEditable === 'true' ||
      contentEditable === 'plaintext-only'
    );
  }

  function findComposerFromTarget(target) {
    if (!(target instanceof HTMLElement)) return null;
    return target.closest(
      '[role="textbox"], [contenteditable="true"], [contenteditable="plaintext-only"]'
    );
  }

  /**
   * composer 周辺の root を探す。
   * 書式設定ボタンや toolbar をこの範囲から探す。
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
   * 既に toolbar が開いているかの推定。
   * ここで true なら click しない。
   */
  function isToolbarLikelyOpen(root, button) {
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

  function tryOpenToolbarForComposer(composer) {
    if (!(composer instanceof HTMLElement)) return;

    const root = findComposerRoot(composer) || composer;
    if (!(root instanceof HTMLElement)) return;

    const button = findFormatButtonInRoot(root);
    if (!(button instanceof HTMLElement)) {
      log('No format button found near composer.');
      return;
    }

    if (isToolbarLikelyOpen(root, button)) {
      log('Toolbar already open; skip.');
      return;
    }

    if (isCooldownActive(root)) {
      log('Cooldown active; skip.');
      return;
    }

    window.setTimeout(() => {
      if (!document.contains(root) || !document.contains(button)) {
        return;
      }

      if (isToolbarLikelyOpen(root, button)) {
        return;
      }

      lastAutoOpenAt = Date.now();
      lastHandledComposerRoot = root;

      log('Clicking format button because composer was clicked.', {
        label: button.getAttribute('aria-label') || button.getAttribute('title')
      });

      button.click();
    }, CLICK_DELAY_MS);
  }

  function handleComposerInteraction(target) {
    const composer = findComposerFromTarget(target);
    if (!(composer instanceof HTMLElement)) return;
    if (!isVisible(composer)) return;

    tryOpenToolbarForComposer(composer);
  }

  function boot() {
    log('Booting composer-click-triggered format toolbar opener.');

    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        handleComposerInteraction(target);
      },
      true
    );

    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const composer = findComposerFromTarget(target);
        if (!(composer instanceof HTMLElement)) return;

        // キーボード移動等でも開けたいので focusin でも同様に試す
        tryOpenToolbarForComposer(composer);
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
