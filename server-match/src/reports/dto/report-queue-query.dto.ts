import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const REPORT_STATUSES = ['OPEN', 'TRIAGED', 'REVIEWING', 'ACTIONED', 'DISMISSED', 'CLOSED'] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];

export class ReportQueueQueryDto {
    @IsOptional()
    @IsIn(REPORT_STATUSES)
    status?: ReportStatus;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(50)
    limit = 20;

    @IsOptional()
    @IsString()
    @MaxLength(512)
    cursor?: string;
}
