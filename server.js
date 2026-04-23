const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let client = null;
let clientStatus = 'disconnected'; // disconnected | qr | ready
let currentQR = null;

// ─── INIT WHATSAPP CLIENT ────────────────────────────────────────────────────
function initClient() {
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', async (qr) => {
        clientStatus = 'qr';
        currentQR = await qrcode.toDataURL(qr);
        io.emit('qr', currentQR);
        io.emit('status', { status: 'qr', message: 'Scan QR code with WhatsApp' });
    });

    client.on('ready', () => {
        clientStatus = 'ready';
        currentQR = null;
        io.emit('status', { status: 'ready', message: 'WhatsApp connected!' });
    });

    client.on('auth_failure', () => {
        clientStatus = 'disconnected';
        io.emit('status', { status: 'error', message: 'Authentication failed' });
    });

    client.on('disconnected', () => {
        clientStatus = 'disconnected';
        io.emit('status', { status: 'disconnected', message: 'Disconnected from WhatsApp' });
    });

    client.initialize();
}

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    // Send current state to newly connected browser
    socket.emit('status', {
        status: clientStatus,
        message: clientStatus === 'ready' ? 'WhatsApp connected!' :
                 clientStatus === 'qr' ? 'Scan QR code' : 'Not connected'
    });
    if (currentQR) socket.emit('qr', currentQR);
});

// ─── REST ENDPOINTS ──────────────────────────────────────────────────────────

// Connect WhatsApp
app.post('/api/connect', (req, res) => {
    if (clientStatus === 'ready') return res.json({ success: true, message: 'Already connected' });
    if (clientStatus === 'qr') return res.json({ success: true, message: 'QR pending scan' });
    initClient();
    res.json({ success: true, message: 'Initializing WhatsApp...' });
});

// Disconnect WhatsApp
app.post('/api/disconnect', async (req, res) => {
    if (client) {
        await client.destroy();
        client = null;
        clientStatus = 'disconnected';
    }
    res.json({ success: true });
});

// Send bulk messages
app.post('/api/send', async (req, res) => {
    if (clientStatus !== 'ready') {
        return res.status(400).json({ success: false, message: 'WhatsApp not connected' });
    }

    const { contacts, message, delay } = req.body;
    if (!contacts || !contacts.length) {
        return res.status(400).json({ success: false, message: 'No contacts provided' });
    }

    res.json({ success: true, message: 'Bulk send started' });

    // Send in background, emit progress via socket
    (async () => {
        let sent = 0, failed = 0;
        io.emit('bulk_start', { total: contacts.length });

        for (let i = 0; i < contacts.length; i++) {
            const { name, number } = contacts[i];
            const chatId = `${number}@c.us`;
            const personalizedMsg = message.replace(/\{name\}/gi, name);

            try {
                const isRegistered = await client.isRegisteredUser(chatId);
                if (!isRegistered) {
                    failed++;
                    io.emit('bulk_progress', {
                        index: i + 1, total: contacts.length,
                        name, number, status: 'failed',
                        reason: 'Not on WhatsApp', sent, failed
                    });
                } else {
                    await client.sendMessage(chatId, personalizedMsg);
                    sent++;
                    io.emit('bulk_progress', {
                        index: i + 1, total: contacts.length,
                        name, number, status: 'sent', sent, failed
                    });
                }
            } catch (err) {
                failed++;
                io.emit('bulk_progress', {
                    index: i + 1, total: contacts.length,
                    name, number, status: 'failed',
                    reason: err.message, sent, failed
                });
            }

            if (i < contacts.length - 1) {
                await new Promise(r => setTimeout(r, (delay || 3) * 1000));
            }
        }

        io.emit('bulk_done', { sent, failed, total: contacts.length });
    })();
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}\n`);
});
