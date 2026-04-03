'use strict';

const { kvGet, kvSet } = require('../db.cjs');
const { decodeRisuSave, encodeRisuSaveLegacy } = require('../utils.cjs');

const DB_KEY = 'database/database.bin';

async function loadCanonicalDatabase() {
    const raw = kvGet(DB_KEY);
    if (!raw) {
        throw new Error('Canonical database not found');
    }
    return await decodeRisuSave(new Uint8Array(raw));
}

function saveCanonicalDatabase(db) {
    const data = Buffer.from(encodeRisuSaveLegacy(db));
    kvSet(DB_KEY, data);
}

module.exports = {
    loadCanonicalDatabase,
    saveCanonicalDatabase,
    DB_KEY,
};
