import { describe, expect, it } from 'vitest';
import en from './en.json';
import ko from './ko.json';

const keys = (value: unknown, prefix = ''): string[] => {
    if (!value || typeof value !== 'object') return [prefix];
    return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
};

describe('locale parity', () => {
    it('keeps every translation key in both Korean and English', () => {
        expect(keys(ko).sort()).toEqual(keys(en).sort());
    });
});
