'use strict';

const { createJob, getJob, getActiveJobs, getActiveJobForChat, cancelJob, JobConflictError } = require('./jobs.cjs');
const { startJob } = require('./service.cjs');
const { createLogger } = require('./logger.cjs');

const log = createLogger('Routes');

function setupGenerationRoutes({ app, authenticatedRouteLimiter, checkAuth, checkActiveSession }) {
    app.post('/api/generations', authenticatedRouteLimiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        if (!checkActiveSession(req, res)) {
            return;
        }

        try {
            const characterId = normalizeString(req.body?.characterId);
            const chatId = normalizeString(req.body?.chatId);
            if (!characterId || !chatId) {
                res.status(400).json({ error: 'characterId and chatId are required' });
                return;
            }

            const job = createJob({
                characterId,
                chatId,
                messageId: normalizeNullableString(req.body?.messageId),
                provider: normalizeNullableString(req.body?.provider),
                model: normalizeNullableString(req.body?.overrideModel) || normalizeNullableString(req.body?.model),
                requestPayload: req.body,
                requestHash: null,
                ownerSessionId: normalizeNullableSession(req.headers['x-session-id']),
            });

            await startJob(job, {
                ...req.body,
                mode: normalizeString(req.body?.mode) || 'mock',
            });

            res.json({
                jobId: job.id,
                messageId: job.messageId,
                status: job.status,
            });
        } catch (error) {
            if (error instanceof JobConflictError) {
                res.status(409).json({
                    error: error.message,
                    existingJobId: error.existingJobId,
                });
                return;
            }
            log.error('Failed to create generation job', { error: error.message });
            res.status(500).json({ error: error.message || 'Failed to create generation job' });
        }
    });

    app.get('/api/generations/active', authenticatedRouteLimiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        res.json({ jobs: getActiveJobs() });
    });

    app.get('/api/chats/:chatId/active-generation', authenticatedRouteLimiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        const job = getActiveJobForChat(req.params.chatId);
        if (!job) {
            res.status(404).json({ error: 'No active generation for chat' });
            return;
        }
        res.json(job);
    });

    app.get('/api/generations/:jobId', authenticatedRouteLimiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        const job = getJob(req.params.jobId);
        if (!job) {
            res.status(404).json({ error: 'Generation job not found' });
            return;
        }
        res.json(job);
    });

    app.get('/api/generations/:jobId/stream', authenticatedRouteLimiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        if (!getJob(req.params.jobId)) {
            res.status(404).json({ error: 'Generation job not found' });
            return;
        }
        res.status(426).json({
            error: 'Upgrade Required',
            message: 'Connect to this endpoint with WebSocket to receive generation events.',
        });
    });

    app.post('/api/generations/:jobId/cancel', authenticatedRouteLimiter, async (req, res) => {
        if (!await checkAuth(req, res)) {
            return;
        }
        if (!checkActiveSession(req, res)) {
            return;
        }
        try {
            const job = cancelJob(req.params.jobId);
            res.json({ ok: true, job });
        } catch (error) {
            res.status(404).json({ error: error.message || 'Generation job not found' });
        }
    });
}

function normalizeString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeNullableString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeNullableSession(value) {
    if (Array.isArray(value)) {
        return value[0] || null;
    }
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

module.exports = {
    setupGenerationRoutes,
};
