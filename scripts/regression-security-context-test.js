#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class HTMLElement {}

function makeElement({ text = '', attrs = {}, closestMap = {}, isBody = false, isDocumentElement = false, visible = true, children = [], rect = null, style = {} } = {}) {
  const element = new HTMLElement();
  element.innerText = text;
  element.textContent = text;
  element.style = style;
  element.getBoundingClientRect = () => visible
    ? (rect || { width: 1, height: 1, top: 0, bottom: 1, left: 0, right: 1 })
    : ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 });
  element.getAttribute = (name) => attrs[name] || null;
  element.setAttribute = (name, value) => { attrs[name] = String(value); };
  element.matches = (selector) => Boolean(closestMap[selector]);
  element.querySelectorAll = (selector) => {
    if (selector === '[role="menuitem"]') return children.filter((child) => child.getAttribute?.('role') === 'menuitem');
    if (selector === 'button, [role="button"]') return children.filter((child) => child.getAttribute?.('role') === 'button' || child.tagName === 'BUTTON');
    if (selector === '[role="menuitem"], button, [role="button"]') {
      return children.filter((child) => child.getAttribute?.('role') === 'menuitem' || child.getAttribute?.('role') === 'button' || child.tagName === 'BUTTON');
    }
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
    getComputedStyle: (element) => ({ visibility: 'visible', display: 'block', opacity: '1', pointerEvents: 'auto', ...(element?.style || {}) }),
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
  const transparentMenu = makeElement({
    text: 'Delete Edit Pin to your profile',
    attrs: { role: 'menu' },
    children: [menuItem],
    style: { opacity: '0', display: 'flex', visibility: 'visible', pointerEvents: 'auto' },
  });
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', menus: [transparentMenu] });
  assert.strictEqual(
    window.__TweetRemoverTest.getVisibleMenus().length,
    1,
    'X menu containers with opacity:0 but visible/clickable menuitems should still count as visible menus',
  );
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
  const editItem = makeElement({ text: 'Edit post', attrs: { role: 'menuitem' }, rect: { width: 90, height: 30, top: 110, bottom: 140, left: 100, right: 190 } });
  const deleteItem = makeElement({ text: 'Delete post', attrs: { role: 'menuitem' }, rect: { width: 110, height: 30, top: 145, bottom: 175, left: 100, right: 210 } });
  const menu = makeElement({
    text: 'Edit post Delete post Pin to your profile',
    attrs: { role: 'menu' },
    children: [editItem, deleteItem],
    rect: { width: 220, height: 160, top: 95, bottom: 255, left: 90, right: 310 },
  });
  const caret = makeElement({ rect: { width: 34, height: 34, top: 80, bottom: 114, left: 260, right: 294 } });
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', menus: [menu] });
  assert.strictEqual(
    window.__TweetRemoverTest.getAnchoredDeleteMenuItem(caret),
    deleteItem,
    'Delete menu lookup should select an exact Delete post row even when it is not the first menu item',
  );
}

{
  const deleteItem = makeElement({ text: 'Delete post', attrs: { role: 'menuitem' }, rect: { width: 110, height: 30, top: 145, bottom: 175, left: 100, right: 210 } });
  const menu = makeElement({
    text: 'Edit post Delete post Pin to your profile',
    attrs: { role: 'menu' },
    children: [deleteItem],
    rect: { width: 220, height: 160, top: 95, bottom: 255, left: 90, right: 310 },
  });
  const caret = makeElement({ rect: { width: 34, height: 34, top: 80, bottom: 114, left: 260, right: 294 } });
  const preExistingSnapshot = [{ menu, text: 'Edit post Delete post Pin to your profile', left: 90, top: 95, width: 220, height: 160 }];
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', menus: [menu] });
  assert.strictEqual(
    window.__TweetRemoverTest.getAnchoredDeleteMenuItem(caret, preExistingSnapshot),
    deleteItem,
    'reused X menu DOM node should remain eligible when it is anchored to the current caret, even if it matches a pre-click snapshot',
  );
}

{
  const deleteItem = makeElement({ text: 'Delete post', attrs: { role: 'menuitem' }, rect: { width: 110, height: 30, top: 145, bottom: 175, left: 100, right: 210 } });
  const menu = makeElement({
    text: 'Edit post Delete post Pin to your profile',
    attrs: { role: 'menu' },
    children: [deleteItem],
    rect: { width: 220, height: 160, top: 700, bottom: 860, left: 90, right: 310 },
  });
  const caret = makeElement({ rect: { width: 34, height: 34, top: 80, bottom: 114, left: 260, right: 294 } });
  const preExistingSnapshot = [{ menu, text: 'Edit post Delete post Pin to your profile', left: 90, top: 700, width: 220, height: 160 }];
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', menus: [menu] });
  assert.strictEqual(
    window.__TweetRemoverTest.getAnchoredDeleteMenuItem(caret, preExistingSnapshot),
    null,
    'unchanged pre-existing Delete menus that are not anchored to the current caret must still be ignored',
  );
}

{
  const deleteAccountItem = makeElement({ text: 'Delete account', attrs: { role: 'menuitem' } });
  const menu = makeElement({ text: 'Delete account', attrs: { role: 'menu' }, children: [deleteAccountItem] });
  const caret = makeElement();
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', menus: [menu] });
  assert.strictEqual(
    window.__TweetRemoverTest.getAnchoredDeleteMenuItem(caret),
    null,
    'Delete menu lookup must not accept destructive non-post labels such as Delete account',
  );
}

{
  const deleteItem = makeElement({ text: 'Delete', attrs: { role: 'menuitem' }, rect: { width: 290, height: 44, top: 0, bottom: 44, left: 0, right: 290 } });
  const menu = makeElement({
    text: 'Delete Edit Pin to your profile View post activity Embed post View post analytics Request Community Note',
    attrs: { role: 'menu' },
    children: [deleteItem],
    rect: { width: 290, height: 484, top: 0, bottom: 484, left: 0, right: 290 },
  });
  const caret = makeElement({ rect: { width: 34, height: 34, top: 560, bottom: 594, left: 1140, right: 1174 } });
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', menus: [menu] });
  assert.strictEqual(
    window.__TweetRemoverTest.getAnchoredDeleteMenuItem(caret),
    deleteItem,
    'Delete menu lookup should allow one newly-opened X post menu when Chrome reports a bogus 0,0 composited menu rect',
  );
}

{
  const deleteItemA = makeElement({ text: 'Delete', attrs: { role: 'menuitem' } });
  const deleteItemB = makeElement({ text: 'Delete', attrs: { role: 'menuitem' } });
  const menuA = makeElement({ text: 'Delete Edit Pin to your profile', attrs: { role: 'menu' }, children: [deleteItemA], rect: { width: 290, height: 132, top: 0, bottom: 132, left: 0, right: 290 } });
  const menuB = makeElement({ text: 'Delete Edit Pin to your profile', attrs: { role: 'menu' }, children: [deleteItemB], rect: { width: 300, height: 132, top: 0, bottom: 132, left: 0, right: 300 } });
  const caret = makeElement({ rect: { width: 34, height: 34, top: 560, bottom: 594, left: 1140, right: 1174 } });
  const { window } = loadTweetRemover({ search: '?TweetRemover=true', menus: [menuA, menuB] });
  assert.strictEqual(
    window.__TweetRemoverTest.getAnchoredDeleteMenuItem(caret),
    null,
    'Delete menu lookup should refuse multiple unanchored 0,0 fallback menus because they are ambiguous',
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
