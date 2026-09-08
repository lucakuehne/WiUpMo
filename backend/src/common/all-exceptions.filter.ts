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

    // Fehler des Body-Parsers sind Aussagen ueber die Anfrage, nicht ueber den
    // Server. Als 500 mit Kennung ausgeliefert sahen sie aus wie ein Defekt und
    // fuellten das Protokoll mit Stapelspuren, die nichts erklaeren.
    const parseError = describeBodyParserError(exception);
    if (parseError) {
      this.logger.warn(`${request.method} ${request.url}: ${parseError.message}`);
      response.status(parseError.status).json({
        statusCode: parseError.status,
        message: parseError.message,
      });
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

/**
 * Erkennt die Fehler von `body-parser` an ihrem `type`-Feld. Nur diese vier
 * Faelle, bewusst keine allgemeine Regel "alles mit 4xx durchreichen": Die
 * Meldungen fremder Bibliotheken sind nicht darauf geprueft, ob sie Interna
 * preisgeben.
 */
function describeBodyParserError(exception: unknown): { status: number; message: string } | null {
  if (typeof exception !== 'object' || exception === null || !('type' in exception)) {
    return null;
  }

  switch ((exception as { type: unknown }).type) {
    case 'entity.too.large':
      return { status: 413, message: 'Die Anfrage ist zu gross.' };
    case 'entity.parse.failed':
      return { status: 400, message: 'Der Anfragekoerper ist kein gueltiges JSON.' };
    case 'encoding.unsupported':
      return { status: 415, message: 'Die Zeichenkodierung wird nicht unterstuetzt.' };
    case 'request.aborted':
      return { status: 400, message: 'Die Anfrage wurde abgebrochen.' };
    default:
      return null;
  }
}
