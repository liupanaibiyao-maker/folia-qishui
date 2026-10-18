import type { ProviderLyricsResult } from '../../../types/onlineMusic';
import { parseLyricsByFormat } from '../../../utils/lyrics/parserCore';
import { isPureMusicLyricText } from '../../../utils/lyrics/pureMusic';

// src/services/onlineMusic/qishui/qishuiLyrics.ts

export function parseQishuiLyrics(payload: { content?: string; type?: string; lrc?: string }): ProviderLyricsResult {
    const raw = String(payload.content || '');
    const lrc = String(payload.lrc || '');
    const format = String(payload.type || '').toLowerCase();
    const wordByWord = /^(krc|yrc|qrc)$/.test(format) && raw.trim()
        ? parseLyricsByFormat(format as 'krc' | 'yrc' | 'qrc', raw)
        : null;
    const mainText = lrc || raw;
    const lineLyrics = parseLyricsByFormat('lrc', mainText);
    const lyrics = wordByWord?.lines.length ? wordByWord : lineLyrics;
    return {
        lyrics: lyrics.lines.length ? lyrics : null,
        mainText,
        wordByWordText: wordByWord?.lines.length ? raw : undefined,
        isPureMusic: isPureMusicLyricText(mainText),
    };
}
