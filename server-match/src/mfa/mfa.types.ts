import type { mfaMethodEnum } from '../database/schema';

export type MfaMethod = typeof mfaMethodEnum.enumValues[number];

export type MfaAuthorization =
    | { kind: 'not-enabled' }
    | { kind: 'verified'; method: MfaMethod };

export type LoginMfaAuthorization =
    | { kind: 'not-enabled' }
    | { kind: 'trusted-device'; token: string }
    | { kind: 'verified'; method: MfaMethod };
