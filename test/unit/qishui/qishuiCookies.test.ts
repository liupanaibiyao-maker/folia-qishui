import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// test/unit/qishui/qishuiCookies.test.ts

const require = createRequire(import.meta.url);
const { cookieFromSetCookie } = require('../../../electron/qishui/qishuiApi.cjs') as {
    cookieFromSetCookie: (list: string[], existing?: Record<string, string>) => Record<string, string>;
};

describe('Qishui Set-Cookie handling', () => {
    it('keeps the session cookies the QR confirmation puts in the response', () => {
        expect(cookieFromSetCookie([
            'sessionid=session-value; Path=/; HttpOnly',
            'sid_tt=tt-value; Path=/',
            'passport_csrf_token=csrf-value; Path=/',
        ])).toEqual({
            sessionid: 'session-value',
            sid_tt: 'tt-value',
            passport_csrf_token: 'csrf-value',
        });
    });

    it('deletes a cookie whose max-age is zero', () => {
        expect(cookieFromSetCookie(
            ['sessionid=; Max-Age=0; Path=/'],
            { sessionid: 'old-value', keep: 'me' },
        )).toEqual({ keep: 'me' });
    });

    it('ignores a malformed Set-Cookie line without dropping the valid ones', () => {
        expect(cookieFromSetCookie(['not a cookie', 'a=b'])).toEqual({ a: 'b' });
    });
});
