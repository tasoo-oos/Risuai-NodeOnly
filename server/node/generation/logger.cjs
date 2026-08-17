'use strict';

/**
 * Structured logger for generation subsystem.
 * Provides consistent log formatting with timestamps, job context, and severity levels.
 */

const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

let currentLevel = LOG_LEVELS.info;

function setLogLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
        currentLevel = LOG_LEVELS[level];
    }
}

function formatTimestamp() {
    return new Date().toISOString();
}

function formatMessage(level, component, message, meta) {
    const parts = [`[${formatTimestamp()}]`, `[Generation]`, `[${level.toUpperCase()}]`];
    if (component) {
        parts.push(`[${component}]`);
    }
    parts.push(message);
    if (meta && Object.keys(meta).length > 0) {
        // Redact sensitive fields
        const safe = { ...meta };
        for (const key of ['apiKey', 'key', 'secret', 'token', 'authorization', 'password']) {
            if (safe[key]) {
                safe[key] = '***REDACTED***';
            }
        }
        parts.push(JSON.stringify(safe));
    }
    return parts.join(' ');
}

function log(level, component, message, meta) {
    if (LOG_LEVELS[level] === undefined || LOG_LEVELS[level] < currentLevel) {
        return;
    }
    const formatted = formatMessage(level, component, message, meta);
    switch (level) {
        case 'error':
            console.error(formatted);
            break;
        case 'warn':
            console.warn(formatted);
            break;
        default:
            console.log(formatted);
            break;
    }
}

function createLogger(component) {
    return {
        debug: (message, meta) => log('debug', component, message, meta),
        info: (message, meta) => log('info', component, message, meta),
        warn: (message, meta) => log('warn', component, message, meta),
        error: (message, meta) => log('error', component, message, meta),
    };
}

// Pre-built loggers for common subsystems
const jobLogger = createLogger('Jobs');
const providerLogger = createLogger('Provider');
const promptLogger = createLogger('Prompt');
const eventLogger = createLogger('Events');
const dbWriterLogger = createLogger('DBWriter');

module.exports = {
    setLogLevel,
    createLogger,
    jobLogger,
    providerLogger,
    promptLogger,
    eventLogger,
    dbWriterLogger,
};
