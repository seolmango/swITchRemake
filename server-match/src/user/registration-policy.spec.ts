import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LEGAL_DOCUMENT_VERSIONS } from '../config/legal.settings';
import { CreateUserDto } from './dto/create-user.dto';
import { ConflictException } from '@nestjs/common';
import { UserService } from './user.service';

const valid = {
    email: 'user@example.com',
    password: 'Password1!',
    nickname: '사용자',
    code: '123456',
    agreements: {
        termsOfService: {
            version: LEGAL_DOCUMENT_VERSIONS.termsVersion,
            acceptedAt: '2026-09-05T00:00:00.000Z',
        },
        privacyPolicy: {
            version: LEGAL_DOCUMENT_VERSIONS.privacyVersion,
            acceptedAt: '2026-09-05T00:00:01.000Z',
        },
    },
} as const satisfies CreateUserDto;

test('가입 DTO는 두 문서의 동의 시각과 버전을 각각 요구한다', async () => {
    assert.equal((await validate(plainToInstance(CreateUserDto, valid))).length, 0);
    assert.ok((await validate(plainToInstance(CreateUserDto, { ...valid, agreements: undefined }))).length > 0);
    assert.ok((await validate(plainToInstance(CreateUserDto, {
        ...valid,
        agreements: { ...valid.agreements, privacyPolicy: undefined },
    }))).length > 0);
});

test('클라이언트가 동의 시각을 날짜가 아닌 값으로 보내면 가입 경계에서 거절한다', async () => {
    const dto = plainToInstance(CreateUserDto, {
        ...valid,
        agreements: {
            ...valid.agreements,
            termsOfService: { ...valid.agreements.termsOfService, acceptedAt: 'now' },
        },
    });
    assert.ok((await validate(dto)).some((error) => error.property === 'agreements'));
});

class RegistrationRedis {
    readonly values = new Map<string, string>([['auth:code:signup:user@example.com', '123456']]);
    async get(key: string) { return this.values.get(key) ?? null; }
    async incrementWithTtl() { return 1; }
    async del(key: string) { this.values.delete(key); }
    async compareAndClaim(key: string, expected: string, lease: string, claimId: string) {
        if (this.values.get(key) !== expected) return -1;
        this.values.delete(key);
        this.values.set(lease, claimId);
        return 300_000;
    }
    async compareAndDelete(key: string, expected: string) {
        if (this.values.get(key) !== expected) return false;
        this.values.delete(key);
        return true;
    }
    async releaseClaim(lease: string, claimId: string, key: string, value: string) {
        if (this.values.get(lease) !== claimId) return false;
        this.values.delete(lease);
        this.values.set(key, value);
        return true;
    }
}

function registrationService(options: { blocked?: boolean; duplicateEmail?: boolean } = {}) {
    const inserted: Record<string, unknown>[] = [];
    const db = {
        insert: () => ({
            values: (value: Record<string, unknown>) => {
                inserted.push(value);
                return {
                    returning: async () => {
                        if (options.duplicateEmail) {
                            throw { code: '23505', detail: 'Key (email) already exists' };
                        }
                        return [{ nickname: value.nickname }];
                    },
                };
            },
        }),
    };
    const sanctions = { isEmailRegistrationBlocked: async () => options.blocked ?? false };
    return {
        service: new UserService(
            db as never,
            new RegistrationRedis() as never,
            sanctions as never,
            {} as never,
            {} as never,
            {} as never,
        ),
        inserted,
    };
}

test('가입은 서버의 현재 두 버전과 각각의 동의 시점을 함께 저장한다', async () => {
    const state = registrationService();
    await state.service.createUser(valid);
    assert.equal(state.inserted[0]!.termsVersion, LEGAL_DOCUMENT_VERSIONS.termsVersion);
    assert.equal(state.inserted[0]!.privacyVersion, LEGAL_DOCUMENT_VERSIONS.privacyVersion);
    assert.ok(state.inserted[0]!.termsAgreedAt instanceof Date);
    assert.equal(state.inserted[0]!.termsAgreedAt, state.inserted[0]!.privacyAgreedAt);
    assert.equal('termsAccepted' in state.inserted[0]!, false);
});

test('이미 가입된 이메일과 탈퇴 제재 이메일은 같은 409 본문을 돌려준다', async () => {
    const responses: unknown[] = [];
    for (const state of [registrationService({ blocked: true }), registrationService({ duplicateEmail: true })]) {
        await assert.rejects(state.service.createUser(valid), (error: unknown) => {
            assert.ok(error instanceof ConflictException);
            responses.push(error.getResponse());
            return true;
        });
    }
    assert.deepEqual(responses, [
        { code: 'EMAIL_UNAVAILABLE', message: 'Email is unavailable' },
        { code: 'EMAIL_UNAVAILABLE', message: 'Email is unavailable' },
    ]);
});

test('서버 버전과 다른 동의는 저장소와 인증 코드에 닿기 전에 다시 동의를 요구한다', async () => {
    const state = registrationService();
    await assert.rejects(
        state.service.createUser({
            ...valid,
            agreements: {
                ...valid.agreements,
                privacyPolicy: { ...valid.agreements.privacyPolicy, version: '0.9' },
            },
        }),
        (error: unknown) => error instanceof ConflictException
            && (error.getResponse() as { code?: string }).code === 'LEGAL_VERSION_OUTDATED',
    );
    assert.equal(state.inserted.length, 0);
});

test('저장된 개별 버전과 현재 버전을 비교해 재동의 필요 여부를 판정한다', async () => {
    const agreedAt = new Date('2026-09-01T00:00:00.000Z');
    const db = {
        select: () => ({
            from: () => ({
                where: async () => [{
                    termsVersion: LEGAL_DOCUMENT_VERSIONS.termsVersion,
                    termsAgreedAt: agreedAt,
                    privacyVersion: '0.9',
                    privacyAgreedAt: agreedAt,
                }],
            }),
        }),
    };
    const service = new UserService(db as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    assert.deepEqual(await service.getLegalConsent(7), {
        current: LEGAL_DOCUMENT_VERSIONS,
        agreed: {
            termsVersion: LEGAL_DOCUMENT_VERSIONS.termsVersion,
            termsAgreedAt: agreedAt.toISOString(),
            privacyVersion: '0.9',
            privacyAgreedAt: agreedAt.toISOString(),
        },
        required: true,
    });
});
