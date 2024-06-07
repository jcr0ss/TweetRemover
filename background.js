chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
  if (changeInfo.status === 'complete') {
    chrome.storage.sync.get('enabled', function(data) {
      if (data.enabled) {
        chrome.scripting.executeScript({
          target: {tabId: tabId},
          function: function() {
            //alert('Hi!');
          }
        }, function(result) {
          if (chrome.runtime.lastError) {
            console.log('Error: ' + chrome.runtime.lastError.message);
            // Handle the error, e.g., by ignoring it or showing a different message
          }
        });
      }
    });
  }
});

