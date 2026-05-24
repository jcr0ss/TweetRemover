#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class HTMLElement {}

function makeElement({ text = '', attrs = {}, closestMap = {}, isBody = false, isDocumentElement = false, visible = true, children = [] } = {}) {
  const element = new HTMLElement();
  element.innerText = text;
  element.textContent = text;
  element.style = {};
  element.getBoundingClientRect = () => visible
    ? ({ width: 1, height: 1, top: 0, bottom: 1, left: 0, right: 1 })
    : ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 });
  element.getAttribute = (name) => attrs[name] || null;
  element.setAttribute = (name, value) => { attrs[name] = String(value); };
  element.matches = (selector) => Boolean(closestMap[selector]);
  element.querySelectorAll = (selector) => {
    if (selector === '[role="menuitem"]') return children.filter((child) => child.getAttribute?.('role') === 'menuitem');
    if (selector === 'button, [role="button"]') return children.filter((child) => child.getAttribute?.('role') === 'button' || child.tagName === 'BUTTON');
    return [];
  };
  element.contains = (candidate) => candidate === element || children.includes(candidate);
  element.dispatchEvent = () => true;
  element.appendChild = () => {};
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

function makeDocument(bodyText, { menus = [], record = {}, menusDisappearAfterEscape = false } = {}) {
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
    activeElement: body,
    querySelectorAll: (selector) => {
      if (selector === '[role="menu"], [data-testid="Dropdown"]') {
        if (menusDisappearAfterEscape && record.windowDispatches > 0) return [];
        return menus;
      }
      return [];
    },
    addEventListener: () => {},
    dispatchEvent: () => { record.documentDispatches = (record.documentDispatches || 0) + 1; return true; },
  };
}

function loadTweetRemover({ pathname = '/DptOfEfficiency/with_replies', search = '', bodyText = '', menus = [], menusDisappearAfterEscape = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const record = { observers: 0, statusBoxes: 0, windowDispatches: 0 };
  const document = makeDocument(bodyText, { menus, record, menusDisappearAfterEscape });
  document.createElement = () => {
    record.statusBoxes += 1;
    return makeElement();
  };
  const window = {
    __TWEET_REMOVER_TEST_HOOK__: true,
    location: { hostname: 'x.com', pathname, search, hash: '', href: `https://x.com${pathname}${search}` },
    innerHeight: 1000,
    scrollY: 0,
    history: {
      state: null,
      pushState: () => {},
      replaceState: () => {},
    },
    addEventListener: () => {},
    dispatchEvent: () => { record.windowDispatches += 1; return true; },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    scrollTo: () => {},
    KeyboardEvent: class {
      constructor(type, init) { this.type = type; Object.assign(this, init); }
    },
  };
  const sandbox = {
    window,
    document,
    HTMLElement,
    MutationObserver: class { observe() { record.observers += 1; } },
    URL,
    URLSearchParams,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'content.js' });
  return { window, document, record };
}

const normalTweetText = [
  'Home Explore Notifications Chat Grok Profile More',
  'You reposted _NamrokNamrok_ @_NamrokNamrok_ · Jan 3',
  'Fox News pundit says the unconfirmed U.S. invasion of Venezuela is for national security against Hezbollah and Iran.',
  '19 602 5.7K 66K',
].join(' ');

async function main() {

{
  const { window } = loadTweetRemover({ search: '?TweetRemover=true&undoRetweets=true', bodyText: normalTweetText });
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
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', bodyText: 'Account security verification required' });
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
  const { window, document } = loadTweetRemover({ search: '?TweetRemover=true', bodyText: 'Enter passcode Recover your encryption keys Forgot passcode' });
  assert.strictEqual(
    window.__TweetRemoverTest.isPasscodeChatOrSecurityContext(document.body),
    true,
    'full-page passcode/recovery wall must still block scrolling and clicks',
  );
}

{
  const { window, record } = loadTweetRemover({ pathname: '/DptOfEfficiency', search: '', bodyText: normalTweetText });
  assert.strictEqual(window.__TweetRemoverTest.shouldActivateFromUrl(), false, 'ordinary profile URL without TweetRemover params must not activate');
  assert.strictEqual(window.__TweetRemoverDebug, undefined, 'ordinary profile URL without TweetRemover params must not install debug/run helpers');
  assert.strictEqual(record.observers, 0, 'ordinary profile URL without TweetRemover params must not install route/mutation watchdog');
  assert.strictEqual(record.statusBoxes, 0, 'ordinary profile URL without TweetRemover params must not create bottom-right status UI');
}

{
  const menu = makeElement({ text: 'Share Copy link Report post' });
  const { window, record } = loadTweetRemover({ search: '?TweetRemover=true', menus: [menu], menusDisappearAfterEscape: true });
  window.__TweetRemoverTest.state.running = true;
  const result = await window.__TweetRemoverTest.dismissPreExistingMenus('post caret', '12345');
  assert.strictEqual(result, true, 'unrelated pre-existing menu that closes on Escape should be dismissed so the caller can retry the target caret');
  assert.strictEqual(window.__TweetRemoverTest.state.running, true, 'dismissed unrelated pre-existing menu should not abort the run');
  assert.ok(record.windowDispatches > 0, 'pre-existing menu recovery should attempt Escape dismissal');
}

{
  const menu = makeElement({ text: 'Share Copy link Report post' });
  const { window, record } = loadTweetRemover({ search: '?TweetRemover=true', menus: [menu] });
  window.__TweetRemoverTest.state.running = true;
  const result = await window.__TweetRemoverTest.dismissPreExistingMenus('post caret', '12345');
  assert.strictEqual(result, true, 'unrelated pre-existing menu that remains visible should not globally block later target-caret processing');
  assert.strictEqual(window.__TweetRemoverTest.state.running, true, 'unrelated pre-existing menu should not remove run flag or abort immediately');
  assert.strictEqual(window.__TweetRemoverTest.state.skipped, 0, 'undismissable unrelated menu should not count as a per-post skip before the target caret is tried');
  assert.ok(record.windowDispatches > 0, 'pre-existing menu recovery should attempt Escape dismissal');
}

{
  const hiddenMenu = makeElement({ text: 'Share Copy link Report post', attrs: { 'aria-hidden': 'true' } });
  const { window, record } = loadTweetRemover({ search: '?TweetRemover=true', menus: [hiddenMenu] });
  window.__TweetRemoverTest.state.running = true;
  const result = await window.__TweetRemoverTest.dismissPreExistingMenus('post caret', '12345');
  assert.strictEqual(result, true, 'hidden/stale role=menu elements must not block target caret processing');
  assert.strictEqual(record.windowDispatches, 0, 'hidden/stale menus should be ignored without recovery key events');
}

{
  const menuItem = makeElement({ text: 'Delete', attrs: { role: 'menuitem' } });
  const outerDropdown = makeElement({ text: 'Delete Edit Pin to your profile', attrs: { 'data-testid': 'Dropdown' }, children: [menuItem] });
  const innerRoleMenu = makeElement({ text: 'Delete Edit Pin to your profile', attrs: { role: 'menu' }, children: [menuItem] });
  outerDropdown.contains = (candidate) => candidate === outerDropdown || candidate === innerRoleMenu || candidate === menuItem;
  innerRoleMenu.contains = (candidate) => candidate === innerRoleMenu || candidate === menuItem;
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', menus: [outerDropdown, innerRoleMenu] });
  assert.strictEqual(
    window.__TweetRemoverTest.getVisibleMenus().length,
    1,
    'nested X Dropdown/[role=menu] wrappers for the same visible menu must be counted once so target menu lookup can proceed',
  );
}

{
  const deletePostButton = makeElement({ text: 'Delete post', attrs: { role: 'button', 'data-testid': 'confirmationSheetConfirm' } });
  deletePostButton.tagName = 'BUTTON';
  const dialog = makeElement({ text: 'Delete Post? This can’t be undone and it will be removed from your profile.', attrs: { role: 'dialog' }, children: [deletePostButton] });
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', bodyText: 'Delete Post? This can’t be undone' });
  assert.strictEqual(
    window.__TweetRemoverTest.getVisibleDeleteConfirmButton(dialog),
    deletePostButton,
    'Delete confirmation should accept current X Delete post confirmation buttons, not only exact "Delete" text',
  );
}

console.log('regression-security-context-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
