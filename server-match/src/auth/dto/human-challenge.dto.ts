import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsInt, IsString, IsUUID, Max, Min } from 'class-validator';

export enum HumanChallengePurpose {
    SIGNUP = 'signup',
    RESET_PASSWORD = 'reset-password',
    DELETE = 'delete',
    LOGIN = 'login',
}

export class IssueHumanChallengeDto {
    @IsEnum(HumanChallengePurpose)
    purpose!: HumanChallengePurpose;

    @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
    @IsEmail()
    subject!: string;
}

export class VerifyHumanChallengeDto {
    @IsString()
    @IsUUID()
    challengeToken!: string;

    @IsInt()
    @Min(1)
    @Max(8)
    selectedSlot!: number;
}
