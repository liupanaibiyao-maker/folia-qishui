import { OnlineProviderError } from '../../../types/onlineMusic';
import type { ProviderErrorCode } from '../../../types/onlineMusic';

// src/services/onlineMusic/qishui/qishuiTransport.ts
// The only renderer file allowed to touch the Qishui desktop bridge.

export type QishuiOperation =
    | 'availability'
    | 'login_status'
    | 'login_qr_key'
    | 'login_qr_create'
    | 'login_qr_check'
    | 'login_qr_cancel'
    | 'import_cookie'
    | 'logout'
    | 'search'
    | 'song_detail'
    | 'audio'
    | 'lyrics'
    | 'account_playlists'
    | 'recommended_playlists'
    | 'playlist_square'
    | 'playlist_tracks'
    | 'liked_ids'
    | 'personal_fm'
    | 'artist_songs'
    | 'artist_albums';

export type QishuiParams = Record<string, string | number | boolean | undefined | Record<string, unknown>>;

export type QishuiBridgeResult =
    | { ok: true; data: unknown }
    | { ok: false; error: { code: string; message: string } };

export const QISHUI_NEEDS_DESKTOP = 'Qishui requires the Folia desktop app';
export const QISHUI_BRIDGE_FAILED = 'Qishui desktop request failed';

const PROVIDER_ERROR_CODES = new Set<ProviderErrorCode>([
    'auth-required', 'unsupported', 'not-public', 'unavailable', 'not-playable',
    'preview-only', 'subscription-required', 'region-restricted', 'network', 'invalid-response',
]);

export const getQishuiTransportAvailability = () => (
    typeof window !== 'undefined' && typeof window.electron?.qishuiRequest === 'function'
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const
);

export async function requestQishui<T = unknown>(operation: QishuiOperation, params: QishuiParams = {}): Promise<T> {
    if (!getQishuiTransportAvailability().configured) {
        throw new OnlineProviderError('unavailable', QISHUI_NEEDS_DESKTOP, 'qishui');
    }
    let result: QishuiBridgeResult;
    try {
        result = await window.electron!.qishuiRequest(operation, params);
    } catch (error) {
        throw new OnlineProviderError('network', QISHUI_BRIDGE_FAILED, 'qishui', error);
    }
    if (!result.ok) {
        const code = PROVIDER_ERROR_CODES.has(result.error.code as ProviderErrorCode)
            ? result.error.code as ProviderErrorCode
            : 'invalid-response';
        throw new OnlineProviderError(code, result.error.message, 'qishui');
    }
    return result.data as T;
}

export type QishuiRawTrack = {
    id: string;
    title: string;
    artists: string[];
    album: string;
    albumId: string;
    coverUrl: string;
    durationMs: number;
    previewMs?: number;
    vip?: boolean;
    limitedFreeInfo?: Record<string, unknown> | null;
};

export type QishuiRawPlaylist = {
    id: string;
    name: string;
    count: number;
    coverUrl: string;
    description: string;
};

export type QishuiRawUser = {
    id: string;
    nickname: string;
    avatarUrl?: string;
    vipType?: number;
};

export type QishuiPage<T> = {
    items: T[];
    total?: number;
    hasMore: boolean;
    nextOffset: number;
};
