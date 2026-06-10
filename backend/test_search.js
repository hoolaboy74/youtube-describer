const YouTube = require('youtube-sr').default;

async function test() {
    const query = "메타 선글라스";
    try {
        console.log(`Searching for: ${query}`);
        const results = await YouTube.search(query, { limit: 50, type: 'video' });
        console.log(`Successfully found ${results.length} results`);
    } catch (e) {
        console.error("Error occurred during search:");
        console.error(e);
    }
}

test();
