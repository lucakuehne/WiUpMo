import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EnrollRequestDto, EnrollResponseDto } from './dto/enroll.dto.js';
import { EnrollmentService } from './enrollment.service.js';

/**
 * Die Version steckt im Pfad, weil aeltere Agent-Staende im Feld bleiben. Das
 * Backend muss mehrere Vertragsversionen gleichzeitig bedienen koennen.
 */
@ApiTags('agent')
@Controller('api/agent/v1')
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Registriert ein Geraet und gibt einmalig dessen Secret zurueck.',
  })
  enroll(@Body() dto: EnrollRequestDto): Promise<EnrollResponseDto> {
    return this.enrollment.enroll(dto);
  }
}
