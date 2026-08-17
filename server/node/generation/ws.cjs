'use strict';

const { WebSocketServer } = require('ws');
const { subscribe, unsubscribe, getJob } = require('./jobs.cjs');
const { createLogger } = require('./logger.cjs');

const log = createLogger('WS');

function setupGenerationWebSocket(server, { checkAuthorizedRequest }) {
    const wsServer = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (req, socket, head) => {
        try {
            const reqUrl = new URL(req.url, `http://${req.headers.host}`);
            const match = reqUrl.pathname.match(/^\/api\/generations\/([^/]+)\/stream$/);
            if (!match) {
                return;
            }

            const auth = reqUrl.searchParams.get('risu-auth') || normalizeAuthHeader(req.headers['risu-auth']);
            if (!await checkAuthorizedRequest({ headers: { 'risu-auth': auth } })) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            const jobId = match[1];
            if (!getJob(jobId)) {
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }

            wsServer.handleUpgrade(req, socket, head, (ws) => {
                wsServer.emit('connection', ws, req, jobId, reqUrl.searchParams.get('lastSeq'));
            });
        } catch {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
        }
    });

    wsServer.on('connection', (ws, _req, jobId, lastSeqRaw) => {
        const lastSeq = Number.parseInt(lastSeqRaw || '0', 10);
        const ok = subscribe(jobId, ws, Number.isFinite(lastSeq) ? lastSeq : 0);
        if (!ok) {
            ws.close();
            return;
        }

        const pingTimer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) {
                return;
            }
            ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }, 15000);

        ws.on('close', () => {
            clearInterval(pingTimer);
            unsubscribe(jobId, ws);
        });

        ws.on('error', (error) => {
            clearInterval(pingTimer);
            unsubscribe(jobId, ws);
            log.warn('Generation websocket error', { jobId, error: error?.message });
        });
    });
}

function normalizeAuthHeader(authHeader) {
    if (Array.isArray(authHeader)) {
        return authHeader[0] || '';
    }
    return typeof authHeader === 'string' ? authHeader : '';
}

module.exports = {
    setupGenerationWebSocket,
};
