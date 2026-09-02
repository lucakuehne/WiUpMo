import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { InitialSchema1788307200000 } from '../../migrations/1788307200000-InitialSchema.js';
import { ALL_ENTITIES } from './entities/index.js';

/**
 * Diese Datei wird von zwei Seiten benutzt: von der TypeORM-CLI (Migrationen)
 * und von der Nest-Anwendung. Die CLI laeuft ohne Nest und damit ohne
 * ConfigModule, deshalb wird `.env` hier selbst eingelesen. In der laufenden
 * Anwendung hat @nestjs/config das bereits getan; ein zweiter Aufruf
 * ueberschreibt nichts, `dotenv` laesst bestehende Werte in Ruhe.
 */
loadDotenv();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Umgebungsvariable ${name} ist nicht gesetzt.`);
  }
  return value;
}

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: required('DB_HOST'),
  port: Number(process.env.DB_PORT ?? 5432),
  username: required('DB_USER'),
  password: required('DB_PASSWORD'),
  database: required('DB_NAME'),
  ssl: ['1', 'true', 'yes', 'on'].includes((process.env.DB_SSL ?? '').toLowerCase())
    ? { rejectUnauthorized: false }
    : false,

  entities: ALL_ENTITIES,

  /**
   * Migrationen werden namentlich importiert statt ueber ein Glob eingesammelt.
   * Unter ESM ist das Glob-Laden von TypeORM unzuverlaessig, und der explizite
   * Import hat ohnehin den Vorteil, dass eine vergessene Registrierung schon
   * beim Kompilieren auffaellt statt erst beim Deployment.
   */
  migrations: [InitialSchema1788307200000],
  migrationsTableName: 'schema_migrations',

  /**
   * Niemals einschalten. Das Schema kommt ausschliesslich aus den Migrationen —
   * `synchronize` wuerde in Produktion Spalten und damit Daten verwerfen, sobald
   * eine Entity von der Tabelle abweicht.
   */
  synchronize: false,
  migrationsRun: false,

  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn', 'migration'] : ['error'],
};

/** Standardexport fuer die TypeORM-CLI (`-d src/database/data-source.ts`). */
export default new DataSource(dataSourceOptions);
