'use strict';

/**
 * SQLite schema for generation jobs and events.
 * Called once at server startup to ensure tables exist.
 */

function initGenerationTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS generation_jobs (
            id                TEXT PRIMARY KEY,
            chat_id           TEXT NOT NULL,
            character_id      TEXT NOT NULL,
            message_id        TEXT,
            status            TEXT NOT NULL DEFAULT 'queued',
            provider          TEXT,
            model             TEXT,
            request_payload   TEXT,
            request_hash      TEXT,
            result_text       TEXT,
            error_json        TEXT,
            batch_id          TEXT,
            owner_session_id  TEXT,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL,
            completed_at      INTEGER
        )
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_generation_jobs_status
        ON generation_jobs (status)
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_generation_jobs_chat_id
        ON generation_jobs (chat_id, status)
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS generation_job_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id      TEXT NOT NULL,
            seq         INTEGER NOT NULL,
            type        TEXT NOT NULL,
            payload     TEXT,
            created_at  INTEGER NOT NULL,
            FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE
        )
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_generation_job_events_job_seq
        ON generation_job_events (job_id, seq)
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS generation_locks (
            chat_id     TEXT PRIMARY KEY,
            job_id      TEXT NOT NULL,
            acquired_at INTEGER NOT NULL,
            FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE
        )
    `);
}

module.exports = { initGenerationTables };
