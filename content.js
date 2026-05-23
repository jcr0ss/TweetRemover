(() => {
  'use strict';

  const CONFIG = {
    queryParam: 'TweetRemover',
    actionDelayMs: 450,
    cycleDelayMs: 1200,
    maxIdleCycles: 10,
    scrollStep: Math.max(400, Math.floor(window.innerHeight * 0.75)),
    deleteTweetQueryId: 'nxpZCY2K-I6QoFHAHeojFQ',
    twitterBearerToken: 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
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

  function shouldRun() {
    return hasRunParam();
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
    return /(^|\/)(i\/chat|messages|settings|account|login|flow|security|checkpoint|passcode|logout|oauth|privacy|help|pin|recovery)(\/|$)/i.test(path);
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
    stripRunParam();
    state.stopReason = `Aborted: out-of-scope page ${window.location.pathname}. Run flag removed; no UI recovery attempted.`;
    setStatus(`${state.stopReason}\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    state.running = false;
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

  function getBlockingSecurityDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
    return dialogs.find((dialog) => isElementVisible(dialog) && isSecurityOrAccountText(dialog.innerText));
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

  function getCookieValue(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function deleteTweetByApi(tweetId) {
    const csrfToken = getCookieValue('ct0');
    if (!csrfToken) throw new Error('missing ct0 csrf cookie');

    const response = await fetch(`/i/api/graphql/${CONFIG.deleteTweetQueryId}/DeleteTweet`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        authorization: `Bearer ${CONFIG.twitterBearerToken}`,
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-client-language': 'en',
      },
      body: JSON.stringify({
        variables: { tweet_id: tweetId, dark_request: false },
        queryId: CONFIG.deleteTweetQueryId,
      }),
    });

    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) {}

    if (!response.ok) {
      const message = payload?.errors?.[0]?.message || text || `HTTP ${response.status}`;
      throw new Error(message);
    }

    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message || error.code || 'unknown error').join('; '));
    }

    return payload;
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

  async function dismissSecurityPromptIfPresent() {
    const securityDialog = getBlockingSecurityDialog();
    if (!securityDialog) return false;

    stripRunParam();
    state.skipped += 1;
    state.running = false;
    setStatus(`Aborted on account/security prompt. Run flag removed; no clicks, keys, or dialog closing attempted.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
    await sleep(CONFIG.actionDelayMs);
    return true;
  }

  function skip(reason) {
    state.skipped += 1;
    setStatus(`Skipped: ${reason}.\nDeleted: ${state.deleted} · Skipped: ${state.skipped}`);
  }

  async function deletePost(post) {
    const attempts = state.attemptedPosts.get(post) || 0;
    if (attempts >= 2) return false;
    state.attemptedPosts.set(post, attempts + 1);

    if (shouldAbortForOutOfScopePage()) return false;

    const postRoot = getPostRoot(post);
    if (!postRoot) {
      skip('not a verified post in the primary column');
      return false;
    }

    const ownStatus = getOwnPostStatus(postRoot);
    if (!ownStatus?.tweetId) {
      skip('post does not belong to the requested profile handle');
      return false;
    }

    if (getBlockingSecurityDialog()) {
      await dismissSecurityPromptIfPresent();
      return false;
    }

    try {
      setStatus(`Deleting verified post ${ownStatus.tweetId} via X post-delete API.
Deleted: ${state.deleted} · Skipped: ${state.skipped}`);
      await deleteTweetByApi(ownStatus.tweetId);
      state.deleted += 1;
      postRoot.remove();
      setStatus(`Deleted verified post ${ownStatus.tweetId}.
Deleted: ${state.deleted} · Skipped: ${state.skipped}`);
      await sleep(CONFIG.actionDelayMs * 2);
      return true;
    } catch (error) {
      skip(`API delete failed for ${ownStatus.tweetId}: ${error?.message || error}`);
      return false;
    }
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

    setStatus('Running in API-only mode. Only verified post articles in the primary column are scanned. If route/account/security UI appears, the run flag is removed and execution stops without clicks or keys.');

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
