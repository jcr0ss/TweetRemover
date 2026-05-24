(() => {
  'use strict';

  const CONFIG = {
    queryParam: 'TweetRemover',
    undoRetweetsParam: 'undoRetweets',
    actionDelayMs: 650,
    cycleDelayMs: 1200,
    waitTimeoutMs: 3500,
    menuAnchorMaxDistancePx: 650,
    maxIdleCycles: 10,
    maxAttemptsPerPost: 2,
    postActionSettleTimeoutMs: 3500,
    staleAllowedMenuGraceMs: 8000,
    scrollStep: Math.max(400, Math.floor(window.innerHeight * 0.75)),
  };

  const state = {
    running: false,
    deleted: 0,
    skipped: 0,
    repostsUndone: 0,
    idleCycles: 0,
    attemptedPosts: new WeakMap(),
    attemptedReposts: new WeakMap(),
    countedUnknownPosts: new WeakSet(),
    stopReason: '',
    recentAllowedAction: null,
  };

  const ARTICLE_CLASSIFICATION = Object.freeze({
    OWN_POST_OR_REPLY: 'OWN_POST_OR_REPLY',
    REPOST_BY_REQUESTED_HANDLE: 'REPOST_BY_REQUESTED_HANDLE',
    OTHER_OR_NON_ACTIONABLE: 'OTHER_OR_NON_ACTIONABLE',
    UNKNOWN: 'UNKNOWN',
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function getSearchParams() {
    return new URLSearchParams(window.location.search || '');
  }

  function hasRunParam() {
    return getSearchParams().get(CONFIG.queryParam) === 'true';
  }

  function hasTweetRemoverParams() {
    const params = getSearchParams();
    return params.has(CONFIG.queryParam) || params.has(CONFIG.undoRetweetsParam);
  }

  function hasUndoRetweetsParam() {
    return getSearchParams().get(CONFIG.undoRetweetsParam) === 'true';
  }

  function shouldActivateFromUrl() {
    // Popup buttons generate ?TweetRemover=true and optionally &undoRetweets=true.
    // Anything else, including ordinary x.com browsing and stale/partial params, must be inert.
    return hasRunParam();
  }

  function getRunMode() {
    const includeReplies = window.location.pathname.replace(/\/+$/, '').endsWith('/with_replies');
    const undoRetweets = includeReplies && hasUndoRetweetsParam();
    if (undoRetweets) return 'Delete Tweets + Replies + Undo Reposts/Retweets';
    if (includeReplies) return 'Delete Tweets + Replies';
    return 'Delete Tweets';
  }

  function getCountsText() {
    return `Deleted: ${state.deleted} · Reposts undone: ${state.repostsUndone} · Skipped: ${state.skipped}`;
  }

  function stripRunParam() {
    if (!hasRunParam()) return;

    const url = new URL(window.location.href);
    url.searchParams.delete(CONFIG.queryParam);
    url.searchParams.delete(CONFIG.undoRetweetsParam);
    const next = `${url.pathname}${url.search}${url.hash}`;
    try {
      window.history.replaceState(window.history.state, document.title, next);
    } catch (_) {
      // Best-effort only; never navigate or click to recover.
    }
  }

  function createStatusBox() {
    let box = document.getElementById('tweet-remover-status');
    if (box) return box;

    box = document.createElement('div');
    box.id = 'tweet-remover-status';
    box.setAttribute('role', 'status');
    box.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'max-width:390px',
      'padding:12px 14px',
      'border-radius:12px',
      'background:rgba(15,20,25,0.94)',
      'color:white',
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 8px 30px rgba(0,0,0,0.35)',
      'white-space:pre-line',
    ].join(';');
    document.documentElement.appendChild(box);
    return box;
  }

  function setStatus(message) {
    createStatusBox().textContent = `TweetRemover\n${message}`;
    console.log(`[TweetRemover] ${message}`);
  }

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (!document.documentElement.contains(element)) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true' || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none'
      && style.opacity !== '0'
      && style.pointerEvents !== 'none';
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function isSecurityOrAccountText(text) {
    return /passcode|verification|verify your identity|authenticate|security|two[-\s]?factor|\b2fa\b|account access|suspicious activity|confirm your identity|checkpoint|unlock your account|log in|login|password|email code|phone number|confirmation code/i.test(text || '');
  }

  function isPasscodeChatOrSecurityContext(element) {
    const blockingChromeTextPattern = /passcode|recover your encryption keys|decrypt your previous messages|forgot passcode|encrypted|encryption keys|chat|message|conversation|pin\/recovery|verification|verify your identity|authenticate|security|two[-\s]?factor|\b2fa\b|checkpoint|unlock your account|log in|login|password|confirmation code/i;
    const blockingPageWallPattern = /enter passcode|recover your encryption keys|decrypt your previous messages|forgot passcode|pin\/recovery/i;

    if (isBlockedPath(window.location.pathname) || /pin\/recovery/i.test(window.location.pathname)) return true;

    const visiblePageText = normalizeText(document.body?.innerText || '').slice(0, 5000);
    const hasBlockingPageWall = blockingPageWallPattern.test(visiblePageText);

    if (!element) return hasBlockingPageWall;

    const isWholePage = element === document.body || element === document.documentElement;
    if (isWholePage) return hasBlockingPageWall;

    // Only scan X chrome surfaces that can actually be account/security/recovery UI.
    // Never scan the full primary column or article text here: ordinary posts often
    // contain benign words like "national security", "message", or "chat", and those
    // posts can also contain the legitimate repost/delete controls we are allowed to click.
    const blockingChromeContext = element.closest('[role="dialog"], [role="menu"], [data-testid="Dropdown"]');
    if (blockingChromeContext) {
      const contextText = normalizeText(blockingChromeContext.innerText || blockingChromeContext.textContent || '');
      return blockingChromeTextPattern.test(contextText) || hasBlockingPageWall;
    }

    // For in-timeline controls, only inspect the control's own accessible text. Do
    // not inherit tweet body copy from the surrounding article/primary column.
    const control = element.closest('button, [role="button"], a, [role="menuitem"]') || element;
    const controlText = normalizeText([
      control.getAttribute?.('aria-label'),
      control.getAttribute?.('title'),
      control.innerText,
      control.textContent,
    ].filter(Boolean).join(' '));

    return blockingChromeTextPattern.test(controlText) || hasBlockingPageWall;
  }

  function isVerifiedAuthorHandle(post, expectedHandle) {
    const handleText = `@${expectedHandle.toLowerCase()}`;
    const userNameLinks = [...post.querySelectorAll('a[role="link"][href], a[href]')].slice(0, 12);
    return userNameLinks.some((link) => {
      try {
        const url = new URL(link.href, window.location.origin);
        const pathHandle = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
        const text = normalizeText(link.innerText || link.textContent || '').toLowerCase();
        return pathHandle === expectedHandle.toLowerCase() && text.includes(handleText);
      } catch (_) {
        return false;
      }
    });
  }

  function isBlockedPath(pathname = window.location.pathname) {
    const path = pathname.toLowerCase();
    return /(^|\/)(i\/chat|messages|settings|account|login|flow|security|checkpoint|passcode|logout|oauth|privacy|help|pin|recovery|compose|search|hashtag)(\/|$)/i.test(path);
  }

  function isAllowedRunSurface() {
    if (window.location.hostname !== 'x.com') return false;
    if (isBlockedPath()) return false;

    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    const parts = path.split('/').filter(Boolean);
    if (parts.length !== 1 && !(parts.length === 2 && parts[1] === 'with_replies')) return false;

    const handle = parts[0] || '';
    const reservedRoots = new Set([
      'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'account', 'login',
      'flow', 'security', 'checkpoint', 'passcode', 'compose', 'search', 'hashtag', 'privacy',
    ]);

    return /^[_a-zA-Z0-9]{1,15}$/.test(handle) && !reservedRoots.has(handle.toLowerCase());
  }

  function abortRun(reason) {
    stripRunParam();
    state.stopReason = reason;
    state.running = false;
    setStatus(`${reason}\n${getCountsText()}`);
  }

  function shouldAbortForOutOfScopePage() {
    if (isAllowedRunSurface()) return false;
    abortRun(`Aborted: out-of-scope page ${window.location.pathname}. Run flag removed; no recovery clicks attempted.`);
    return true;
  }

  function installRouteWatchdog() {
    const abortIfUnsafe = () => {
      if (!state.running && !hasRunParam()) return;
      if (!isAllowedRunSurface()) shouldAbortForOutOfScopePage();
    };

    for (const method of ['pushState', 'replaceState']) {
      const original = window.history[method];
      window.history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        queueMicrotask(abortIfUnsafe);
        return result;
      };
    }

    window.addEventListener('popstate', abortIfUnsafe);
    window.addEventListener('hashchange', abortIfUnsafe);

    const observer = new MutationObserver(abortIfUnsafe);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    abortIfUnsafe();
  }

  function getVisibleDialogs() {
    return [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(isElementVisible);
  }

  function getBlockingSecurityDialog() {
    return getVisibleDialogs().find((dialog) => isSecurityOrAccountText(dialog.innerText));
  }

  function abortIfSecurityOrUnexpectedDialog(allowedDialog = null) {
    const securityDialog = getBlockingSecurityDialog();
    if (securityDialog) {
      abortRun('Aborted: account/security/passcode dialog appeared. Run flag removed; no dialog clicks attempted.');
      return true;
    }

    const unexpectedDialog = getVisibleDialogs().find((dialog) => dialog !== allowedDialog && !dialog.contains(allowedDialog));
    if (unexpectedDialog) {
      abortRun(`Aborted: unexpected dialog appeared (${normalizeText(unexpectedDialog.innerText).slice(0, 120) || 'no text'}). Run flag removed; no recovery clicks attempted.`);
      return true;
    }

    return false;
  }

  function isInsidePrimaryColumn(element) {
    return Boolean(element?.closest('[data-testid="primaryColumn"]'));
  }

  function getPostStatusLink(post) {
    const links = [...post.querySelectorAll('a[href*="/status/"]')];
    return links.find((link) => {
      try {
        const url = new URL(link.href, window.location.origin);
        return url.hostname === 'x.com' && /^\/[^/]+\/status\/\d+/.test(url.pathname);
      } catch (_) {
        return false;
      }
    }) || null;
  }

  function getPrimaryStatus(post) {
    return parseStatusLink(getPostStatusLink(post));
  }

  function getProfileHandleFromLink(link) {
    try {
      const url = new URL(link.href, window.location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.hostname !== 'x.com' || parts.length !== 1) return null;
      const handle = parts[0].toLowerCase();
      if (!/^[_a-z0-9]{1,15}$/.test(handle)) return null;
      return handle;
    } catch (_) {
      return null;
    }
  }

  function isInsideRepostSocialContextNode(node) {
    const socialContext = node?.closest?.('[data-testid="socialContext"]');
    if (socialContext) return true;
    const text = normalizeText(node?.innerText || node?.textContent || node?.getAttribute?.('aria-label') || '');
    return /\b(reposted|retweeted)\b/i.test(text) && !/\bquote\b/i.test(text);
  }

  function getPrimaryVisibleAuthorHandle(post) {
    const links = [...post.querySelectorAll('a[href]')].filter(isElementVisible);
    for (const link of links.slice(0, 20)) {
      if (link.href.includes('/status/')) continue;
      if (isInsideRepostSocialContextNode(link)) continue;
      const handle = getProfileHandleFromLink(link);
      if (!handle) continue;
      const text = normalizeText(link.innerText || link.textContent || link.getAttribute('aria-label') || '').toLowerCase();
      if (text.includes(`@${handle}`)) return handle;
    }
    return null;
  }

  function parseStatusLink(link) {
    if (!link) return null;
    try {
      const url = new URL(link.href, window.location.origin);
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (!match) return null;
      const [, handle, tweetId] = match;
      return { handle, tweetId, url };
    } catch (_) {
      return null;
    }
  }

  function getTargetHandle() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return (parts[0] || '').replace(/^@+/, '').toLowerCase();
  }

  function getOwnPostStatus(post) {
    const targetHandle = getTargetHandle();
    const links = [...post.querySelectorAll('a[href*="/status/"]')];

    for (const link of links) {
      const status = parseStatusLink(link);
      if (status?.handle?.toLowerCase() === targetHandle && isVerifiedAuthorHandle(post, targetHandle)) return status;
    }

    return null;
  }

  function getPostRoot(element) {
    // Prefer the outer article. X keeps the "You reposted" social context as a
    // sibling/ancestor of the inner [data-testid="tweet"] body; using the inner
    // tweet as the root loses the repost marker and makes repost classification
    // depend only on button state.
    const articleRoot = element?.closest('article[role="article"], article');
    const candidate = articleRoot || element?.closest('[data-testid="tweet"]');
    if (!candidate || !isInsidePrimaryColumn(candidate)) return null;
    if (!getPostStatusLink(candidate)) return null;
    return candidate;
  }

  function getVisiblePostRoots() {
    if (!isAllowedRunSurface()) return [];

    const candidates = [
      ...document.querySelectorAll('[data-testid="primaryColumn"] article[role="article"], [data-testid="primaryColumn"] article'),
      ...document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="tweet"]'),
    ];

    const unique = [];
    const seen = new Set();

    for (const candidate of candidates) {
      const post = getPostRoot(candidate);
      if (!post || seen.has(post)) continue;
      seen.add(post);
      unique.push(post);
    }

    return unique.filter((post) => {
      const rect = post.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight * 1.5;
    });
  }

  function findPostCaret(post) {
    const caret = post.querySelector('button[data-testid="caret"][aria-label="More"], button[data-testid="caret"]');
    if (!isElementVisible(caret)) return null;
    if (getPostRoot(caret) !== post) return null;
    return caret;
  }

  function distanceBetweenRects(a, b) {
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    return Math.hypot(ax - bx, ay - by);
  }

  function isMenuAnchoredToCaret(menu, caret) {
    if (!menu || !caret) return false;
    const menuRect = menu.getBoundingClientRect();
    const caretRect = caret.getBoundingClientRect();
    return distanceBetweenRects(menuRect, caretRect) <= CONFIG.menuAnchorMaxDistancePx
      && menuRect.left <= caretRect.right + 420
      && menuRect.right >= caretRect.left - 420
      && menuRect.top <= caretRect.bottom + 520
      && menuRect.bottom >= caretRect.top - 120;
  }

  function getVisibleMenus() {
    const candidates = [...document.querySelectorAll('[role="menu"], [data-testid="Dropdown"]')].filter(isElementVisible);
    const unique = [];

    for (const candidate of candidates) {
      const candidateText = normalizeText(candidate.innerText || candidate.textContent || '');
      const candidateRect = candidate.getBoundingClientRect();
      const duplicateIndex = unique.findIndex((existing) => {
        if (existing === candidate) return true;
        const existingText = normalizeText(existing.innerText || existing.textContent || '');
        const existingRect = existing.getBoundingClientRect();
        const sameBox = Math.abs(existingRect.left - candidateRect.left) <= 2
          && Math.abs(existingRect.top - candidateRect.top) <= 2
          && Math.abs(existingRect.width - candidateRect.width) <= 2
          && Math.abs(existingRect.height - candidateRect.height) <= 2;
        const sameText = existingText === candidateText;
        return sameText && (sameBox || existing.contains(candidate) || candidate.contains(existing));
      });

      if (duplicateIndex === -1) {
        unique.push(candidate);
        continue;
      }

      // X often renders the same visible menu as a nested [data-testid="Dropdown"]
      // and [role="menu"]. Keep the element that actually owns menuitems so
      // callers see one actionable menu instead of refusing to click because
      // the same menu was counted twice.
      const existing = unique[duplicateIndex];
      const existingItems = existing.querySelectorAll?.('[role="menuitem"]').length || 0;
      const candidateItems = candidate.querySelectorAll?.('[role="menuitem"]').length || 0;
      if (candidateItems > existingItems) unique[duplicateIndex] = candidate;
    }

    return unique;
  }

  function dispatchEscape() {
    const eventInit = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    const KeyboardEventCtor = window.KeyboardEvent || globalThis.KeyboardEvent;
    const event = KeyboardEventCtor ? new KeyboardEventCtor('keydown', eventInit) : null;
    if (event) {
      (document.activeElement || document.body || document.documentElement).dispatchEvent(event);
      document.dispatchEvent(event);
      window.dispatchEvent(event);
    }
  }

  function blurActiveElement() {
    try {
      if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    } catch (_) {
      // Best-effort only.
    }
  }

  function isNeutralDismissTarget(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest('[role="menu"], [data-testid="Dropdown"], [role="dialog"], article, [data-testid="tweet"], a, button, [role="button"], [role="menuitem"]')) return false;
    if (isPasscodeChatOrSecurityContext(element)) return false;
    return true;
  }

  function dispatchNeutralPointerDismiss() {
    const points = [
      [Math.max(8, Math.floor(window.innerWidth || 0) - 12), 12],
      [12, 12],
      [Math.floor((window.innerWidth || 800) / 2), 12],
    ];
    const MouseEventCtor = window.MouseEvent || globalThis.MouseEvent;

    for (const [x, y] of points) {
      const target = document.elementFromPoint?.(x, y) || document.body || document.documentElement;
      if (!isNeutralDismissTarget(target)) continue;

      if (MouseEventCtor) {
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEventCtor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
        }
      }
      return true;
    }

    return false;
  }

  async function tryDismissVisibleMenus() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      dispatchEscape();
      blurActiveElement();
      if (attempt >= 1) dispatchNeutralPointerDismiss();
      await sleep(attempt < 2 ? 150 : 250);
      const menus = getVisibleMenus();
      if (menus.length === 0) return { dismissed: true, menus };
      if (menus.some((menu) => isSecurityOrAccountText(menu.innerText || menu.textContent || ''))) {
        return { dismissed: false, menus, security: true };
      }
    }

    return { dismissed: false, menus: getVisibleMenus() };
  }

  async function dismissPreExistingMenus(stepName, tweetId) {
    let menus = getVisibleMenus();
    if (menus.length === 0) return true;

    if (menus.some((menu) => isSecurityOrAccountText(menu.innerText || menu.textContent || ''))) {
      abortRun(`Aborted: account/security/passcode menu was open before ${stepName}. Run flag removed; no cleanup clicks attempted.`);
      return false;
    }

    setStatus(`Recovering: dismissing ${menus.length} pre-existing actionable menu(s) before ${stepName} ${tweetId}; no menu item clicks attempted.\n${getCountsText()}`);
    const result = await tryDismissVisibleMenus();
    if (result.dismissed) return true;

    if (result.security) {
      abortRun(`Aborted: account/security/passcode menu was open before ${stepName}. Run flag removed; no cleanup clicks attempted.`);
      return false;
    }

    menus = result.menus || [];
    setStatus(`Continuing cautiously: ${menus.length} unrelated pre-existing menu(s) remained before ${stepName} ${tweetId}; will only use a newly anchored target menu.\n${getCountsText()}`);
    return true;
  }

  function isUndoRepostContainer(container) {
    if (!container || !isElementVisible(container)) return false;
    const text = normalizeText(container.innerText || container.textContent || '');
    if (!/\bundo\b/i.test(text) || !/\b(repost|retweet)\b/i.test(text)) return false;
    if (isSecurityOrAccountText(text)) return false;
    if (/chat|message|conversation|pin\s+(chat|conversation)|encrypted|keys/i.test(text)) return false;

    const controls = [...container.querySelectorAll('[role="menuitem"], button, [role="button"]')].filter(isElementVisible);
    return controls.some((control) => {
      const controlText = normalizeText(control.innerText || control.textContent || control.getAttribute('aria-label') || '');
      return /^Undo\s+(repost|reposts|retweet|retweets)$/i.test(controlText) && !isSecurityOrAccountText(controlText);
    });
  }

  function markRecentAllowedAction(type, tweetId) {
    state.recentAllowedAction = { type, tweetId, at: Date.now() };
  }

  function clearRecentAllowedAction() {
    state.recentAllowedAction = null;
  }

  function hasRecentAllowedAction(type = null) {
    const action = state.recentAllowedAction;
    if (!action) return false;
    if (type && action.type !== type) return false;
    return Date.now() - action.at <= CONFIG.staleAllowedMenuGraceMs;
  }

  function getVisibleBlockingOverlays() {
    return [...getVisibleMenus(), ...getVisibleDialogs()].filter(isElementVisible);
  }

  async function waitForAllowedUiToSettle(actionType, tweetId) {
    const started = Date.now();

    while (Date.now() - started < CONFIG.postActionSettleTimeoutMs) {
      if (!state.running || shouldAbortForOutOfScopePage()) return false;
      const securityDialog = getBlockingSecurityDialog();
      if (securityDialog) {
        abortRun('Aborted: account/security/passcode dialog appeared after an allowed action. Run flag removed; no cleanup clicks attempted.');
        return false;
      }
      if (getVisibleBlockingOverlays().length === 0) {
        clearRecentAllowedAction();
        return true;
      }
      await sleep(100);
    }

    const menus = getVisibleMenus();
    const dialogs = getVisibleDialogs();
    if (dialogs.some((dialog) => isSecurityOrAccountText(dialog.innerText || dialog.textContent || ''))
      || menus.some((menu) => isSecurityOrAccountText(menu.innerText || menu.textContent || ''))) {
      abortRun('Aborted: account/security/passcode UI remained visible after an allowed action. Run flag removed; no cleanup clicks attempted.');
      return false;
    }

    markRecentAllowedAction(actionType, tweetId);
    setStatus(`Waiting: X left ${menus.length} menu(s) and ${dialogs.length} dialog(s) visible after ${actionType} ${tweetId}; no cleanup clicks attempted.\n${getCountsText()}`);
    return false;
  }

  function shouldPauseForSafeStaleUndoUi(stepName, tweetId) {
    const overlays = getVisibleBlockingOverlays();
    if (overlays.length === 0) return false;

    if (!hasOnlySafeUndoOverlays()) return false;

    const recentText = hasRecentAllowedAction() ? ' from the previous allowed action' : '';
    setStatus(`Waiting: X still shows safe Undo repost/retweet UI${recentText} before ${stepName} ${tweetId}; no cleanup clicks attempted.\n${getCountsText()}`);
    return true;
  }

  function hasOnlySafeUndoOverlays() {
    const overlays = getVisibleBlockingOverlays();
    return overlays.length > 0 && overlays.every(isUndoRepostContainer);
  }

  function noteProceedingPastSafeUndoUi(stepName, tweetId) {
    const recentText = hasRecentAllowedAction() ? ' from the previous allowed action' : '';
    setStatus(`Continuing: X still shows safe Undo repost/retweet UI${recentText} before ${stepName} ${tweetId}; no cleanup clicks attempted.\n${getCountsText()}`);
  }

  function shouldPauseForRecentAllowedStaleUi(stepName, tweetId) {
    return shouldPauseForSafeStaleUndoUi(stepName, tweetId);
  }

  function getMenuSnapshot(menu) {
    const rect = menu.getBoundingClientRect();
    return {
      menu,
      text: normalizeText(menu.innerText || menu.textContent || ''),
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function isUnchangedPreExistingMenu(menu, snapshots = []) {
    const snapshot = snapshots.find((candidate) => candidate.menu === menu);
    if (!snapshot) return false;

    const current = getMenuSnapshot(menu);
    return current.text === snapshot.text
      && Math.abs(current.left - snapshot.left) <= 2
      && Math.abs(current.top - snapshot.top) <= 2
      && Math.abs(current.width - snapshot.width) <= 2
      && Math.abs(current.height - snapshot.height) <= 2;
  }

  function getAnchoredDeleteMenuItem(caret, preExistingMenuSnapshots = []) {
    const candidates = getVisibleMenus()
      .filter((menu) => isMenuAnchoredToCaret(menu, caret))
      .filter((menu) => !isUnchangedPreExistingMenu(menu, preExistingMenuSnapshots))
      .map((menu) => {
        const menuText = normalizeText(menu.innerText || '');
        if (isSecurityOrAccountText(menuText)) return null;
        if (/chat|message|conversation|pin\s+(chat|conversation)|encrypted|keys/i.test(menuText)) return null;

        const menuItems = [...menu.querySelectorAll('[role="menuitem"]')].filter(isElementVisible);
        const firstItem = menuItems[0] || null;
        if (!firstItem) return null;

        const firstText = normalizeText(firstItem.innerText || firstItem.textContent);
        if (!/^Delete$/i.test(firstText)) return null;

        return {
          menu,
          firstItem,
          distance: distanceBetweenRects(menu.getBoundingClientRect(), caret.getBoundingClientRect()),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance);

    // X can leave multiple visible Delete menus during fast timeline cleanup.
    // Pre-existing snapshots exclude unchanged old menus; if more than one new
    // candidate remains, use the one physically closest to this post's caret.
    // We still require it to be anchored to the caret and to have Delete as the
    // first menu item, so we do not click unrelated menus.
    return candidates[0]?.firstItem || null;
  }

  function getVisibleDeleteConfirmDialog() {
    const dialogs = getVisibleDialogs();
    return dialogs.find((dialog) => {
      const text = normalizeText(dialog.innerText || '');
      if (!/delete/i.test(text)) return false;
      if (isSecurityOrAccountText(text)) return false;
      if (/delete\s+(account|profile|message|conversation|chat|list|bookmark|draft|all)/i.test(text)) return false;
      return /(delete\s+post|delete\s+tweet|this can[’']?t be undone|this cannot be undone)/i.test(text);
    }) || null;
  }

  function getVisibleDeleteConfirmButton(dialog) {
    if (!dialog) return null;
    const buttons = [...dialog.querySelectorAll('button, [role="button"]')];
    return buttons.find((button) => {
      if (!isElementVisible(button)) return false;
      const text = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label'));
      const testId = button.getAttribute('data-testid') || '';
      const isDeleteText = /^Delete(\s+(post|tweet))?$/i.test(text);
      const isXConfirmButton = testId === 'confirmationSheetConfirm' && /delete/i.test(text || normalizeText(dialog.innerText || dialog.textContent || ''));
      return (isDeleteText || isXConfirmButton) && !isSecurityOrAccountText(text);
    }) || null;
  }

  function isWithRepliesTimeline() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return parts.length === 2 && parts[1] === 'with_replies';
  }

  function shouldUndoRetweets() {
    return hasUndoRetweetsParam() && isWithRepliesTimeline();
  }

  function getFirstStatusLinkRect(post) {
    const link = getPostStatusLink(post);
    return link?.getBoundingClientRect?.() || null;
  }

  function getTopContextLimit(post) {
    const statusRect = getFirstStatusLinkRect(post);
    const postRect = post.getBoundingClientRect();
    return statusRect ? statusRect.top + Math.max(0, statusRect.height) + 16 : postRect.top + postRect.height * 0.45;
  }

  function getTopContextNodes(post) {
    const postRect = post.getBoundingClientRect();
    const topLimit = getTopContextLimit(post);
    return [...post.querySelectorAll('div, span, a')].filter((node) => {
      if (!isElementVisible(node)) return false;
      const rect = node.getBoundingClientRect();
      return rect.top >= postRect.top - 2 && rect.top <= topLimit;
    });
  }

  function hasTargetProfileRepostContext(post, targetHandle) {
    const topContextNodes = getTopContextNodes(post);
    const topText = normalizeText(topContextNodes.map((node) => node.innerText || node.textContent || '').join(' '));
    if (!/\b(reposted|retweeted)\b/i.test(topText)) return false;

    return [...post.querySelectorAll('a[href]')].some((link) => {
      if (!isElementVisible(link)) return false;
      const rect = link.getBoundingClientRect();
      const postRect = post.getBoundingClientRect();
      const topLimit = getTopContextLimit(post);
      if (rect.top < postRect.top - 2 || rect.top > topLimit) return false;
      try {
        const url = new URL(link.href, window.location.origin);
        const parts = url.pathname.split('/').filter(Boolean);
        return url.hostname === 'x.com' && parts.length === 1 && parts[0].toLowerCase() === targetHandle.toLowerCase();
      } catch (_) {
        return false;
      }
    });
  }

  function getRepostSocialContext(post, targetHandle) {
    const topNodes = getTopContextNodes(post);
    const socialContextNodes = [...post.querySelectorAll('[data-testid="socialContext"]')].filter(isElementVisible);
    const markerNodes = [...topNodes, ...socialContextNodes];
    const topText = normalizeText(markerNodes.map((node) => (
      node.innerText || node.textContent || node.getAttribute?.('aria-label') || ''
    )).join(' '));
    if (!/\b(reposted|retweeted)\b/i.test(topText)) return null;

    const targetProfileLink = [...post.querySelectorAll('a[href]')].some((link) => {
      if (!isElementVisible(link)) return false;
      const rect = link.getBoundingClientRect();
      const postRect = post.getBoundingClientRect();
      if (rect.top < postRect.top - 2 || rect.top > getTopContextLimit(post)) return false;
      return getProfileHandleFromLink(link) === targetHandle.toLowerCase();
    });

    const handleText = `@${targetHandle.toLowerCase()}`;
    const lowerText = topText.toLowerCase();
    const saysYouReposted = /\byou\s+(reposted|retweeted)\b/i.test(topText);
    const namesRequestedHandle = lowerText.includes(handleText) || targetProfileLink;
    if (!saysYouReposted && !namesRequestedHandle) return null;

    return { text: topText, saysYouReposted, namesRequestedHandle, marker: 'social-context' };
  }

  function getArticleRepostContext(post, targetHandle) {
    const socialContext = getRepostSocialContext(post, targetHandle);
    if (socialContext) return socialContext;

    const visibleSocialContext = [...post.querySelectorAll('[data-testid="socialContext"]')]
      .filter(isElementVisible)
      .map((node) => normalizeText(node.innerText || node.textContent || node.getAttribute('aria-label') || ''))
      .find((text) => /\b(reposted|retweeted)\b/i.test(text)
        && (/\byou\s+(reposted|retweeted)\b/i.test(text) || text.toLowerCase().includes(`@${targetHandle.toLowerCase()}`)));
    if (visibleSocialContext) return { text: visibleSocialContext, marker: 'article-social-context' };

    const unretweetCount = [...post.querySelectorAll('button[data-testid="unretweet"]')]
      .filter((button) => isElementVisible(button) && getPostRoot(button) === post).length;
    if (unretweetCount > 0) return { text: `ambiguous post-owned unretweet button count ${unretweetCount} without requested-handle/You reposted context`, marker: 'unretweet-button-only', unretweetCount };

    return null;
  }

  function getDeleteEligibility(post, targetHandle) {
    const repostContext = getArticleRepostContext(post, targetHandle);
    if (repostContext) {
      return { eligible: false, repostContext, reason: 'repost article: delete path blocked' };
    }

    const primaryAuthorHandle = getPrimaryVisibleAuthorHandle(post);
    if (primaryAuthorHandle !== targetHandle.toLowerCase()) {
      return { eligible: false, primaryAuthorHandle, reason: `primary visible author @${primaryAuthorHandle || 'unknown'} did not match @${targetHandle}` };
    }

    const primaryStatus = getPrimaryStatus(post);
    if (primaryStatus?.handle?.toLowerCase() !== targetHandle.toLowerCase()) {
      return { eligible: false, primaryAuthorHandle, primaryStatus, reason: `primary status URL handle @${primaryStatus?.handle || 'unknown'} did not match @${targetHandle}` };
    }

    const caret = findPostCaret(post);
    if (!caret) {
      return { eligible: false, primaryAuthorHandle, primaryStatus, reason: 'post-owned caret button not found' };
    }

    return { eligible: true, primaryAuthorHandle, primaryStatus, caret, reason: 'no repost context; primary author/status/caret match requested handle' };
  }

  function getRepostedStatus(post) {
    const targetHandle = getTargetHandle();
    const statusLink = getPostStatusLink(post);
    if (!statusLink) return null;
    if (getOwnPostStatus(post)) return null;
    if (!hasTargetProfileRepostContext(post, targetHandle)) return null;

    return parseStatusLink(statusLink);
  }

  function findPostUndoRepostButton(post) {
    const buttons = [...post.querySelectorAll('button[data-testid="unretweet"]')].filter(isElementVisible);
    if (buttons.length !== 1) return null;
    const button = buttons[0];
    if (getPostRoot(button) !== post) return null;
    const label = normalizeText(button.getAttribute('aria-label') || button.innerText || button.textContent || '');
    if (isSecurityOrAccountText(label)) return null;
    return button;
  }

  function classifyArticle(post) {
    const postRoot = getPostRoot(post);
    if (!postRoot) {
      return { type: ARTICLE_CLASSIFICATION.UNKNOWN, reason: 'not a visible verified post article inside primaryColumn' };
    }

    const targetHandle = getTargetHandle();
    const status = getPrimaryStatus(postRoot);
    if (!status?.tweetId) {
      return { type: ARTICLE_CLASSIFICATION.UNKNOWN, reason: 'missing visible status URL' };
    }

    const repostContext = getArticleRepostContext(postRoot, targetHandle);
    const undoButton = findPostUndoRepostButton(postRoot);
    const unretweetCount = [...postRoot.querySelectorAll('button[data-testid="unretweet"]')]
      .filter((button) => isElementVisible(button) && getPostRoot(button) === postRoot).length;

    const hasStrictRepostContext = repostContext && repostContext.marker !== 'unretweet-button-only';

    if (hasStrictRepostContext && undoButton && unretweetCount === 1) {
      return {
        type: ARTICLE_CLASSIFICATION.REPOST_BY_REQUESTED_HANDLE,
        postRoot,
        status,
        undoButton,
        socialContext: repostContext,
        deleteEligible: false,
        reason: 'repost article: delete path blocked; use post-owned unretweet button only',
      };
    }

    if (repostContext) {
      return {
        type: ARTICLE_CLASSIFICATION.UNKNOWN,
        postRoot,
        status,
        socialContext: repostContext,
        deleteEligible: false,
        reason: hasStrictRepostContext
          ? `repost article: delete path blocked; post-owned unretweet button count is ${unretweetCount}`
          : `ambiguous repost evidence: ${repostContext.text}`,
      };
    }

    const deleteEligibility = getDeleteEligibility(postRoot, targetHandle);
    if (deleteEligibility.eligible) {
      return {
        type: ARTICLE_CLASSIFICATION.OWN_POST_OR_REPLY,
        postRoot,
        status: deleteEligibility.primaryStatus,
        deleteEligible: true,
        reason: deleteEligibility.reason,
      };
    }

    const primaryAuthorHandle = deleteEligibility.primaryAuthorHandle;
    const reason = deleteEligibility.reason || 'not delete eligible';
    if (primaryAuthorHandle === targetHandle.toLowerCase() || status.handle?.toLowerCase() === targetHandle.toLowerCase()) {
      return { type: ARTICLE_CLASSIFICATION.UNKNOWN, postRoot, status, deleteEligible: false, reason };
    }

    return { type: ARTICLE_CLASSIFICATION.OTHER_OR_NON_ACTIONABLE, postRoot, status, deleteEligible: false, reason };
  }

  function getVisibleUndoRepostConfirm(button) {
    const menuOrDialog = [...getVisibleMenus(), ...getVisibleDialogs()].find((container) => {
      if (!isElementVisible(container)) return false;
      const text = normalizeText(container.innerText || container.textContent || '');
      if (!/\bundo\b/i.test(text) || !/\b(repost|retweet)\b/i.test(text)) return false;
      if (isSecurityOrAccountText(text)) return false;
      if (container.getAttribute('role') === 'menu' || container.matches('[data-testid="Dropdown"]')) return isMenuAnchoredToCaret(container, button);
      return true;
    });
    if (!menuOrDialog) return null;

    const confirm = menuOrDialog.querySelector('[data-testid="unretweetConfirm"]');
    if (!isElementVisible(confirm)) return null;
    const text = normalizeText(confirm.innerText || confirm.textContent || confirm.getAttribute('aria-label') || '');
    if (!/^Undo\s+(repost|reposts|retweet|retweets)$/i.test(text) || isSecurityOrAccountText(text)) return null;
    return confirm;
  }

  async function waitFor(predicate, stepName) {
    const started = Date.now();
    while (Date.now() - started < CONFIG.waitTimeoutMs) {
      if (!state.running || shouldAbortForOutOfScopePage()) return null;
      const result = predicate();
      if (result) return result;
      await sleep(100);
    }
    skip(`${stepName} failed: timed out after ${CONFIG.waitTimeoutMs}ms`);
    return null;
  }

  function skip(reason) {
    state.skipped += 1;
    setStatus(`Skipped: ${reason}.\n${getCountsText()}`);
  }

  function skipUnknownOnce(post, reason) {
    if (state.countedUnknownPosts.has(post)) {
      setStatus(`Unknown article skipped without clicking: ${reason}.\n${getCountsText()}`);
      return;
    }
    state.countedUnknownPosts.add(post);
    skip(`unknown article: ${reason}; no click attempted`);
  }

  // CLICK CALLSITE 1 OF 5: the target post article's own More/caret button only.
  function clickPostCaret(caret) {
    if (isPasscodeChatOrSecurityContext(caret)) {
      abortRun('Aborted: refused to click post caret because passcode/chat/security text was visible nearby.');
      return false;
    }
    caret.click();
    return true;
  }

  // CLICK CALLSITE 2 OF 5: the Delete menu item opened by that caret only.
  function clickDeleteMenuItem(deleteMenuItem) {
    if (isPasscodeChatOrSecurityContext(deleteMenuItem)) {
      abortRun('Aborted: refused to click Delete because passcode/chat/security text was visible nearby.');
      return false;
    }
    deleteMenuItem.click();
    return true;
  }

  // CLICK CALLSITE 3 OF 5: the Delete button in X's delete confirmation dialog only.
  function clickConfirmDeleteButton(confirmButton) {
    if (isPasscodeChatOrSecurityContext(confirmButton)) {
      abortRun('Aborted: refused to confirm Delete because passcode/chat/security text was visible nearby.');
      return false;
    }
    confirmButton.click();
    return true;
  }

  // CLICK CALLSITE 4 OF 5: the target repost article's own Undo Repost/Retweet button only.
  function clickPostUndoRepostButton(button) {
    if (isPasscodeChatOrSecurityContext(button)) {
      abortRun('Aborted: refused to click Undo Repost/Retweet because passcode/chat/security text was visible nearby.');
      return false;
    }
    button.click();
    return true;
  }

  // CLICK CALLSITE 5 OF 5: X's own [data-testid="unretweetConfirm"] confirmation control only.
  function clickConfirmUndoRepostButton(confirmControl) {
    if (isPasscodeChatOrSecurityContext(confirmControl)) {
      abortRun('Aborted: refused to confirm Undo Repost/Retweet because passcode/chat/security text was visible nearby.');
      return false;
    }
    confirmControl.click();
    return true;
  }

  async function deletePost(classification) {
    const postRoot = classification?.postRoot;
    const targetHandle = getTargetHandle();

    // Hard invariant: a repost/social-context article can never enter the caret Delete path.
    // This must run before attempts are counted and before we find or click a caret.
    const repostContext = postRoot ? getArticleRepostContext(postRoot, targetHandle) : null;
    if (repostContext) {
      skip('repost article: delete path blocked');
      return false;
    }

    if (classification?.type !== ARTICLE_CLASSIFICATION.OWN_POST_OR_REPLY || !postRoot) {
      skip('delete refused: article was not classified as OWN_POST_OR_REPLY');
      return false;
    }

    const deleteEligibility = getDeleteEligibility(postRoot, targetHandle);
    if (!deleteEligibility.eligible) {
      skip(`delete refused: ${deleteEligibility.reason || 'article failed hard delete eligibility guards'}`);
      return false;
    }

    const ownStatus = deleteEligibility.primaryStatus;
    const caret = deleteEligibility.caret;
    if (!ownStatus?.tweetId || !caret) {
      skip('delete refused: missing primary status or post-owned caret after hard eligibility guards');
      return false;
    }

    const attempts = state.attemptedPosts.get(postRoot) || 0;
    if (attempts >= CONFIG.maxAttemptsPerPost) return false;
    state.attemptedPosts.set(postRoot, attempts + 1);

    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;

    if (getVisibleMenus().length > 0) {
      if (shouldPauseForRecentAllowedStaleUi('post caret', ownStatus.tweetId)) return false;
      if (!await dismissPreExistingMenus('post caret', ownStatus.tweetId, caret)) return false;
      if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;
    }

    const preExistingMenuSnapshots = getVisibleMenus().map(getMenuSnapshot);

    setStatus(`Step 1/3: opening post menu for ${ownStatus.tweetId}.\n${getCountsText()}`);
    postRoot.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(150);
    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;
    if (!clickPostCaret(caret)) return false;

    const deleteMenuItem = await waitFor(() => {
      if (abortIfSecurityOrUnexpectedDialog()) return null;
      return getAnchoredDeleteMenuItem(caret, preExistingMenuSnapshots);
    }, `step 2 delete menu item for ${ownStatus.tweetId}`);
    if (!deleteMenuItem || !state.running) {
      await tryDismissVisibleMenus();
      return false;
    }

    setStatus(`Step 2/3: selecting Delete for ${ownStatus.tweetId}.\n${getCountsText()}`);
    if (!clickDeleteMenuItem(deleteMenuItem)) return false;

    const dialog = await waitFor(() => {
      const confirmDialog = getVisibleDeleteConfirmDialog();
      if (!confirmDialog) {
        if (abortIfSecurityOrUnexpectedDialog()) return null;
        return null;
      }
      if (abortIfSecurityOrUnexpectedDialog(confirmDialog)) return null;
      return confirmDialog;
    }, `step 3 delete confirmation dialog for ${ownStatus.tweetId}`);
    if (!dialog || !state.running) return false;

    const confirmButton = getVisibleDeleteConfirmButton(dialog);
    if (!confirmButton) {
      skip(`step 3 confirm delete failed for ${ownStatus.tweetId}: Delete confirmation button not found`);
      return false;
    }

    setStatus(`Step 3/3: confirming Delete for ${ownStatus.tweetId}.\n${getCountsText()}`);
    if (!clickConfirmDeleteButton(confirmButton)) return false;

    await sleep(CONFIG.actionDelayMs * 2);
    state.deleted += 1;
    setStatus(`Deleted ${ownStatus.tweetId}.\n${getCountsText()}`);
    await waitForAllowedUiToSettle('delete', ownStatus.tweetId);
    return true;
  }

  async function undoRepost(classification) {
    const postRoot = classification?.postRoot;
    const repostedStatus = classification?.status;
    if (classification?.type !== ARTICLE_CLASSIFICATION.REPOST_BY_REQUESTED_HANDLE || !postRoot || !repostedStatus?.tweetId) {
      skip('undo repost refused: article was not classified as REPOST_BY_REQUESTED_HANDLE');
      return false;
    }

    const attempts = state.attemptedReposts.get(postRoot) || 0;
    if (attempts >= CONFIG.maxAttemptsPerPost) return false;
    state.attemptedReposts.set(postRoot, attempts + 1);

    if (!shouldUndoRetweets()) return false;
    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;

    const undoButton = classification.undoButton || findPostUndoRepostButton(postRoot);
    if (!undoButton) {
      skip(`undo repost failed for ${repostedStatus.tweetId}: exactly one post-owned reposted/unretweet button was not found`);
      return false;
    }

    let preOpenedConfirmControl = null;
    if (getVisibleMenus().length > 0) {
      preOpenedConfirmControl = getVisibleUndoRepostConfirm(undoButton);
      if (preOpenedConfirmControl && hasOnlySafeUndoOverlays()) {
        noteProceedingPastSafeUndoUi('undo repost confirmation', repostedStatus.tweetId);
      } else if (hasOnlySafeUndoOverlays()) {
        noteProceedingPastSafeUndoUi('undo repost', repostedStatus.tweetId);
      } else if (shouldPauseForRecentAllowedStaleUi('undo repost', repostedStatus.tweetId)) {
        return false;
      } else {
        if (!await dismissPreExistingMenus('undo repost', repostedStatus.tweetId)) return false;
        preOpenedConfirmControl = getVisibleUndoRepostConfirm(undoButton);
      }
    }

    if (!preOpenedConfirmControl) {
      setStatus(`Undo repost/retweet: opening confirmation for ${repostedStatus.tweetId}.\n${getCountsText()}`);
      postRoot.scrollIntoView({ block: 'center', inline: 'nearest' });
      await sleep(150);
      if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;
      if (!clickPostUndoRepostButton(undoButton)) return false;
    }

    const confirmControl = preOpenedConfirmControl || await waitFor(() => {
      const control = getVisibleUndoRepostConfirm(undoButton);
      if (control) {
        const allowedDialog = control.closest('[role="dialog"], [aria-modal="true"]');
        if (allowedDialog && abortIfSecurityOrUnexpectedDialog(allowedDialog)) return null;
        return control;
      }
      if (abortIfSecurityOrUnexpectedDialog()) return null;
      return null;
    }, `undo repost confirmation for ${repostedStatus.tweetId}`);
    if (!confirmControl || !state.running) return false;

    setStatus(`Undo repost/retweet: confirming for ${repostedStatus.tweetId}.\n${getCountsText()}`);
    if (!clickConfirmUndoRepostButton(confirmControl)) return false;

    await sleep(CONFIG.actionDelayMs * 2);
    state.repostsUndone += 1;
    setStatus(`Undid repost/retweet ${repostedStatus.tweetId}.\n${getCountsText()}`);
    await waitForAllowedUiToSettle('undo repost/retweet', repostedStatus.tweetId);
    return true;
  }

  function getScrollTop() {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  function scrollTimelineForward() {
    if (isPasscodeChatOrSecurityContext(document.body)) {
      abortRun('Aborted: passcode/chat/security text visible before scroll. Run flag removed.');
      return;
    }

    const nextTop = Math.min(
      getScrollTop() + CONFIG.scrollStep,
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    );

    window.scrollTo(0, nextTop);
    document.documentElement.scrollTop = nextTop;
  }

  function isAtPageBottom() {
    return getScrollTop() + window.innerHeight >= document.documentElement.scrollHeight - 8;
  }

  async function processVisiblePosts() {
    if (shouldAbortForOutOfScopePage()) return 0;
    if (abortIfSecurityOrUnexpectedDialog()) return 0;

    let changedThisCycle = 0;
    const posts = getVisiblePostRoots();

    for (const post of posts) {
      if (!document.documentElement.contains(post)) continue;
      const classification = classifyArticle(post);

      if (classification.type === ARTICLE_CLASSIFICATION.OWN_POST_OR_REPLY) {
        if (await deletePost(classification)) changedThisCycle += 1;
      } else if (classification.type === ARTICLE_CLASSIFICATION.REPOST_BY_REQUESTED_HANDLE) {
        if (shouldUndoRetweets()) {
          if (await undoRepost(classification)) changedThisCycle += 1;
        }
      } else if (classification.type === ARTICLE_CLASSIFICATION.UNKNOWN) {
        skipUnknownOnce(post, classification.reason || 'classification was uncertain');
      }
      if (!state.running) break;
    }

    return changedThisCycle;
  }

  async function run() {
    if (state.running || !hasRunParam()) return;
    state.running = true;

    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return;

    setStatus(`Mode: ${getRunMode()}\nRunning UI-only cleanup. Allowed runtime clicks are exactly: post caret → Delete menu item → Delete confirmation${shouldUndoRetweets() ? ' OR post repost/retweet button → Undo repost/retweet confirmation' : ''}. No other clicks, keys, API deletes, or recovery UI actions.\n${getCountsText()}`);

    while (state.running) {
      const beforeY = getScrollTop();
      const beforeHeight = document.documentElement.scrollHeight;
      const deletedThisCycle = await processVisiblePosts();

      if (!state.running) break;

      if (deletedThisCycle === 0) {
        state.idleCycles += 1;
      } else {
        state.idleCycles = 0;
      }

      if (isAtPageBottom() && state.idleCycles >= CONFIG.maxIdleCycles) {
        setStatus(`Done.\n${getCountsText()}`);
        state.running = false;
        break;
      }

      scrollTimelineForward();
      await sleep(CONFIG.cycleDelayMs);

      if (getScrollTop() === beforeY && document.documentElement.scrollHeight === beforeHeight) {
        state.idleCycles += 1;
      }
    }
  }

  if (window.__TWEET_REMOVER_TEST_HOOK__) {
    window.__TweetRemoverTest = Object.freeze({
      isPasscodeChatOrSecurityContext,
      normalizeText,
      hasRunParam,
      hasTweetRemoverParams,
      shouldActivateFromUrl,
      dismissPreExistingMenus,
      getVisibleMenus,
      getVisibleDeleteConfirmButton,
      state,
    });
  }

  if (!shouldActivateFromUrl()) return;

  window.__TweetRemoverDebug = Object.freeze({
    classifyVisibleArticles() {
      return getVisiblePostRoots().map((post, index) => {
        const classification = classifyArticle(post);
        const status = classification.status || getPrimaryStatus(post);
        return {
          index,
          type: classification.type,
          deleteEligible: classification.deleteEligible === true,
          primaryAuthorHandle: getPrimaryVisibleAuthorHandle(post),
          primaryStatusHandle: status?.handle || null,
          tweetId: status?.tweetId || null,
          repostContext: classification.socialContext?.text || null,
          reason: classification.reason || null,
        };
      });
    },
  });

  installRouteWatchdog();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
