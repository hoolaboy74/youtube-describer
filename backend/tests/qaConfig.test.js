'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { cacheWarmingEnabled } = require('../modules/qaConfig');
test('incremental Q&A warms full caches by default while explicit rollback overrides remain independent', () => {
    assert.equal(cacheWarmingEnabled({}), false);
    assert.equal(cacheWarmingEnabled({ QA_INCREMENTAL_SPEECH_ENABLED: 'true' }), true);
    assert.equal(cacheWarmingEnabled({ QA_INCREMENTAL_SPEECH_ENABLED: 'true', QA_CACHE_WARMING_ENABLED: 'false' }), false);
    assert.equal(cacheWarmingEnabled({ QA_INCREMENTAL_SPEECH_ENABLED: 'false', QA_CACHE_WARMING_ENABLED: 'true' }), true);
});
