/**
 * Global exception translation.
 *
 * Two responsibilities:
 *  1. Give clients one consistent error envelope regardless of what threw.
 *  2. Never leak internals. Prisma errors in particular carry table and column names,
 *     and stack traces carry filesystem paths — useful in logs, not in an HTTP body.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

import { ProviderError } from '../../modules/providers/provider.errors';

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  code?: string;
  path: string;
  timestamp: string;
  requestId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const { status, message, error, code } = this.translate(exception);

    const body: ErrorResponseBody = {
      statusCode: status,
      error,
      message,
      ...(code ? { code } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
      ...(request.id ? { requestId: request.id } : {}),
    };

    // 5xx means we broke; log the whole thing. 4xx is the client's problem and would
    // otherwise fill the logs with noise from ordinary validation failures.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}: ${JSON.stringify(message)}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.debug(`${request.method} ${request.url} -> ${status}`);
    }

    response.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    message: string | string[];
    error: string;
    code?: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);
      return { status, message, error: this.reasonFor(status) };
    }

    // Provider failures are upstream problems, not client errors: 502/503/504 tell the
    // caller honestly that the fault lies outside this service.
    if (exception instanceof ProviderError) {
      const status =
        exception.syncStatus === 'RATE_LIMITED'
          ? HttpStatus.SERVICE_UNAVAILABLE
          : exception.syncStatus === 'TIMEOUT'
            ? HttpStatus.GATEWAY_TIMEOUT
            : HttpStatus.BAD_GATEWAY;
      return {
        status,
        message: exception.message,
        error: this.reasonFor(status),
        code: exception.syncStatus,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.translatePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'The request did not match the expected shape.',
        error: 'Bad Request',
        code: 'PRISMA_VALIDATION',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred.',
      error: 'Internal Server Error',
    };
  }

  private translatePrisma(exception: Prisma.PrismaClientKnownRequestError): {
    status: number;
    message: string;
    error: string;
    code: string;
  } {
    const target = exception.meta?.target;
    const fields = Array.isArray(target) ? target.join(', ') : String(target ?? 'field');

    switch (exception.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          message: `A record with this ${fields} already exists.`,
          error: 'Conflict',
          code: exception.code,
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          message: 'The requested record was not found.',
          error: 'Not Found',
          code: exception.code,
        };
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'A referenced record does not exist.',
          error: 'Bad Request',
          code: exception.code,
        };
      case 'P2014':
        return {
          status: HttpStatus.BAD_REQUEST,
          message: 'This change would break a required relation.',
          error: 'Bad Request',
          code: exception.code,
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'A database error occurred.',
          error: 'Internal Server Error',
          code: exception.code,
        };
    }
  }

  private reasonFor(status: number): string {
    const names: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      409: 'Conflict',
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };
    return names[status] ?? 'Error';
  }
}
