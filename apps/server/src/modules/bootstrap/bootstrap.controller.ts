import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ChronosRequest, clientIp } from '../../common/http/request-context';
import { Public } from '../auth/auth.decorators';
import { extractBearerToken } from '../auth/auth.guard';
import { BootstrapInput, bootstrapSchema } from './bootstrap.schemas';
import { BootstrapService } from './bootstrap.service';

@Controller('bootstrap')
@Public()
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @Get('status')
  status() {
    return this.bootstrap.status();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  run(@Body(new ZodValidationPipe(bootstrapSchema)) body: BootstrapInput, @Req() request: ChronosRequest) {
    const ipAddress = clientIp(request);
    return this.bootstrap.bootstrap(body, extractBearerToken(request.headers.authorization), {
      requestId: request.id,
      ...(ipAddress ? { ipAddress } : {}),
    });
  }
}
