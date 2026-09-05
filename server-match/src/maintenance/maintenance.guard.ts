import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BLOCK_DURING_MAINTENANCE } from './maintenance.decorator';
import { MaintenanceService } from './maintenance.service';

@Injectable()
export class MaintenanceGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly maintenance: MaintenanceService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const blocked = this.reflector.getAllAndOverride<boolean>(BLOCK_DURING_MAINTENANCE, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (!blocked) return true;
        await this.maintenance.assertAcceptingNewEntries();
        return true;
    }
}
