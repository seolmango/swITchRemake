import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_PLAYERS_PER_ROOM, RoomMode } from 'shared';

export class CreateRoomDto {
    @IsString()
    @MinLength(1)
    @MaxLength(20)
    name!: string;

    @IsOptional()
    @IsString()
    @Matches(/^\d{4,8}$/, { message: 'password must be 4 to 8 digits' })
    password?: string;

    /**
     * 훈련장은 정원 1을 허용한다. 경기 방은 예전대로 2 이상이다.
     * 값 자체의 하한은 인게임 서버가 모드와 함께 다시 본다 — 여기서는 형식만 통과시킨다.
     */
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(MAX_PLAYERS_PER_ROOM)
    capacity?: number;

    /** 생략하면 일반 경기. 훈련장은 방 목록에도 빠른 참가에도 나오지 않는다. */
    @IsOptional()
    @IsIn(Object.values(RoomMode))
    mode?: RoomMode;

    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    mapId?: string;
}
