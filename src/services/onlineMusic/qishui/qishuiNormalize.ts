import type { Artist, UnifiedSong } from '../../../types';
import type { JsonValue, ProviderCollection, ProviderPage, ProviderUser } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import type { QishuiRawPlaylist, QishuiRawTrack, QishuiRawUser } from './qishuiTransport';

// src/services/onlineMusic/qishui/qishuiNormalize.ts

const text = (value: unknown) => value == null ? '' : String(value);

const artistRef = (name: string) => (
    name ? { providerId: 'qishui', kind: 'artist' as const, id: name } : undefined
);
const albumRef = (id: string) => (
    id && id !== '0' ? { providerId: 'qishui', kind: 'album' as const, id } : undefined
);

export const normalizeQishuiSong = (raw: unknown): UnifiedSong => {
    const item = raw as Partial<QishuiRawTrack> | null;
    if (!item || item.id == null) throw new OnlineProviderError('invalid-response', 'Qishui song has no id', 'qishui');
    const id = text(item.id);
    const artists: Artist[] = (item.artists || [])
        .map(name => text(name).trim())
        .filter(Boolean)
        .map(name => ({ id: name, name, catalogRef: artistRef(name) }));
    const artistList = artists.length ? artists : [{ id: 'unknown', name: '未知歌手' }];
    const albumId = text(item.albumId);
    const providerData: Record<string, JsonValue> = {};
    if (Number(item.previewMs) > 0) providerData.previewMs = Number(item.previewMs);
    if (item.vip === true) providerData.vip = true;
    if (item.limitedFreeInfo && typeof item.limitedFreeInfo === 'object') {
        providerData.limitedFreeInfo = item.limitedFreeInfo as JsonValue;
    }
    return {
        id,
        name: text(item.title || '未知歌曲'),
        artists: artistList,
        album: {
            id: albumId,
            name: text(item.album || '单曲'),
            coverUrl: text(item.coverUrl),
            catalogRef: albumRef(albumId),
        },
        durationMs: Math.max(0, Number(item.durationMs) || 0),
        sourceRef: {
            kind: 'online',
            providerId: 'qishui',
            mediaId: id,
            providerData,
        },
    };
};

export const normalizeQishuiUser = (raw: unknown): ProviderUser => {
    const item = raw as Partial<QishuiRawUser> | null;
    if (!item || item.id == null) throw new OnlineProviderError('invalid-response', 'Qishui account has no id', 'qishui');
    return {
        id: text(item.id),
        nickname: text(item.nickname || '汽水音乐用户'),
        avatarUrl: text(item.avatarUrl),
        vipType: Number(item.vipType) || 0,
    };
};

export const normalizeQishuiCollection = (raw: unknown, type = 'playlist'): ProviderCollection => {
    const item = raw as Partial<QishuiRawPlaylist> | null;
    if (!item || item.id == null) throw new OnlineProviderError('invalid-response', 'Qishui collection has no id', 'qishui');
    return {
        providerId: 'qishui',
        id: text(item.id),
        type,
        name: text(item.name || '未命名歌单'),
        coverUrl: text(item.coverUrl),
        description: text(item.description),
        trackCount: Number(item.count) || 0,
    };
};

export const qishuiPage = <T,>(items: T[], total: unknown, offset: number, limit: number): ProviderPage<T> => {
    const count = Number(total);
    const knownTotal = Number.isFinite(count) && count >= 0;
    const nextOffset = offset + items.length;
    return {
        items,
        ...(knownTotal ? { total: count } : {}),
        nextOffset,
        hasMore: knownTotal ? nextOffset < count : items.length === limit,
    };
};
