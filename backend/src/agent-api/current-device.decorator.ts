import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Device } from '../database/entities/index.js';
import { AUTHENTICATED_DEVICE, RequestWithDevice } from './device-auth.guard.js';

/**
 * Liefert das vom `DeviceAuthGuard` gesetzte Geraet. Nur an Routen benutzen,
 * die hinter diesem Guard haengen — sonst ist der Wert undefiniert.
 */
export const CurrentDevice = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Device => {
    const request = context.switchToHttp().getRequest<RequestWithDevice>();
    const device = request[AUTHENTICATED_DEVICE];
    if (!device) {
      throw new Error(
        'CurrentDevice ohne DeviceAuthGuard verwendet — die Route ist nicht authentifiziert.',
      );
    }
    return device;
  },
);
