# 澄音 · 汽水音乐接入说明

维护者：`liupanaibiyao-maker`  
仓库：https://github.com/liupanaibiyao-maker/folia-qishui  
安装包：https://github.com/liupanaibiyao-maker/folia-qishui/releases/tag/v0.7.21-qishui

这是基于 Folia 0.7.21 内核的源码分支，增加了汽水音乐在线音源：

- 搜索、歌曲墙、账号歌单、歌手页、探索页
- 汽水账号扫码登录 / 官方客户端 Cookies 导入
- CENC 音频解密、回环音频服务、Range/206
- KRC 逐字歌词
- 「我喜欢的音乐」歌单（747 首）
- 广告免费听参数链路（`limited_free_info` / `limited_free_param`）

## 快速构建

```bash
npm install
ELECTRON=true ELECTRON_DEV=false npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never
codesign --force --deep --sign - release/mac-arm64/Folia.app
```

完整文件清单、扫码参数、登录态、macOS 权限、签名和踩坑记录见：

[docs/qishui-integration.md](docs/qishui-integration.md)

## 登录

稳定路径是「从官方客户端导入」：先把官方汽水客户端的 Cookies 复制到：

```text
~/Library/Application Support/Folia/qishui/cookies.sqlite
```

然后在 Folia 登录窗口选择「从官方客户端导入」。

扫码已经能到 `scanned`，但手机确认后平台可能返回 `error_code=2156`；这不是二维码识别失败。

## 已知边界

- 非会员大部分歌曲仍是 30~60 秒试听；移动端看广告的免费听权益目前没有出现在 PC 接口的 `limited_free_info` 中。
- 少数曲目返回 `ERR_RESOURCE_NOT_FOUND`（版权/地区）。
- 本仓库是源码构建，不是 Apple 公证版本。
