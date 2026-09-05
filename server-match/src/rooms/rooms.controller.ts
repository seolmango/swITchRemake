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
    @RateLimiter({ limit: 120, ttl: 60_000 })
    async list(@Query('page') page?: string) {
        const parsed = page === undefined ? 1 : Number(page);
        return this.rooms.list(parsed);
    }

    @Post()
    // 방 생성·참가·빠른 참가는 모두 §9의 "좁게" 등급 한도 하나를 공유한다.
    @RateLimiter({ limit: 15, ttl: 60_000 })
    async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateRoomDto) {
        return this.rooms.create(req.user, dto, req.ip);
    }

    @Post('quick-join')
    // 신원 종류와 무관하게 같은 참가 한도를 쓴다. IP 버킷은 가드에서 NAT 배수로 더 넓다.
    @RateLimiter({ limit: 15, ttl: 60_000 })
    async quickJoin(@Req() req: AuthenticatedRequest) {
        return this.rooms.quickJoin(req.user, req.ip);
    }

    @Post('code/:roomCode/join')
    // 신원 종류와 무관하게 같은 참가 한도를 쓴다. IP 버킷은 가드에서 NAT 배수로 더 넓다.
    @RateLimiter({ limit: 15, ttl: 60_000 })
    async joinByCode(
        @Req() req: AuthenticatedRequest,
        @Param('roomCode') roomCode: string,
        @Body() dto: JoinRoomDto,
    ) {
        return this.rooms.joinByCode(req.user, roomCode, dto.password, req.ip);
    }

    @Post(':roomId/resume')
    @RateLimiter({ limit: 120, ttl: 60_000 })
    async resume(@Req() req: AuthenticatedRequest, @Param('roomId') roomId: string) {
        return this.rooms.resume(req.user, roomId);
    }

    @Post(':roomId/join')
    // 신원 종류와 무관하게 같은 참가 한도를 쓴다. IP 버킷은 가드에서 NAT 배수로 더 넓다.
    @RateLimiter({ limit: 15, ttl: 60_000 })
    async join(
        @Req() req: AuthenticatedRequest,
        @Param('roomId') roomId: string,
        @Body() dto: JoinRoomDto,
    ) {
        return this.rooms.join(req.user, roomId, dto.password, req.ip);
    }
}
