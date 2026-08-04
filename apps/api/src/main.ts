import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { CONFIG_TOKEN, type AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get<AppConfig>(CONFIG_TOKEN);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix(config.apiPrefix);

  app.use(
    helmet({
      // Swagger UI needs inline styles/scripts; disabling CSP entirely would be worse,
      // so it is relaxed only where the docs are served from.
      contentSecurityPolicy: config.env === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties and reject requests that send them: mass-assignment
      // protection, and it keeps DTOs honest.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // Validation errors leak the DTO shape; acceptable for an internal tool and
      // genuinely useful to the frontend, but disabled in production.
      disableErrorMessages: false,
    }),
  );

  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('DSA Tracker API')
        .setDescription(
          'LeetCode progress tracking for Kalvium mentors.\n\n' +
            '**Note on the data provider:** LeetCode publishes no official API for ' +
            'submission history. This service reads the public GraphQL endpoint behind ' +
            'a `SubmissionProvider` abstraction, and that endpoint returns only the 20 ' +
            'most recent submissions per user — which is why syncs run several times a ' +
            'day and every submission is mirrored locally.',
        )
        .setVersion('1.0.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
        .addTag('Auth')
        .addTag('Dashboard')
        .addTag('Students')
        .addTag('Assignments')
        .addTag('Sync')
        .addTag('Leaderboard')
        .addTag('Analytics')
        .addTag('Reports')
        .addTag('Admin')
        .addTag('Notifications')
        .addTag('Audit')
        .addTag('Health')
        .build(),
    );

    SwaggerModule.setup(`${config.apiPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true },
      customSiteTitle: 'DSA Tracker API',
    });
  }

  await app.listen(config.port, '0.0.0.0');

  logger.log(`API listening on http://localhost:${config.port}/${config.apiPrefix}`);
  if (config.swaggerEnabled) {
    logger.log(`Swagger UI at http://localhost:${config.port}/${config.apiPrefix}/docs`);
  }
  logger.log(`Program timezone: ${config.program.timezone}`);
  logger.log(`Queue driver: ${config.redis.driver}`);
}

bootstrap().catch((error) => {
  // Nothing is listening yet, so the console is the only channel that exists.
  console.error('Failed to start the API:', error);
  process.exit(1);
});
