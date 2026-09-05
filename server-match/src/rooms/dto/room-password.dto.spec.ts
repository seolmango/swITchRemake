import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRoomDto } from './create-room.dto';
import { JoinRoomDto } from './join-room.dto';

async function createPasswordErrors(password: string | undefined) {
    const value = password === undefined ? { name: '방' } : { name: '방', password };
    return validate(plainToInstance(CreateRoomDto, value));
}

async function joinPasswordErrors(password: string | undefined) {
    const value = password === undefined ? {} : { password };
    return validate(plainToInstance(JoinRoomDto, value));
}

test('방 생성과 참가 비밀번호는 3자리·9자리·문자 혼합·빈 문자열을 거절한다', async () => {
    for (const password of ['123', '123456789', '12a4', '']) {
        assert.ok((await createPasswordErrors(password)).some((error) => error.property === 'password'), password);
        assert.ok((await joinPasswordErrors(password)).some((error) => error.property === 'password'), password);
    }
});

test('방 생성과 참가 비밀번호는 4자리와 8자리 숫자를 허용한다', async () => {
    for (const password of ['1234', '12345678']) {
        assert.equal((await createPasswordErrors(password)).length, 0, password);
        assert.equal((await joinPasswordErrors(password)).length, 0, password);
    }
});

test('비밀번호를 생략한 방은 그대로 만들 수 있다', async () => {
    assert.equal((await createPasswordErrors(undefined)).length, 0);
    assert.equal((await joinPasswordErrors(undefined)).length, 0);
});
