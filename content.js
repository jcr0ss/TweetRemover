console.log('Content script executing');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function unclick() {
    const targetDiv = document.querySelector('div.css-175oi2r.r-1p0dtai.r-1d2f490.r-1xcajam.r-zchlnj.r-ipm5af');
    if (targetDiv) {
        targetDiv.click();
    } else {
        console.log('Target div not found');
    }
}

async function clickButtonAndDelete(path) {
    const button = path.closest('button');
    if (button) {
        button.click();
        await sleep(200);
        const spans = document.querySelectorAll('span');
        for (const deleteSpan of spans) {
            if (deleteSpan && deleteSpan.textContent.trim() === 'Delete') {
                deleteSpan.click();
                await sleep(200);
                const confirmButton = document.querySelector('button[data-testid="confirmationSheetConfirm"]');
                if (confirmButton) {
                    confirmButton.click();
                    await sleep(200);
                    console.log('Tweet deleted');
                }
            }
        }
        unclick();
    }
}

async function processPaths() {
    const paths = document.querySelectorAll('path[d*="M3"]');
    const currentPathCount = paths.length;

    for (const path of paths) {
        await clickButtonAndDelete(path);
    }
    let scrollPosition = window.pageYOffset || document.documentElement.scrollTop;
    let windowHeight = window.innerHeight;
    let documentHeight = document.documentElement.scrollHeight;

    if (scrollPosition + windowHeight >= documentHeight) {
        alert('Done Removing Tweets!');
    } else {
        previousPathCount = currentPathCount;
        setTimeout(processPaths, 1000);
    }
}

function startScrolling() {
    let lastScrollHeight = document.body.scrollHeight;
    const scrollInterval = setInterval(async () => {
        window.scrollBy(0, 1);
        if (document.body.scrollHeight > lastScrollHeight) {
            lastScrollHeight = document.body.scrollHeight;
        } else {
           // clearInterval(scrollInterval);
        }
    }, 1); // Adjust the interval for scrolling here
}

let previousPathCount = 0;
startScrolling();
// Start the process when the page loads
window.addEventListener('load', function () {
    setTimeout(() => {
        processPaths();
    }, 5000);
});