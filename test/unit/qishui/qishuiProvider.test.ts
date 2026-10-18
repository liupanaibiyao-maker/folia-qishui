import { describe, expect, it } from 'vitest';
import { qishuiProvider } from '@/services/onlineMusic/qishui/qishuiProvider';
import { normalizeQishuiSong } from '@/services/onlineMusic/qishui/qishuiNormalize';
import { parseQishuiLyrics } from '@/services/onlineMusic/qishui/qishuiLyrics';

// test/unit/qishui/qishuiProvider.test.ts

describe('Qishui provider data', () => {
    it('keeps the Qishui identity and the playable preview length on a normalized song', () => {
        const song = normalizeQishuiSong({
            id: 'track-1',
            title: '晴天',
            artists: ['季星白', ''],
            album: '晴天',
            albumId: 'album-1',
            coverUrl: 'https://example.test/cover.jpg',
            durationMs: 281751,
            previewMs: 30001,
            vip: true,
        });

        expect(song.sourceRef).toEqual({
            kind: 'online',
            providerId: 'qishui',
            mediaId: 'track-1',
            providerData: { previewMs: 30001, vip: true },
        });
        expect(song.artists.map(artist => artist.name)).toEqual(['季星白']);
        expect(song.album.catalogRef).toEqual({ providerId: 'qishui', kind: 'album', id: 'album-1' });
    });

    it('parses KRC into word-by-word lines and keeps the plain text fallback', () => {
        const parsed = parseQishuiLyrics({
            type: 'krc',
            content: '[1000,600]<0,240,0>你<240,360,0>好',
            lrc: '[00:01.00]你好',
        });

        expect(parsed.lyrics?.isWordByWord).toBe(true);
        expect(parsed.lyrics?.lines).toHaveLength(1);
        expect(parsed.lyrics?.lines[0]?.fullText).toBe('你好');
        expect(parsed.lyrics?.lines[0]?.words?.length).toBeGreaterThan(1);
        expect(parsed.wordByWordText).toContain('<0,240,0>');
    });

    it('offers the saved-client import beside QR sign-in', () => {
        expect(qishuiProvider.auth?.getLoginMethods?.().map(method => method.id)).toEqual(['qr', 'cookie-import']);
    });
});
