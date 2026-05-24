# TweetRemover

Chrome extension for deleting your tweets.

## v1.0.14 safety scope

TweetRemover runs on the requested X profile or `/with_replies` page, classifies each visible article before acting, and uses strict UI-only flows:

Delete:

1. click the post article's own `button[data-testid="caret"]` More button,
2. click the `Delete` item in that menu,
3. click the `Delete` button in the confirmation dialog.

Undo reposts/retweets, when launched from `/with_replies` with undo reposts enabled:

1. click the repost article's own `button[data-testid="unretweet"]` / Undo Repost control,
2. click X's `Undo repost` / `Undo retweet` confirmation control.

It classifies every visible post/tweet article inside `primaryColumn` as exactly one of: own post/reply, repost by the requested handle, other/non-actionable, or unknown. Own posts/replies require both the visible author handle and status URL handle to match the requested handle. Reposts require requested-handle/`You reposted` social context and exactly one post-owned `button[data-testid="unretweet"]`; repost status URLs are allowed to belong to the original author. It does not call X delete APIs, click sidebar/settings/chat/account/security UI, close passcode dialogs, send keyboard recovery actions, or attempt arbitrary cleanup clicks. If an out-of-scope page or unexpected/security dialog appears, it removes the run flag and stops.

After a successful delete or undo repost, it waits for X's menu/dialog UI to disappear before moving to the next item. If X leaves behind a safe Undo repost menu from the previous allowed action, TweetRemover can continue the undo-repost flow for the next strictly classified repost without cleanup clicks; the delete flow still refuses to run into any pre-existing menu.

## Chrome Web Store package

Download the upload-ready ZIP from GitHub:

https://github.com/jcr0ss/TweetRemover/raw/main/dist/TweetRemover-v1.0.14-chrome-web-store.zip

To rebuild it locally:

```bash
./scripts/package-extension.sh
```

Current Chrome Web Store listing:

https://chromewebstore.google.com/detail/tweetremover/faekdflheemcikjbcobkchjapoihapbl?authuser=0&hl=en
