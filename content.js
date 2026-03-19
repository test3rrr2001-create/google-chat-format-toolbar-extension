(() => {
  'use strict';

  /**********************************************************************
   * Google Chat Always Open Format Toolbar
   *
   * 対象:
   * - Google Chat 専用: https://chat.google.com/*
   *
   * 目的:
   * - メッセージ入力欄の「書式設定ツールバー（Aボタン）」を
   *   常に開いた状態に保つ
   *
   * 実装方針:
   * - CSSで無理やり表示はしない
   * - 「書式設定ボタンが閉じている」ことを検知して click() する
   * - Google ChatはSPAなので MutationObserver で再監視する
   *
   * 仕様変更時に見直すべき場所:
   * 1. findFormatButtons()
   * 2. isLikelyFormatButtonByLabel()
   * 3. isToolbarAlreadyOpenNearButton()
   *
   * クラス名には依存せず、aria-label / aria-expanded / role など
   * 比較的変わりにくい属性を優先して使う
   **********************************************************************/

  const DEBUG = false;
  const LOG_PREFIX = '[GChatFormatAutoOpen]';
  const DEBOUNCE_MS = 150;
  const RETRY_AFTER_CLICK_MS = 250;
  const PERIODIC_CHECK_MS = 2000;

  let observer = null;
  let debounceTimer = null;
  let periodicTimer = null;
  let lastClickAt = 0;

  function log(...args) {
    if (DEBUG) {
      console.log(LOG_PREFIX, ...args);
    }
  }

  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Google Chat の書式設定ボタンを aria-label / title / tooltip から判定する。
   *
   * 将来 Google 側の文言が変わったら、
   * keywords 配列を修正してください。
   */
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

  /**
   * SVGベースの判定用フック。
   *
   * 現状は誤検知防止のため使っていませんが、
   * Google Chat側の aria-label が変わった場合は
   * ここに Aアイコンの path 判定を追加できます。
   */
  function isLikelyFormatButtonBySvg(el) {
    if (!(el instanceof HTMLElement)) return false;

    const svg = el.querySelector('svg');
    if (!svg) return false;

    return false;
  }

  function isLikelyFormatButton(el) {
    if (!(el instanceof HTMLElement)) return false;

    const role = el.getAttribute('role');
    const isButtonLike =
      el.tagName === 'BUTTON' ||
      role === 'button' ||
      typeof el.click === 'function';

    if (!isButtonLike) return false;

    return isLikelyFormatButtonByLabel(el) || isLikelyFormatButtonBySvg(el);
  }

  /**
   * 書式設定ボタン候補を列挙する。
   *
   * Google ChatのDOM変更時は、まずここを見直してください。
   * クラス名ではなく、button / role=button と aria系属性を使います。
   */
  function findFormatButtons() {
    const selector = [
      'button[aria-label]',
      'button[title]',
      'button[data-tooltip]',
      '[role="button"][aria-label]',
      '[role="button"][title]',
      '[role="button"][data-tooltip]'
    ].join(',');

    return Array.from(document.querySelectorAll(selector)).filter(isLikelyFormatButton);
  }

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;

    return true;
  }

  /**
   * ボタン近傍に書式ツールバーが既に開いているかを判定する。
   *
   * 優先判定:
   * - aria-expanded="true"
   * - aria-controls の参照先が存在
   *
   * 保険:
   * - 周辺に role="toolbar" があるか
   * - 太字/斜体/下線など、書式系のボタン群が周辺にあるか
   */
  function isToolbarAlreadyOpenNearButton(button) {
    if (!(button instanceof HTMLElement)) return false;

    const expanded = button.getAttribute('aria-expanded');
    if (expanded === 'true') {
      return true;
    }

    const controlsId = button.getAttribute('aria-controls');
    if (controlsId) {
      const controlled = document.getElementById(controlsId);
      if (controlled) return true;
    }

    const searchRoots = [];
    if (button.parentElement) searchRoots.push(button.parentElement);
    if (button.parentElement?.parentElement) searchRoots.push(button.parentElement.parentElement);
    if (button.closest('form')) searchRoots.push(button.closest('form'));

    for (const root of searchRoots) {
      if (!(root instanceof HTMLElement)) continue;

      const toolbar = root.querySelector('[role="toolbar"]');
      if (toolbar) return true;

      const richControls = Array.from(root.querySelectorAll('button,[role="button"]')).filter((el) => {
        if (el === button) return false;

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

      if (richControls.length >= 2) {
        return true;
      }
    }

    return false;
  }

  /**
   * 閉じている書式設定ボタンを見つけて click() する。
   */
  function ensureToolbarOpen() {
    const now = Date.now();

    if (now - lastClickAt < 120) {
      return;
    }

    const buttons = findFormatButtons();
    if (buttons.length === 0) {
      log('No format button found.');
      return;
    }

    for (const button of buttons) {
      if (!isVisible(button)) continue;

      const alreadyOpen = isToolbarAlreadyOpenNearButton(button);
      log('Format button check:', {
        ariaLabel: button.getAttribute('aria-label'),
        expanded: button.getAttribute('aria-expanded'),
        alreadyOpen
      });

      if (!alreadyOpen) {
        lastClickAt = Date.now();
        log('Clicking format button.', button);
        button.click();

        window.setTimeout(() => {
          scheduleEnsureToolbarOpen();
        }, RETRY_AFTER_CLICK_MS);

        return;
      }
    }
  }

  function scheduleEnsureToolbarOpen() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = window.setTimeout(() => {
      ensureToolbarOpen();
    }, DEBOUNCE_MS);
  }

  /**
   * Google Chat はSPAなので、
   * ルーム移動・送信後・入力欄再生成などを MutationObserver で監視する。
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

  /**
   * MutationObserver だけでは拾いきれないケース向けの保険。
   */
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

    window.addEventListener('focus', scheduleEnsureToolbarOpen, true);

    document.addEventListener('click', () => {
      scheduleEnsureToolbarOpen();
    }, true);

    document.addEventListener('keyup', () => {
      scheduleEnsureToolbarOpen();
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
