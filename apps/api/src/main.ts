import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableCors();
  await app.listen(env.PORT);
  // eslint-disable-next-line no-console
  console.log(
    `Bob Pro API -> http://localhost:${env.PORT}  (demo=${env.DEMO_MODE}, claude=${!!env.ANTHROPIC_API_KEY}, glm=${!!env.GLM_API_KEY})`,
  );
}

void bootstrap();
