import assert from 'node:assert/strict';
import test from 'node:test';

import { findPostgresError, uniqueViolationTarget } from './pg-error';

/**
 * drizzle이 감싸서 던지는 모양을 그대로 흉내 낸다. 실제로 이것 때문에 중복 이메일 가입이
 * 409 대신 500을 냈다 — `error.code`만 보면 감싼 층에는 그 값이 없기 때문이다.
 */
const wrapped = (original: unknown, depth = 1): unknown => {
    let current = original;
    for (let i = 0; i < depth; i += 1) {
        const wrapper = new Error('Failed query: insert into "users" ...') as Error & { cause?: unknown };
        wrapper.cause = current;
        current = wrapper;
    }
    return current;
};

const uniqueViolation = {
    code: '23505',
    detail: 'Key (email)=(a@example.com) already exists.',
    constraint_name: 'users_email_unique',
};

test('감싸지 않은 오류에서 SQLSTATE를 찾는다', () => {
    assert.equal(findPostgresError(uniqueViolation, '23505')?.constraint_name, 'users_email_unique');
});

test('drizzle이 한 겹 감싼 오류에서도 찾는다', () => {
    const found = findPostgresError(wrapped(uniqueViolation), '23505');
    assert.equal(found?.detail, uniqueViolation.detail);
});

test('여러 겹 감싸도 찾는다', () => {
    assert.notEqual(findPostgresError(wrapped(uniqueViolation, 3), '23505'), null);
});

test('너무 깊으면 포기한다 — 순환이나 이상한 체인에서 돌지 않는다', () => {
    assert.equal(findPostgresError(wrapped(uniqueViolation, 9), '23505'), null);
});

test('다른 SQLSTATE는 찾지 않는다', () => {
    assert.equal(findPostgresError(wrapped(uniqueViolation), '23503'), null);
});

test('유일성 위반이 아니면 null이다', () => {
    assert.equal(uniqueViolationTarget(new Error('boom')), null);
    assert.equal(uniqueViolationTarget(null), null);
    assert.equal(uniqueViolationTarget(undefined), null);
});

test('어느 제약에서 났는지 detail과 제약 이름을 함께 돌려준다', () => {
    const target = uniqueViolationTarget(wrapped(uniqueViolation));
    assert.ok(target !== null);
    assert.ok(target.includes('email'), '이메일 유일성 위반임을 알아볼 수 있어야 한다');
});

test('닉네임 유일성 위반과 이메일 유일성 위반이 구분된다', () => {
    const nickname = uniqueViolationTarget(wrapped({
        code: '23505',
        detail: 'Key (nickname)=(dup) already exists.',
        constraint_name: 'users_nickname_unique',
    }));
    assert.ok(nickname !== null);
    assert.ok(nickname.includes('nickname'));
    assert.ok(!nickname.includes('email'));
});
