(() => {
  'use strict';

  const CONFIG = {
    queryParam: 'TweetRemover',
    actionDelayMs: 450,
    cycleDelayMs: 1200,
    maxIdleCycles: 10,
    scrollStep: Math.max(400, Math.floor(window.innerHeight * 0.75)),
  };

  const state = {
    running: false,
    deleted: 0,
    skipped: 0,
    idleCycles: 0,
    seenPosts: new WeakSet(),
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
      'max-width:320px',
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

  function isSecurityOrAccountText(text) {
    return /passcode|verification|verify your identity|authenticate|security|two-factor|2fa|account access|suspicious activity|confirm your identity/i.test(text || '');
  }

  function getBlockingSecurityDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
    return dialogs.find((dialog) => isSecurityOrAccountText(dialog.innerText));
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

  function getPostRoot(element) {
    const tweet = element?.closest('[data-testid="tweet"]');
    if (tweet && isInsidePrimaryColumn(tweet)) return tweet;

    const article = element?.closest('article[role="article"], article');
    if (article && isInsidePrimaryColumn(article) && article.querySelector('[data-testid="caret"]')) return article;

    return null;
  }

  function getVisiblePostRoots() {
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
    return post.querySelector('button[data-testid="caret"][aria-haspopup="menu"], button[data-testid="caret"]');
  }

  function getMenuDeleteItem() {
    const menuItems = [...document.querySelectorAll('[role="menuitem"], [data-testid="Dropdown"] [role="button"], [role="button"]')];
    return menuItems.find((item) => /^delete$/i.test((item.innerText || item.textContent || '').trim()));
  }

  function getConfirmationButton() {
    return document.querySelector('button[data-testid="confirmationSheetConfirm"]');
  }

  function getDeleteConfirmationDialog() {
    const confirmButton = getConfirmationButton();
    if (!confirmButton) return null;

    const dialog = confirmButton.closest('[role="dialog"], [aria-modal="true"]') || document.body;
    const text = dialog.innerText || '';
    return /delete/i.test(text) && !isSecurityOrAccountText(text) ? dialog : null;
  }

  async function dismissSecurityPromptIfPresent() {
    const securityDialog = getBlockingSecurityDialog();
    if (!securityDialog) return false;

    closeOutOfScopeDialog(securityDialog);
    state.skipped += 1;
    setStatus(`Skipped an out-of-scope account/security prompt.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    await sleep(CONFIG.actionDelayMs);
    return true;
  }

  async function dismissOpenMenuOrDialog() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(100);
  }

  async function deletePost(post) {
    if (state.seenPosts.has(post)) return false;
    state.seenPosts.add(post);

    const menuButton = getPostMenuButton(post);
    if (!menuButton) {
      state.skipped += 1;
      return false;
    }

    menuButton.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(CONFIG.actionDelayMs);

    if (!getPostRoot(menuButton)) {
      state.skipped += 1;
      return false;
    }

    menuButton.click();
    await sleep(CONFIG.actionDelayMs);

    if (await dismissSecurityPromptIfPresent()) return false;

    const deleteItem = getMenuDeleteItem();
    if (!deleteItem) {
      state.skipped += 1;
      await dismissOpenMenuOrDialog();
      return false;
    }

    deleteItem.click();
    await sleep(CONFIG.actionDelayMs);

    if (await dismissSecurityPromptIfPresent()) return false;

    const dialog = getDeleteConfirmationDialog();
    const confirmButton = getConfirmationButton();
    if (!dialog || !confirmButton) {
      state.skipped += 1;
      await dismissOpenMenuOrDialog();
      return false;
    }

    confirmButton.click();
    state.deleted += 1;
    setStatus(`Deleted a post.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
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
    }

    return deletedThisCycle;
  }

  async function run() {
    if (state.running || !shouldRun()) return;
    state.running = true;

    setStatus('Running. Only recognized posts in the main timeline will be touched. Account, passcode, security, DM, profile, follow, like, and media-management UI is ignored.');

    while (state.running) {
      const beforeY = getScrollTop();
      const beforeHeight = document.documentElement.scrollHeight;
      const deletedThisCycle = await processVisiblePosts();

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
