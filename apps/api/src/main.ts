import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { AppLogger } from './observability/logger';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(AppLogger));
  app.use(helmet());
  app.enableCors();
  await app.listen(env.PORT);
  app
    .get(AppLogger)
    .log(
      `Bob Pro API -> http://localhost:${env.PORT} (demo=${env.DEMO_MODE}, claude=${!!env.ANTHROPIC_API_KEY}, glm=${!!env.GLM_API_KEY})`,
      'Bootstrap',
    );
}

void bootstrap();
