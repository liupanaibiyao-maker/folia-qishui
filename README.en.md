<div align="center">

# Qishui Music Player · macOS

Maintained by `liupanaibiyao-maker` · built on the Folia 0.7.21 core

[![Release](https://img.shields.io/github/v/release/liupanaibiyao-maker/folia-qishui?label=release)](https://github.com/liupanaibiyao-maker/folia-qishui/releases)
[![License](https://img.shields.io/github/license/liupanaibiyao-maker/folia-qishui)](LICENSE)

[Download](https://github.com/liupanaibiyao-maker/folia-qishui/releases) ·
[Integration guide](docs/qishui-integration.md) ·
[Build notes](QISHUI.md)

</div>

## What this is

This is a macOS desktop player with a built-in Qishui Music provider. It keeps the player, lyrics, library and mod system, and adds Qishui search, library, playback and KRC lyrics.

Features:

- Qishui search, library wall, account playlists, artist pages and explore
- QR sign-in and official-client cookie import
- CENC audio decryption, local loopback audio server, Range/206
- KRC word-by-word lyrics
- "Liked Songs" playlist
- Limited-free playback parameter chain (`limited_free_info` / `limited_free_param`)

## Download

macOS arm64 installer:

[Folia-0.7.21-arm64-qishui.dmg](https://github.com/liupanaibiyao-maker/folia-qishui/releases/download/v0.7.21-qishui/Folia-0.7.21-arm64-qishui.dmg)

Open the DMG and drag Folia into Applications. This is an ad-hoc signed local build, not an Apple-notarized release.

## Sign in to Qishui

The stable path is **Import from the official app**:

1. Sign in to the official Soda Music desktop client.
2. Copy its cookies to a path Folia can read:

```bash
mkdir -p "$HOME/Library/Application Support/Folia/qishui"
cp "$HOME/Library/Containers/com.soda.music/Data/Library/Application Support/SodaMusic/Cookies" \
  "$HOME/Library/Application Support/Folia/qishui/cookies.sqlite"
chmod 600 "$HOME/Library/Application Support/Folia/qishui/cookies.sqlite"
```

3. Choose **Import from the official app** in Folia's sign-in window.

The QR flow reaches `scanned`, but the platform may return `error_code=2156` after phone confirmation.

## Build

```bash
npm install
ELECTRON=true ELECTRON_DEV=false npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never
codesign --force --deep --sign - release/mac-arm64/Folia.app
```

See [QISHUI.md](QISHUI.md) and [docs/qishui-integration.md](docs/qishui-integration.md) for the macOS changes, native modules, signing, DMG creation and troubleshooting.

## Known limits

- Most songs are 30–60 second previews on a non-member account.
- Mobile ad-based free listening is not reflected in the PC `limited_free_info` response.
- Some tracks return `ERR_RESOURCE_NOT_FOUND` because of copyright or region limits.
- QR confirmation may be blocked by error `2156`; use official-client import for a stable sign-in.

## License and attribution

This project is a modified fork of Folia v0.7.21. Copyright in the original project and its contributors remains with them; it is distributed under AGPL-3.0.  
The Qishui provider and macOS build changes are maintained by `liupanaibiyao-maker`.

See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
