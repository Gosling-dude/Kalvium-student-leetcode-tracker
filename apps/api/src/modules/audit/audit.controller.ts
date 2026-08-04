import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { Roles } from '../../common/decorators';
import { AuditService } from './audit.service';

class AuditQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() entityType?: string;
  @IsOptional() @IsString() actorId?: string;
}

class SystemLogQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() level?: string;
  @IsOptional() @IsString() context?: string;
}

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
@Roles('ADMIN')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('logs')
  @ApiOperation({ summary: 'Paginated audit trail of user actions' })
  findAuditLogs(@Query() query: AuditQueryDto) {
    return this.audit.findAuditLogs({
      page: query.page,
      pageSize: query.pageSize,
      action: query.action,
      entityType: query.entityType,
      actorId: query.actorId,
      search: query.search,
    });
  }

  @Get('system')
  @ApiOperation({ summary: 'Paginated system log' })
  findSystemLogs(@Query() query: SystemLogQueryDto) {
    return this.audit.findSystemLogs({
      page: query.page,
      pageSize: query.pageSize,
      level: query.level,
      context: query.context,
    });
  }
}
