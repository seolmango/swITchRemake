import { applyDecorators } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';

/** Shared password rule for registration and password changes. */
export const IsValidPassword = (): PropertyDecorator => applyDecorators(
    IsString(),
    Length(8, 20),
    Matches(/^[A-Za-z0-9!@#$%^&*]+$/),
);
