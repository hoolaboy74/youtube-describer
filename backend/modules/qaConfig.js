'use strict';
// Incremental Q&A includes full-cache preparation unless explicitly disabled.
// Legacy deployments remain opt-in, and warming can be enabled independently.
function cacheWarmingEnabled(env = process.env) {
    return env.QA_CACHE_WARMING_ENABLED === undefined
        ? env.QA_INCREMENTAL_SPEECH_ENABLED === 'true'
        : env.QA_CACHE_WARMING_ENABLED === 'true';
}
module.exports = { cacheWarmingEnabled };
