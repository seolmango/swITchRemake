import { applyDecorators, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

export const NeedAdmin = () => applyDecorators(UseGuards(AdminGuard));
