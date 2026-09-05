import { Transform, Type } from 'class-transformer';
import {
    IsDateString,
    IsIn,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
    ValidateNested,
} from 'class-validator';

export const SERVICE_STATUSES = ['ready', 'maintenance'] as const;
export type ServiceStatus = typeof SERVICE_STATUSES[number];

export class LocalizedMessageDto {
    @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
    @IsString()
    @MinLength(1)
    @MaxLength(2_000)
    ko!: string;

    @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
    @IsString()
    @MinLength(1)
    @MaxLength(2_000)
    en!: string;
}

/**
 * 공개 상태 전체를 한 번에 교체한다.
 *
 * ready일 때 announcement를 생략하면 기존 공지를 지우고, maintenance일 때 notice는 선택이다.
 * 상태별로 허용되지 않는 필드 조합은 서비스가 400으로 거절한다.
 */
export class UpdateMaintenanceDto {
    @IsIn(SERVICE_STATUSES)
    status!: ServiceStatus;

    @IsOptional()
    @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
    @IsDateString()
    returnsAt?: string;

    @IsOptional()
    @ValidateNested()
    @Type(() => LocalizedMessageDto)
    notice?: LocalizedMessageDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => LocalizedMessageDto)
    announcement?: LocalizedMessageDto;

    /** 운영 변경을 감사 로그만 보고도 설명할 수 있게 반드시 받는다. */
    @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
    @IsString()
    @MinLength(1)
    @MaxLength(500)
    reason!: string;
}
