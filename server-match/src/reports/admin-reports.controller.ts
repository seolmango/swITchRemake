import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { NeedAdmin } from '../admin/need-admin.decorator';
import { ReportQueueQueryDto } from './dto/report-queue-query.dto';
import { SanctionReportDto } from './dto/sanction-report.dto';
import { UpdateReportStatusDto } from './dto/update-report-status.dto';
import { ReportsService } from './reports.service';

type AdminRequest = FastifyRequest & { user: { id: number; guest: false } };

@Controller('admin/reports')
@NeedAdmin()
export class AdminReportsController {
    constructor(private readonly reports: ReportsService) {}

    @Get()
    async list(@Query() query: ReportQueueQueryDto) {
        return this.reports.getQueue(query.status, query.limit, query.cursor);
    }

    @Get(':caseId')
    async detail(@Param('caseId', new ParseUUIDPipe()) caseId: string) {
        return this.reports.getCase(caseId);
    }

    @Post(':caseId/status')
    async updateStatus(
        @Req() req: AdminRequest,
        @Param('caseId', new ParseUUIDPipe()) caseId: string,
        @Body() dto: UpdateReportStatusDto,
    ) {
        return this.reports.updateStatus(caseId, req.user.id, dto);
    }

    @Post(':caseId/sanction')
    async sanction(
        @Req() req: AdminRequest,
        @Param('caseId', new ParseUUIDPipe()) caseId: string,
        @Body() dto: SanctionReportDto,
    ) {
        return this.reports.sanction(caseId, req.user.id, dto);
    }
}
