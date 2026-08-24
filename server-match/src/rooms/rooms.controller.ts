import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { NeedActor } from '../auth/need-actor.decorator';
import { RateLimiter } from '../ratelimiter.decorator';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';
import { RoomsService } from './rooms.service';
import type { ActorId } from 'shared';

type AuthenticatedRequest = {
    user: { id: ActorId; nickname?: string; guest?: boolean };
    ip: string;
};

@Controller('rooms')
@NeedActor()
export class RoomsController {
    constructor(private readonly rooms: RoomsService) {}

    @Get()
    async list(@Query('page') page?: string) {
        const parsed = page === undefined ? 1 : Number(page);
        return this.rooms.list(parsed);
    }

    @Post()
    @RateLimiter({ anon: 0, guest: 3, account: 6, ttl: 60_000 })
    async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateRoomDto) {
        return this.rooms.create(req.user, dto, req.ip);
    }

    @Post('quick-join')
    @RateLimiter({ anon: 0, guest: 3, account: 6, ttl: 60_000 })
    async quickJoin(@Req() req: AuthenticatedRequest) {
        return this.rooms.quickJoin(req.user, req.ip);
    }

    @Post('code/:roomCode/join')
    @RateLimiter({ anon: 0, guest: 3, account: 6, ttl: 60_000 })
    async joinByCode(
        @Req() req: AuthenticatedRequest,
        @Param('roomCode') roomCode: string,
        @Body() dto: JoinRoomDto,
    ) {
        return this.rooms.joinByCode(req.user, roomCode, dto.password, req.ip);
    }

    @Post(':roomId/resume')
    async resume(@Req() req: AuthenticatedRequest, @Param('roomId') roomId: string) {
        return this.rooms.resume(req.user, roomId);
    }

    @Post(':roomId/join')
    @RateLimiter({ anon: 0, guest: 3, account: 6, ttl: 60_000 })
    async join(
        @Req() req: AuthenticatedRequest,
        @Param('roomId') roomId: string,
        @Body() dto: JoinRoomDto,
    ) {
        return this.rooms.join(req.user, roomId, dto.password, req.ip);
    }
}
