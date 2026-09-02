import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import { Device, DeviceSecret } from '../database/entities/index.js';
import { DeviceStatus } from '../database/enums.js';
import { EnrollRequestDto, EnrollResponseDto } from './dto/enroll.dto.js';
import { buildDeviceToken, generateDeviceSecret, hashDeviceSecret } from './device-token.js';

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);
  private readonly enrollmentTokenHash: Buffer;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    const token = config.get<string>('AGENT_ENROLLMENT_TOKEN');
    if (!token) {
      // Kann nur passieren, wenn die Env-Validierung umgangen wurde.
      throw new Error('AGENT_ENROLLMENT_TOKEN ist nicht konfiguriert.');
    }
    // Als Hash vorhalten, damit der Vergleich unabhaengig von der Laenge des
    // eingehenden Werts in konstanter Zeit laufen kann.
    this.enrollmentTokenHash = createHash('sha256').update(token, 'utf8').digest();
  }

  private assertValidEnrollmentToken(candidate: string): void {
    const candidateHash = createHash('sha256').update(candidate, 'utf8').digest();
    if (!timingSafeEqual(this.enrollmentTokenHash, candidateHash)) {
      throw new UnauthorizedException('Ungueltiges Enrollment-Token.');
    }
  }

  /**
   * Registriert ein Geraet und gibt genau einmal dessen Secret heraus.
   *
   * Meldet sich ein bereits bekanntes Geraet erneut (Neuinstallation,
   * verlorenes Secret), werden die alten Secrets gesperrt und ein neues
   * ausgegeben. Die Geraete-ID und damit die gesamte Historie bleibt erhalten.
   */
  async enroll(dto: EnrollRequestDto): Promise<EnrollResponseDto> {
    this.assertValidEnrollmentToken(dto.enrollmentToken);

    const secret = generateDeviceSecret();
    const secretHash = hashDeviceSecret(secret);

    const deviceId = await this.dataSource.transaction(async (manager) => {
      const devices = manager.getRepository(Device);

      // Zuordnung bevorzugt ueber die objectGUID: sie ueberlebt Umbenennungen.
      let device: Device | null = null;
      if (dto.host.adObjectGuid) {
        device = await devices.findOne({ where: { adObjectGuid: dto.host.adObjectGuid } });
      }
      if (!device) {
        device = await devices
          .createQueryBuilder('d')
          .where('lower(d.hostname) = lower(:hostname)', { hostname: dto.host.hostname })
          .orderBy('d.enrolled_at', 'DESC', 'NULLS LAST')
          .getOne();
      }

      if (device) {
        device.hostname = dto.host.hostname;
        device.osName = dto.host.osName ?? device.osName;
        device.osVersion = dto.host.osVersion ?? device.osVersion;
        device.osBuild = dto.host.osBuild ?? device.osBuild;
        device.adObjectGuid = dto.host.adObjectGuid ?? device.adObjectGuid;
        device.agentVersion = dto.agentVersion;
        device.enrolledAt = device.enrolledAt ?? new Date();
        // Ein Geraet, das sich wieder meldet, ist offensichtlich wieder da.
        if (device.status === DeviceStatus.Archived) {
          device.status = DeviceStatus.Active;
          device.archivedAt = null;
          device.archivedReason = null;
        }
        await devices.save(device);

        await manager
          .getRepository(DeviceSecret)
          .update({ deviceId: device.id, revokedAt: IsNull() }, { revokedAt: new Date() });

        this.logger.log(`Erneutes Enrollment fuer ${device.hostname} (${device.id}).`);
      } else {
        device = devices.create({
          hostname: dto.host.hostname,
          osName: dto.host.osName ?? null,
          osVersion: dto.host.osVersion ?? null,
          osBuild: dto.host.osBuild ?? null,
          adObjectGuid: dto.host.adObjectGuid ?? null,
          agentVersion: dto.agentVersion,
          enrolledAt: new Date(),
          status: DeviceStatus.Active,
        });
        await devices.save(device);
        this.logger.log(`Neues Geraet registriert: ${device.hostname} (${device.id}).`);
      }

      await manager.getRepository(DeviceSecret).insert({ deviceId: device.id, secretHash });

      return device.id;
    });

    return {
      deviceId,
      deviceSecret: secret,
      token: buildDeviceToken(deviceId, secret),
    };
  }
}
