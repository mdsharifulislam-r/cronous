import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { CredentialsService } from './credentials.service';
import { LoginThrottleService } from './login-throttle.service';
import { RateLimitService } from './rate-limit.service';
import { RolesGuard } from './roles.guard';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    CredentialsService,
    LoginThrottleService,
    RateLimitService,
    // Order matters: authentication runs before authorization.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [CredentialsService, RateLimitService],
})
export class AuthModule {}
