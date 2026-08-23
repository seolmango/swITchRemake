import { IsOptional, IsString, MaxLength } from 'class-validator';

export class JoinRoomDto {
    @IsOptional()
    @IsString()
    @MaxLength(32)
    password?: string;
}
