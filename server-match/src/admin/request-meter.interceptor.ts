import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { RequestMeterService } from './request-meter.service';

/**
 * 요청 수를 센다. 응답을 기다리지 않고 들어오는 즉시 센다 — 느린 요청도 트래픽이다.
 *
 * 반환 타입을 `CallHandler`에서 끌어오는 이유는 워크스페이스에 rxjs가 두 벌 설치돼 있어서,
 * `Observable`을 직접 import하면 어느 쪽을 잡느냐에 따라 타입이 갈리기 때문이다.
 */
@Injectable()
export class RequestMeterInterceptor implements NestInterceptor {
    constructor(private readonly meter: RequestMeterService) {}

    intercept(_context: ExecutionContext, next: CallHandler): ReturnType<CallHandler['handle']> {
        this.meter.record();
        return next.handle();
    }
}
