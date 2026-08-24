import { applyDecorators, UseGuards } from '@nestjs/common';
import { AccountGuard } from './account.guard';

export const NeedAccount = () => applyDecorators(UseGuards(AccountGuard));
