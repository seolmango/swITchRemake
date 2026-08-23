import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_PLAYERS_PER_ROOM } from 'shared';

export class CreateRoomDto {
    @IsString()
    @MinLength(1)
    @MaxLength(20)
    name!: string;

    @IsOptional()
    @IsString()
    @MaxLength(32)
    password?: string;

    @IsOptional()
    @IsInt()
    @Min(2)
    @Max(MAX_PLAYERS_PER_ROOM)
    capacity?: number;

    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    mapId?: string;
}
