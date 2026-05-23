document.addEventListener('DOMContentLoaded', function() {
  var twitterHandleInput = document.getElementById('twitterHandle');
  var deleteTweetsButton = document.getElementById('deleteTweetsButton');
  var deleteTweetsWithRepliesButton = document.getElementById('deleteTweetsWithRepliesButton');
  var deleteTweetsRepliesRepostsButton = document.getElementById('deleteTweetsRepliesRepostsButton');

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

  function openTweetRemover(includeReplies, undoRetweets) {
    var twitterHandle = getHandle();
    if (twitterHandle) {
      rememberHandle(twitterHandle);
      var redirectUrl = 'https://x.com/' + encodeURIComponent(twitterHandle) + (includeReplies ? '/with_replies' : '') + '?TweetRemover=true' + (undoRetweets ? '&undoRetweets=true' : '');
      chrome.tabs.update({url: redirectUrl});
      window.close();
    }
  }

  twitterHandleInput.addEventListener('input', function() {
    var twitterHandle = getHandle();
    if (twitterHandle) rememberHandle(twitterHandle);
  });

  twitterHandleInput.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') openTweetRemover(false, false);
  });

  deleteTweetsButton.addEventListener('click', function() {
    openTweetRemover(false, false);
  });

  deleteTweetsWithRepliesButton.addEventListener('click', function() {
    openTweetRemover(true, false);
  });

  deleteTweetsRepliesRepostsButton.addEventListener('click', function() {
    openTweetRemover(true, true);
  });
});
