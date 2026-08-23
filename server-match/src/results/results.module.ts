import { Module } from '@nestjs/common';
import { ResultService } from './result.service';
import { ResultWorker } from './result.worker';

@Module({
    providers: [ResultService, ResultWorker],
    exports: [ResultService],
})
export class ResultsModule {}
