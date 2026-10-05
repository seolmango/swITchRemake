import { Transform, Type } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, ValidateNested } from 'class-validator';

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

    /** 장면이 필요할 때 무엇으로 받을지. 'radio'는 턴제 중계(접근성 경로)다. */
    @IsOptional()
    @IsIn(['switch', 'radio'])
    mode?: 'switch' | 'radio';
}

export class HumanChallengeAnswerDto {
    @IsInt()
    @Min(1)
    @Max(8)
    slot!: number;

    /** 장면 시작 기준 누른 시각(ms). 라스트 세컨드 스위치에서만 쓴다. */
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(60_000)
    atMs?: number;
}

export class VerifyHumanChallengeDto {
    @IsString()
    @IsUUID()
    challengeToken!: string;

    /** 스위치 충전(작업 증명)의 답. */
    @IsInt()
    @Min(0)
    @Max(Number.MAX_SAFE_INTEGER)
    powCounter!: number;

    @IsOptional()
    @ValidateNested()
    @Type(() => HumanChallengeAnswerDto)
    answer?: HumanChallengeAnswerDto;
}
