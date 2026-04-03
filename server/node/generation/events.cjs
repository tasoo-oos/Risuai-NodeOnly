'use strict';

/**
 * Normalized server event model for generation jobs.
 *
 * All events streamed to clients follow this format.
 * Provider-specific chunks are never exposed directly.
 */

const EVENT_TYPES = {
    JOB_CREATED:         'job_created',
    STATUS:              'status',
    MESSAGE_PLACEHOLDER: 'message_placeholder',
    DELTA:               'delta',
    TOOL_CALL_STARTED:   'tool_call_started',
    TOOL_CALL_FINISHED:  'tool_call_finished',
    PROVIDER_RETRY:      'provider_retry',
    PROVIDER_WARNING:    'provider_warning',
    COMPLETED:           'completed',
    FAILED:              'failed',
    CANCELED:            'canceled',
    PING:                'ping',
};

/**
 * Create a normalized event object.
 */
function createEvent(type, jobId, data = {}) {
    return {
        type,
        jobId,
        ts: Date.now(),
        ...data,
    };
}

/**
 * Validate that an event type is known.
 */
function isValidEventType(type) {
    return Object.values(EVENT_TYPES).includes(type);
}

/**
 * Parse a raw event string from WebSocket.
 */
function parseEvent(raw) {
    try {
        const event = JSON.parse(raw);
        if (!event || !event.type) return null;
        return event;
    } catch {
        return null;
    }
}

module.exports = {
    EVENT_TYPES,
    createEvent,
    isValidEventType,
    parseEvent,
};
