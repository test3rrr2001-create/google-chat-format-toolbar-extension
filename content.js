(() => {
  'use strict';

  if (window.__gchatFormatDebugInstalled) {
    console.info('[gchat-format-debug] already installed');
    return;
  }
  window.__gchatFormatDebugInstalled = true;

  const PREFIX = '[gchat-format-debug]';
  const LOG_COOLDOWN_MS = 1000;
  const SEARCH_MARGIN = 260;
  const MAX_CANDIDATES = 20;

  let lastLogAt = 0;
  let lastSignature = '';
  let seq = 0;

  function isGoogleChat() {
    return location.hostname === 'chat.google.com';
  }

  function text(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!(el instanceof Element)) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isTextboxLike(el) {
    if (!(el instanceof Element)) {
      return false;
    }

    if (el.matches('[contenteditable="true"], textarea, input[type="text"], input:not([type]), [role="textbox"]')) {
      return true;
    }

    return false;
  }

  function findTextboxFromTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    const direct = target.closest('[contenteditable="true"], textarea, input[type="text"], input:not([type]), [role="textbox"]');
    if (direct) {
      return direct;
    }

    const nearbyTextboxes = [...document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"], input:not([type]), [role="textbox"]')]
      .filter(isVisible)
      .map((el) => ({
        el,
        distance: distanceBetween(el.getBoundingClientRect(), target.getBoundingClientRect()),
      }))
      .sort((a, b) => a.distance - b.distance);

    return nearbyTextboxes[0]?.distance <= SEARCH_MARGIN ? nearbyTextboxes[0].el : null;
  }

  function findComposerRoot(textbox) {
    if (!(textbox instanceof Element)) {
      return null;
    }

    let node = textbox;
    for (let i = 0; i < 6 && node; i += 1) {
      const buttonCount = node.querySelectorAll('button, [role="button"]').length;
      const textboxCount = node.querySelectorAll('[contenteditable="true"], textarea, input[type="text"], input:not([type]), [role="textbox"]').length;
      if (buttonCount > 0 && textboxCount > 0) {
        return node;
      }
      node = node.parentElement;
    }

    return textbox.parentElement || textbox;
  }

  function distanceBetween(a, b) {
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const dx = ax - bx;
    const dy = ay - by;
    return Math.round(Math.sqrt(dx * dx + dy * dy));
  }

  function intersectsExpandedRect(baseRect, candidateRect, margin = SEARCH_MARGIN) {
    return !(
      candidateRect.right < baseRect.left - margin ||
      candidateRect.left > baseRect.right + margin ||
      candidateRect.bottom < baseRect.top - margin ||
      candidateRect.top > baseRect.bottom + margin
    );
  }

  function scoreCandidate(button, textboxRect) {
    const label = text(button.getAttribute('aria-label'));
    const title = text(button.getAttribute('title'));
    const tooltip = text(button.getAttribute('data-tooltip'));
    const bodyText = text(button.innerText || button.textContent || '');
    const expanded = text(button.getAttribute('aria-expanded'));
    const controls = text(button.getAttribute('aria-controls'));
    const combined = `${label} ${title} ${tooltip} ${bodyText}`.toLowerCase();
    const rect = button.getBoundingClientRect();
    const distance = distanceBetween(textboxRect, rect);

    let score = 0;
    if (bodyText === 'A' || bodyText === 'a') score += 8;
    if (/format|formatting|書式|書式設定|style/.test(combined)) score += 8;
    if (expanded) score += 3;
    if (controls) score += 3;
    if (button.getAttribute('aria-haspopup')) score += 1;
    score += Math.max(0, 6 - Math.floor(distance / 80));

    return {
      score,
      distance,
      text: bodyText,
      ariaLabel: label,
      title,
      dataTooltip: tooltip,
      ariaExpanded: expanded,
      ariaControls: controls,
      ariaHaspopup: text(button.getAttribute('aria-haspopup')),
      rect: `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      tag: button.tagName.toLowerCase(),
      role: text(button.getAttribute('role')),
      className: text(button.className),
      button,
    };
  }

  function collectCandidates(textbox, composerRoot) {
    const textboxRect = textbox.getBoundingClientRect();
    const scope = composerRoot || document.body;
    const buttons = [...scope.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .filter((button) => intersectsExpandedRect(textboxRect, button.getBoundingClientRect()))
      .map((button) => scoreCandidate(button, textboxRect))
      .sort((a, b) => b.score - a.score || a.distance - b.distance)
      .slice(0, MAX_CANDIDATES);

    return buttons;
  }

  function makeSignature(textbox, composerRoot) {
    const textboxRect = textbox.getBoundingClientRect();
    const rootTag = composerRoot?.tagName?.toLowerCase() || 'none';
    return [
      location.pathname,
      rootTag,
      Math.round(textboxRect.left),
      Math.round(textboxRect.top),
      Math.round(textboxRect.width),
      Math.round(textboxRect.height),
    ].join('|');
  }

  function shouldLog(signature) {
    const now = Date.now();
    if (signature === lastSignature && now - lastLogAt < LOG_COOLDOWN_MS) {
      return false;
    }
    lastSignature = signature;
    lastLogAt = now;
    return true;
  }

  function debugComposer(target, trigger) {
    if (!isGoogleChat()) {
      return;
    }

    const textbox = findTextboxFromTarget(target);
    if (!textbox || !isTextboxLike(textbox)) {
      return;
    }

    const composerRoot = findComposerRoot(textbox);
    const signature = makeSignature(textbox, composerRoot);
    if (!shouldLog(signature)) {
      return;
    }

    const candidates = collectCandidates(textbox, composerRoot);
    const textboxRect = textbox.getBoundingClientRect();

    seq += 1;
    console.group(`${PREFIX} #${seq} ${trigger}`);
    console.info('url:', location.href);
    console.info('textbox:', textbox);
    console.info('composerRoot:', composerRoot);
    console.info('textboxRect:', `${Math.round(textboxRect.left)},${Math.round(textboxRect.top)} ${Math.round(textboxRect.width)}x${Math.round(textboxRect.height)}`);
    console.table(candidates.map((item) => ({
      score: item.score,
      distance: item.distance,
      text: item.text,
      ariaLabel: item.ariaLabel,
      title: item.title,
      dataTooltip: item.dataTooltip,
      ariaExpanded: item.ariaExpanded,
      ariaControls: item.ariaControls,
      ariaHaspopup: item.ariaHaspopup,
      rect: item.rect,
      tag: item.tag,
      role: item.role,
      className: item.className,
    })));
    console.groupEnd();

    window.__gchatFormatDebugLast = {
      at: new Date().toISOString(),
      trigger,
      url: location.href,
      textbox,
      composerRoot,
      candidates: candidates.map(({ button, ...rest }) => rest),
    };
  }

  function onInteraction(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    window.setTimeout(() => {
      debugComposer(target, event.type);
    }, 120);
  }

  document.addEventListener('click', onInteraction, true);
  document.addEventListener('focusin', onInteraction, true);

  console.info(`${PREFIX} installed for ${location.href}`);
})();
