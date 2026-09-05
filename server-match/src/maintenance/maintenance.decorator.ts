import { SetMetadata } from '@nestjs/common';

export const BLOCK_DURING_MAINTENANCE = Symbol('BLOCK_DURING_MAINTENANCE');

/** 새 로그인과 새 방 진입처럼 점검 중 시작하면 안 되는 요청에만 붙인다. */
export const BlockDuringMaintenance = () => SetMetadata(BLOCK_DURING_MAINTENANCE, true);
