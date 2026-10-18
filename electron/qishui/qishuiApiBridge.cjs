const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');
const QS = require('./qishuiApi.cjs');
const CORE = require('./lunaCore.cjs');

// electron/qishui/qishuiApiBridge.cjs
// 汽水音乐主进程桥：原生签名器、登录态、解密缓存、回环音频服务全在这里。
// 渲染进程只看到搜索/播放/歌词/账号这些结果，拿不到 Cookie 或设备密钥。

const OPERATIONS = new Set([
    'availability', 'login_status', 'login_qr_key', 'login_qr_create', 'login_qr_check',
    'login_qr_cancel', 'logout', 'search', 'song_detail', 'audio', 'lyrics',
    'account_playlists', 'recommended_playlists', 'playlist_square', 'playlist_tracks',
    'liked_ids', 'personal_fm', 'artist_songs', 'artist_albums', 'import_cookie',
]);

const COVER_HOSTS = ['douyinpic.com', 'douyincdn.com', 'byteimg.com', 'bytedance.com', 'qishui.com'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
};
const QUALITY_ORDER = {
    standard: ['medium', 'higher', 'highest', 'hi_res', 'lossless'],
    high: ['higher', 'medium', 'highest', 'hi_res', 'lossless'],
    lossless: ['lossless', 'hi_res', 'highest', 'higher', 'medium'],
    hires: ['hi_res', 'lossless', 'highest', 'higher', 'medium'],
};

const ensureDir = dir => {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const md5 = value => crypto.createHash('md5').update(String(value)).digest('hex');

class NativeHost {
    constructor(log) {
        this.log = log;
        this.child = null;
        this.seq = 0;
        this.pending = new Map();
    }

    async start(nativeDir, execPath) {
        if (this.child) return true;
        const script = __dirname.includes('app.asar')
            ? path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'nativeHost.cjs')
            : path.join(__dirname, 'nativeHost.cjs');
        this.child = fork(script, [], {
            execPath,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        this.child.on('message', message => {
            if (!message || message.id === undefined) return;
            const job = this.pending.get(message.id);
            if (!job) return;
            this.pending.delete(message.id);
            if (message.ok) job.resolve(message.result);
            else job.reject(new Error(String(message.error || 'native op failed')));
        });
        this.child.on('exit', (code, signal) => {
            const error = new Error(`Qishui native host exited (code=${code}${signal ? ` signal=${signal}` : ''})`);
            for (const [, job] of this.pending) job.reject(error);
            this.pending.clear();
            this.child = null;
        });
        this.child.on('error', error => this.log.warn('[Qishui] native host error', error));
        const booted = await this.call('boot', { dir: nativeDir });
        this.log.info(`[Qishui] native modules loaded from ${nativeDir}${booted?.hasDevice ? '' : ' (device module missing)'}`);
        return true;
    }

    call(cmd, args, timeoutMs = 20000) {
        if (!this.child) return Promise.reject(new Error('Qishui native host is not running'));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Qishui native ${cmd} timed out`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
            try {
                this.child.send({ id, cmd, args });
            } catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    stop() {
        const child = this.child;
        this.child = null;
        try { child?.disconnect(); } catch { }
        try { child?.kill(); } catch { }
    }
}

function findNativeDir() {
    const wanted = dir => {
        try { return fs.existsSync(path.join(dir, 'bdms.node')); } catch { return false; }
    };
    const forced = String(process.env.FOLIA_QISHUI_NATIVE_DIR || '').trim();
    if (forced) return wanted(forced) ? forced : null;
    const candidates = [];
    if (process.platform === 'darwin') {
        const arch = process.arch === 'arm64' ? 'app-arm64.asar.unpacked' : 'app-x64.asar.unpacked';
        for (const base of [
            '/Applications/汽水音乐.app/Contents/Resources',
            path.join(os.homedir(), 'Applications', '汽水音乐.app', 'Contents', 'Resources'),
        ]) {
            candidates.push(path.join(base, arch), path.join(base, 'app.asar.unpacked'));
        }
    } else if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        for (const root of [path.join(local, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
            for (const name of ['汽水音乐', 'SodaMusic']) {
                candidates.push(path.join(root, name, 'resources', 'app.asar.unpacked'), path.join(root, name, 'resources'));
            }
        }
    }
    return candidates.find(candidate => candidate && wanted(candidate)) || null;
}

function coverFromUrlCover(cover, px = 500) {
    if (!cover || !cover.uri) return '';
    const base = (cover.urls && cover.urls[0]) || 'https://p3-luna.douyinpic.com/img/';
    const raw = base + cover.uri;
    if (/~tplv|~crop/.test(raw)) return raw.replace(/(crop-center:)\d+:\d+/, `$1${px}:${px}`);
    return `${raw}~${cover.template_prefix || 'tplv-b829550vbb'}-crop-center:${px}:${px}.jpg`;
}

function createQishuiApiBridge({ userDataDir, safeStorage, log = console, execPath = process.execPath, now = Date.now } = {}) {
    const dataDir = path.join(userDataDir, 'qishui');
    const cacheDir = path.join(userDataDir, 'qishui-cache');
    const sessionFile = path.join(dataDir, 'session.bin');
    const deviceFile = path.join(dataDir, 'device.json');
    const qrLogFile = path.join(dataDir, 'qr.log');
    const dirtyDeviceMark = path.join(dataDir, 'device-rotate');
    const nativeDir = findNativeDir();
    const native = new NativeHost(log);
    const token = crypto.randomBytes(16).toString('hex');
    let cookie = '';
    let memoryCookie = '';
    let dev = null;
    let signReady = false;
    let signPromise = null;
    let server = null;
    let serverPort = 0;
    let qrSeq = 0;
    const qrSessions = new Map();
    const detailCache = new Map();
    const inflightAudio = new Map();
    const playlistCache = new Map();

    const qrLog = message => {
        try {
            ensureDir(dataDir);
            fs.appendFileSync(qrLogFile, `${new Date().toISOString()} ${message}\n`);
        } catch { }
    };

    const cookieNames = jar => Object.keys(jar || {}).sort().join(',');
    const hasSessionCookie = jar => Boolean(jar && (jar.sessionid || jar.sessionid_ss || jar.sid_tt));

    const loadSession = () => {
        if (memoryCookie) return memoryCookie;
        try {
            if (!fs.existsSync(sessionFile) || !safeStorage?.isEncryptionAvailable?.()) return '';
            const value = safeStorage.decryptString(fs.readFileSync(sessionFile));
            return String(value || '').trim();
        } catch (error) {
            log.warn('[Qishui] could not read the saved session', error);
            return '';
        }
    };

    const saveSession = value => {
        memoryCookie = value || '';
        try {
            if (!value) {
                fs.rmSync(sessionFile, { force: true });
                return false;
            }
            if (!safeStorage?.isEncryptionAvailable?.()) return false;
            ensureDir(dataDir);
            fs.writeFileSync(sessionFile, safeStorage.encryptString(value), { mode: 0o600 });
            return true;
        } catch (error) {
            log.warn('[Qishui] could not save the session', error);
            return false;
        }
    };

    const ensureDevice = async (force = false) => {
        if (!force) {
            try {
                const saved = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
                if (saved?.did && saved?.iid) {
                    dev = saved;
                    return dev;
                }
            } catch { }
        }
        if (force) {
            try { fs.rmSync(deviceFile, { force: true }); } catch { }
            dev = null;
            signReady = false;
            signPromise = null;
        }
        if (!native.child) throw new Error('Qishui native host is not running');
        const device = await QS.registerDevice(native);
        ensureDir(dataDir);
        fs.writeFileSync(deviceFile, JSON.stringify(device, null, 1), { mode: 0o600 });
        dev = device;
        log.info(`[Qishui] device registered: ${String(device.did).slice(0, 8)}…`);
        return dev;
    };

    const readySigned = () => {
        if (signReady && dev && native.child) return Promise.resolve(true);
        if (signPromise) return signPromise;
        signPromise = (async () => {
            if (!nativeDir) throw new Error('Qishui client not found; install and launch the Soda Music desktop client once');
            await native.start(nativeDir, execPath);
            await ensureDevice();
            await native.call('init', { deviceId: dev.did });
            signReady = true;
            log.info('[Qishui] signing ready');
            return true;
        })().catch(error => {
            signReady = false;
            signPromise = null;
            throw error;
        });
        return signPromise;
    };

    const rotateDeviceIfMarked = async () => {
        let marked = false;
        try { marked = fs.existsSync(dirtyDeviceMark); } catch { }
        if (!marked) return false;
        await readySigned();
        await ensureDevice(true);
        await native.call('init', { deviceId: dev.did });
        signReady = true;
        try { fs.rmSync(dirtyDeviceMark, { force: true }); } catch { }
        log.info(`[Qishui] rotated to a fresh device identity: ${String(dev.did).slice(0, 8)}…`);
        qrLog(`device rotated to ${String(dev.did).slice(0, 8)}`);
        return true;
    };

    const getDetail = async (id, options = {}) => {
        const limited = options.limitedFreeInfo && options.limitedFreeInfo.limited_free === true;
        const key = `${String(id)}:${limited ? 'limited-free' : 'normal'}`;
        const hit = detailCache.get(key);
        if (hit && now() - hit.at < 4 * 60 * 1000) return hit.value;
        if (!signReady) await readySigned();
        const detail = await QS.trackV2(native, dev, cookie, String(id), options);
        if (!detail.items.length) throw new Error('Qishui returned no audio stream for this track');
        detailCache.set(key, { at: now(), value: detail });
        if (detailCache.size > 80) detailCache.delete(detailCache.keys().next().value);
        return detail;
    };

    const pickStream = (items, wanted) => {
        const order = QUALITY_ORDER[wanted] || QUALITY_ORDER.high;
        for (const quality of order) {
            const hit = items.find(item => item.quality === quality && item.url);
            if (hit) return hit;
        }
        return items.find(item => item.url) || null;
    };

    const sweepCache = (maxBytes = 1024 * 1024 * 1024) => {
        try {
            const files = fs.readdirSync(cacheDir)
                .filter(name => name.endsWith('.audio') || name.endsWith('.img'))
                .map(name => {
                    const file = path.join(cacheDir, name);
                    return { file, size: fs.statSync(file).size, at: fs.statSync(file).mtimeMs };
                })
                .sort((a, b) => a.at - b.at);
            let total = files.reduce((sum, item) => sum + item.size, 0);
            for (const item of files) {
                if (total <= maxBytes) break;
                try { fs.rmSync(item.file, { force: true }); total -= item.size; } catch { }
            }
        } catch { }
    };

    const startServer = async () => {
        if (serverPort) return serverPort;
        ensureDir(cacheDir);
        server = http.createServer(async (req, res) => {
            try {
                const url = new URL(req.url, 'http://127.0.0.1');
                const host = String(req.headers.host || '').split(':')[0];
                if (!LOOPBACK_HOSTS.has(host)) { res.writeHead(403); return res.end(); }
                if (String(url.searchParams.get('t') || '') !== token) { res.writeHead(403); return res.end(); }
                if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
                const match = /^\/stream\/([a-f0-9]{64})$/.exec(url.pathname);
                if (!match || req.method !== 'GET') { res.writeHead(404); return res.end(); }
                const file = path.join(cacheDir, `${match[1]}.audio`);
                if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
                let contentType = 'audio/mp4';
                try {
                    contentType = JSON.parse(fs.readFileSync(path.join(cacheDir, `${match[1]}.meta.json`), 'utf8')).contentType || contentType;
                } catch { }
                const stat = fs.statSync(file);
                const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
                if (range) {
                    const start = range[1] ? Number(range[1]) : 0;
                    const end = range[2] ? Number(range[2]) : stat.size - 1;
                    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stat.size) {
                        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                        return res.end();
                    }
                    res.writeHead(206, {
                        'Content-Type': contentType,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': String(end - start + 1),
                        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                        ...CORS,
                    });
                    return fs.createReadStream(file, { start, end }).pipe(res);
                }
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Content-Length': String(stat.size),
                    'Accept-Ranges': 'bytes',
                    ...CORS,
                });
                return fs.createReadStream(file).pipe(res);
            } catch (error) {
                log.warn('[Qishui] audio server request failed', error);
                if (!res.headersSent) res.writeHead(500);
                res.end();
            }
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        serverPort = server.address().port;
        log.info(`[Qishui] audio server listening on 127.0.0.1:${serverPort}`);
        return serverPort;
    };

    const resolveAudio = async (id, quality, options = {}) => {
        const key = `${id}:${quality || ''}:${options.limitedFreeInfo && options.limitedFreeInfo.limited_free === true ? 'limited-free' : 'normal'}`;
        const running = inflightAudio.get(key);
        if (running) return running;
        const task = (async () => {
            const detail = await getDetail(id, options);
            const item = pickStream(detail.items, quality);
            if (!item) throw new Error('Qishui returned no playable stream');
            const fullMs = Number(detail.track.durationMs) || 0;
            const gotMs = Number(detail.videoDurationMs) || Math.round((Number(item.size) || 0) * 8 / Math.max(1, Number(item.bitrate) || 1) * 1000);
            const preview = Boolean(fullMs && gotMs && Math.abs(gotMs - fullMs) > Math.max(2500, fullMs * 0.08));
            if (!item.encrypted) {
                return { url: item.url, quality: item.quality, preview, expiresAt: item.expiresAt };
            }
            const streamId = item.streamKey || `${id}:${item.quality}:${item.vtype}`;
            const cacheKey = crypto.createHash('sha256').update(`cenc:${streamId}`).digest('hex');
            const file = path.join(cacheDir, `${cacheKey}.audio`);
            const port = await startServer();
            const served = {
                url: `http://127.0.0.1:${port}/stream/${cacheKey}?t=${token}`,
                quality: item.quality,
                preview,
                expiresAt: item.expiresAt,
            };
            if (fs.existsSync(file) && fs.statSync(file).size > 0) return served;
            if (!native.child) throw new Error('Qishui native host is not running');
            const decoded = await native.call('decodeSpade', { spade: item.spade_a });
            const decryptionKey = decoded.kind === 'string'
                ? decoded.text
                : Buffer.from(decoded.b64, 'base64').toString('latin1');
            const encrypted = await QS.request(item.url, {
                headers: { 'user-agent': QS.WEB_UA, referer: 'https://www.qishui.com/' },
                timeout: 120000,
            });
            if (encrypted.status !== 200) throw new Error(`Qishui encrypted stream HTTP ${encrypted.status}`);
            const output = CORE.decrypt(encrypted.buf, decryptionKey, {
                title: detail.track.title,
                artist: (detail.track.artists || []).join(' / '),
                album: detail.track.album,
                lyric: detail.lyricContent || '',
                coverBuf: null,
            });
            const contentType = output.ext === '.flac' ? 'audio/flac' : 'audio/mp4';
            ensureDir(cacheDir);
            const temporary = `${file}.tmp`;
            fs.writeFileSync(temporary, output.data);
            fs.renameSync(temporary, file);
            fs.writeFileSync(path.join(cacheDir, `${cacheKey}.meta.json`), JSON.stringify({ contentType }));
            sweepCache();
            log.info(`[Qishui] decrypted ${id} (${item.quality}, ${(output.data.length / 1048576).toFixed(1)}MB)`);
            return served;
        })();
        inflightAudio.set(key, task);
        try {
            return await task;
        } finally {
            inflightAudio.delete(key);
        }
    };

    const accountInfo = async () => {
        if (!cookie) return null;
        if (!signReady) await readySigned();
        const info = await QS.accountInfo(native, dev, cookie);
        return {
            id: String(info.raw?.my_info?.id || info.raw?.user?.id || info.raw?.id || 'me'),
            nickname: info.nickname || '汽水音乐',
            avatarUrl: info.avatarUrl || '',
            vipType: info.isVip ? 1 : 0,
        };
    };

    const playlistInfo = async id => {
        const key = String(id);
        const cached = playlistCache.get(key);
        if (cached && now() - cached.at < 5 * 60 * 1000) return cached.value;
        if (!signReady) await readySigned();
        const tracks = await QS.getPlaylistDetail(native, dev, cookie, key, 40);
        const value = { tracks };
        playlistCache.set(key, { at: now(), value });
        return value;
    };

    const likedPlaylist = async () => {
        if (!signReady) await readySigned();
        const lists = await QS.getMyPlaylists(native, dev, cookie);
        return lists.find(item => /我喜欢的音乐/.test(item.name)) || null;
    };

    const cookieImportCandidates = () => [
        path.join(os.homedir(), 'Library', 'Application Support', 'Folia', 'mods-data', 'folia-qishui', 'cookies.sqlite'),
        path.join(dataDir, 'cookies.sqlite'),
        QS.COOKIE_IMPORT.cookieDbPath(),
    ].filter(Boolean);

    const importCookie = async explicitPath => {
        const requested = String(explicitPath || '').trim();
        const dbPath = requested || cookieImportCandidates().find(candidate => {
            try { return fs.existsSync(candidate); } catch { return false; }
        });
        // The official client's container is usually blocked by macOS TCC. The small desktop
        // helper from the mod writes a readable copy here; say so instead of failing with EPERM.
        if (!dbPath) {
            throw new Error('没有找到汽水音乐登录副本：请先双击桌面「导入汽水音乐登录」工具，或手动从官方客户端导出 Cookies 后再试');
        }
        const temporary = path.join(os.tmpdir(), `qishui-cookies-${Date.now()}.sqlite`);
        try {
            try {
                fs.copyFileSync(dbPath, temporary);
            } catch (error) {
                throw new Error(`读不到汽水音乐登录副本（${error?.code || error?.message || error}）：请双击桌面「导入汽水音乐登录」工具后重试`);
            }
            const { DatabaseSync } = require('node:sqlite');
            const database = new DatabaseSync(temporary, { readOnly: true });
            const rows = database.prepare(
                "select host_key, name, value, encrypted_value from cookies where host_key like '%qishui%' or host_key like '%douyin%'",
            ).all();
            database.close();
            if (!rows.length) throw new Error('No Soda Music cookies in the client database');
            const { pbkdf2Sync, createDecipheriv } = require('node:crypto');
            const jar = {};
            for (const row of rows) {
                let value = String(row.value || '');
                if (!value && row.encrypted_value?.length) {
                    value = await QS.COOKIE_IMPORT.decryptValue(Buffer.from(row.encrypted_value), {
                        security: null,
                        pbkdf2: (password, salt, iterations, length, digest) => pbkdf2Sync(password, salt, iterations, length, digest),
                        decipher: (algorithm, key, iv, data) => {
                            const decipher = createDecipheriv(algorithm, key, iv);
                            decipher.setAutoPadding(true);
                            return Buffer.concat([decipher.update(data), decipher.final()]);
                        },
                    });
                }
                if (value) jar[row.name] = value;
            }
            if (!(jar.sessionid || jar.sessionid_ss || jar.sid_tt)) {
                throw new Error('Soda Music cookies have no sessionid');
            }
            cookie = Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
            saveSession(cookie);
            detailCache.clear();
            playlistCache.clear();
            return await accountInfo();
        } finally {
            try { fs.rmSync(temporary, { force: true }); } catch { }
        }
    };

    const publicQrState = rec => {
        if (!rec) return { state: 'expired' };
        if (rec.lastState === 'scanned') return { state: 'scanned' };
        return { state: 'waiting' };
    };

    const checkQr = async key => {
        const rec = qrSessions.get(String(key));
        if (!rec) return { state: 'expired' };
        if (now() > rec.deadline) {
            qrSessions.delete(String(key));
            return { state: 'expired' };
        }
        if (now() < rec.throttledUntil) return publicQrState(rec);
        // The app polls every 2 seconds; passport allows only a few reads per token. Keep the
        // first read late enough for the listener to scan, then spend the rest of the budget
        // around the confirmation instead of before it.
        if (now() < (rec.nextPollAt || 0)) return publicQrState(rec);
        if ((rec.waitingPolls || 0) >= 3) {
            qrSessions.delete(String(key));
            qrLog('poll budget spent before confirmation; ask for a new code');
            return { state: 'expired' };
        }
        if ((rec.polls || 0) >= 5) {
            qrSessions.delete(String(key));
            qrLog('poll budget spent; ask for a new code');
            return { state: 'expired' };
        }
        rec.polls = (rec.polls || 0) + 1;
        qrLog(`poll #${rec.polls} start`);
        const poll = async label => {
            const result = await QS.qrPoll(rec.dev || dev, rec.session, message => log.info(`[Qishui] ${message}`));
            qrLog(`${label} status=${result.status}${result.code !== undefined ? ` code=${result.code}` : ''}`
                + ` session=${hasSessionCookie(rec.session.jar)} cookies=${cookieNames(rec.session.jar)}`);
            return result;
        };
        const finish = result => {
            if (result.status === 'success') {
                cookie = result.cookie;
                saveSession(cookie);
                qrSessions.delete(String(key));
                qrLog('success; session saved');
                return { state: 'confirmed' };
            }
            if (result.status === 'scanned') {
                rec.lastState = 'scanned';
                rec.nextPollAt = now() + 5000;
                qrLog('scanned');
                return { state: 'scanned' };
            }
            if (result.status === 'confirmed') {
                rec.lastState = 'confirmed';
                rec.nextPollAt = now() + 4000;
                // Passport sometimes says "confirmed" one poll before it issues the session
                // cookies. The host treats `confirmed` as terminal and immediately reads the
                // account, so never report it until there is a cookie to read with.
                qrLog('confirmed without session cookie; keep polling');
                return { state: 'waiting' };
            }
            if (result.status === 'expired') {
                qrSessions.delete(String(key));
                qrLog('expired');
                return { state: 'expired' };
            }
            if (result.throttled) {
                rec.throttleCount = (rec.throttleCount || 0) + 1;
                rec.throttledUntil = now() + 60000;
                if (rec.throttleCount >= 2) {
                    try { fs.writeFileSync(dirtyDeviceMark, '1'); } catch { }
                    qrSessions.delete(String(key));
                    qrLog('throttled twice; device marked for rotation');
                    return { state: 'expired' };
                }
                log.warn('[Qishui] passport throttled the QR check; waiting 60s');
                qrLog('throttled; wait 60s');
                return publicQrState(rec);
            }
            if (result.status === 'failed') {
                qrSessions.delete(String(key));
                qrLog(`failed: ${result.message || 'unknown'}`);
                if (/2156|系统繁忙/.test(String(result.message || ''))) {
                    return {
                        state: 'error',
                        message: '汽水平台确认繁忙，请重新获取二维码再试',
                        failure: { case: 'retry-later', code: '2156', message: result.message },
                    };
                }
                return {
                    state: 'error',
                    message: result.message || 'Qishui login failed',
                    failure: { case: 'refused', code: result.code ? String(result.code) : undefined, message: result.message || undefined },
                };
            }
            rec.waitingPolls = (rec.waitingPolls || 0) + 1;
            rec.nextPollAt = now() + 18000;
            return publicQrState(rec);
        };
        const result = await poll('check');
        return finish(result);
    };

    const handle = async (operation, params = {}) => {
        if (!cookie) cookie = loadSession();
        switch (operation) {
            case 'availability':
                return {
                    configured: Boolean(nativeDir),
                    reason: nativeDir ? undefined : 'not-configured',
                };
            case 'login_status':
                cookie = cookie || loadSession();
                if (!cookie) return null;
                try {
                    return await accountInfo();
                } catch (error) {
                    log.warn('[Qishui] saved session could not be read', error);
                    if (/1000016|登录|session/i.test(String(error?.message || ''))) {
                        cookie = '';
                        saveSession('');
                    }
                    return null;
                }
            case 'login_qr_key': {
                await rotateDeviceIfMarked();
                await readySigned();
                const session = await QS.qrCreate(dev, message => log.info(`[Qishui] ${message}`));
                const key = `qr${++qrSeq}`;
                qrLog(`begin key=${key} device=${String(dev.did).slice(0, 8)} cookies=${cookieNames(session.jar)} expires=${session.expiresAt || ''}`);
                qrSessions.set(key, {
                    session,
                    dev,
                    deadline: session.expiresAt || now() + 5 * 60 * 1000,
                    polls: 0,
                    // Give the listener time to pick up the phone and scan before the first
                    // passport read. Each token only has a few reads in total.
                    nextPollAt: now() + 12000,
                    throttleCount: 0,
                    throttledUntil: 0,
                    lastState: 'waiting',
                });
                return { key };
            }
            case 'login_qr_create': {
                const rec = qrSessions.get(String(params.key));
                if (!rec) throw new Error('Qishui QR session is gone');
                return { imageUrl: `data:image/png;base64,${rec.session.qrcodePngBase64}` };
            }
            case 'login_qr_check':
                return checkQr(params.key);
            case 'login_qr_cancel':
                qrSessions.delete(String(params.key));
                return true;
            case 'logout':
                cookie = '';
                saveSession('');
                detailCache.clear();
                playlistCache.clear();
                return true;
            case 'search': {
                await readySigned();
                const result = await QS.searchTrack(native, dev, cookie, String(params.query || ''), {
                    limit: Math.max(1, Math.min(50, Number(params.limit) || 20)),
                    cursor: Math.max(0, Number(params.offset) || 0),
                });
                return { items: result.items, hasMore: result.hasMore, nextCursor: result.nextCursor };
            }
            case 'song_detail': {
                const detail = await getDetail(String(params.id));
                return {
                    track: detail.track,
                    videoDurationMs: detail.videoDurationMs,
                    lyricContent: detail.lyricContent,
                    lyricType: detail.lyricType,
                };
            }
            case 'audio':
                return resolveAudio(String(params.id), String(params.quality || 'high'), {
                    playCount: Number(params.playCount) || 0,
                    limitedFreeInfo: params.limitedFreeInfo && typeof params.limitedFreeInfo === 'object'
                        ? params.limitedFreeInfo
                        : null,
                });
            case 'lyrics': {
                const detail = await getDetail(String(params.id));
                return {
                    content: detail.lyricContent || '',
                    type: detail.lyricType || '',
                    lrc: QS.toLrc(detail.lyricContent || ''),
                };
            }
            case 'account_playlists':
                await readySigned();
                return { items: await QS.getMyPlaylists(native, dev, cookie) };
            case 'recommended_playlists':
                await readySigned();
                return { items: await QS.getRecommendedPlaylists(native, dev, cookie) };
            case 'playlist_square':
                await readySigned();
                return { items: await QS.getPlaylistSquare(native, dev, cookie, 4) };
            case 'playlist_tracks': {
                const cached = await playlistInfo(params.id);
                const offset = Math.max(0, Number(params.offset) || 0);
                const limit = Math.max(1, Math.min(200, Number(params.limit) || 50));
                return {
                    items: cached.tracks.slice(offset, offset + limit),
                    total: cached.tracks.length,
                    hasMore: offset + limit < cached.tracks.length,
                    nextOffset: offset + Math.min(limit, Math.max(0, cached.tracks.length - offset)),
                };
            }
            case 'liked_ids': {
                const liked = await likedPlaylist();
                if (!liked) return { ids: [], whole: true };
                const cached = await playlistInfo(liked.id);
                return { ids: cached.tracks.map(track => String(track.id)), whole: true };
            }
            case 'personal_fm': {
                await readySigned();
                const seen = new Set();
                const items = [];
                for (let round = 0; round < 5 && items.length < 30; round += 1) {
                    const batch = await QS.getSongTab(native, dev, cookie, 6);
                    for (const item of batch) {
                        if (seen.has(String(item.id))) continue;
                        seen.add(String(item.id));
                        items.push(item);
                    }
                }
                return { items };
            }
            case 'artist_songs': {
                await readySigned();
                const name = String(params.name || '').trim();
                const limit = Math.max(1, Math.min(50, Number(params.limit) || 30));
                const offset = Math.max(0, Number(params.offset) || 0);
                const result = await QS.searchTrack(native, dev, cookie, name, { limit: 50, cursor: 0 });
                const matches = result.items.filter(track => (track.artists || []).some(artist => artist.includes(name)));
                return {
                    items: matches.slice(offset, offset + limit),
                    total: matches.length,
                    hasMore: offset + limit < matches.length,
                    nextOffset: offset + Math.min(limit, Math.max(0, matches.length - offset)),
                };
            }
            case 'artist_albums': {
                await readySigned();
                const name = String(params.name || '').trim();
                const result = await QS.searchTrack(native, dev, cookie, name, { limit: 50, cursor: 0 });
                const albums = new Map();
                for (const track of result.items) {
                    if (!track.albumId || track.albumId === '0') continue;
                    if (!albums.has(track.albumId)) {
                        albums.set(track.albumId, {
                            id: track.albumId,
                            name: track.album || '单曲',
                            coverUrl: track.coverUrl || '',
                            trackCount: 0,
                        });
                    }
                    albums.get(track.albumId).trackCount += 1;
                }
                return { items: [...albums.values()] };
            }
            case 'import_cookie':
                return importCookie(params.dbPath);
            default:
                throw new Error(`Unsupported Qishui operation: ${operation}`);
        }
    };

    return {
        async request(operation, params = {}) {
            if (!OPERATIONS.has(operation)) {
                return { ok: false, error: { code: 'unsupported', message: 'Unsupported Qishui operation' } };
            }
            try {
                return { ok: true, data: await handle(operation, params) };
            } catch (error) {
                const message = String(error?.message || error);
                log.warn(`[Qishui] ${operation} failed: ${message}`);
                return {
                    ok: false,
                    error: {
                        code: error?.code !== undefined ? String(error.code) : 'invalid-response',
                        message,
                    },
                };
            }
        },
        dispose() {
            native.stop();
            try { server?.close(); } catch { }
            server = null;
            serverPort = 0;
        },
    };
}

module.exports = { createQishuiApiBridge, findNativeDir, coverFromUrlCover };
