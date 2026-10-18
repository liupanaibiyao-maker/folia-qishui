import type {
    AudioQualityPreference,
    LoginState,
    OnlineMusicProvider,
    ProviderAudioSource,
    ProviderCollection,
    ProviderPage,
    ProviderSongAvailability,
} from '../../../types/onlineMusic';
import type { SongResult, UnifiedSong } from '../../../types';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { createProviderSongMetadata } from '../../../utils/songMetadata';
import { getQishuiTransportAvailability, requestQishui } from './qishuiTransport';
import type {
    QishuiPage,
    QishuiRawPlaylist,
    QishuiRawTrack,
    QishuiRawUser,
} from './qishuiTransport';
import {
    normalizeQishuiCollection,
    normalizeQishuiSong,
    normalizeQishuiUser,
    qishuiPage,
} from './qishuiNormalize';
import { parseQishuiLyrics } from './qishuiLyrics';

// src/services/onlineMusic/qishui/qishuiProvider.ts

const QUALITY_OF_STREAM: Record<string, AudioQualityPreference> = {
    medium: 'standard',
    higher: 'high',
    highest: 'high',
    lossless: 'lossless',
    hi_res: 'hires',
};

const isQishuiSong = (song: SongResult): song is SongResult & {
    sourceRef: { kind: 'online'; providerId: 'qishui'; mediaId: string; providerData?: Record<string, unknown> };
} => song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'qishui';

// The import path is a one-shot action, but the login window speaks one protocol: a key and a
// picture, then checks. This tiny mark stands in for the QR while the saved client session is
// read; the first check reports success.
const IMPORTED_SESSION_KEY = 'imported-client-session';
const IMPORTED_SESSION_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">'
    + '<rect width="160" height="160" rx="28" fill="#22c55e"/>'
    + '<path d="M44 82l22 22 50-52" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>',
)}`;

const pageOfSongs = (items: UnifiedSong[], offset: number, limit: number, hasMore?: boolean): ProviderPage<UnifiedSong> => ({
    items,
    nextOffset: offset + items.length,
    hasMore: hasMore ?? items.length === limit,
});

const mapPlaylists = (items: QishuiRawPlaylist[] | undefined): ProviderCollection[] => (
    (items || []).map(item => normalizeQishuiCollection(item, 'playlist'))
);

export const qishuiProvider: OnlineMusicProvider = {
    id: 'qishui',
    displayName: '汽水音乐',
    shortName: '汽水',
    mark: { letter: '汽', color: '#22c55e' },
    getAvailability: getQishuiTransportAvailability,
    capabilities: {
        search: true,
        playback: true,
        lyrics: true,
        wordByWordLyrics: true,
        auth: true,
        userLibrary: true,
        playlists: true,
        albums: false,
        artists: true,
        recommendations: true,
        mutations: false,
        likes: false,
        userAlbums: false,
        playlistTrackMutations: false,
        playbackReports: false,
        explore: true,
    },
    normalizeSong: normalizeQishuiSong,
    normalizeUser: normalizeQishuiUser,
    normalizeCollection: normalizeQishuiCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    describeFailure(operation, error) {
        const message = String((error as Error)?.message || error);
        if (/ERR_RESOURCE_NOT_FOUND|no audio stream|no track/i.test(message)) {
            return { case: 'no-audio', message };
        }
        if (/login|登录|1000016/i.test(message)) {
            return { case: 'sign-in-needed', message };
        }
        return null;
    },
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return pageOfSongs([], offset, limit, false);
            const data = await requestQishui<{ items: QishuiRawTrack[]; hasMore: boolean }>('search', {
                query,
                limit,
                offset,
            });
            const items = (data.items || []).map(normalizeQishuiSong);
            return pageOfSongs(items, offset, limit, Boolean(data.hasMore));
        },
    },
    playback: {
        async getSongDetail(id) {
            const data = await requestQishui<{ track: QishuiRawTrack }>('song_detail', { id: String(id) });
            return data?.track ? normalizeQishuiSong(data.track) : null;
        },
        async getAudioSource(song, quality) {
            if (!isQishuiSong(song)) {
                throw new OnlineProviderError('unsupported', 'Song does not belong to Qishui', 'qishui');
            }
            const source = song.sourceRef;
            const limitedFreeInfo = source.providerData?.limitedFreeInfo;
            const data = await requestQishui<{
                url: string;
                quality: string;
                preview?: boolean;
                expiresAt?: number;
            }>('audio', {
                id: String(source.mediaId),
                quality,
                playCount: 0,
                ...(limitedFreeInfo && typeof limitedFreeInfo === 'object' && !Array.isArray(limitedFreeInfo)
                    ? { limitedFreeInfo: limitedFreeInfo as Record<string, unknown> }
                    : {}),
            });
            if (!data?.url) throw new OnlineProviderError('invalid-response', 'Qishui returned no audio URL', 'qishui');
            return {
                url: data.url,
                fetchedAt: Date.now(),
                expiresAt: data.expiresAt,
                quality: QUALITY_OF_STREAM[data.quality] || quality,
                ...(data.preview ? { preview: true } : {}),
            } satisfies ProviderAudioSource;
        },
        audioQualityLevels: ['standard', 'high', 'lossless', 'hires'],
        getAvailability(song): ProviderSongAvailability {
            if (!isQishuiSong(song)) return { state: 'unknown' };
            const previewMs = Number(song.sourceRef.providerData?.previewMs) || 0;
            if (previewMs > 0) return { state: 'unknown', reason: 'restricted' };
            return { state: 'unknown' };
        },
    },
    lyrics: {
        async getLyrics(song) {
            if (!isQishuiSong(song)) {
                throw new OnlineProviderError('unsupported', 'Song does not belong to Qishui', 'qishui');
            }
            const source = song.sourceRef;
            const data = await requestQishui<{ content?: string; type?: string; lrc?: string }>('lyrics', {
                id: String(source.mediaId),
            });
            return parseQishuiLyrics(data || {});
        },
    },
    auth: {
        getLoginTexts: () => ({ title: 'home.loginTitleQishui', note: 'home.loginNoteQishui' }),
        getLoginMethods: () => [
            { id: 'qr', labelKey: 'home.qishuiLoginMethodQr', iconKey: 'qishui' },
            { id: 'cookie-import', labelKey: 'home.qishuiLoginMethodCookie', iconKey: 'qishui' },
        ],
        async getLoginStatus() {
            const user = await requestQishui<QishuiRawUser | null>('login_status');
            return user ? normalizeQishuiUser(user) : null;
        },
        async logout() {
            await requestQishui('logout');
        },
        async startLogin(methodId) {
            if (methodId === 'cookie-import') {
                const user = await requestQishui<QishuiRawUser | null>('import_cookie');
                if (!user) {
                    throw new OnlineProviderError('auth-required', '没有从官方客户端读到汽水登录态', 'qishui');
                }
                return IMPORTED_SESSION_KEY;
            }
            const data = await requestQishui<{ key: string }>('login_qr_key');
            return data.key;
        },
        async createQr(key) {
            if (key === IMPORTED_SESSION_KEY) return IMPORTED_SESSION_IMAGE;
            const data = await requestQishui<{ imageUrl: string }>('login_qr_create', { key });
            if (!data?.imageUrl) throw new OnlineProviderError('invalid-response', 'Qishui returned no QR image', 'qishui');
            return data.imageUrl;
        },
        checkLogin: key => (
            key === IMPORTED_SESSION_KEY
                ? Promise.resolve({ state: 'confirmed' } satisfies LoginState)
                : requestQishui<LoginState>('login_qr_check', { key })
        ),
        async cancelLogin(key) {
            if (key === IMPORTED_SESSION_KEY) return;
            await requestQishui('login_qr_cancel', { key });
        },
        getLoginTtlMs: () => 5 * 60 * 1000,
        describeLoginFailure(_step, error) {
            const message = String((error as Error)?.message || error);
            if (/4031|版本过低/.test(message)) return { case: 'refused', code: '4031', message };
            if (/频控|太频繁|error_code=7/.test(message)) {
                return { case: 'retry-later', code: '7', message, retryAfterMs: 60_000 };
            }
            return null;
        },
    },
    library: {
        async getUserPlaylists(_userId, limit, offset) {
            const [mine, square] = await Promise.all([
                requestQishui<{ items: QishuiRawPlaylist[] }>('account_playlists'),
                requestQishui<{ items: QishuiRawPlaylist[] }>('playlist_square').catch(() => ({ items: [] })),
            ]);
            // Qishui does not expose the heart/like mutation yet, so Folia has no separate
            // "Liked Songs" collection for it. Keep the platform's "我喜欢的音乐" playlist on
            // the wall; hiding it here leaves no way to open the account's liked songs.
            const seen = new Set<string>();
            const items = [
                ...mapPlaylists(mine.items)
                    .map(item => ({ ...item, isOwned: true })),
                ...mapPlaylists(square.items).map(item => ({
                    ...item,
                    isOwned: false,
                    description: item.description || '推荐歌单',
                    providerData: { discovery: true },
                })),
            ].filter(item => {
                const key = String(item.id);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            return qishuiPage(items.slice(offset, offset + limit), items.length, offset, limit);
        },
        async getLikedSongIds() {
            const data = await requestQishui<{ ids: string[]; whole: boolean }>('liked_ids');
            return { ids: data.ids || [], whole: data.whole !== false };
        },
        async getLikedSongCount() {
            const data = await requestQishui<{ items: QishuiRawPlaylist[] }>('account_playlists');
            const liked = data.items?.find(item => /我喜欢的音乐/.test(item.name));
            return liked ? Number(liked.count) || 0 : null;
        },
    },
    catalog: {
        canResolveSongCatalogRefs: song => isQishuiSong(song),
        resolveSongCatalogRefs: async song => song,
        async getPlaylistTracks(id, limit, offset) {
            const data = await requestQishui<QishuiPage<QishuiRawTrack>>('playlist_tracks', {
                id: String(id),
                limit,
                offset,
            });
            return {
                items: (data.items || []).map(normalizeQishuiSong),
                ...(Number.isFinite(Number(data.total)) ? { total: Number(data.total) } : {}),
                hasMore: Boolean(data.hasMore),
                nextOffset: Number(data.nextOffset) || offset + (data.items?.length || 0),
            };
        },
        async getPlaylistDetail(id, collection) {
            return collection || {
                providerId: 'qishui',
                id: String(id),
                type: 'playlist',
                name: '汽水歌单',
            };
        },
        async getArtistSongs(id, limit, offset) {
            const data = await requestQishui<QishuiPage<QishuiRawTrack>>('artist_songs', {
                name: String(id),
                limit,
                offset,
            });
            return {
                items: (data.items || []).map(normalizeQishuiSong),
                ...(Number.isFinite(Number(data.total)) ? { total: Number(data.total) } : {}),
                hasMore: Boolean(data.hasMore),
                nextOffset: Number(data.nextOffset) || offset + (data.items?.length || 0),
            };
        },
        async getArtistAlbums(id, limit, offset) {
            const data = await requestQishui<{ items: Array<{ id: string; name: string; coverUrl?: string; trackCount?: number }> }>(
                'artist_albums',
                { name: String(id) },
            );
            const items = (data.items || []).map(item => normalizeQishuiCollection({
                id: item.id,
                name: item.name,
                coverUrl: item.coverUrl || '',
                count: item.trackCount || 0,
                description: '',
            }, 'album'));
            return qishuiPage(items.slice(offset, offset + limit), items.length, offset, limit);
        },
        async getArtistDetail(id) {
            return {
                providerId: 'qishui',
                id: String(id),
                type: 'artist',
                name: String(id),
            };
        },
    },
    recommendations: {
        async getRecommendedCollections(limit) {
            const [recommended, square] = await Promise.all([
                requestQishui<{ items: QishuiRawPlaylist[] }>('recommended_playlists').catch(() => ({ items: [] })),
                requestQishui<{ items: QishuiRawPlaylist[] }>('playlist_square').catch(() => ({ items: [] })),
            ]);
            const seen = new Set<string>();
            return [...mapPlaylists(recommended.items), ...mapPlaylists(square.items)]
                .filter(item => {
                    if (seen.has(String(item.id))) return false;
                    seen.add(String(item.id));
                    return true;
                })
                .slice(0, limit);
        },
        async getPersonalFm() {
            const data = await requestQishui<{ items: QishuiRawTrack[] }>('personal_fm');
            return (data.items || []).map(normalizeQishuiSong);
        },
    },
    explore: {
        async getFeed() {
            const [square, feed] = await Promise.all([
                requestQishui<{ items: QishuiRawPlaylist[] }>('playlist_square').catch(() => ({ items: [] })),
                requestQishui<{ items: QishuiRawTrack[] }>('personal_fm').catch(() => ({ items: [] })),
            ]);
            return {
                sections: [
                    {
                        id: 'qishui-square',
                        title: '汽水歌单广场',
                        items: mapPlaylists(square.items).map(collection => ({ kind: 'collection' as const, collection })),
                    },
                    {
                        id: 'qishui-feed',
                        title: '为你推荐',
                        items: (feed.items || []).map(track => ({ kind: 'song' as const, song: normalizeQishuiSong(track) })),
                    },
                ],
            };
        },
    },
};
