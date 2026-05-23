# TweetRemover

Chrome extension for deleting your tweets.

## v1.0.6 safety scope

TweetRemover runs on the requested X profile or `/with_replies` page and uses a strict UI-only flow:

1. click the post article's own `button[data-testid="caret"]` More button,
2. click the `Delete` item in that menu,
3. click the `Delete` button in the confirmation dialog,
4. scroll the timeline and repeat until bottom/no more posts.

It only processes visible post/tweet articles inside `primaryColumn` whose status links belong to the requested handle. It does not call X delete APIs, click sidebar/settings/chat/account/security UI, close passcode dialogs, or attempt recovery clicks. If an out-of-scope page or unexpected/security dialog appears, it removes the run flag and stops.

## Chrome Web Store package

Download the upload-ready ZIP from GitHub:

https://github.com/jcr0ss/TweetRemover/raw/main/dist/TweetRemover-v1.0.6-chrome-web-store.zip

To rebuild it locally:

```bash
./scripts/package-extension.sh
```

Current Chrome Web Store listing:

https://chromewebstore.google.com/detail/tweetremover/faekdflheemcikjbcobkchjapoihapbl?authuser=0&hl=en
