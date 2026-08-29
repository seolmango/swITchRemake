import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min, ValidateIf } from 'class-validator';

export const REPORT_CATEGORIES = ['CHEAT', 'ABUSE', 'GRIEFING', 'NICKNAME'] as const;
export type ReportCategory = typeof REPORT_CATEGORIES[number];

export class CreateReportDto {
    @IsUUID()
    matchId!: string;

    @ValidateIf((_object, value) => value !== undefined)
    @Type(() => Number)
    @IsInt()
    @Min(1)
    targetUserId?: number;

    @ValidateIf((_object, value) => value !== undefined)
    @Type(() => Number)
    @IsInt()
    @Min(1)
    targetPlayerId!: number;

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
