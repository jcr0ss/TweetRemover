(() => {
  'use strict';

  const CONFIG = {
    queryParam: 'TweetRemover',
    actionDelayMs: 650,
    cycleDelayMs: 1200,
    waitTimeoutMs: 3500,
    menuAnchorMaxDistancePx: 650,
    maxIdleCycles: 10,
    maxAttemptsPerPost: 2,
    scrollStep: Math.max(400, Math.floor(window.innerHeight * 0.75)),
  };

  const state = {
    running: false,
    deleted: 0,
    skipped: 0,
    idleCycles: 0,
    attemptedPosts: new WeakMap(),
    stopReason: '',
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function hasRunParam() {
    return new URLSearchParams(window.location.search).get(CONFIG.queryParam) === 'true';
  }

  function stripRunParam() {
    if (!hasRunParam()) return;

    const url = new URL(window.location.href);
    url.searchParams.delete(CONFIG.queryParam);
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
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function isSecurityOrAccountText(text) {
    return /passcode|verification|verify your identity|authenticate|security|two[-\s]?factor|\b2fa\b|account access|suspicious activity|confirm your identity|checkpoint|unlock your account|log in|login|password|email code|phone number|confirmation code/i.test(text || '');
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
    setStatus(`${reason}\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
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

  function getTargetHandle() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    return (parts[0] || '').replace(/^@+/, '').toLowerCase();
  }

  function getOwnPostStatus(post) {
    const targetHandle = getTargetHandle();
    const links = [...post.querySelectorAll('a[href*="/status/"]')];

    for (const link of links) {
      try {
        const url = new URL(link.href, window.location.origin);
        const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
        if (!match) continue;
        const [, handle, tweetId] = match;
        if (handle.toLowerCase() === targetHandle) return { handle, tweetId, url };
      } catch (_) {
        // Ignore malformed links.
      }
    }

    return null;
  }

  function getPostRoot(element) {
    const candidate = element?.closest('[data-testid="tweet"], article[role="article"], article');
    if (!candidate || !isInsidePrimaryColumn(candidate)) return null;
    if (!getPostStatusLink(candidate)) return null;
    return candidate;
  }

  function getVisiblePostRoots() {
    if (!isAllowedRunSurface()) return [];

    const candidates = [
      ...document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="tweet"]'),
      ...document.querySelectorAll('[data-testid="primaryColumn"] article[role="article"], [data-testid="primaryColumn"] article'),
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
    return [...document.querySelectorAll('[role="menu"], [data-testid="Dropdown"]')].filter(isElementVisible);
  }

  function getAnchoredDeleteMenuItem(caret) {
    const menus = getVisibleMenus().filter((menu) => isMenuAnchoredToCaret(menu, caret));
    if (menus.length !== 1) return null;

    const menu = menus[0];
    const menuText = normalizeText(menu.innerText || '');
    if (isSecurityOrAccountText(menuText)) return null;
    if (/chat|message|conversation|pin\s+(chat|conversation)|encrypted|keys/i.test(menuText)) return null;

    const menuItems = [...menu.querySelectorAll('[role="menuitem"]')].filter(isElementVisible);
    const firstItem = menuItems[0] || null;
    if (!firstItem) return null;

    const firstText = normalizeText(firstItem.innerText || firstItem.textContent);
    if (!/^Delete$/i.test(firstText)) return null;

    return firstItem;
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
      return /^Delete$/i.test(text) && !isSecurityOrAccountText(text);
    }) || null;
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
    setStatus(`Skipped: ${reason}.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
  }

  // CLICK CALLSITE 1 OF 3: the target post article's own More/caret button only.
  function clickPostCaret(caret) {
    caret.click();
  }

  // CLICK CALLSITE 2 OF 3: the Delete menu item opened by that caret only.
  function clickDeleteMenuItem(deleteMenuItem) {
    deleteMenuItem.click();
  }

  // CLICK CALLSITE 3 OF 3: the Delete button in X's delete confirmation dialog only.
  function clickConfirmDeleteButton(confirmButton) {
    confirmButton.click();
  }

  async function deletePost(post) {
    const attempts = state.attemptedPosts.get(post) || 0;
    if (attempts >= CONFIG.maxAttemptsPerPost) return false;
    state.attemptedPosts.set(post, attempts + 1);

    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;

    const postRoot = getPostRoot(post);
    if (!postRoot) {
      skip('step 1 caret failed: not a verified post article inside primaryColumn');
      return false;
    }

    const ownStatus = getOwnPostStatus(postRoot);
    if (!ownStatus?.tweetId) {
      skip('step 1 caret failed: post does not belong to requested profile handle');
      return false;
    }

    const caret = findPostCaret(postRoot);
    if (!caret) {
      skip(`step 1 caret failed for ${ownStatus.tweetId}: post-owned button[data-testid="caret"] not found or not visible`);
      return false;
    }

    if (getVisibleMenus().length > 0) {
      abortRun('Aborted: a menu was already open before the post caret step. Run flag removed to avoid clicking a menu not opened from the target post caret.');
      return false;
    }

    setStatus(`Step 1/3: opening post menu for ${ownStatus.tweetId}.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    postRoot.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(150);
    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;
    clickPostCaret(caret);

    const deleteMenuItem = await waitFor(() => {
      if (abortIfSecurityOrUnexpectedDialog()) return null;
      return getAnchoredDeleteMenuItem(caret);
    }, `step 2 delete menu item for ${ownStatus.tweetId}`);
    if (!deleteMenuItem || !state.running) return false;

    setStatus(`Step 2/3: selecting Delete for ${ownStatus.tweetId}.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    clickDeleteMenuItem(deleteMenuItem);

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

    setStatus(`Step 3/3: confirming Delete for ${ownStatus.tweetId}.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    clickConfirmDeleteButton(confirmButton);

    await sleep(CONFIG.actionDelayMs * 2);
    state.deleted += 1;
    setStatus(`Deleted ${ownStatus.tweetId}.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    return true;
  }

  function getScrollTop() {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  function scrollTimelineForward() {
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
    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return 0;

    let deletedThisCycle = 0;
    const posts = getVisiblePostRoots();

    for (const post of posts) {
      if (!document.documentElement.contains(post)) continue;
      if (await deletePost(post)) deletedThisCycle += 1;
      if (!state.running) break;
    }

    return deletedThisCycle;
  }

  async function run() {
    if (state.running || !hasRunParam()) return;
    state.running = true;

    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return;

    setStatus('Running UI-only deletion. Allowed runtime clicks are exactly: post caret → Delete menu item → Delete confirmation. No other clicks, keys, API deletes, or recovery UI actions.');

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
        setStatus(`Done.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
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

  installRouteWatchdog();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
