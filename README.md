<div align="center">

# 汽水音乐播放器 · macOS 版

由 `liupanaibiyao-maker` 维护 · 基于 Folia 0.7.21 内核

[![Release](https://img.shields.io/github/v/release/liupanaibiyao-maker/folia-qishui?label=release)](https://github.com/liupanaibiyao-maker/folia-qishui/releases)
[![License](https://img.shields.io/github/license/liupanaibiyao-maker/folia-qishui)](LICENSE)

[下载安装包](https://github.com/liupanaibiyao-maker/folia-qishui/releases) ·
[集成文档](docs/qishui-integration.md) ·
[构建说明](QISHUI.md)

</div>

## 这是什么

这是一个 macOS 桌面播放器，内建汽水音乐在线音源，保留播放器、歌词、曲库和模组系统。

主要能力：

- 汽水音乐搜索、歌曲墙、账号歌单、歌手页、探索页
- 扫码登录 / 官方客户端 Cookies 导入
- CENC 音频解密、本机回环音频服务、Range/206
- KRC 逐字歌词
- 「我喜欢的音乐」歌单
- 广告免费听参数链路（`limited_free_info` / `limited_free_param`）

## 下载

macOS arm64 安装包：

[Folia-0.7.21-arm64-qishui.dmg](https://github.com/liupanaibiyao-maker/folia-qishui/releases/download/v0.7.21-qishui/Folia-0.7.21-arm64-qishui.dmg)

安装：打开 DMG，把 Folia 拖进「应用程序」。  
这是本地 ad-hoc 签名版本，不是 Apple 公证版本。

## 登录汽水音乐

稳定路径是「从官方客户端导入」：

1. 打开官方「汽水音乐」客户端并确认已登录。
2. 把官方 Cookies 复制到 Folia 可读路径：

```bash
mkdir -p "$HOME/Library/Application Support/Folia/qishui"
cp "$HOME/Library/Containers/com.soda.music/Data/Library/Application Support/SodaMusic/Cookies" \
  "$HOME/Library/Application Support/Folia/qishui/cookies.sqlite"
chmod 600 "$HOME/Library/Application Support/Folia/qishui/cookies.sqlite"
```

3. 在 Folia 登录窗口选择「从官方客户端导入」。

扫码已经能识别到 `scanned`，但手机确认后平台可能返回 `error_code=2156`；这不是二维码识别失败。

## 构建

```bash
npm install
ELECTRON=true ELECTRON_DEV=false npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never
codesign --force --deep --sign - release/mac-arm64/Folia.app
```

完整的 macOS 端改动、原生模块加载、签名、DMG 生成和排错记录见：

- [QISHUI.md](QISHUI.md)
- [docs/qishui-integration.md](docs/qishui-integration.md)

## 已知边界

- 非会员大部分歌曲仍是 30~60 秒试听。
- 移动端看广告获得的免费听权益，目前没有出现在 PC 接口的 `limited_free_info` 中。
- 少数曲目返回 `ERR_RESOURCE_NOT_FOUND`（版权/地区限制）。
- 扫码确认可能被平台 `2156` 拦截；稳定登录用本地客户端导入。

## 许可证与归属

本项目基于 Folia v0.7.21 修改，原项目及其贡献者的版权归原作者所有，按 AGPL-3.0 发布。  
本仓库的汽水音乐适配与 macOS 构建修改由 `liupanaibiyao-maker` 维护。

许可证全文见 [LICENSE](LICENSE)，必要的上游归属说明见 [NOTICE.md](NOTICE.md)。
