
async function checkUrl(url, headers = {}) {
    console.log(`\nTesting ${url} with headers:`, JSON.stringify(headers));
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: headers,
            redirect: 'manual' // We want to see the redirect
        });

        console.log(`Status: ${response.status}`);
        console.log(`Location: ${response.headers.get('location')}`);
        console.log(`Content-Type: ${response.headers.get('content-type')}`);

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectUrl = new URL(response.headers.get('location'), url).toString();
            console.log(`-> Redirecting to: ${redirectUrl}`);
            await checkUrl(redirectUrl, headers);
        }
    } catch (error) {
        console.error("Fetch error:", error.message);
    }
}

async function run() {
    // Check with no referer
    await checkUrl('https://t.alcy.cc/acg', { 'User-Agent': 'Mozilla/5.0' });

    // Check with Referer: localhost
    console.log("\n------------------------------------------------");
    await checkUrl('https://t.alcy.cc/acg', {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'http://localhost:3000/'
    });
}

run();
