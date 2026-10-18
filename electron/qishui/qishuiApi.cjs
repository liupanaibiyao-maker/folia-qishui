/**
 * 汽水音乐 API 核心层（Node 侧，跑在 Folia 主进程）
 * ============================================================================
 * 只做三件事：调用汽水公开接口、必要时用原生签名器升级成「登录态 + 全档」请求、
 * 把结果整理成模组内部统一的数据形状。不直接面向宿主（那是 client 的事）。
 *
 * 只有的一条路径（实测**免登录即可用**，扫码只是可选解锁更多权益）：
 *   · GET  /luna/pc/search/track   搜索（签名；Cookie 可选）
 *   · POST /luna/pc/track_v2       播放流 + 歌词（签名；Cookie 可选）
 *   · 签名 X-Helios / X-Medusa 由本机汽水音乐客户端自带的原生模块算（见 native-host.cjs）
 *   · 流是 CENC/AES-128-CTR 加密，密钥 = device.node.decodeSpade(spade_a)
 *   · VIP 曲能否整曲取决于账号本身是否会员，权益由服务端决定，模组不做任何绕过
 *   · 单次失败只影响这一首歌，不拖垮音源
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const fs = require('fs');
const path = require('path');

const API_HOST = 'api.qishui.com';
const AID = '386088';
// 取静态资源（音频流/封面）用的 UA
const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// 客户端 UA：路径 B 的 device_register 用（与官方 PC 端一致，见下）
const CLIENT_VERSION = '3.8.0';
const CLIENT_VERSION_CODE = '30080000';
const CLIENT_UA = 'LunaPC/3.8.0(467160162)';
const CHANNEL = 'official';

const TIMEOUT = 15000;

/* ------------------------------------------------------------------ 极小 HTTP */

function request(url, { method = 'GET', headers = {}, body = null, timeout = TIMEOUT } = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad url')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search, method, headers, timeout,
      },
      (res) => {
        // 音频 CDN 会 302 到另一台节点（实测少数歌因此播放失败）。
        // 手动跟随，保留 Range/UA 等请求头；303 按规范改 GET。
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, url).toString(); }
          catch (e) { return reject(new Error('bad redirect')); }
          const nextMethod = res.statusCode === 303 ? 'GET' : method;
          return request(next, {
            method: nextMethod,
            headers,
            body: nextMethod === 'GET' ? null : body,
            timeout,
          }, redirects - 1).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          buf: Buffer.concat(chunks),
          text: () => Buffer.concat(chunks).toString('utf8'),
        }));
      });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getJson(url, opts) {
  const r = await request(url, opts);
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  try { return JSON.parse(r.text()); } catch (e) { throw new Error('bad json'); }
}

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => k + '=' + encodeURIComponent(v))
    .join('&');
}

/* ------------------------------------------------------------------- 工具 */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 封面：必须带图片处理模板，裸 uri 会 400（实测） */
function coverOf(track, px = 500) {
  if (!track) return '';
  const album = track.album || {};
  // 汽水有一部分曲目（尤其是用户歌单里的翻唱/短视频来源）album.id=0、
  // 没有专辑封面，但歌手头像一定有图。以前只读 album.url_cover，
  // 这些歌在歌单里就变成一整块占位色。按「专辑 → 单曲 → 专辑歌手 →
  // 曲目歌手头像」的顺序兜底，尽量每首歌都有真实封面。
  const covers = [];
  if (album.url_cover && album.url_cover.uri) covers.push(album.url_cover);
  if (track.url_cover && track.url_cover.uri) covers.push(track.url_cover);
  if (album.artist && album.artist.url_cover && album.artist.url_cover.uri) {
    covers.push(album.artist.url_cover);
  }
  for (const a of (track.artists || [])) {
    if (a && a.url_avatar && a.url_avatar.uri) covers.push(a.url_avatar);
  }
  for (const uc of covers) {
    const out = coverFromUrlCover(uc, px);
    if (out) return out;
  }
  // 少数账号型歌手只有现成的头像 URL，没有 uri/template 结构。
  for (const a of (track.artists || [])) {
    const u = a && a.user_info && (a.user_info.medium_avatar_url || a.user_info.thumb_avatar_url);
    if (u && Array.isArray(u.urls) && u.urls[0]) return String(u.urls[0]);
  }
  return '';
}

/** 从 KRC/YRC 逐字文本抽行级纯文本（给非逐字模式用） */
function toLrc(raw) {
  const lines = [];
  for (const line of String(raw || '').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const m = text.match(/^\[(\d+),(\d+)\](.*)$/);
    if (m) {
      const ms = Number(m[1]);
      const value = (m[3].match(/>([^<]*)/g) || []).map((p) => p.slice(1)).join('').replace(/\u200b/g, '').trim();
      if (!value || !Number.isFinite(ms)) continue;
      const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
      const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
      const hh = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
      lines.push(`[${mm}:${ss}.${hh}]${value}`);
      continue;
    }
    if (/^\[(\d+):(\d+(?:\.\d+)?)/.test(text)) lines.push(text);
  }
  return lines.join('\n');
}

function normTrack(track) {
  if (!track || track.id === undefined || track.id === null) return null;
  const artists = (track.artists || [])
    .map((a) => String((a && a.name) || ''))
    .filter(Boolean)
    .filter((name) => !/^(未知艺人|未知歌手|unknown artist)$/i.test(name));
  const album = track.album || {};
  const previewMs = Number((track.preview || {}).duration) || 0;
  return {
    id: String(track.track_id || track.id),
    title: String(track.name || '未知歌曲'),
    artists: artists.length ? artists : ['未知歌手'],
    // album.id=0 是「没有专辑信息」的单曲；给个可读名字，别让详情页空着。
    album: String(album.name || (album.id && String(album.id) !== '0' ? '' : '单曲')),
    albumId: String(album.id || ''),
    // 宿主适配器读的字段名是 coverUrl（见 experimental-JFgkSL6v 的投影函数），
    // 写成 cover 会静默没有封面 —— 别「优化」回去。
    coverUrl: coverOf(track),
    durationMs: Number(track.duration) || 0,
    // preview.duration 是接口明确给出的「可播放片段」长度；整曲为空。
    // Subsonic 侧据此把显示时长改成真实可播长度，避免进度条 4 分钟却 30 秒就停。
    previewMs: previewMs,
    vid: String(track.vid || ''),
    // label_info 里藏着 VIP 标记；只是用来给用户提示，不用于任何绕过
    vip: !!(track.label_info && (track.label_info.only_vip_playable || track.label_info.only_vip_download)),
    // The PC client sends this back as `limited_free_param` after the ad-supported free
    // listening entitlement has been granted. Keep it on the playable so playback can use it.
    limitedFreeInfo: track.limited_free_info && typeof track.limited_free_info === 'object'
      ? track.limited_free_info
      : null,
  };
}

/**
 * video_model（字符串，要再解一层 JSON）→ 统一流列表。
 * 每项：{ quality, url, backup, encrypted, spade_a, size, bitrate, durationMs, expiresAt }
 */
function parseVideoModel(videoModelStr) {
  let out = [];
  let videoDurationMs = 0;
  try {
    const vm = JSON.parse(videoModelStr);
    videoDurationMs = Math.round(Number(vm.video_duration || 0) * 1000) || 0;
    const expire = Number(vm.url_expire);
    const expiresAt = Number.isFinite(expire) ? expire * 1000 : undefined;
    out = (vm.video_list || []).map((v) => {
      const meta = v.video_meta || {};
      const enc = v.encrypt_info || {};
      return {
        quality: String(meta.quality || ''),
        vtype: String(meta.vtype || ''),
        bitrate: Number(meta.bitrate) || 0,
        size: Number(meta.size) || 0,
        url: v.main_url || '',
        backup: v.backup_url || '',
        // file_hash / file_id 是这条流的稳定身份（换签名地址不变）：拿它做解密缓存键
        // encrypt 标记 + spade_a 同时存在才真需要解密
        encrypted: !!(enc.spade_a && String(enc.spade_a).trim()),
        spade_a: String(enc.spade_a || ''),
        streamKey: String(meta.file_hash || meta.file_id || ''),
        expiresAt,
      };
    }).filter((i) => i.url);
  } catch (e) { /* 结构变了就当没有 */ }
  return { items: out, videoDurationMs };
}

/** url_player_info（VOD 预签名 GetPlayInfo）→ 同一形状，作为 video_model 缺失时的兜底 */
async function parseUrlPlayerInfo(infoUrl) {
  let out = [];
  let videoDurationMs = 0;
  try {
    const gi = await getJson(String(infoUrl), { headers: { 'user-agent': CLIENT_UA } });
    const list = ((((gi.Result || {}).Data) || {}).PlayInfoList) || [];
    out = list.map((p) => ({
      quality: String(p.Quality || ''),
      vtype: String((p.Format || '').toLowerCase()),
      bitrate: Number(p.Bitrate) || 0,
      size: Number(p.Size) || 0,
      url: p.MainPlayUrl || p.BackupPlayUrl || '',
      backup: p.BackupPlayUrl || '',
      streamKey: String(p.FileHash || p.FileId || ''),
      encrypted: !!(p.PlayAuth && String(p.PlayAuth).trim()),
      spade_a: String(p.PlayAuth || ''),
      expiresAt: Number.isFinite(Number(p.UrlExpire)) ? Number(p.UrlExpire) * 1000 : undefined,
    })).filter((i) => i.url);
    if (list[0] && list[0].Duration) videoDurationMs = Math.round(Number(list[0].Duration) * 1000) || 0;
  } catch (e) { /* 保留空 */ }
  return { items: out, videoDurationMs };
}

/* ---------------------------------------------------------------- 设备身份 */

/**
 * 以本机汽水客户端的原生模块注册一个设备身份（did / iid），拿到后落盘复用。
 * 这一步与其它播放器那边「设备初始化」等价：签名器需要一个 deviceId 才能产出
 * 有效的 X-Helios/X-Medusa（实测 init({deviceId}) 不先跑，签名头是空串）。
 */
async function registerDevice(native) {
  const serial = await native.call('serial').catch(() => '');
  const cdid = crypto.randomUUID();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  const payload = {
    header: {
      // 服务端只认这套 PC 申报格式（实测 os 填 'macOS'/'darwin' 会返回 device_id:0）。
      // 它只是「一个 PC 端 Luna 客户端」的设备登记，与账号无关，也不影响接口取值。
      device_id: '', install_id: '', os: 'Windows', device_platform: 'PC',
      sdk_version: '1.0', sdk_version_code: 1, aid: AID,
      mc: '00:00:00:00:00:00', channel: CHANNEL, package: 'com.soda.music',
      language: 'zh-CN', app_version: CLIENT_VERSION, os_version: os.release(),
      device_model: 'no detected', time_zone: tz, tz_name: tz, tz_offset: 0,
      resolution: 'no detected', app_region: 'cn', app_language: 'zh-CN',
      display_name: '汽水音乐', pc_uuid: cdid, pc_serial: serial,
    },
    gen_time: Date.now(), magic_tag: 'ss_app_log',
  };
  let body;
  try {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
    body = Buffer.from((await native.call('decorate', { b64: gz.toString('base64') })).b64, 'base64');
  } catch (e) {
    // device.node 不可用时无法装饰请求体 —— 只能沿用客户端已有的身份
    throw new Error('无法装饰设备注册请求（device.node 不可用）：' + e.message);
  }
  const q = qs({ aid: AID, channel: CHANNEL, os: os.type(), os_version: os.release(), device_platform: 'PC', app_version: CLIENT_VERSION });
  const r = await request(`https://${API_HOST}/service/2/desktop/device_register/?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'user-agent': CLIENT_UA },
    body,
  });
  let j; try { j = JSON.parse(r.text()); } catch (e) { throw new Error('device_register 响应不是 JSON'); }
  if (!j.device_id_str) throw new Error('设备注册失败：' + r.text().slice(0, 160));
  return { did: String(j.device_id_str), iid: String(j.install_id_str), cdid, serial };
}

/* ------------------------------------------------------------- 签名请求构造 */

/** 与官方客户端一致的公共 query 参数（PC 端形态） */
function baseQuery(dev) {
  return {
    aid: AID, app_name: 'luna_pc', region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '',
    device_id: dev.did, cdid: dev.cdid || '', iid: dev.iid, version_name: CLIENT_VERSION, version_code: CLIENT_VERSION_CODE,
    channel: CHANNEL, build_mode: 'master', network_carrier: '', ac: 'wifi',
    tz_name: 'Asia/Shanghai', resolution: '',
    // 本机是 macOS：实测 mac/pc 这组取值能出整曲（Windows 版模组用 windows/Windows）
    device_platform: 'mac', device_type: 'pc',
  };
}

/**
 * 给 URL 加签。签名输入是「参与签名的 header 行」，输出按 name\r\nvalue 交替排布。
 * 这一步全在子进程里算，主进程不碰原生代码。
 */
async function signedHeaders(native, url, body, cookie) {
  const h = { 'user-agent': CLIENT_UA, 'content-type': 'application/json; charset=utf-8' };
  if (cookie) h.cookie = cookie;
  if (body) h['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
  const lines = Object.entries(h).map(([k, v]) => k + '\r\n' + v).join('\r\n');
  const raw = await native.call('sign', { url, lines });
  const parts = String(raw).split('\r\n').filter((t) => t.trim());
  for (let i = 0; i < parts.length / 2; i++) h[parts[i * 2]] = parts[i * 2 + 1];
  return h;
}

/* ------------------------------------------------------------------ 各接口 */

/** 搜索（签名 PC 接口；免登录可用，Cookie 可选） */
async function searchTrack(native, dev, cookie, query, { limit = 20, cursor = 0 } = {}) {
  const q = Object.assign(baseQuery(dev), { q: String(query || '').trim(), cursor: String(cursor), count: '20' });
  const url = `https://${API_HOST}/luna/pc/search/track?${qs(q)}`;
  const headers = await signedHeaders(native, url, null, cookie);
  const j = await getJson(url, { headers });
  const items = [];
  const seen = new Set();
  let hasMore = false;
  let nextCursor = null;
  for (const g of (j.result_groups || [])) {
    if (!/track/i.test(String(g.id || ''))) continue;
    hasMore = hasMore || g.has_more === true;
    if (g.next_cursor !== undefined) nextCursor = String(g.next_cursor);
    for (const entry of (g.data || [])) {
      const t = (entry && entry.entity && entry.entity.track)
        || (entry && entry.entity && entry.track_wrapper && entry.track_wrapper.track)
        || (entry && entry.track);
      const song = normTrack(t);
      if (song && !seen.has(song.id)) { seen.add(song.id); items.push(song); }
    }
  }
  // 接口每次固定回 20 条，按宿主给的 limit 裁一刀，否则 nextOffset 会跳号
  const capped = items.slice(0, Math.max(1, limit));
  if (capped.length < items.length) hasMore = true;
  return { items: capped, hasMore, nextCursor };
}

/**
 * track_v2 —— 取播放流 + 歌词（签名 [+ 登录 Cookie]）。
 */
async function trackV2(native, dev, cookie, trackId, options = {}) {
  const payload = {
    track_id: String(trackId), media_type: 'track', queue_type: 'daily_mix', scene_name: 'track_reco',
    play_count: Math.max(0, Number(options.playCount) || 0),
  };
  const limited = options.limitedFreeInfo;
  if (limited && limited.limited_free === true) {
    payload.limited_free_param = {
      from_other_queue: false,
      is_login_support: false,
      is_logout_support: false,
      ...limited,
    };
  }
  const body = JSON.stringify(payload);
  const url = `https://${API_HOST}/luna/pc/track_v2?${qs(baseQuery(dev))}`;
  const headers = await signedHeaders(native, url, body, cookie);
  const j = await getJson(url, { method: 'POST', headers, body });
  if (!j.track || j.track.id === undefined) {
    const msg = ((j.status_info || {}).status_msg) || '无 track';
    throw new Error('track_v2：' + msg);
  }
  const player = j.track_player || {};
  let parsed = { items: [], videoDurationMs: 0 };
  if (player.video_model) parsed = parseVideoModel(player.video_model);
  if (!parsed.items.length && player.url_player_info) parsed = await parseUrlPlayerInfo(player.url_player_info);
  const lyric = j.lyric || {};
  return {
    track: normTrack(j.track),
    items: parsed.items,
    videoDurationMs: parsed.videoDurationMs,
    // 有整曲才信接口给的时长；video_model 只有试听时它是 29s 这种
    lyricContent: typeof lyric.content === 'string' ? lyric.content : '',
    lyricType: String(lyric.type || ''),
    expireAt: Number(j.expire_at) ? Number(j.expire_at) * 1000 : undefined,
    source: 'signed',
  };
}

/* ---------------------------------------------------------------- 登录态 */

/**
 * Passport 扫码登录。
 * ⚠️ 这里的一组参数与请求头是**实测必须**的，少一样就会拿到 error_code=7 / 「繁忙」：
 *   · passport_jssdk_*、p_js_v/p_js_t/p_zt/p_ver/p_bd、account_sdk_source、request_host
 *   · device_id / install_id / did / iid 必须与签名用的设备身份一致（复用已注册的 did/iid）
 *   · bd-ticket-guard-* 四件套（字节 Passport 的风控要求）
 *   · UA 用官方 PC 客户端那串（SodaMusic/… TTElectron/…），不是浏览器 UA
 * 另外 check_qrconnect **不能快于 2 秒一次**，太快就是频控。
 */
const QR_BASE = `https://${API_HOST}/passport/web`;
const WEB_LOGIN_UA = 'Mozilla/5.0';
const PASSPORT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.1.0 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36';
const GUARD_HEADERS = {
  'bd-ticket-guard-version': '2',
  'bd-ticket-guard-iteration-version': '2',
  'bd-ticket-guard-ree-public-key': 'BAnIxKL96Jby5x+Um9i7HZ2c8O6lfZJRxm6yk73Mqcr06l2qIw2iqu2Mtm3U/6OI98usukA9dqxUlsctVWK9rKA=',
  'bd-ticket-guard-server-cert-sn': '0',
};
const QR_QUERY_ORDER = ['passport_jssdk_version', 'passport_jssdk_type', 'is_from_ttaccountsdk', 'aid', 'language',
  'account_sdk_source', 'p_js_v', 'p_js_t', 'p_zt', 'p_ver', 'request_host', 'p_bd', 'biz_trace_id',
  'is_new_login', 'is_from_iesaccountsaas', 'device_id', 'install_id', 'did', 'iid', 'device_platform', 'version_code'];
const QR_FORM_ORDER = ['need_logo', 'need_short_url', 'is_frontier', 'token', 'is_new_login', 'next',
  'passport_mfa_retry_tag', 'std_verify_flow_id', 'std_verify_scene', 'std_verify_template', 'std_verify_token', 'std_verify_type', 'std_verify_way'];

function passportQuery(dev, extra) {
  const biz = crypto.randomBytes(4).toString('hex');
  const v = {
    passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1', aid: AID,
    language: 'zh', account_sdk_source: 'web', p_js_v: '2.4.13', p_js_t: 'pro', p_zt: '3.3.5', p_ver: '1.0.29',
    request_host: 'app%3A%2F%2Fresources', p_bd: '1.0.0.41', biz_trace_id: biz, is_new_login: '1',
    is_from_iesaccountsaas: '1', device_id: dev.did, install_id: dev.iid, did: dev.did, iid: dev.iid,
    device_platform: 'PC', version_code: '3.3.0',
  };
  Object.assign(v, extra || {});
  const parts = [];
  const seen = new Set();
  for (const k of QR_QUERY_ORDER.concat(Object.keys(extra || {}))) {
    if (v[k] === undefined || seen.has(k)) continue;
    seen.add(k); parts.push(k + '=' + v[k]);
  }
  for (const k of Object.keys(v).sort()) if (!seen.has(k)) parts.push(k + '=' + v[k]);
  return parts.join('&');
}

/** 二维码登录走官方网页账号 SDK 的 web 参数；它不需要 PC 设备身份。 */
function webPassportQuery(extra = {}) {
  const params = new URLSearchParams({
    aid: AID,
    passport_jssdk_version: '2.4.13',
    passport_jssdk_type: 'normal',
    is_from_ttaccountsdk: '1',
    next: `https://${API_HOST}`,
    need_logo: 'false',
    need_short_url: 'false',
    is_new_login: '1',
    device_platform: 'web',
    biz_name: 'quic',
    capapp: '0',
    ...extra,
  });
  return params.toString();
}

function encodeOrderedForm(values, order) {
  const parts = []; const seen = new Set();
  for (const k of order) { if (values[k] === undefined || seen.has(k)) continue; seen.add(k); parts.push(k + '=' + values[k]); }
  for (const k of Object.keys(values).sort()) if (!seen.has(k)) parts.push(k + '=' + values[k]);
  return parts.join('&');
}

function cookieFromSetCookie(list, existing = {}) {
  const jar = { ...existing };
  for (const sc of list || []) {
    // The first capture is the cookie name. A stray escape here turns the class into a literal
    // `[` and silently drops every Set-Cookie, so the QR session can never learn its sessionid.
    const m = /^([^=]+)=([^;]*)(.*)$/.exec(sc);
    if (!m) continue;
    if (/max-age=0\b/i.test(sc)) { delete jar[m[1]]; continue; }
    if (m[2]) jar[m[1]] = m[2];
  }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
const hasSession = (jar) => !!(jar.sessionid || jar.sessionid_ss || jar.sid_tt);

/** 建一次扫码会话：二维码图片（base64 PNG）+ token + csrf + 本会话 cookie 罐 */
async function qrCreate(dev, debug) {
  const q = webPassportQuery();
  const r = await request(`${QR_BASE}/get_qrcode/?${q}`, {
    headers: { 'user-agent': WEB_LOGIN_UA, referer: 'https://www.qishui.com/', accept: 'application/json, text/javascript' },
  });
  if (debug) debug('get_qrcode HTTP ' + r.status + ' body=' + String(r.text()).slice(0, 260));
  let j; try { j = JSON.parse(r.text()); } catch (e) { throw new Error('get_qrcode 响应不是 JSON（HTTP ' + r.status + '）'); }
  const d = j.data || {};
  if (Number(d.error_code) !== 0) {
    const err = new Error('get_qrcode：error_code=' + d.error_code + ' ' + (d.description || j.message || ''));
    err.code = Number(d.error_code);
    throw err;
  }
  if (!d.token) throw new Error('get_qrcode 没有返回 token');
  const jar = cookieFromSetCookie(r.headers['set-cookie']);
  const png = String(d.qrcode || '').replace(/^data:image\/png;base64,/, '');
  if (!png) throw new Error('接口没返回二维码图片');
  let hint = '';
  // copywriting.desc 里带 [color=red]…[/] 这类标记，去掉后才是给人看的一句话
  try { hint = String(JSON.parse(d.copywriting || '{}').desc || '').replace(/\[color=[^\]]*\]/g, '').replace(/\[\/\]/g, ''); } catch (e) { }
  return {
    token: String(d.token), csrf: jar.passport_csrf_token || '', jar,
    qrcodePngBase64: png, hint,
    expiresAt: Number(d.expire_time) ? Number(d.expire_time) * 1000 : undefined,
  };
}

/**
 * 轮询扫码状态。调用方要保证 ≥2 秒间隔。
 * error_code=7 是频控：返回 throttled 让调用方退避，**不算失败**。
 */
async function qrPoll(dev, session, debug) {
  const q = webPassportQuery({
    aid: AID,
    passport_jssdk_version: '2.4.13',
    is_from_ttaccountsdk: '1',
    device_platform: 'web',
    next: `https://${API_HOST}`,
    biz_name: 'quic',
  });
  const form = new URLSearchParams({
    need_logo: 'false',
    need_short_url: 'false',
    is_frontier: 'false',
    token: session.token,
    is_new_login: '1',
    next: `https://${API_HOST}`,
    aid: AID,
  }).toString();
  const r = await request(`${QR_BASE}/check_qrconnect/?${q}`, {
    method: 'POST',
    headers: {
      'user-agent': WEB_LOGIN_UA, referer: 'https://www.qishui.com/', accept: 'application/json, text/javascript',
      'content-type': 'application/x-www-form-urlencoded',
      'x-tt-csrf-token': session.csrf || '',
      cookie: cookieHeader(session.jar),
    },
    body: form,
  });
  if (debug) debug('check_qrconnect HTTP ' + r.status + ' body=' + String(r.text()).slice(0, 300)
    + ' set-cookie=' + (r.headers['set-cookie'] || []).map((x) => String(x).split('=')[0]).join(','));
  let j; try { j = JSON.parse(r.text()); } catch (e) { return { status: 'waiting', message: 'poll 响应非 JSON（HTTP ' + r.status + '）' }; }
  const d = j.data || {};
  session.jar = cookieFromSetCookie(r.headers['set-cookie'], session.jar);
  const code = Number(d.error_code);
  if (hasSession(session.jar)) return { status: 'success', cookie: cookieHeader(session.jar), jar: { ...session.jar } };
  if (code === 7) return { status: 'waiting', throttled: true, message: '轮询太快，退避中' };
  // 部分确认响应把 status 放在 data 外层（music-lib 的 sodaQRConnectResponse 同样兼容两种）
  const st = String(d.status || j.data && j.data.status || '').toLowerCase();
  if (st === 'expired') return { status: 'expired', message: '二维码已过期，请重新获取' };
  if (st === 'scanned') return { status: 'scanned', message: '已扫码，请在手机上确认' };
  if (st === 'confirmed') return { status: 'confirmed', message: '已确认，正在换取登录态' };
  if (String(d.account_flow || '').toLowerCase() === 'verify' || code === 2046) {
    return { status: 'failed', mfa: true, message: '该账号需要二次验证（短信/上行短信）。请改用已登录的抖音 APP 重新扫码试试。' };
  }
  if (code && code !== 0) return { status: 'failed', message: String(d.description || j.message || '登录失败（error_code=' + code + '）') };
  return { status: 'waiting', message: String(d.description || j.message || '') };
}

/** 登录态是否有效 + 账号概况（登录后拿一次，用于把权益如实显示给用户） */
async function accountInfo(native, dev, cookie) {
  const url = `https://${API_HOST}/luna/pc/me?${qs(baseQuery(dev))}`;
  const headers = await signedHeaders(native, url, null, cookie);
  const j = await getJson(url, { headers });
  const info = j.my_info || j.user || j.data || {};
  // 汽水的头像字段是对象：larger_avatar_url = { uri, urls:[签名 URL] }。
  // 旧代码只读 avatar_uri/avatar_url 字符串，所以面板一直拿不到头像。
  const av = info.larger_avatar_url || info.avatar_url || info.avatar_larger ||
    info.avatar_medium || info.avatar_thumb || null;
  let avatarUrl = '';
  if (typeof av === 'string') avatarUrl = av;
  else if (av && Array.isArray(av.urls) && av.urls.length) avatarUrl = String(av.urls[0] || '');
  else if (av && av.uri) avatarUrl = String(av.uri);
  if (!avatarUrl) avatarUrl = String(info.avatar_uri || info.avatarUri || info.avatar || '');
  return {
    raw: j,
    isVip: info.is_vip === true || info.vip === true,
    nickname: String(info.nickname || info.name || ''),
    avatarUrl,
  };
}

/* ------------------------------------------------------- 曲库 / 歌单数据 */

/**
 * 带签名的 PC 接口 GET。所有歌单、推荐流接口都必须经过这里：
 * 不带 X-Helios / X-Medusa 时服务端会给 200 + 空 body，很容易被误判成“没有数据”。
 */
async function pcGet(native, dev, cookie, pathname, params = {}) {
  const url = `https://${API_HOST}${pathname}?${qs(Object.assign(baseQuery(dev), params))}`;
  const headers = await signedHeaders(native, url, null, cookie);
  const j = await getJson(url, { headers });
  const code = Number(j && j.status_code);
  if (code && code !== 0) {
    const msg = String((j.status_info && j.status_info.status_msg) || ('status_code=' + code));
    const err = new Error(msg);
    err.code = code;
    throw err;
  }
  return j;
}

async function pcPost(native, dev, cookie, pathname, payload) {
  const body = JSON.stringify(payload || {});
  const url = `https://${API_HOST}${pathname}?${qs(baseQuery(dev))}`;
  const headers = await signedHeaders(native, url, body, cookie);
  const j = await getJson(url, { method: 'POST', headers, body });
  const code = Number(j && j.status_code);
  if (code && code !== 0) {
    const msg = String((j.status_info && j.status_info.status_msg) || ('status_code=' + code));
    const err = new Error(msg);
    err.code = code;
    throw err;
  }
  return j;
}

/** 歌单封面与曲目封面用同一套 CDN 规则：裸 uri 会 404，必须带模板后缀。 */
function coverFromUrlCover(uc, px = 500) {
  if (!uc || !uc.uri) return '';
  const base = ((uc.urls && uc.urls[0]) || 'https://p3-luna.douyinpic.com/img/');
  const raw = base + uc.uri;
  if (/~tplv|~crop/.test(raw)) return raw.replace(/(crop-center:)\d+:\d+/, '$1' + px + ':' + px);
  return raw + '~' + (uc.template_prefix || 'tplv-b829550vbb') + '-crop-center:' + px + ':' + px + '.jpg';
}

function normPlaylist(p) {
  if (!p || p.id === undefined || p.id === null) return null;
  const daily = p.daily_playlist_info || {};
  return {
    id: String(p.id),
    name: String(daily.title || p.title || p.name || '未命名歌单'),
    count: Number(p.count_tracks || p.track_count || 0) || 0,
    coverUrl: coverFromUrlCover(p.url_cover, 800),
    description: String(p.description || (daily.sub_title) || ''),
  };
}

/** 我的歌单（必须登录；未登录返回 1000016） */
async function getMyPlaylists(native, dev, cookie) {
  const j = await pcGet(native, dev, cookie, '/luna/pc/me/playlist', { cursor: '0', count: '100' });
  return (j.playlists || (j.data && j.data.playlists) || []).map(normPlaylist).filter(Boolean);
}

/** 首页推荐歌单（必须登录） */
async function getRecommendedPlaylists(native, dev, cookie) {
  let j = null;
  for (const p of ['/luna/pc/me/playlist/recommend', '/luna/me/playlist/recommend']) {
    try {
      j = await pcGet(native, dev, cookie, p, { count: '20' });
      if ((j.playlists || []).length) break;
    } catch (e) { j = null; }
  }
  return ((j && j.playlists) || []).map(normPlaylist).filter(Boolean);
}

/** 歌单广场（免登录可用）。offset 是滚动推荐，翻页会不断给新歌单。 */
async function getPlaylistSquare(native, dev, cookie, pages = 4) {
  const out = [];
  const seen = new Set();
  const PAGE = 20;
  for (let i = 0; i < Math.max(1, pages); i++) {
    let j;
    try {
      j = await pcPost(native, dev, cookie, '/luna/pc/feed/playlist-square', {
        count: PAGE, offset: i * PAGE, is_first_request: i === 0,
      });
    } catch (e) {
      if (i === 0) throw e;
      break;
    }
    const items = (j && j.items) || [];
    if (!items.length) break;
    let added = 0;
    for (const it of items) {
      const raw = (it.entity && it.entity.playlist) || it.playlist || null;
      const p = normPlaylist(raw);
      if (!p || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      added++;
    }
    if (!added) break;
  }
  return out;
}

/** 推荐流（免登录可用）。每次固定 6 首且没有 cursor，只能反复拉 + 去重。 */
async function getSongTab(native, dev, cookie, count = 6) {
  const j = await pcPost(native, dev, cookie, '/luna/pc/feed/song-tab', {
    count: Math.max(1, Math.min(6, Number(count) || 6)), is_first_request: true,
  });
  const out = [];
  for (const it of (j && j.items) || []) {
    const t = (it.entity && it.entity.track_wrapper && it.entity.track_wrapper.track)
      || (it.entity && it.entity.track) || null;
    const song = normTrack(t);
    if (song) out.push(song);
  }
  return out;
}

/** 歌单详情（免登录可用）。100 首一页，最多翻 40 页。 */
async function getPlaylistDetail(native, dev, cookie, playlistId, maxPages = 40) {
  const out = [];
  const seen = new Set();
  let cursor = '0';
  for (let page = 0; page < maxPages; page++) {
    const j = await pcGet(native, dev, cookie, '/luna/pc/playlist/detail', {
      playlist_id: String(playlistId), cursor: String(cursor), count: '100',
    });
    for (const m of (j.media_resources || [])) {
      const t = (m.entity && m.entity.track_wrapper && m.entity.track_wrapper.track)
        || (m.entity && m.entity.track) || null;
      const song = normTrack(t);
      if (song && !seen.has(song.id)) { seen.add(song.id); out.push(song); }
    }
    if (!j.has_more || j.next_cursor === undefined || j.next_cursor === null) break;
    cursor = String(j.next_cursor);
  }
  return out;
}

/* ---------------------------------------------------------------- 音频流 */


/* ------------------------------------------------------- 官方客户端 Cookie 导入 */
/**
 * 备用登录通道：用户在官方「汽水音乐」客户端里登录后，把它的 Chromium Cookies
 * 里的登录态导入本模组（社区 Windows 模组的同款思路，macOS 等价实现）。
 * 适用场景：passport 网页扫码被平台门禁挡住（如 error_code=4031）时。
 * 隐私边界：只读汽水自家域（.qishui.com / .douyin.com）的 Cookie，读到的登录态
 * 立即用 safeStorage 加密落本机，不上传任何第三方。
 */
const COOKIE_IMPORT = {
  // 官方客户端可能的 userData 目录（官网版非沙盒 / App Store 版沙盒）
  userDataDirs() {
    const h = os.homedir();
    const out = [];
    if (process.platform === 'darwin') {
      const sup = path.join(h, 'Library', 'Application Support');
      out.push(path.join(sup, 'SodaMusic'), path.join(sup, '汽水音乐'));
      out.push(path.join(h, 'Library', 'Containers', 'com.soda.music', 'Data', 'Library', 'Application Support', 'SodaMusic'));
    } else if (process.platform === 'win32') {
      const roam = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
      const local = process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local');
      out.push(path.join(roam, 'SodaMusic'), path.join(roam, '汽水音乐'), path.join(local, 'SodaMusic'));
    }
    return out;
  },
  cookieDbPath() {
    for (const dir of COOKIE_IMPORT.userDataDirs()) {
      const p = path.join(dir, 'Cookies');
      try { if (fs.existsSync(p)) return p; } catch (e) { }
    }
    return null;
  },
  /** macOS：钥匙串 'Electron Safe Storage' / 'SodaMusic Safe Storage' → PBKDF2 → AES-128-CBC */
  async decryptValue(enc, { security, pbkdf2, decipher }) {
    if (!enc || enc.length < 3) return '';
    if (enc[0] === 0x76 && enc[1] === 0x31 && enc[2] === 0x30) { // 'v10'
      let keyHex = '';
      try {
        let sec = security || null;   // 测试可注入
        if (!sec) {
          const { execFile } = require('child_process');
          for (const svc of ['Electron Safe Storage', 'SodaMusic Safe Storage', 'Chromium Safe Storage']) {
            sec = await new Promise((res) => {
              execFile('/usr/bin/security', ['find-generic-password', '-s', svc, '-w'],
                (e, o) => res(e ? null : String(o).trim()));
            });
            if (sec) break;
          }
        }
        if (!sec) return '';
        keyHex = pbkdf2(sec, 'saltysalt', 1003, 16, 'sha1').toString('hex');
      } catch (e) { return ''; }
      const data = enc.subarray(3);
      const iv = Buffer.alloc(16, 0x20); // 空格填充
      try {
        const dec = decipher('aes-128-cbc', Buffer.from(keyHex, 'hex'), iv, data);
        let out = dec.toString('utf8');
        // PKCS7 去填充后尾部可能有 padding 字节：截掉不可见尾巴
        out = out.replace(/[\u0000-\u001f]+$/,'').trim();
        return out;
      } catch (e) { return ''; }
    }
    return enc.toString('utf8'); // 未加密明文
  },
};

module.exports = {
  COOKIE_IMPORT,
  WEB_UA, CLIENT_UA, AID, API_HOST,
  searchTrack, trackV2, registerDevice, baseQuery, signedHeaders,
  qrCreate, qrPoll, accountInfo,
  pcGet, pcPost, coverFromUrlCover, normPlaylist,
  getMyPlaylists, getRecommendedPlaylists, getPlaylistSquare, getSongTab, getPlaylistDetail,
  parseVideoModel, toLrc, normTrack, coverOf, sleep, request, getJson, qs, cookieFromSetCookie,
};
