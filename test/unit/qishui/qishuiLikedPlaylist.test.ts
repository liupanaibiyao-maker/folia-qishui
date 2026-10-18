import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/qishui/qishuiLikedPlaylist.test.ts

const { requestQishui } = vi.hoisted(() => ({ requestQishui: vi.fn() }));

vi.mock('@/services/onlineMusic/qishui/qishuiTransport', () => ({
    getQishuiTransportAvailability: () => ({ configured: true }),
    requestQishui,
}));

import { qishuiProvider } from '@/services/onlineMusic/qishui/qishuiProvider';

describe('Qishui account playlists', () => {
    beforeEach(() => {
        requestQishui.mockReset();
    });

    it('keeps the platform liked playlist on the wall when there is no heart collection', async () => {
        requestQishui.mockImplementation((operation: string) => {
            if (operation === 'account_playlists') {
                return Promise.resolve({
                    items: [
                        { id: 'liked', name: '我喜欢的音乐', count: 657, coverUrl: '', description: '' },
                        { id: 'other', name: '抖音收藏的音乐', count: 16, coverUrl: '', description: '' },
                    ],
                });
            }
            if (operation === 'playlist_square') return Promise.resolve({ items: [] });
            throw new Error(`unexpected operation: ${operation}`);
        });

        const page = await qishuiProvider.library!.getUserPlaylists('me', 20, 0);
        expect(page.items.map(item => item.name)).toEqual(['我喜欢的音乐', '抖音收藏的音乐']);
    });
});
