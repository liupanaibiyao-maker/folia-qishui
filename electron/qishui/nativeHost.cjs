/**
 * 原生签名宿主（独立子进程）
 * ============================================================================
 * bdms.node / device.node 是「汽水音乐」PC 客户端自带的字节安全组件（MetaSec / mssdk），
 * 负责两件事：给 api.qishui.com 的请求算 X-Helios / X-Medusa 签名头，以及解出音频的
 * CENC AES-CTR 密钥（spade_a → key）。
 *
 * 为什么放在子进程里：
 *   · 它们不属于本模组的代码。一旦在 Folia 主进程里 dlopen，就等于把一份外部原生代码
 *     塞进宿主主进程 —— 同权限、同地址空间、同一个崩溃域。
 *   · 加载它们需要改 process.env.PATH 和 cwd（libMetaSecML.dylib 按 @loader_path 找），
 *     这会污染主进程环境。
 * 子进程只做三件事：算签名 / 取设备序列号并注册设备身份 / 解 spade 密钥。
 * 对外只有一个 JSON-RPC（process.send），入参出参全是可序列化字符串。
 *
 * 这些文件**不随模组分发**，从用户自己安装的汽水音乐客户端目录里探测出来。
 * 客户端没装或没跑过 → 本模组的「签名档」直接不可用，退回匿名明文流，不影响其它功能。
 *
 * 不上报、不联网、不写盘。
 */
'use strict';

const path = require('path');

let dir = '';
let bdms = null;
let devn = null;

function dlopen(p) {
  const m = { exports: {} };
  process.dlopen(m, p);   // 只在**本子进程**里加载外部原生代码
  return m.exports;
}

/** 载入原生模块。PATH / cwd 的改动只作用于本子进程。 */
function boot(nativeDir) {
  dir = String(nativeDir || '');
  if (!dir) throw new Error('native dir is empty');
  process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
  try { process.chdir(dir); } catch (e) { /* 改不动也不致命，PATH 已够 */ }
  bdms = dlopen(path.join(dir, 'bdms.node'));
  try { devn = dlopen(path.join(dir, 'device.node')); } catch (e) { devn = null; }
  return { hasBdms: !!bdms, hasDevice: !!devn };
}

const handlers = {
  /** 初始化签名器。不 init 的话 X-Helios / X-Medusa 是空串，签名接口直接空响应。 */
  init(a) {
    if (!bdms) throw new Error('bdms 未加载');
    bdms.init({ deviceId: String((a && a.deviceId) || '') });
    return true;
  },
  /** 算签名头：返回原始多行文本，由调用方按 name\r\nvalue 解析成 header。 */
  sign(a) {
    if (!bdms) throw new Error('bdms 未加载');
    return String(bdms.generateHttpSignatureHeaders(String(a.url || ''), String(a.lines || '')));
  },
  /** 机器序列号（设备注册用）。取不到回空串，不抛。 */
  serial() {
    if (!devn) return '';
    try { return String(devn.getSerial() || '').replace(/\0+$/, ''); } catch (e) { return ''; }
  },
  /** applog 装饰：设备注册请求体要经过它，入参出参都是二进制，走 base64。 */
  decorate(a) {
    if (!devn) throw new Error('device 模块未加载');
    const out = devn.applogDecorated(Buffer.from(String(a.b64 || ''), 'base64'));
    return { b64: Buffer.from(out).toString('base64') };
  },
  /** 解 spade_a → 音频解密密钥。 */
  decodeSpade(a) {
    if (!devn) throw new Error('device 模块未加载');
    const k = devn.decodeSpade(String(a.spade || ''));
    return Buffer.isBuffer(k)
      ? { kind: 'buffer', b64: k.toString('base64') }
      : { kind: 'string', text: String(k) };
  },
};

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object' || msg.id === undefined) return;
  const { id, cmd, args } = msg;
  try {
    if (cmd === 'boot') { process.send({ id, ok: true, result: boot(args && args.dir) }); return; }
    if (cmd === 'ping') { process.send({ id, ok: true, result: dir }); return; }
    const fn = handlers[cmd];
    if (!fn) throw new Error('unknown native op: ' + String(cmd));
    process.send({ id, ok: true, result: fn(args || {}) });
  } catch (e) {
    process.send({ id, ok: false, error: (e && e.message) || String(e) });
  }
});

// 父进程没了就自己退出，别留孤儿
process.on('disconnect', () => process.exit(0));
