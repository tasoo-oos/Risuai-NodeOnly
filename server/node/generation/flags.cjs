'use strict';

/**
 * Feature flags for incremental server-generation rollout.
 *
 * Flags can be overridden via environment variables (prefixed with RISU_)
 * or programmatically via setFlag().
 */

const defaults = {
    serverGenerationEnabled: false,
    serverGenerationPromptBuildEnabled: false,
    serverGenerationDbWritesEnabled: false,
    serverGenerationAnthropicBatchEnabled: false,
    serverGenerationToolsEnabled: false,
};

const flags = { ...defaults };

// Read overrides from environment on load
for (const key of Object.keys(defaults)) {
    const envKey = `RISU_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal !== undefined) {
        flags[key] = envVal === 'true' || envVal === '1';
    }
}

function getFlag(name) {
    return flags[name] ?? false;
}

function setFlag(name, value) {
    if (name in defaults) {
        flags[name] = Boolean(value);
    }
}

function getAllFlags() {
    return { ...flags };
}

module.exports = {
    getFlag,
    setFlag,
    getAllFlags,
};
