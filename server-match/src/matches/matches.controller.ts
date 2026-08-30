import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Req, Res } from '@nestjs/common';
import type { ActorId } from 'shared';
import { NeedActor } from '../auth/need-actor.decorator';
import { RateLimiter } from '../ratelimiter.decorator';
import { MatchesService } from './matches.service';

type AuthenticatedRequest = { user: { id: ActorId } };
type StatusResponse = { status(code: number): unknown };

@Controller('matches')
@NeedActor()
export class MatchesController {
    constructor(private readonly matches: MatchesService) {}

    @Get(':matchId/result')
    @RateLimiter({ anon: 0, guest: 30, account: 60, ttl: 60_000 })
    async getResult(
        @Req() req: AuthenticatedRequest,
        // uuid가 아니면 Postgres 파싱 오류로 500이 난다. 형식은 여기서 거른다.
        @Param('matchId', new ParseUUIDPipe()) matchId: string,
        @Res({ passthrough: true }) response: StatusResponse,
    ) {
        const result = await this.matches.getResult(matchId, req.user.id);
        if ('status' in result) response.status(HttpStatus.ACCEPTED);
        return result;
    }
}
