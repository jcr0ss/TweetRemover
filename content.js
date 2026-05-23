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
    stopReason: '',
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function hasRunParam() {
    return new URLSearchParams(window.location.search).get(CONFIG.queryParam) === 'true';
  }

  function hasUndoRetweetsParam() {
    return new URLSearchParams(window.location.search).get(CONFIG.undoRetweetsParam) === 'true';
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

  function isPasscodeChatOrSecurityContext(element) {
    const blockedTextPattern = /passcode|recover your encryption keys|decrypt your previous messages|forgot passcode|encrypted|encryption keys|chat|message|conversation|pin\/recovery|verification|verify your identity|authenticate|security|two[-\s]?factor|\b2fa\b|checkpoint|unlock your account|log in|login|password|confirmation code/i;

    if (blockedTextPattern.test(window.location.pathname)) return true;
    if (element) {
      const isWholePage = element === document.body || element === document.documentElement;
      const context = isWholePage
        ? element
        : (element.closest('[role="dialog"], [role="menu"], [data-testid="Dropdown"], [data-testid="primaryColumn"], article, [data-testid="tweet"]') || element);
      const contextText = normalizeText(context.innerText || context.textContent || '');

      // Full-page scans only look for the actual passcode/recovery wall. The normal X
      // shell can contain labels like "Chat" in the sidebar, which must not stop scrolling.
      if (isWholePage) {
        return /enter passcode|recover your encryption keys|decrypt your previous messages|forgot passcode|pin\/recovery/i.test(contextText)
          || /pin\/recovery/i.test(window.location.pathname);
      }

      if (blockedTextPattern.test(contextText)) return true;
    }

    const visiblePageText = normalizeText(document.body?.innerText || '').slice(0, 5000);
    return /enter passcode|recover your encryption keys|decrypt your previous messages|forgot passcode/i.test(visiblePageText);
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
        if (handle.toLowerCase() === targetHandle && isVerifiedAuthorHandle(post, targetHandle)) return { handle, tweetId, url };
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

  function hasTargetProfileRepostContext(post, targetHandle) {
    const statusRect = getFirstStatusLinkRect(post);
    const postRect = post.getBoundingClientRect();
    const topLimit = statusRect ? statusRect.top + Math.max(0, statusRect.height) + 16 : postRect.top + postRect.height * 0.45;
    const topContextNodes = [...post.querySelectorAll('div, span, a')].filter((node) => {
      if (!isElementVisible(node)) return false;
      const rect = node.getBoundingClientRect();
      return rect.top >= postRect.top - 2 && rect.top <= topLimit;
    });
    const topText = normalizeText(topContextNodes.map((node) => node.innerText || node.textContent || '').join(' '));
    if (!/\b(reposted|retweeted)\b/i.test(topText)) return false;

    return [...post.querySelectorAll('a[href]')].some((link) => {
      if (!isElementVisible(link)) return false;
      const rect = link.getBoundingClientRect();
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

  function getRepostedStatus(post) {
    const targetHandle = getTargetHandle();
    const statusLink = getPostStatusLink(post);
    if (!statusLink) return null;
    if (getOwnPostStatus(post)) return null;
    if (!hasTargetProfileRepostContext(post, targetHandle)) return null;

    try {
      const url = new URL(statusLink.href, window.location.origin);
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (!match) return null;
      const [, handle, tweetId] = match;
      return { handle, tweetId, url };
    } catch (_) {
      return null;
    }
  }

  function findPostUndoRepostButton(post) {
    const buttons = [...post.querySelectorAll('button[data-testid="unretweet"], button[aria-label*="Undo repost" i], button[aria-label*="Undo Repost"], button[aria-label*="reposted" i]')].filter(isElementVisible);
    if (buttons.length !== 1) return null;
    const button = buttons[0];
    if (getPostRoot(button) !== post) return null;
    const label = normalizeText(button.getAttribute('aria-label') || button.innerText || button.textContent || '');
    if (isSecurityOrAccountText(label)) return null;
    if (button.getAttribute('data-testid') === 'unretweet') return button;
    return /undo repost|reposted|retweeted/i.test(label) ? button : null;
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

    const controls = [...menuOrDialog.querySelectorAll('[role="menuitem"], button, [role="button"]')].filter(isElementVisible);
    return controls.find((control) => {
      const text = normalizeText(control.innerText || control.textContent || control.getAttribute('aria-label') || '');
      return /^Undo\s+(repost|reposts|retweet|retweets)$/i.test(text) && !isSecurityOrAccountText(text);
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
    setStatus(`Skipped: ${reason}.\n${getCountsText()}`);
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

  // CLICK CALLSITE 5 OF 5: X's own confirmation control for Undo Repost/Retweet only.
  function clickConfirmUndoRepostButton(confirmControl) {
    if (isPasscodeChatOrSecurityContext(confirmControl)) {
      abortRun('Aborted: refused to confirm Undo Repost/Retweet because passcode/chat/security text was visible nearby.');
      return false;
    }
    confirmControl.click();
    return true;
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

    setStatus(`Step 1/3: opening post menu for ${ownStatus.tweetId}.\n${getCountsText()}`);
    postRoot.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(150);
    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;
    if (!clickPostCaret(caret)) return false;

    const deleteMenuItem = await waitFor(() => {
      if (abortIfSecurityOrUnexpectedDialog()) return null;
      return getAnchoredDeleteMenuItem(caret);
    }, `step 2 delete menu item for ${ownStatus.tweetId}`);
    if (!deleteMenuItem || !state.running) return false;

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
    return true;
  }

  async function undoRepost(post) {
    const attempts = state.attemptedReposts.get(post) || 0;
    if (attempts >= CONFIG.maxAttemptsPerPost) return false;
    state.attemptedReposts.set(post, attempts + 1);

    if (!shouldUndoRetweets()) return false;
    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;

    const postRoot = getPostRoot(post);
    if (!postRoot) {
      skip('undo repost failed: not a verified post article inside primaryColumn');
      return false;
    }

    const repostedStatus = getRepostedStatus(postRoot);
    if (!repostedStatus?.tweetId) {
      skip('undo repost skipped: article is not clearly a requested-profile repost/retweet');
      return false;
    }

    const undoButton = findPostUndoRepostButton(postRoot);
    if (!undoButton) {
      skip(`undo repost failed for ${repostedStatus.tweetId}: exactly one post-owned reposted/unretweet button was not found`);
      return false;
    }

    if (getVisibleMenus().length > 0) {
      abortRun('Aborted: a menu was already open before the undo repost step. Run flag removed to avoid clicking a menu not opened from the target post.');
      return false;
    }

    setStatus(`Undo repost/retweet: opening confirmation for ${repostedStatus.tweetId}.\n${getCountsText()}`);
    postRoot.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(150);
    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return false;
    if (!clickPostUndoRepostButton(undoButton)) return false;

    const confirmControl = await waitFor(() => {
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
    if (shouldAbortForOutOfScopePage() || abortIfSecurityOrUnexpectedDialog()) return 0;

    let changedThisCycle = 0;
    const posts = getVisiblePostRoots();

    for (const post of posts) {
      if (!document.documentElement.contains(post)) continue;
      if (shouldUndoRetweets() && !getOwnPostStatus(post)) {
        if (await undoRepost(post)) changedThisCycle += 1;
      } else if (await deletePost(post)) {
        changedThisCycle += 1;
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

  installRouteWatchdog();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
