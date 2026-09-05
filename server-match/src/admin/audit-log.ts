import { isIP } from 'node:net';
import type { SessionSecurityService } from '../session/session-security.service';

type AuditMetaScalar = string | number | boolean | null;
export type AuditMetaInput = {
    readonly [key: string]: AuditMetaScalar | readonly AuditMetaScalar[];
} & {
    /** IP는 JSON 부가 정보가 아니라 전용 보호 컬럼으로만 받는다. */
    readonly ip?: never;
    readonly ipAddress?: never;
    readonly clientIp?: never;
    readonly remoteIp?: never;
    readonly ipHmac?: never;
    readonly ipEncrypted?: never;
};

declare const auditRequestMetaBrand: unique symbol;

/**
 * 감사 로그 JSON에 넣을 수 있는 값. 생성 함수가 IP처럼 보이는 값까지 검사한 뒤에만 붙이는
 * 브랜드라서, 새 감사 경로가 평범한 `Record<string, unknown>`을 그대로 저장할 수 없다.
 */
export type AuditRequestMeta = Readonly<Record<string, AuditMetaScalar | readonly AuditMetaScalar[]>> & {
    readonly [auditRequestMetaBrand]: true;
};

export interface AuditContext {
    requestMeta: AuditRequestMeta;
    ipHmac?: string;
    ipEncrypted?: string;
}

function looksLikeIp(value: string): boolean {
    let candidate = value.trim().toLowerCase();
    if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
    const zone = candidate.indexOf('%');
    if (zone !== -1) candidate = candidate.slice(0, zone);
    if (candidate.startsWith('::ffff:')) candidate = candidate.slice(7);
    return isIP(candidate) !== 0;
}

export function auditContext(meta: AuditMetaInput = {}): AuditContext {
    for (const [key, value] of Object.entries(meta)) {
        const normalizedKey = key.replace(/[-_]/g, '').toLowerCase();
        if (['ip', 'ipaddress', 'clientip', 'remoteip', 'iphmac', 'ipencrypted'].includes(normalizedKey)) {
            throw new Error('감사 로그 IP는 전용 보호 컬럼으로만 저장해야 한다');
        }
        const values = Array.isArray(value) ? value : [value];
        if (values.some((item) => typeof item === 'string' && looksLikeIp(item))) {
            throw new Error('감사 로그 부가 정보에는 평문 IP를 저장할 수 없다');
        }
    }
    return { requestMeta: Object.freeze({ ...meta }) as AuditRequestMeta };
}

/** 원본 IP는 이 경로에서 즉시 HMAC과 암호화본으로 갈라지고 평문은 반환되지 않는다. */
export function auditContextWithIp(
    security: SessionSecurityService,
    ip: string,
    meta: AuditMetaInput = {},
): AuditContext {
    const protectedIp = security.protectIp(ip);
    return { ...auditContext(meta), ...protectedIp };
}
