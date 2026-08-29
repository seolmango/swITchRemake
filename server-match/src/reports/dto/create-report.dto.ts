import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

export const REPORT_CATEGORIES = ['CHEAT', 'ABUSE', 'GRIEFING', 'NICKNAME'] as const;
export type ReportCategory = typeof REPORT_CATEGORIES[number];

export class CreateReportDto {
    @IsUUID()
    matchId!: string;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    targetUserId!: number;

    @IsIn(REPORT_CATEGORIES)
    category!: ReportCategory;

    @IsString()
    @Length(10, 500)
    description!: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    tick?: number;
}
