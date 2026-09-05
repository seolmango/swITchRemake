import { Body, Controller, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { NeedAccount } from '../auth/need-account.decorator';
import { RateLimiter } from '../ratelimiter.decorator';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportsService } from './reports.service';

type AccountRequest = FastifyRequest & { user: { id: number; guest: false } };

@Controller('reports')
export class ReportsController {
    constructor(private readonly reports: ReportsService) {}

    @Post()
    @NeedAccount()
    @RateLimiter({ limit: 5, ttl: 60_000 })
    async create(@Req() req: AccountRequest, @Body() dto: CreateReportDto) {
        return this.reports.create(req.user.id, dto);
    }
}
