import { applyDecorators, UseGuards } from '@nestjs/common';
import { ActorGuard } from './actor.guard';

export const NeedActor = () => applyDecorators(UseGuards(ActorGuard));
