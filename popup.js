document.addEventListener('DOMContentLoaded', function() {
  var twitterHandleInput = document.getElementById('twitterHandle');
  var removeTweetsButton = document.getElementById('removeTweetsButton');
  var removeTweetsWithRepliesButton = document.getElementById('removeTweetsWithRepliesButton');

  removeTweetsButton.addEventListener('click', function() {
    var twitterHandle = twitterHandleInput.value;
    if (twitterHandle) {
      var redirectUrl = 'https://x.com/' + encodeURIComponent(twitterHandle) + '?TweetRemover=true';
      chrome.tabs.update({url: redirectUrl});
      window.close();
    }
  });

  removeTweetsWithRepliesButton.addEventListener('click', function() {
    var twitterHandle = twitterHandleInput.value;
    if (twitterHandle) {
      var redirectUrl = 'https://x.com/' + encodeURIComponent(twitterHandle) + '/with_replies?TweetRemover=true';
      chrome.tabs.update({url: redirectUrl});
      window.close();
    }
  });
});