(() => {
  'use strict';

  const CONFIG = {
    queryParam: 'TweetRemover',
    actionDelayMs: 450,
    cycleDelayMs: 1200,
    maxIdleCycles: 10,
    scrollStep: Math.max(400, Math.floor(window.innerHeight * 0.75)),
    menuAnchorMaxDistancePx: 650,
  };

  const state = {
    running: false,
    deleted: 0,
    skipped: 0,
    idleCycles: 0,
    seenPosts: new WeakSet(),
    stopReason: '',
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function shouldRun() {
    const params = new URLSearchParams(window.location.search);
    return params.get(CONFIG.queryParam) === 'true';
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
      'max-width:360px',
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
    return /(^|\/)(i\/chat|messages|settings|account|login|flow|security|checkpoint|passcode|logout|oauth|privacy|help)(\/|$)/i.test(path);
  }

  function isAllowedRunSurface() {
    if (window.location.hostname !== 'x.com') return false;
    if (isBlockedPath()) return false;

    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0 || parts.length > 3) return false;

    const handle = parts[0] || '';
    const reservedRoots = new Set([
      'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'account', 'login',
      'flow', 'security', 'checkpoint', 'passcode', 'compose', 'search', 'hashtag', 'privacy',
    ]);

    if (!/^[_a-zA-Z0-9]{1,15}$/.test(handle) || reservedRoots.has(handle.toLowerCase())) return false;
    if (parts.length === 1) return true;
    if (parts.length === 2) return parts[1] === 'with_replies';
    return parts.length === 3 && parts[1] === 'status' && /^\d+$/.test(parts[2]);
  }

  function shouldAbortForOutOfScopePage() {
    if (isAllowedRunSurface()) return false;
    state.stopReason = `Aborted: out-of-scope page ${window.location.pathname}.`;
    setStatus(`${state.stopReason}\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    state.running = false;
    return true;
  }

  function getBlockingSecurityDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
    return dialogs.find((dialog) => isElementVisible(dialog) && isSecurityOrAccountText(dialog.innerText));
  }

  function closeOutOfScopeDialog(dialog) {
    const closeButton = dialog?.querySelector('[data-testid="app-bar-close"], [aria-label="Close"], [aria-label="Back"], [data-testid="confirmationSheetCancel"]');
    if (closeButton instanceof HTMLElement) {
      closeButton.click();
      return true;
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
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

  function getPostRoot(element) {
    const candidate = element?.closest('[data-testid="tweet"], article[role="article"], article');
    if (!candidate || !isInsidePrimaryColumn(candidate)) return null;
    if (!candidate.querySelector('button[data-testid="caret"]')) return null;
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

  function getPostMenuButton(post) {
    const buttons = [...post.querySelectorAll('button[data-testid="caret"][aria-haspopup="menu"], button[data-testid="caret"]')];
    return buttons.find((button) => getPostRoot(button) === post && isElementVisible(button)) || null;
  }

  function getOpenMenus() {
    return [...document.querySelectorAll('[role="menu"], [data-testid="Dropdown"]')]
      .filter((menu) => isElementVisible(menu) && !isSecurityOrAccountText(menu.innerText));
  }

  function distanceBetweenRects(a, b) {
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    return Math.hypot(ax - bx, ay - by);
  }

  function getMenuAnchoredToButton(menuButton, ignoredMenus = new Set()) {
    const buttonRect = menuButton.getBoundingClientRect();
    const menus = getOpenMenus().filter((menu) => !ignoredMenus.has(menu));
    return menus.find((menu) => {
      const menuRect = menu.getBoundingClientRect();
      const nearButton = distanceBetweenRects(buttonRect, menuRect) <= CONFIG.menuAnchorMaxDistancePx;
      const horizontallyPlausible = menuRect.left <= buttonRect.right + 420 && menuRect.right >= buttonRect.left - 420;
      const verticallyPlausible = menuRect.top <= buttonRect.bottom + 520 && menuRect.bottom >= buttonRect.top - 120;
      return nearButton && horizontallyPlausible && verticallyPlausible;
    }) || null;
  }

  function getMenuDeleteItemForPost(menu, menuButton) {
    if (!menu || !menuButton || menuButton.getAttribute('aria-expanded') === 'false') return null;

    const candidates = [...menu.querySelectorAll('[role="menuitem"], [role="button"]')];
    return candidates.find((item) => {
      if (!isElementVisible(item)) return false;
      const text = normalizeText(item.innerText || item.textContent);
      return /^delete$/i.test(text) && !isSecurityOrAccountText(text);
    }) || null;
  }

  function getConfirmationButton(dialog) {
    const candidates = [
      ...dialog.querySelectorAll('button[data-testid="confirmationSheetConfirm"], [role="button"]'),
    ];

    return candidates.find((button) => {
      if (!isElementVisible(button)) return false;
      const text = normalizeText(button.innerText || button.textContent || button.getAttribute('aria-label'));
      return /^delete$/i.test(text);
    }) || null;
  }

  function getPostDeleteConfirmationDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(isElementVisible);
    return dialogs.find((dialog) => {
      const text = normalizeText(dialog.innerText || '');
      if (isSecurityOrAccountText(text)) return false;
      if (/delete\s+(account|profile|message|conversation|list|bookmark|draft|all)/i.test(text)) return false;
      if (!/delete/i.test(text)) return false;
      if (!/(post|tweet|this can[’']?t be undone|this cannot be undone)/i.test(text)) return false;
      return Boolean(getConfirmationButton(dialog));
    }) || null;
  }

  async function dismissSecurityPromptIfPresent() {
    const securityDialog = getBlockingSecurityDialog();
    if (!securityDialog) return false;

    closeOutOfScopeDialog(securityDialog);
    state.skipped += 1;
    setStatus(`Skipped and closed an out-of-scope account/security prompt.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    await sleep(CONFIG.actionDelayMs);
    return true;
  }

  async function dismissOpenMenuOrDialog() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(100);
  }

  function skip(reason) {
    state.skipped += 1;
    setStatus(`Skipped: ${reason}.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
  }

  async function deletePost(post) {
    if (state.seenPosts.has(post)) return false;
    state.seenPosts.add(post);

    if (shouldAbortForOutOfScopePage()) return false;

    const postRoot = getPostRoot(post);
    if (!postRoot) {
      skip('not a verified post in the primary column');
      return false;
    }

    const menuButton = getPostMenuButton(postRoot);
    if (!menuButton) {
      skip('post menu button not found');
      return false;
    }

    menuButton.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(CONFIG.actionDelayMs);

    if (shouldAbortForOutOfScopePage()) return false;
    if (getPostRoot(menuButton) !== postRoot) {
      skip('post menu button moved out of verified post');
      return false;
    }

    const menusBeforeClick = new Set(getOpenMenus());
    menuButton.click();
    await sleep(CONFIG.actionDelayMs);

    if (shouldAbortForOutOfScopePage()) return false;
    if (await dismissSecurityPromptIfPresent()) return false;

    const menu = getMenuAnchoredToButton(menuButton, menusBeforeClick);
    const deleteItem = getMenuDeleteItemForPost(menu, menuButton);
    if (!deleteItem) {
      skip('no anchored post Delete menu item');
      await dismissOpenMenuOrDialog();
      return false;
    }

    deleteItem.click();
    await sleep(CONFIG.actionDelayMs);

    if (shouldAbortForOutOfScopePage()) return false;
    if (await dismissSecurityPromptIfPresent()) return false;

    const dialog = getPostDeleteConfirmationDialog();
    if (!dialog) {
      skip('no safe post delete confirmation dialog');
      await dismissOpenMenuOrDialog();
      return false;
    }

    const confirmButton = getConfirmationButton(dialog);
    if (!confirmButton) {
      skip('delete confirmation button not verified');
      await dismissOpenMenuOrDialog();
      return false;
    }

    confirmButton.click();
    state.deleted += 1;
    setStatus(`Deleted a verified post.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    await sleep(CONFIG.actionDelayMs * 2);
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
    if (shouldAbortForOutOfScopePage()) return 0;

    const securityDialog = getBlockingSecurityDialog();
    if (securityDialog) {
      await dismissSecurityPromptIfPresent();
      return 0;
    }

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
    if (state.running || !shouldRun()) return;
    state.running = true;

    if (shouldAbortForOutOfScopePage()) return;

    setStatus('Running. Only verified post articles in the primary timeline will be touched. Sidebar, DM, settings, profile/account, passcode, and security UI are ignored.');

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
