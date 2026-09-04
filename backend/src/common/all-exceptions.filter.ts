import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Faengt alles ab, was nicht als HttpException geworfen wurde.
 *
 * Zwei Dinge sollen damit aufhoeren: Erstens gehen unerwartete Fehler sonst
 * als Nest-Standardantwort hinaus, bei der je nach Fehlertyp interne Details
 * mitgehen — ein Datenbankfehler nennt gern Tabellen- und Spaltennamen.
 * Zweitens steht in der Antwort dann nichts, womit sich der Eintrag im
 * Protokoll wiederfinden liesse.
 *
 * Deshalb: nach aussen eine feste Meldung mit einer Kennung, nach innen der
 * vollstaendige Fehler mit derselben Kennung. Wer einen Fehler meldet, nennt
 * die Kennung, und man findet die Stelle sofort.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    // Erwartete Fehler — Validierung, 401, 404, Konflikte — gehen unveraendert
    // hinaus. Sie sind Teil des Vertrags und tragen Meldungen, die das
    // Frontend anzeigt.
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    const reference = randomUUID().slice(0, 8);
    const message = exception instanceof Error ? exception.stack ?? exception.message : String(exception);

    this.logger.error(`[${reference}] ${request.method} ${request.url}\n${message}`);

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: `Unerwarteter Fehler. Kennung ${reference} — sie steht so im Protokoll des Backends.`,
      reference,
    });
  }
}
