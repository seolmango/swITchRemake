import { describe, expect, it } from 'vitest';
import en from './en.json';
import ko from './ko.json';

const keys = (value: unknown, prefix = ''): string[] => {
    if (!value || typeof value !== 'object') return [prefix];
    return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
};

describe('MFA locale parity', () => {
    it('keeps every account-security key in both Korean and English', () => {
        expect(keys(ko.settings.security).sort()).toEqual(keys(en.settings.security).sort());
        expect(keys(ko.auth).sort()).toEqual(keys(en.auth).sort());
        expect(keys(ko.profile).sort()).toEqual(keys(en.profile).sort());
    });
});
