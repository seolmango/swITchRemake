import { Type } from 'class-transformer';
import { IsDefined, IsISO8601, IsString, MaxLength, ValidateNested } from 'class-validator';

export class LegalAcceptanceDto {
    @IsString()
    @MaxLength(32)
    version!: string;

    /** 화면에서 체크한 시각. 저장 시각은 조작할 수 없는 서버 시계를 쓴다. */
    @IsISO8601({ strict: true })
    acceptedAt!: string;
}

export class LegalAgreementsDto {
    @IsDefined()
    @ValidateNested()
    @Type(() => LegalAcceptanceDto)
    termsOfService!: LegalAcceptanceDto;

    @IsDefined()
    @ValidateNested()
    @Type(() => LegalAcceptanceDto)
    privacyPolicy!: LegalAcceptanceDto;
}

export class LegalConsentDto {
    @IsDefined()
    @ValidateNested()
    @Type(() => LegalAgreementsDto)
    agreements!: LegalAgreementsDto;
}
