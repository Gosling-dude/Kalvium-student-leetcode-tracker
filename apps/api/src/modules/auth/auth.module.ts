import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AdminRecoveryController } from './admin-recovery.controller';
import { AdminRecoveryService } from './admin-recovery.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { StudentAccountsService } from './student-accounts.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    // Secrets are passed explicitly at sign/verify time so the access and refresh
    // secrets can never be accidentally interchanged by a module-level default.
    JwtModule.register({}),
    // `AuditService` and `EmailService` need no import here — both modules are `@Global()`.
  ],
  controllers: [AuthController, AdminRecoveryController],
  providers: [AuthService, JwtStrategy, StudentAccountsService, AdminRecoveryService],
  exports: [AuthService, StudentAccountsService, AdminRecoveryService],
})
export class AuthModule {}
