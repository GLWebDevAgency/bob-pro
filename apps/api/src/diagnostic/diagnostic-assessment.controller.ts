import { Body, Controller, Get, Put } from '@nestjs/common';
import { unwrap } from '../http/result';
import { DiagnosticAssessmentService } from './diagnostic-assessment.service';

/** Resource singleton du tenant courant. JWT + company_id sont imposés par les guards globaux. */
@Controller('diagnostic/assessment')
export class DiagnosticAssessmentController {
  constructor(private readonly service: DiagnosticAssessmentService) {}

  @Get()
  async get() {
    return unwrap(await this.service.getCurrent());
  }

  @Put()
  async put(@Body() body: unknown) {
    return unwrap(await this.service.saveCurrent(body));
  }
}
