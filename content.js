(() => {
  'use strict';

  if (window.__gchatFormatDebugInstalled) {
    console.info('[gchat-format-debug] already installed');
    return;
  }
  window.__gchatFormatDebugInstalled = true;

  const PREFIX = '[gchat-format-debug]';
  const LOG_COOLDOWN_MS = 1000;
  const MAX_DEPTH = 12;
  const MAX_PER_SCOPE = 12;
  const MAX_GLOBAL = 40;
  const NEAR_DISTANCE = 420;

  let lastLogAt = 0;
  let lastSignature = '';
  let seq = 0;

  function text(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  function isGoogleChat() {
    return location.hostname === 'chat.google.com';
  }

  function isVisible(el) {
    if (!(el instanceof Element)) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isTextboxLike(el) {
    return el instanceof Element
      && el.matches('[contenteditable="true"], textarea, input[type="text"], input:not([type]), [role="textbox"]');
  }

  function centerOfRect(rect) {
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  function distanceBetweenRects(a, b) {
    const ca = centerOfRect(a);
    const cb = centerOfRect(b);
    const dx = ca.x - cb.x;
    const dy = ca.y - cb.y;
    return Math.round(Math.sqrt(dx * dx + dy * dy));
  }

  function simplePath(el, limit = 5) {
    if (!(el instanceof Element)) {
      return '';
    }

    const parts = [];
    let node = el;
    let depth = 0;

    while (node && depth < limit) {
      let part = node.tagName.toLowerCase();
      const role = text(node.getAttribute('role'));
      const ariaLabel = text(node.getAttribute('aria-label'));
      if (node.id) part += `#${node.id}`;
      if (role) part += `[role="${role}"]`;
      if (ariaLabel) part += `[aria-label="${ariaLabel.slice(0, 24)}"]`;
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }

    return parts.join(' > ');
  }

  function findTextboxFromTarget(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    const direct = target.closest('[contenteditable="true"], textarea, input[type="text"], input:not([type]), [role="textbox"]');
    if (direct) {
      return direct;
    }

    const targetRect = target.getBoundingClientRect();
    const nearestTextbox = [...document.querySelectorAll('[contenteditable="true"], textarea, input[type="text"], input:not([type]), [role="textbox"]')]
      .filter(isVisible)
      .map((el) => ({
        el,
        distance: distanceBetweenRects(targetRect, el.getBoundingClientRect()),
      }))
      .sort((a, b) => a.distance - b.distance)[0];

    if (!nearestTextbox || nearestTextbox.distance > 260) {
      return null;
    }

    return nearestTextbox.el;
  }

  function collectAncestorScopes(textbox) {
    const scopes = [];
    let node = textbox instanceof Element ? textbox : null;
    let depth = 0;

    while (node && depth < MAX_DEPTH) {
      scopes.push({
        depth,
        node,
        path: simplePath(node),
      });
      node = node.parentElement;
      depth += 1;
    }

    return scopes;
  }

  function formatButtonData(button, textboxRect, source, scopeDepth = null, scopePath = '') {
    const rect = button.getBoundingClientRect();
    const label = text(button.getAttribute('aria-label'));
    const title = text(button.getAttribute('title'));
    const tooltip = text(button.getAttribute('data-tooltip'));
    const bodyText = text(button.innerText || button.textContent || '');
    const expanded = text(button.getAttribute('aria-expanded'));
    const controls = text(button.getAttribute('aria-controls'));
    const combined = `${label} ${title} ${tooltip} ${bodyText}`.toLowerCase();
    const distance = distanceBetweenRects(textboxRect, rect);

    let score = 0;
    if (bodyText === 'A' || bodyText === 'a') score += 10;
    if (/format|formatting|書式|書式設定|style/.test(combined)) score += 8;
    if (expanded) score += 4;
    if (controls) score += 4;
    if (button.getAttribute('aria-haspopup')) score += 2;
    score += Math.max(0, 8 - Math.floor(distance / 70));

    return {
      source,
      scopeDepth,
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
      path: simplePath(button),
      scopePath,
      element: button,
    };
  }

  function collectScopeCandidates(scopes, textboxRect) {
    const dedupe = new Map();

    for (const scope of scopes) {
      const buttons = [...scope.node.querySelectorAll('button, [role="button"]')]
        .filter(isVisible)
        .slice(0, 200);

      for (const button of buttons) {
        if (!dedupe.has(button)) {
          dedupe.set(button, formatButtonData(button, textboxRect, 'ancestor-scope', scope.depth, scope.path));
        }
      }
    }

    return [...dedupe.values()]
      .sort((a, b) => b.score - a.score || a.distance - b.distance)
      .slice(0, MAX_GLOBAL);
  }

  function collectNearbyGlobalCandidates(textboxRect, textbox) {
    return [...document.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .filter((button) => button !== textbox && !button.contains(textbox))
      .map((button) => formatButtonData(button, textboxRect, 'global-nearby'))
      .filter((item) => item.distance <= NEAR_DISTANCE)
      .sort((a, b) => b.score - a.score || a.distance - b.distance)
      .slice(0, MAX_GLOBAL);
  }

  function collectLikelyFormatButtons(allCandidates) {
    return allCandidates
      .filter((item) => item.text === 'A'
        || item.text === 'a'
        || /format|formatting|書式|書式設定|style/i.test(`${item.ariaLabel} ${item.title} ${item.dataTooltip} ${item.text}`)
        || !!item.ariaExpanded
        || !!item.ariaControls)
      .sort((a, b) => b.score - a.score || a.distance - b.distance)
      .slice(0, MAX_PER_SCOPE);
  }

  function makeSignature(textbox) {
    const rect = textbox.getBoundingClientRect();
    return [
      location.pathname,
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height),
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

  function logDebug(target, trigger) {
    if (!isGoogleChat()) {
      return;
    }

    const textbox = findTextboxFromTarget(target);
    if (!isTextboxLike(textbox) || !isVisible(textbox)) {
      return;
    }

    const signature = makeSignature(textbox);
    if (!shouldLog(signature)) {
      return;
    }

    const textboxRect = textbox.getBoundingClientRect();
    const scopes = collectAncestorScopes(textbox);
    const scopeCandidates = collectScopeCandidates(scopes, textboxRect);
    const nearbyCandidates = collectNearbyGlobalCandidates(textboxRect, textbox);
    const allCandidates = [...new Map([...scopeCandidates, ...nearbyCandidates].map((item) => [item.element, item])).values()]
      .sort((a, b) => b.score - a.score || a.distance - b.distance);
    const likelyFormatButtons = collectLikelyFormatButtons(allCandidates);

    seq += 1;
    console.group(`${PREFIX} #${seq} ${trigger}`);
    console.info('url:', location.href);
    console.info('textbox:', textbox);
    console.info('textboxPath:', simplePath(textbox));
    console.info('textboxRect:', `${Math.round(textboxRect.left)},${Math.round(textboxRect.top)} ${Math.round(textboxRect.width)}x${Math.round(textboxRect.height)}`);
    console.info('ancestorScopes:', scopes.map((scope) => ({ depth: scope.depth, path: scope.path })));
    console.info('撤退判断目安: 入力欄を複数回クリックしても likelyFormatButtons が毎回 0 件なら、この方向は一旦撤退寄りで判断');
    console.groupCollapsed('likelyFormatButtons');
    console.table(likelyFormatButtons.map(({ element, ...rest }) => rest));
    console.groupEnd();
    console.groupCollapsed('scopeCandidates(top)');
    console.table(scopeCandidates.slice(0, MAX_PER_SCOPE).map(({ element, ...rest }) => rest));
    console.groupEnd();
    console.groupCollapsed('nearbyCandidates(top)');
    console.table(nearbyCandidates.slice(0, MAX_PER_SCOPE).map(({ element, ...rest }) => rest));
    console.groupEnd();
    console.groupEnd();

    window.__gchatFormatDebugLast = {
      at: new Date().toISOString(),
      trigger,
      url: location.href,
      textbox,
      textboxPath: simplePath(textbox),
      ancestorScopes: scopes.map((scope) => ({ depth: scope.depth, path: scope.path })),
      likelyFormatButtons: likelyFormatButtons.map(({ element, ...rest }) => rest),
      scopeCandidates: scopeCandidates.map(({ element, ...rest }) => rest),
      nearbyCandidates: nearbyCandidates.map(({ element, ...rest }) => rest),
    };
  }

  function onInteraction(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    window.setTimeout(() => {
      logDebug(target, event.type);
    }, 140);
  }

  document.addEventListener('click', onInteraction, true);
  document.addEventListener('focusin', onInteraction, true);

  console.info(`${PREFIX} installed for ${location.href}`);
})();
