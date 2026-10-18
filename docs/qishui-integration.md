# Folia 汽水音乐源码集成手册（v0.7.21）

日期：2026-10-18  
目标：把汽水音乐接进 Folia 源码，支持搜索、曲库墙、账号歌单、完整/试听播放、KRC 逐字歌词、扫码登录和本地客户端导入。

## 0. 最终交付物

- 源码：当前 GitHub 仓库根目录（Folia 0.7.21）
- 构建产物：`release/mac-arm64/Folia.app`
- 安装位：`/Applications/Folia.app`
- 最终 DMG：GitHub Releases 中的 `Folia-0.7.21-arm64-qishui.dmg`
- 旧外置 mod：已在 `~/Library/Application Support/Folia/mod-system.json` 禁用 `folia-qishui`，保留 `auto-skip`
- 本地登录 Cookies 副本：`~/Library/Application Support/Folia/qishui/cookies.sqlite`
- 扫码日志：`~/Library/Application Support/Folia/qishui/qr.log`

## 1. 源码结构

新增/主要修改：

- `src/services/onlineMusic/qishui/qishuiProvider.ts`：Omni provider，搜索/播放/歌词/账号/歌单/歌手/推荐/探索。
- `src/services/onlineMusic/qishui/qishuiTransport.ts`：渲染层 IPC 边界和数据类型。
- `src/services/onlineMusic/qishui/qishuiNormalize.ts`：歌曲/用户/歌单归一化，保留 `limitedFreeInfo`。
- `src/services/onlineMusic/qishui/qishuiLyrics.ts`：KRC → 逐字歌词，LRC 回退。
- `electron/qishui/qishuiApi.cjs`：汽水 API、Passport 扫码、签名请求、CVM 流解析。
- `electron/qishui/qishuiApiBridge.cjs`：主进程桥、登录态、二维码轮询、设备轮换、CENC 解密、回环音频服务。
- `electron/qishui/nativeHost.cjs`：子进程加载官方客户端 `bdms.node/device.node`。
- `electron/qishui/lunaCore.cjs`：CENC/AES-128-CTR 解密和容器重建。
- `electron/main.cjs` / `electron/preload.cjs` / `src/vite-env.d.ts`：受限 IPC。
- `src/services/onlineMusic/providerRegistry.ts`：注册 `qishui`。
- 三份 i18n：`src/i18n/locales/{zh-CN,en,in}.ts`。
- `test/unit/qishui/`：provider、Cookies、喜欢歌单测试。

## 1.1 macOS 端改动清单

宿主版本：Folia 0.7.21（macOS arm64，Electron 43.7.5）。

### 主进程接入

- `electron/main.cjs`
  - `require('./qishui/qishuiApiBridge.cjs')` 并创建 bridge。
  - 注册 `qishui-api-request` IPC，只接受可信主窗口。
  - 给汽水 CDN 补 CORS：`*.douyinvod.com`、`*.douyinpic.com`、`*.douyincdn.com`、`*.byteimg.com`、`*.qishui.com`。
- `electron/preload.cjs`：暴露受限的 `qishuiRequest(operation, params)`。
- `src/vite-env.d.ts`：补 `window.electron.qishuiRequest` 类型。
- `package.json`：`asarUnpack` 加入 `electron/qishui/nativeHost.cjs`。

### 官方客户端原生模块

macOS 官方客户端路径：

```text
/Applications/汽水音乐.app/Contents/Resources/app-arm64.asar.unpacked
```

其中使用：

- `bdms.node`：生成 `X-Helios` / `X-Medusa` 请求签名。
- `device.node`：`decodeSpade` 解出 CENC 音频密钥。

加载方式：

- 不在 Folia 主进程直接 `dlopen`。
- `nativeHost.cjs` 用 `fork(..., { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })` 启动独立 Node 子进程。
- 子进程提供 `boot / init / sign / decodeSpade` 四个操作。
- 设备身份保存到 `~/Library/Application Support/Folia/qishui/device.json`，连续频控时删除并重新注册。

### 登录态与 macOS 权限

- 扫码：Passport 网页参数建码，状态能到 `scanned`；手机确认后可能返回 `error_code=2156`，这不是二维码识别错误。
- 本地客户端导入：

```text
~/Library/Containers/com.soda.music/Data/Library/Application Support/SodaMusic/Cookies
```

Folia 沙盒直接读这个容器可能得到 `EPERM`，先复制到：

```text
~/Library/Application Support/Folia/qishui/cookies.sqlite
```

- 登录态用 `safeStorage` 加密保存在 `userData/qishui/session.bin`。
- macOS 每次重新 ad-hoc 签名后，钥匙串 ACL 会变化，首次启动可能弹：

```text
Folia 想使用你储存在钥匙串 “Folia Safe Storage” 中的机密信息
```

点「始终允许」并输入 Mac 登录密码即可。

### 音频与封面

- CENC/AES-128-CTR 解密在 `lunaCore.cjs`，解密后的文件按 `file_hash` 缓存。
- 回环音频服务只监听 `127.0.0.1`，随机端口 + 随机 token，支持 Range/206。
- 音频地址必须是小写 `http://127.0.0.1`。
- 封面代理地址必须是大写 `HTTP://127.0.0.1`，避免宿主把它改写成 https。
- 封面 CDN 无 CORS，由主进程代理补 `Access-Control-Allow-Origin: *`。

### macOS 构建与签名

```bash
cd folia-qishui
ELECTRON=true ELECTRON_DEV=false npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never
codesign --force --deep --sign - release/mac-arm64/Folia.app
codesign --verify --deep --strict release/mac-arm64/Folia.app
```

注意：

- 桌面构建必须带 `ELECTRON=true`，否则 `file://` 下资源 404。
- 源码 tar 没有 `.git` 时，MNN 构建脚本会失败；可复用官方 0.7.21 包的 `Resources/mnn/libfolia_mnn.dylib`，并按脚本规则写 `BUILD-INFO.txt`。
- 模型和 koffi 也从官方包补齐到 `models/`、`build/koffi/darwin_arm64/`。
- `codesign --timestamp` 在时间戳服务不可用时会失败；本地验证版用 `codesign --sign -` 做 ad-hoc 签名。

### macOS 验证结果

- 汽水歌曲墙正常出图。
- 「我喜欢的音乐」上墙，747 首。
- 《刻名苍穹》完整播放 191.81 秒。
- KRC 歌词 51 行，逐字。
- 本地客户端导入成功，账号 `⭐sky`。
- BY2《我知道》当前 PC 接口 `limitedFreeInfo=null`，仍为 60 秒试听；移动端广告权益未同步到 PC。

## 2. 扫码登录：官方网页参数才是对的

### 2.1 结论

之前用 PC 的 `passportQuery(dev)` 参数建码，手机能扫但服务端一直返回 `new`，随后 `error_code=7` 频控。  
换成官方网页账号 SDK 的参数后，扫码能正常变成 `scanned`：

- `device_platform=web`
- `biz_name=quic`
- UA 用 `Mozilla/5.0`
- 不需要 PC 的 `did/iid`、`p_js_*`、`version_code=3.3.0`

### 2.2 关键代码

```js
function webPassportQuery(extra = {}) {
  return new URLSearchParams({
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
  }).toString();
}
```

建码：

```js
const q = webPassportQuery();
const r = await request(`${QR_BASE}/get_qrcode/?${q}`, {
  headers: {
    'user-agent': WEB_LOGIN_UA,
    referer: 'https://www.qishui.com/',
    accept: 'application/json, text/javascript',
  },
});
```

轮询：

```js
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
```

### 2.3 必须修掉的 Set-Cookie 正则

原正则少写了一个字符，导致所有 `Set-Cookie` 都解析不到，`sessionid` 永远收不进来：

```js
// 错误
const m = /^(\[^=]+)=([^;]*)(.*)$/.exec(sc);

// 正确
const m = /^([^=]+)=([^;]*)(.*)$/.exec(sc);
```

### 2.4 二维码轮询策略

Passport 每个二维码 token 只有很少几次查询额度。不要在扫码前猛查：

- 建码后先等 12 秒再查第一次
- 等待态每 18 秒查一次，最多 3 次等待查询
- 状态变成 `scanned` 后 5 秒查一次
- 变成 `confirmed` 但还没拿到 `sessionid` 时 4 秒查一次，不要提前向宿主报告成功
- 连续两次 `error_code=7`：写 `device-rotate` 标记，下次建码自动换设备身份

关键判断：

```js
if (result.status === 'success') {
  cookie = result.cookie;
  saveSession(cookie);
  return { state: 'confirmed' };
}
if (result.status === 'confirmed') {
  // 平台可能先返回 confirmed，下一轮才下发 sessionid
  return { state: 'waiting' };
}
```

### 2.5 2156 的边界

实测扫码可以到 `scanned`，但手机点确认后 passport 返回：

```text
error_code=2156
系统繁忙，请重启应用或刷新页面后重试
```

没有 `sessionid`。这不是二维码识别错误，也不是少传一个固定参数；更像是账号/设备/IP 的确认交换风控，或者平台要求二次验证。  
当前稳定登录路径是「从官方客户端导入」，不要把它和扫码混在一起。

## 3. 本地客户端导入（稳定登录）

官方客户端 Cookies：

```text
~/Library/Containers/com.soda.music/Data/Library/Application Support/SodaMusic/Cookies
```

Folia 沙盒可能读不到容器，先复制到可读路径：

```bash
mkdir -p "$HOME/Library/Application Support/Folia/qishui"
cp "$HOME/Library/Containers/com.soda.music/Data/Library/Application Support/SodaMusic/Cookies" \
  "$HOME/Library/Application Support/Folia/qishui/cookies.sqlite"
chmod 600 "$HOME/Library/Application Support/Folia/qishui/cookies.sqlite"
```

然后在 Folia 登录窗口选「从官方客户端导入」。  
导入逻辑会按顺序找：

1. `mods-data/folia-qishui/cookies.sqlite`
2. `qishui/cookies.sqlite`
3. 官方客户端容器

只读 `.qishui.com` / `.douyin.com`，登录态用 Electron `safeStorage` 加密保存。

## 4. 「我喜欢的音乐」上墙

根因：`qishuiProvider.getUserPlaylists` 之前把「我喜欢的音乐」过滤掉了，理由是宿主会有单独的“喜欢”集合；但汽水 provider 的 `likes` 能力是 `false`，所以两边都没有。

修复：

```ts
const items = [
  ...mapPlaylists(mine.items).map(item => ({ ...item, isOwned: true })),
  ...mapPlaylists(square.items).map(item => ({
    ...item,
    isOwned: false,
    description: item.description || '推荐歌单',
    providerData: { discovery: true },
  })),
];
```

实测：歌曲墙出现「我喜欢的音乐」，打开后 747 首。  
回归测试：`test/unit/qishui/qishuiLikedPlaylist.test.ts`。

## 5. 广告免费听 / 整曲

官方 PC 客户端的 `GetTrackV2` 会带：

- `play_count`
- `limited_free_param`
- 队列里的 `limitedFreeInfos`

源码已经补上数据链路：

```js
// normTrack 保留字段
limitedFreeInfo: track.limited_free_info && typeof track.limited_free_info === 'object'
  ? track.limited_free_info
  : null,
```

```js
// trackV2
const payload = {
  track_id: String(trackId),
  media_type: 'track',
  queue_type: 'daily_mix',
  scene_name: 'track_reco',
  play_count: Math.max(0, Number(options.playCount) || 0),
};
if (limited && limited.limited_free === true) {
  payload.limited_free_param = {
    from_other_queue: false,
    is_login_support: false,
    is_logout_support: false,
    ...limited,
  };
}
```

provider 取流时把 `sourceRef.providerData.limitedFreeInfo` 传给 `audio`，bridge 再传给 `trackV2`。

BY2《我知道》实测：

- 搜索/详情：`limitedFreeInfo=null`
- `previewMs=60001`
- 取流：`preview=true`，实际 60 秒

结论：当前 PC 会话没有拿到移动端看广告的权益。不是少传一个固定参数；如果平台返回 `limited_free_info.limited_free=true`，代码会自动按整曲请求。移动端广告天数是否会同步到 PC，需要平台在 PC 接口返回该字段。

## 6. 构建和打包

### 6.1 桌面构建必须带 ELECTRON

```bash
cd folia-qishui
ELECTRON=true ELECTRON_DEV=false npm run build
```

否则 Vite `base` 是 `/`，打包后 `file://` 下 `/assets/...` 全部 404，只剩启动页。

### 6.2 打包 app

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never
codesign --force --deep --sign - release/mac-arm64/Folia.app
codesign --verify --deep --strict release/mac-arm64/Folia.app
```

### 6.3 源码 tar 没有 .git 时

`build/buildMnnRuntime.mjs` 需要 `git rev-parse HEAD`。可直接复用官方 0.7.21 包里的：

```text
Folia.app/Contents/Resources/mnn/libfolia_mnn.dylib
```

放到 `build/mnn/mac-arm64/`，并按脚本规则写 `BUILD-INFO.txt`。模型和 koffi 也从官方包补齐。

### 6.4 生成 DMG

```bash
stage=$(mktemp -d /tmp/folia-dmg.XXXXXX)
ditto release/mac-arm64/Folia.app "$stage/Folia.app"
ln -s /Applications "$stage/Applications"
hdiutil create -volname "Folia 0.7.21" -srcfolder "$stage" \
  -ov -format UDZO outputs/Folia-0.7.21-arm64-qishui.dmg
hdiutil verify outputs/Folia-0.7.21-arm64-qishui.dmg
```

最终 DMG SHA-256：

```text
498d3b61c740d7749e6f1cdc3a65a167ef4fc5ee52f069bb8044d8a10a7fbaf9
```

## 7. 验证清单

- `npm run typecheck` 通过
- `npx vitest run -c vitest.config.ts test/unit/qishui` 通过
- 汽水歌曲墙出图
- 「我喜欢的音乐」出现，747 首
- 打开账号歌单，歌曲列表正常
- 播放《刻名苍穹》完整 191.81 秒
- KRC 歌词逐字
- 本地客户端导入成功
- 扫码能到 `scanned`；确认 2156 时改用本地导入
- DMG 挂载后版本 0.7.21，签名校验通过

## 8. 重要日志和排错

- `~/Library/Application Support/Folia/qishui/qr.log`：每次二维码轮询状态
- `~/Library/Application Support/Folia/qishui/session.bin`：safeStorage 加密登录态
- `~/Library/Application Support/Folia/qishui/cookies.sqlite`：官方客户端 Cookies 副本
- 主进程日志关键词：`[Qishui]`

常见错误：

- `error_code=7`：Passport 频控。停止轮询，等 60 秒；连续两次换设备身份。
- `error_code=2156`：扫码确认交换繁忙/风控。重新建码或改本地导入。
- `EPERM` 读官方 Cookies：先复制到 `qishui/cookies.sqlite`。
- `ERR_RESOURCE_NOT_FOUND`：版权/地区限制，换账号也不保证。

## 9. 从笔记恢复代码的最短路径

1. 下载 `chthollyphile/folia-major` 的 v0.7.21 源码。
2. 按第 1 节建 `src/services/onlineMusic/qishui/` 和 `electron/qishui/`。
3. 把第 2、3、4、5 节的关键代码接进 provider、bridge 和 main/preload。
4. 在 `providerRegistry.ts` 注册 `qishui`，三份 i18n 加登录文案。
5. 用第 6 节命令构建、签名、生成 DMG。
6. 用第 7 节清单逐项验证。

如果需要在另一台机器上完整恢复，优先拿源码目录或源码 zip；这篇笔记记录的是关键差异和踩坑，完整 provider/bridge 文件仍以源码目录为准。
