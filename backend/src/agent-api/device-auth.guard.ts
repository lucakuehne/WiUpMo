import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { IsNull, Repository } from 'typeorm';
import { Device, DeviceSecret } from '../database/entities/index.js';
import { DeviceStatus } from '../database/enums.js';
import { hashDeviceSecret, parseDeviceToken, secretHashMatches } from './device-token.js';

/** Das authentifizierte Geraet wird unter diesem Schluessel am Request abgelegt. */
export const AUTHENTICATED_DEVICE = 'authenticatedDevice';

export interface RequestWithDevice extends Request {
  [AUTHENTICATED_DEVICE]?: Device;
}

@Injectable()
export class DeviceAuthGuard implements CanActivate {
  private readonly logger = new Logger(DeviceAuthGuard.name);

  constructor(
    @InjectRepository(Device)
    private readonly devices: Repository<Device>,
    @InjectRepository(DeviceSecret)
    private readonly secrets: Repository<DeviceSecret>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithDevice>();

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization-Header fehlt oder ist kein Bearer-Token.');
    }

    const parsed = parseDeviceToken(header.slice('Bearer '.length).trim());
    if (!parsed) {
      throw new UnauthorizedException('Token hat nicht die Form <deviceId>.<secret>.');
    }

    const device = await this.devices.findOne({ where: { id: parsed.deviceId } });
    if (!device) {
      // Bewusst dieselbe Meldung wie bei falschem Secret: sonst laesst sich
      // ueber die Antwort herausfinden, welche Geraete-IDs existieren.
      throw new UnauthorizedException('Unbekanntes Geraet oder ungueltiges Secret.');
    }

    const activeSecrets = await this.secrets.find({
      where: { deviceId: device.id, revokedAt: IsNull() },
    });

    const candidateHash = hashDeviceSecret(parsed.secret);
    // Mehrere aktive Secrets sind waehrend einer Rotation normal: das alte
    // bleibt gueltig, bis der Agent das neue nachweislich benutzt hat.
    const matches = activeSecrets.some((s) => secretHashMatches(s.secretHash, candidateHash));

    if (!matches) {
      this.logger.warn(`Fehlgeschlagene Authentifizierung fuer Geraet ${device.id}.`);
      throw new UnauthorizedException('Unbekanntes Geraet oder ungueltiges Secret.');
    }

    if (device.status === DeviceStatus.Archived) {
      // Getrennte Meldung: hier ist das Secret korrekt, das Geraet aber gesperrt.
      throw new UnauthorizedException('Geraet ist archiviert.');
    }

    request[AUTHENTICATED_DEVICE] = device;
    return true;
  }
}
