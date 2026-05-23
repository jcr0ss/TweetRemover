document.addEventListener('DOMContentLoaded', function() {
  var twitterHandleInput = document.getElementById('twitterHandle');
  var removeTweetsButton = document.getElementById('removeTweetsButton');
  var removeTweetsWithRepliesButton = document.getElementById('removeTweetsWithRepliesButton');

  chrome.storage.local.get(['lastTwitterHandle'], function(result) {
    if (result.lastTwitterHandle) {
      twitterHandleInput.value = result.lastTwitterHandle;
      twitterHandleInput.select();
    }
  });

  function getHandle() {
    return twitterHandleInput.value.trim().replace(/^@+/, '');
  }

  function rememberHandle(twitterHandle) {
    chrome.storage.local.set({ lastTwitterHandle: twitterHandle });
  }

  function openTweetRemover(includeReplies) {
    var twitterHandle = getHandle();
    if (twitterHandle) {
      rememberHandle(twitterHandle);
      var redirectUrl = 'https://x.com/' + encodeURIComponent(twitterHandle) + (includeReplies ? '/with_replies' : '') + '?TweetRemover=true';
      chrome.tabs.update({url: redirectUrl});
      window.close();
    }
  }

  twitterHandleInput.addEventListener('input', function() {
    var twitterHandle = getHandle();
    if (twitterHandle) rememberHandle(twitterHandle);
  });

  twitterHandleInput.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') openTweetRemover(false);
  });

  removeTweetsButton.addEventListener('click', function() {
    openTweetRemover(false);
  });

  removeTweetsWithRepliesButton.addEventListener('click', function() {
    openTweetRemover(true);
  });
});
