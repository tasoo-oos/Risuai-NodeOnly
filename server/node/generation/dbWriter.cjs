'use strict';

const nodeCrypto = require('crypto');
const { loadCanonicalDatabase, saveCanonicalDatabase } = require('./database.cjs');

async function prepareServerMessage(job) {
    const db = await loadCanonicalDatabase();
    const character = (db.characters || []).find((entry) => entry?.chaId === job.characterId);
    if (!character) {
        throw new Error(`Character not found for DB write: ${job.characterId}`);
    }
    const chat = (character.chats || []).find((entry) => entry?.id === job.chatId)
        || character.chats?.[character.chatPage || 0]
        || character.chats?.[0];
    if (!chat) {
        throw new Error(`Chat not found for DB write: ${job.chatId}`);
    }

    let message = null;
    let prefix = '';
    if (job.messageId) {
        message = (chat.message || []).find((entry) => entry?.chatId === job.messageId) || null;
    }

    if (!message) {
        message = findReusableAssistantMessage(chat, job);
    }

    if (message) {
        job.messageId = message.chatId || job.messageId || createMessageId();
        message.chatId = job.messageId;
        prefix = message.data || '';
    } else {
        job.messageId = job.messageId || createMessageId();
        message = {
            role: 'char',
            data: '',
            saying: character.chaId,
            time: Date.now(),
            chatId: job.messageId,
        };
        chat.message = chat.message || [];
        chat.message.push(message);
        if (db.statics && typeof db.statics.messages === 'number') {
            db.statics.messages += 1;
        }
    }

    chat.isStreaming = true;
    character.lastInteraction = Date.now();
    saveCanonicalDatabase(db);

    return {
        db,
        character,
        chat,
        messageId: job.messageId,
        prefix,
    };
}

function updateServerMessage(state, fullText, { done = false } = {}) {
    const chat = state.chat;
    const message = (chat.message || []).find((entry) => entry?.chatId === state.messageId);
    if (!message) {
        throw new Error(`Server message not found: ${state.messageId}`);
    }
    message.data = `${state.prefix || ''}${fullText || ''}`;
    chat.isStreaming = !done;
    chat.lastDate = Date.now();
    state.character.lastInteraction = Date.now();
    saveCanonicalDatabase(state.db);
}

function markServerMessageTerminal(state) {
    const chat = state.chat;
    chat.isStreaming = false;
    chat.lastDate = Date.now();
    state.character.lastInteraction = Date.now();
    saveCanonicalDatabase(state.db);
}

function findReusableAssistantMessage(chat, job) {
    if (!job.requestPayload?.continue) {
        return null;
    }
    const messages = chat.message || [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'char') {
            return message;
        }
    }
    return null;
}

function createMessageId() {
    return `msg_${nodeCrypto.randomUUID()}`;
}

module.exports = {
    prepareServerMessage,
    updateServerMessage,
    markServerMessageTerminal,
};
