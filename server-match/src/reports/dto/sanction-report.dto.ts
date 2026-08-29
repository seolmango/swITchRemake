import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export const REPORT_SANCTION_TYPES = ['WARN', 'GAME_RESTRICT', 'BAN'] as const;
export type ReportSanctionType = typeof REPORT_SANCTION_TYPES[number];

export class SanctionReportDto {
    @IsIn(REPORT_SANCTION_TYPES)
    type!: ReportSanctionType;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(3650)
    days?: number;

    @IsString()
    @Length(10, 500)
    reason!: string;
}
