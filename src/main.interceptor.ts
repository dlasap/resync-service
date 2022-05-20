import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from "@nestjs/common";
// import { snakeCase } from '@dnamicro/service-common/build/utils/helper';
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const { url, body } = context.getArgs()[0];
    const log_path = `${url}`;
    const logger = new Logger(log_path.toUpperCase(), true);

    logger.log(`[PARAMS]: ${JSON.stringify(body)?.length}`);
    return next.handle().pipe(
      tap(
        (res) => logger.log(`[${log_path}]: ${JSON.stringify(res)?.length}`),
        (res) => logger.error(`[${log_path}]: ${JSON.stringify(res)}`)
      )
    );
  }
}
