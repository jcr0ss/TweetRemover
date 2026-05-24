#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class HTMLElement {}

function makeElement({ text = '', attrs = {}, closestMap = {}, isBody = false, isDocumentElement = false } = {}) {
  const element = new HTMLElement();
  element.innerText = text;
  element.textContent = text;
  element.style = {};
  element.getBoundingClientRect = () => ({ width: 1, height: 1, top: 0, bottom: 1, left: 0, right: 1 });
  element.getAttribute = (name) => attrs[name] || null;
  element.matches = (selector) => Boolean(closestMap[selector]);
  element.querySelectorAll = () => [];
  element.closest = (selectorList) => {
    for (const selector of selectorList.split(',').map((selector) => selector.trim())) {
      if (closestMap[selector]) return closestMap[selector];
    }
    return null;
  };
  element.__isBody = isBody;
  element.__isDocumentElement = isDocumentElement;
  return element;
}

function makeDocument(bodyText) {
  const body = makeElement({ text: bodyText, isBody: true });
  const documentElement = makeElement({ text: bodyText, isDocumentElement: true });
  documentElement.appendChild = () => {};
  documentElement.contains = () => true;
  body.scrollTop = 0;
  documentElement.scrollTop = 0;
  documentElement.scrollHeight = 1000;

  return {
    body,
    documentElement,
    title: 'X',
    readyState: 'complete',
    getElementById: () => null,
    createElement: () => makeElement(),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
}

function loadTweetRemover({ pathname = '/DptOfEfficiency/with_replies', bodyText = '' } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const document = makeDocument(bodyText);
  const window = {
    __TWEET_REMOVER_TEST_HOOK__: true,
    location: { hostname: 'x.com', pathname, search: '', hash: '', href: `https://x.com${pathname}` },
    innerHeight: 1000,
    scrollY: 0,
    history: {
      state: null,
      pushState: () => {},
      replaceState: () => {},
    },
    addEventListener: () => {},
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    scrollTo: () => {},
  };
  const sandbox = {
    window,
    document,
    HTMLElement,
    MutationObserver: class { observe() {} },
    URL,
    URLSearchParams,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'content.js' });
  return { window, document };
}

const normalTweetText = [
  'Home Explore Notifications Chat Grok Profile More',
  'You reposted _NamrokNamrok_ @_NamrokNamrok_ · Jan 3',
  'Fox News pundit says the unconfirmed U.S. invasion of Venezuela is for national security against Hezbollah and Iran.',
  '19 602 5.7K 66K',
].join(' ');

{
  const { window } = loadTweetRemover({ bodyText: normalTweetText });
  const article = makeElement({ text: normalTweetText });
  const button = makeElement({
    attrs: { 'aria-label': '602 reposts. Reposted' },
    text: '',
    closestMap: { article, '[data-testid="tweet"]': article, '[data-testid="primaryColumn"]': makeElement({ text: normalTweetText }) },
  });

  assert.strictEqual(
    window.__TweetRemoverTest.isPasscodeChatOrSecurityContext(button),
    false,
    'normal tweet/article text containing "national security" must not block an in-timeline Undo Repost button',
  );
}

{
  const { window } = loadTweetRemover({ bodyText: 'Account security verification required' });
  const dialog = makeElement({ text: 'Security verification Enter password Confirmation code' });
  const button = makeElement({
    attrs: { 'aria-label': 'Continue' },
    closestMap: { '[role="dialog"]': dialog },
  });

  assert.strictEqual(
    window.__TweetRemoverTest.isPasscodeChatOrSecurityContext(button),
    true,
    'real account/security dialog text must still block clicks',
  );
}

{
  const { window, document } = loadTweetRemover({ bodyText: 'Enter passcode Recover your encryption keys Forgot passcode' });
  assert.strictEqual(
    window.__TweetRemoverTest.isPasscodeChatOrSecurityContext(document.body),
    true,
    'full-page passcode/recovery wall must still block scrolling and clicks',
  );
}

console.log('regression-security-context-test: ok');
