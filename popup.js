document.addEventListener('DOMContentLoaded', function() {
  var twitterHandleInput = document.getElementById('twitterHandle');
  var deleteTweetsButton = document.getElementById('deleteTweetsButton');
  var deleteTweetsWithRepliesButton = document.getElementById('deleteTweetsWithRepliesButton');
  var deleteTweetsRepliesRepostsButton = document.getElementById('deleteTweetsRepliesRepostsButton');

  chrome.storage.local.get(['lastTwitterHandle'], function(result) {
    if (result.lastTwitterHandle) {
      twitterHandleInput.value = result.lastTwitterHandle;
      twitterHandleInput.select();
      updateButtons();
    }
  });

  function getHandle() {
    return twitterHandleInput.value.trim().replace(/^@+/, '');
  }

  function rememberHandle(twitterHandle) {
    chrome.storage.local.set({ lastTwitterHandle: twitterHandle });
  }

  function updateButtons() {
    var enabled = Boolean(getHandle());
    deleteTweetsButton.disabled = !enabled;
    deleteTweetsWithRepliesButton.disabled = !enabled;
    deleteTweetsRepliesRepostsButton.disabled = !enabled;
  }

  function setLaunching(button) {
    button.textContent = 'Opening X…';
    deleteTweetsButton.disabled = true;
    deleteTweetsWithRepliesButton.disabled = true;
    deleteTweetsRepliesRepostsButton.disabled = true;
  }

  function openTweetRemover(includeReplies, undoRetweets, button) {
    var twitterHandle = getHandle();
    if (twitterHandle) {
      if (button) setLaunching(button);
      rememberHandle(twitterHandle);
      var redirectUrl = 'https://x.com/' + encodeURIComponent(twitterHandle) + (includeReplies ? '/with_replies' : '') + '?TweetRemover=true' + (undoRetweets ? '&undoRetweets=true' : '');
      chrome.tabs.update({url: redirectUrl});
      window.close();
    }
  }

  twitterHandleInput.addEventListener('input', function() {
    var twitterHandle = getHandle();
    if (twitterHandle) rememberHandle(twitterHandle);
    updateButtons();
  });

  twitterHandleInput.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') openTweetRemover(false, false, deleteTweetsButton);
  });

  deleteTweetsButton.addEventListener('click', function() {
    openTweetRemover(false, false, deleteTweetsButton);
  });

  deleteTweetsWithRepliesButton.addEventListener('click', function() {
    openTweetRemover(true, false, deleteTweetsWithRepliesButton);
  });

  deleteTweetsRepliesRepostsButton.addEventListener('click', function() {
    openTweetRemover(true, true, deleteTweetsRepliesRepostsButton);
  });

  updateButtons();
});
