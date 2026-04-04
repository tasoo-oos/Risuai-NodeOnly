'use strict';

const nodeCrypto = require('crypto');
const { jobLogger: log } = require('./logger.cjs');

/**
 * Generation Job Manager
 *
 * Manages the full lifecycle of generation jobs:
 * - create, run, cancel, complete, fail
 * - persist to SQLite
 * - broadcast events to WebSocket subscribers
 * - support reconnect (replay from last seen seq)
 * - stale job cleanup
 */

// Valid status transitions
const VALID_TRANSITIONS = {
    queued:          ['running', 'canceled', 'failed'],
    running:         ['awaiting_batch', 'awaiting_tool', 'completed', 'failed', 'canceled'],
    awaiting_batch:  ['running', 'completed', 'failed', 'canceled'],
    awaiting_tool:   ['running', 'completed', 'failed', 'canceled'],
    // terminal states — no transitions out
    completed:       [],
    failed:          [],
    canceled:        [],
    stale:           [],
};

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'stale']);

// In-memory job state (superset of DB row for live jobs)
// Map<jobId, LiveJob>
const liveJobs = new Map();
const jobHooks = new Map();

// Prepared statements (initialized in init())
let stmts = null;
let db = null;

// ─── Initialization ──────────────────────────────────────────────────────────

function init(sqliteDb) {
    db = sqliteDb;

    const { initGenerationTables } = require('./schema.cjs');
    initGenerationTables(db);

    stmts = {
        insertJob: db.prepare(`
            INSERT INTO generation_jobs
                (id, chat_id, character_id, message_id, status, provider, model,
                 request_payload, request_hash, owner_session_id, created_at, updated_at)
            VALUES
                (@id, @chatId, @characterId, @messageId, @status, @provider, @model,
                 @requestPayload, @requestHash, @ownerSessionId, @createdAt, @updatedAt)
        `),

        updateJobStatus: db.prepare(`
            UPDATE generation_jobs
            SET status = @status, updated_at = @updatedAt
            WHERE id = @id
        `),

        completeJob: db.prepare(`
            UPDATE generation_jobs
            SET status = @status, result_text = @resultText, updated_at = @updatedAt, completed_at = @completedAt
            WHERE id = @id
        `),

        failJob: db.prepare(`
            UPDATE generation_jobs
            SET status = 'failed', error_json = @errorJson, updated_at = @updatedAt, completed_at = @completedAt
            WHERE id = @id
        `),

        updateJobBatch: db.prepare(`
            UPDATE generation_jobs
            SET batch_id = @batchId, status = @status, updated_at = @updatedAt
            WHERE id = @id
        `),

        updateJobResult: db.prepare(`
            UPDATE generation_jobs
            SET result_text = @resultText, updated_at = @updatedAt
            WHERE id = @id
        `),

        updateJobMessageId: db.prepare(`
            UPDATE generation_jobs
            SET message_id = @messageId, updated_at = @updatedAt
            WHERE id = @id
        `),

        getJob: db.prepare(`
            SELECT * FROM generation_jobs WHERE id = ?
        `),

        getActiveJobForChat: db.prepare(`
            SELECT * FROM generation_jobs
            WHERE chat_id = ? AND status NOT IN ('completed', 'failed', 'canceled', 'stale')
            ORDER BY created_at DESC LIMIT 1
        `),

        getActiveJobs: db.prepare(`
            SELECT * FROM generation_jobs
            WHERE status NOT IN ('completed', 'failed', 'canceled', 'stale')
            ORDER BY created_at DESC
        `),

        insertEvent: db.prepare(`
            INSERT INTO generation_job_events (job_id, seq, type, payload, created_at)
            VALUES (@jobId, @seq, @type, @payload, @createdAt)
        `),

        getEventsSince: db.prepare(`
            SELECT * FROM generation_job_events
            WHERE job_id = ? AND seq > ?
            ORDER BY seq ASC
        `),

        getAllEvents: db.prepare(`
            SELECT * FROM generation_job_events
            WHERE job_id = ?
            ORDER BY seq ASC
        `),

        acquireLock: db.prepare(`
            INSERT OR REPLACE INTO generation_locks (chat_id, job_id, acquired_at)
            VALUES (@chatId, @jobId, @acquiredAt)
        `),

        releaseLock: db.prepare(`
            DELETE FROM generation_locks WHERE chat_id = ? AND job_id = ?
        `),

        getLock: db.prepare(`
            SELECT * FROM generation_locks WHERE chat_id = ?
        `),

        cleanupOldJobs: db.prepare(`
            DELETE FROM generation_jobs
            WHERE status IN ('completed', 'failed', 'canceled', 'stale')
              AND completed_at < ?
        `),

        cleanupOrphanEvents: db.prepare(`
            DELETE FROM generation_job_events
            WHERE job_id NOT IN (SELECT id FROM generation_jobs)
        `),

        cleanupOrphanLocks: db.prepare(`
            DELETE FROM generation_locks
            WHERE job_id NOT IN (SELECT id FROM generation_jobs)
        `),

        markStaleJobs: db.prepare(`
            UPDATE generation_jobs
            SET status = 'stale', updated_at = @now
            WHERE status NOT IN ('completed', 'failed', 'canceled', 'stale')
              AND updated_at < @cutoff
        `),
    };

    // On startup, mark any non-terminal jobs from a previous run as stale
    const now = Date.now();
    stmts.markStaleJobs.run({ now, cutoff: now });
    log.info('Generation job manager initialized');
}

// ─── Job Creation ────────────────────────────────────────────────────────────

function createJob(params) {
    const {
        chatId,
        characterId,
        messageId = null,
        provider = null,
        model = null,
        requestPayload = null,
        requestHash = null,
        ownerSessionId = null,
    } = params;

    // Check for existing active generation on this chat
    const existingLock = stmts.getLock.get(chatId);
    if (existingLock) {
        const existingJob = liveJobs.get(existingLock.job_id);
        if (existingJob && !TERMINAL_STATUSES.has(existingJob.status)) {
            throw new JobConflictError(
                `Chat ${chatId} already has an active generation job: ${existingLock.job_id}`,
                existingLock.job_id
            );
        }
        // Stale lock — release it
        stmts.releaseLock.run(chatId, existingLock.job_id);
    }

    const id = `gen_${nodeCrypto.randomUUID()}`;
    const now = Date.now();

    const row = {
        id,
        chatId,
        characterId,
        messageId,
        status: 'queued',
        provider,
        model,
        requestPayload: requestPayload ? JSON.stringify(requestPayload) : null,
        requestHash,
        ownerSessionId,
        createdAt: now,
        updatedAt: now,
    };

    stmts.insertJob.run(row);
    stmts.acquireLock.run({ chatId, jobId: id, acquiredAt: now });

    const liveJob = {
        id,
        chatId,
        characterId,
        messageId,
        status: 'queued',
        provider,
        model,
        resultText: null,
        errorJson: null,
        batchId: null,
        ownerSessionId,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        // Live-only state
        eventSeq: 0,
        subscribers: new Set(),
        abortController: new AbortController(),
    };

    liveJobs.set(id, liveJob);

    const event = emitEvent(liveJob, 'job_created', {
        jobId: id,
        chatId,
        characterId,
        messageId,
        status: 'queued',
    });

    log.info('Job created', { jobId: id, chatId, characterId, model });
    return liveJob;
}

// ─── Status Transitions ──────────────────────────────────────────────────────

function transitionStatus(jobId, newStatus) {
    const job = liveJobs.get(jobId);
    if (!job) {
        throw new Error(`Job ${jobId} not found in live jobs`);
    }

    const allowed = VALID_TRANSITIONS[job.status];
    if (!allowed || !allowed.includes(newStatus)) {
        throw new Error(
            `Invalid status transition: ${job.status} -> ${newStatus} for job ${jobId}`
        );
    }

    const previousStatus = job.status;
    const now = Date.now();
    job.status = newStatus;
    job.updatedAt = now;

    if (TERMINAL_STATUSES.has(newStatus)) {
        job.completedAt = now;
    }

    stmts.updateJobStatus.run({ id: jobId, status: newStatus, updatedAt: now });

    emitEvent(job, 'status', { jobId, status: newStatus });

    if (TERMINAL_STATUSES.has(newStatus)) {
        stmts.releaseLock.run(job.chatId, jobId);
    }

    log.info('Job status changed', { jobId, from: previousStatus, to: newStatus });
    return job;
}

// ─── Job Completion ──────────────────────────────────────────────────────────

function completeJob(jobId, resultText) {
    const job = liveJobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const now = Date.now();
    job.status = 'completed';
    job.resultText = resultText;
    job.updatedAt = now;
    job.completedAt = now;

    stmts.completeJob.run({
        id: jobId,
        status: 'completed',
        resultText,
        updatedAt: now,
        completedAt: now,
    });

    stmts.releaseLock.run(job.chatId, jobId);

    emitEvent(job, 'completed', {
        jobId,
        messageId: job.messageId,
        resultText,
    });

    const hooks = jobHooks.get(jobId);
    if (hooks?.onComplete) {
        hooks.onComplete(resultText);
    }

    log.info('Job completed', { jobId, chatId: job.chatId });
    jobHooks.delete(jobId);
    scheduleCleanupLiveJob(jobId);
    return job;
}

function failJob(jobId, error) {
    const job = liveJobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const now = Date.now();
    const errorJson = JSON.stringify({
        message: error?.message || String(error),
        code: error?.code,
    });

    job.status = 'failed';
    job.errorJson = errorJson;
    job.updatedAt = now;
    job.completedAt = now;

    stmts.failJob.run({
        id: jobId,
        errorJson,
        updatedAt: now,
        completedAt: now,
    });

    stmts.releaseLock.run(job.chatId, jobId);

    emitEvent(job, 'failed', {
        jobId,
        error: error?.message || String(error),
    });

    const hooks = jobHooks.get(jobId);
    if (hooks?.onFail) {
        hooks.onFail(error);
    }

    log.error('Job failed', { jobId, chatId: job.chatId, error: error?.message });
    jobHooks.delete(jobId);
    scheduleCleanupLiveJob(jobId);
    return job;
}

function cancelJob(jobId) {
    const job = liveJobs.get(jobId);
    if (!job) {
        // Check DB for completed job
        const row = stmts.getJob.get(jobId);
        if (!row) throw new Error(`Job ${jobId} not found`);
        if (TERMINAL_STATUSES.has(row.status)) return row; // already done
        throw new Error(`Job ${jobId} not in live jobs but not terminal`);
    }

    if (TERMINAL_STATUSES.has(job.status)) {
        return job; // already terminal, idempotent
    }

    const now = Date.now();
    job.status = 'canceled';
    job.updatedAt = now;
    job.completedAt = now;

    stmts.updateJobStatus.run({ id: jobId, status: 'canceled', updatedAt: now });
    stmts.releaseLock.run(job.chatId, jobId);

    // Abort any in-flight provider request
    try { job.abortController.abort(); } catch { /* ignore */ }

    emitEvent(job, 'canceled', { jobId });

    const hooks = jobHooks.get(jobId);
    if (hooks?.onCancel) {
        hooks.onCancel();
    }

    log.info('Job canceled', { jobId, chatId: job.chatId });
    jobHooks.delete(jobId);
    scheduleCleanupLiveJob(jobId);
    return job;
}

// ─── Event System ────────────────────────────────────────────────────────────

function emitEvent(job, type, data) {
    job.eventSeq += 1;
    const seq = job.eventSeq;
    const now = Date.now();

    const event = { type, seq, ...data };
    const eventJson = JSON.stringify(event);

    // Persist
    stmts.insertEvent.run({
        jobId: job.id,
        seq,
        type,
        payload: eventJson,
        createdAt: now,
    });

    // Broadcast to live subscribers
    for (const sub of job.subscribers) {
        try {
            sub.send(eventJson);
        } catch {
            job.subscribers.delete(sub);
        }
    }

    return event;
}

function emitDelta(jobId, text) {
    const job = liveJobs.get(jobId);
    if (!job) return;
    emitEvent(job, 'delta', { jobId, text });
    const hooks = jobHooks.get(jobId);
    if (hooks?.onDelta) {
        hooks.onDelta(text);
    }
}

function emitProviderRetry(jobId, reason, attempt) {
    const job = liveJobs.get(jobId);
    if (!job) return;
    emitEvent(job, 'provider_retry', { jobId, reason, attempt });
}

function emitProviderWarning(jobId, message) {
    const job = liveJobs.get(jobId);
    if (!job) return;
    emitEvent(job, 'provider_warning', { jobId, message });
}

function emitToolCallStarted(jobId, toolName, toolArgs) {
    const job = liveJobs.get(jobId);
    if (!job) return;
    emitEvent(job, 'tool_call_started', { jobId, toolName, toolArgs });
}

function emitToolCallFinished(jobId, toolName, result) {
    const job = liveJobs.get(jobId);
    if (!job) return;
    emitEvent(job, 'tool_call_finished', { jobId, toolName, result });
}

function emitMessagePlaceholder(jobId, messageId) {
    const job = liveJobs.get(jobId);
    if (!job) return;
    job.messageId = messageId;
    stmts.updateJobMessageId.run({ id: jobId, messageId, updatedAt: Date.now() });
    emitEvent(job, 'message_placeholder', { jobId, messageId });
}

function setJobHooks(jobId, hooks) {
    jobHooks.set(jobId, hooks);
}

// ─── Subscription (WebSocket) ────────────────────────────────────────────────

function subscribe(jobId, ws, lastSeq = 0) {
    const job = liveJobs.get(jobId);

    if (job) {
        // Replay missed events
        const missed = stmts.getEventsSince.all(jobId, lastSeq);
        for (const row of missed) {
            try { ws.send(row.payload); } catch { /* ignore */ }
        }
        job.subscribers.add(ws);
        return true;
    }

    // Job might have completed and been evicted from live jobs
    // Replay all events from DB
    const dbJob = stmts.getJob.get(jobId);
    if (!dbJob) return false;

    const events = lastSeq > 0
        ? stmts.getEventsSince.all(jobId, lastSeq)
        : stmts.getAllEvents.all(jobId);
    for (const row of events) {
        try { ws.send(row.payload); } catch { /* ignore */ }
    }
    return true;
}

function unsubscribe(jobId, ws) {
    const job = liveJobs.get(jobId);
    if (job) {
        job.subscribers.delete(ws);
    }
}

// ─── Query ───────────────────────────────────────────────────────────────────

function getJob(jobId) {
    const live = liveJobs.get(jobId);
    if (live) {
        return formatJobResponse(live);
    }
    const row = stmts.getJob.get(jobId);
    if (!row) return null;
    return formatDbRow(row);
}

function getActiveJobForChat(chatId) {
    // Check live jobs first
    for (const job of liveJobs.values()) {
        if (job.chatId === chatId && !TERMINAL_STATUSES.has(job.status)) {
            return formatJobResponse(job);
        }
    }
    const row = stmts.getActiveJobForChat.get(chatId);
    if (!row) return null;
    return formatDbRow(row);
}

function getActiveJobs() {
    const result = [];
    for (const job of liveJobs.values()) {
        if (!TERMINAL_STATUSES.has(job.status)) {
            result.push(formatJobResponse(job));
        }
    }
    return result;
}

// ─── Batch Support ───────────────────────────────────────────────────────────

function setJobBatchId(jobId, batchId) {
    const job = liveJobs.get(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    job.batchId = batchId;
    const now = Date.now();
    job.updatedAt = now;

    stmts.updateJobBatch.run({
        batchId,
        status: 'awaiting_batch',
        updatedAt: now,
        id: jobId,
    });

    if (job.status !== 'awaiting_batch') {
        transitionStatus(jobId, 'awaiting_batch');
    }
}

function updateJobResult(jobId, partialText) {
    const job = liveJobs.get(jobId);
    if (!job) return;
    job.resultText = partialText;
    job.updatedAt = Date.now();
    stmts.updateJobResult.run({
        resultText: partialText,
        updatedAt: job.updatedAt,
        id: jobId,
    });
    const hooks = jobHooks.get(jobId);
    if (hooks?.onResultText) {
        hooks.onResultText(partialText);
    }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

const LIVE_JOB_GRACE_MS = 60000; // keep completed live jobs for 60s for late subscribers
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h DB retention
const STALE_JOB_CUTOFF_MS = 10 * 60 * 1000; // 10 min without update = stale

function scheduleCleanupLiveJob(jobId) {
    setTimeout(() => {
        const job = liveJobs.get(jobId);
        if (job && TERMINAL_STATUSES.has(job.status) && job.subscribers.size === 0) {
            liveJobs.delete(jobId);
        }
    }, LIVE_JOB_GRACE_MS);
}

function runGarbageCollection() {
    const now = Date.now();

    // Mark stale live jobs
    for (const [jobId, job] of liveJobs.entries()) {
        if (!TERMINAL_STATUSES.has(job.status) && now - job.updatedAt > STALE_JOB_CUTOFF_MS) {
            log.warn('Marking job as stale', { jobId, lastUpdate: job.updatedAt });
            try {
                job.status = 'stale';
                job.updatedAt = now;
                job.completedAt = now;
                stmts.updateJobStatus.run({ id: jobId, status: 'stale', updatedAt: now });
                stmts.releaseLock.run(job.chatId, jobId);
                emitEvent(job, 'failed', { jobId, error: 'Job became stale' });
                scheduleCleanupLiveJob(jobId);
            } catch (e) {
                log.error('Failed to mark job stale', { jobId, error: e.message });
            }
        }
    }

    // Clean up old DB records
    const cutoff = now - JOB_RETENTION_MS;
    try {
        stmts.cleanupOldJobs.run(cutoff);
        stmts.cleanupOrphanEvents.run();
        stmts.cleanupOrphanLocks.run();
    } catch (e) {
        log.error('GC cleanup error', { error: e.message });
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatJobResponse(job) {
    return {
        id: job.id,
        chatId: job.chatId,
        characterId: job.characterId,
        messageId: job.messageId,
        status: job.status,
        provider: job.provider,
        model: job.model,
        resultText: job.resultText,
        errorJson: job.errorJson,
        batchId: job.batchId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
    };
}

function formatDbRow(row) {
    return {
        id: row.id,
        chatId: row.chat_id,
        characterId: row.character_id,
        messageId: row.message_id,
        status: row.status,
        provider: row.provider,
        model: row.model,
        resultText: row.result_text,
        errorJson: row.error_json,
        batchId: row.batch_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    };
}

// ─── Error Classes ───────────────────────────────────────────────────────────

class JobConflictError extends Error {
    constructor(message, existingJobId) {
        super(message);
        this.name = 'JobConflictError';
        this.existingJobId = existingJobId;
    }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    init,
    createJob,
    transitionStatus,
    completeJob,
    failJob,
    cancelJob,
    emitDelta,
    emitProviderRetry,
    emitProviderWarning,
    emitToolCallStarted,
    emitToolCallFinished,
    emitMessagePlaceholder,
    subscribe,
    unsubscribe,
    getJob,
    getActiveJobForChat,
    getActiveJobs,
    setJobBatchId,
    updateJobResult,
    setJobHooks,
    runGarbageCollection,
    JobConflictError,
    TERMINAL_STATUSES,
    // Expose liveJobs for testing/inspection
    _liveJobs: liveJobs,
};
