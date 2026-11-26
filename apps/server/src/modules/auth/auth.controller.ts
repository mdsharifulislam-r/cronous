import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ChronosRequest, Principal, clientIp } from '../../common/http/request-context';
import { CurrentPrincipal, CurrentUserId, Public } from './auth.decorators';
import {
  ChangePasswordInput,
  LoginInput,
  UpdateProfileInput,
  changePasswordSchema,
  loginSchema,
  updateProfileSchema,
} from './auth.schemas';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput, @Req() request: ChronosRequest) {
    const ipAddress = clientIp(request);
    return this.auth.login(body, { requestId: request.id, ...(ipAddress ? { ipAddress } : {}) });
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@CurrentPrincipal() principal: Principal, @Req() request: ChronosRequest): Promise<void> {
    await this.auth.logout(principal, { requestId: request.id });
  }

  @Get('me')
  me(@CurrentUserId() userId: string) {
    return this.auth.me(userId);
  }

  @Patch('me')
  updateProfile(
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileInput,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.auth.updateProfile(principal as Principal & { type: 'user' }, body, { requestId: request.id });
  }

  /** Changes the caller's password and signs out all of their other sessions. */
  @Post('password')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @CurrentPrincipal() principal: Principal,
    @Req() request: ChronosRequest,
  ) {
    return this.auth.changePassword(principal as Principal & { type: 'user' }, body, { requestId: request.id });
  }
}
