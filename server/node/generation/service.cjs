'use strict';

const {
    transitionStatus,
    completeJob,
    failJob,
    emitDelta,
    emitProviderWarning,
    updateJobResult,
} = require('./jobs.cjs');
const { createLogger } = require('./logger.cjs');

const log = createLogger('Service');

const runners = new Map();

function registerRunner(name, runner) {
    runners.set(name, runner);
}

function getRunner(name) {
    return runners.get(name);
}

async function startJob(job, command) {
    const mode = command?.mode || 'mock';
    const runner = getRunner(mode) || getRunner('mock');
    if (!runner) {
        throw new Error(`No generation runner registered for mode: ${mode}`);
    }

    void Promise.resolve()
        .then(async () => {
            transitionStatus(job.id, 'running');
            await runner(job, command);
        })
        .catch((error) => {
            failJob(job.id, error);
        });

    return job;
}

async function mockRunner(job, command) {
    const text = typeof command?.mockText === 'string'
        ? command.mockText
        : 'Server generation job initialized. Provider execution has not been migrated for this path yet.';

    emitProviderWarning(job.id, 'Using mock generation runner');

    const chunks = text.split(/(\s+)/).filter(Boolean);
    let acc = '';
    for (const chunk of chunks) {
        if (job.abortController.signal.aborted) {
            return;
        }
        acc += chunk;
        emitDelta(job.id, chunk);
        updateJobResult(job.id, acc);
        await delay(20);
    }

    completeJob(job.id, acc);
    log.info('Mock generation completed', { jobId: job.id, mode: command?.mode || 'mock' });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

registerRunner('mock', mockRunner);

module.exports = {
    registerRunner,
    getRunner,
    startJob,
};
