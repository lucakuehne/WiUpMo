import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Prueft die Datenbankverbindung mit, nicht nur den Prozess. Ein Backend, das
   * antwortet, aber die Datenbank nicht erreicht, ist fuer den Agent wertlos —
   * es soll in dem Fall auch nicht als gesund gelten.
   */
  @Get()
  @ApiOperation({ summary: 'Bereitschaft von Anwendung und Datenbank.' })
  async check(): Promise<{ status: string; database: string; uptimeSeconds: number }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'unreachable',
      });
    }

    return {
      status: 'ok',
      database: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
