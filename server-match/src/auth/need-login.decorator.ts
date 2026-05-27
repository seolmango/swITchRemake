import { applyDecorators, UseGuards } from '@nestjs/common';
import { LoggedInGuard } from "./logged-in.guard";

export const NeedLogin = () => applyDecorators(UseGuards(LoggedInGuard));