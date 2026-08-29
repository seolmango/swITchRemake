import { IsIn, IsOptional, IsString } from 'class-validator';
import { REPORT_STATUSES, type ReportStatus } from './report-queue-query.dto';

export class UpdateReportStatusDto {
    @IsIn(REPORT_STATUSES)
    status!: ReportStatus;

    @IsOptional()
    @IsString()
    note?: string;
}
