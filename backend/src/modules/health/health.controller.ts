import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getHealth() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  getReadiness() {
    return {
      status: 'ready',
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      timestamp: new Date().toISOString(),
    };
  }
}
