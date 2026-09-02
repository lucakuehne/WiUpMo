import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ausgangsschema. Bewusst als handgeschriebenes SQL statt als generierte
 * Migration: Enumtypen, Teilindizes und die Idempotenzbedingung auf
 * `snapshot_id` sollen genau so aussehen und nicht dem entsprechen, was ein
 * Generator gerade aus den Entities ableitet.
 *
 * Setzt PostgreSQL 13 oder neuer voraus (`gen_random_uuid()` ohne Extension).
 */
export class InitialSchema1788307200000 implements MigrationInterface {
  name = 'InitialSchema1788307200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------- Enums
    await queryRunner.query(`CREATE TYPE "device_status" AS ENUM ('active', 'archived')`);
    await queryRunner.query(
      `CREATE TYPE "update_state" AS ENUM ('available', 'installed', 'failed', 'hidden', 'superseded')`,
    );
    await queryRunner.query(
      `CREATE TYPE "update_event_type" AS ENUM ('appeared', 'installed', 'failed', 'disappeared', 'hidden')`,
    );
    await queryRunner.query(
      `CREATE TYPE "update_source" AS ENUM ('wsus', 'microsoft_update', 'intune', 'dual_scan', 'unknown')`,
    );
    await queryRunner.query(`CREATE TYPE "ad_sync_trigger" AS ENUM ('scheduled', 'manual')`);
    await queryRunner.query(
      `CREATE TYPE "ad_sync_status" AS ENUM ('running', 'success', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "agent_update_job_state" AS ENUM ('pending', 'delivered', 'installing', 'done', 'failed')`,
    );

    // -------------------------------------------------------------- devices
    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "hostname"        text NOT NULL,
        "ad_dn"           text,
        "ad_object_guid"  uuid UNIQUE,
        "ad_ou"           text,
        "os_name"         text,
        "os_version"      text,
        "os_build"        text,
        "enrolled_at"     timestamptz,
        "last_seen_at"    timestamptz,
        "agent_version"   text,
        "status"          "device_status" NOT NULL DEFAULT 'active',
        "archived_at"     timestamptz,
        "archived_reason" text,
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "updated_at"      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `COMMENT ON COLUMN "devices"."ad_object_guid" IS 'Stabiler Schluessel gegenueber dem AD; Hostnamen aendern sich, die GUID nicht.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "devices"."enrolled_at" IS 'NULL = Geraet nur aus dem AD bekannt, ohne installierten Agent.'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_devices_last_seen_at" ON "devices" ("last_seen_at")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_devices_status" ON "devices" ("status")`);
    // Fuer den Abgleich beim Enrollment, wenn noch keine objectGUID vorliegt.
    await queryRunner.query(`CREATE INDEX "idx_devices_hostname_lower" ON "devices" (lower("hostname"))`);

    // ------------------------------------------------------- device_secrets
    await queryRunner.query(`
      CREATE TABLE "device_secrets" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "device_id"   uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
        "secret_hash" text NOT NULL,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "revoked_at"  timestamptz
      )
    `);
    await queryRunner.query(
      `COMMENT ON COLUMN "device_secrets"."secret_hash" IS 'SHA-256 des Geraete-Secrets. Kein Argon2: der Wert ist ein Zufallswert mit 256 Bit Entropie, kein erratbares Passwort.'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_device_secrets_device_active" ON "device_secrets" ("device_id", "revoked_at")`,
    );

    // -------------------------------------------------------------- updates
    await queryRunner.query(`
      CREATE TABLE "updates" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "update_id"       text NOT NULL UNIQUE,
        "revision_number" int,
        "kb_article"      text,
        "title"           text NOT NULL,
        "severity"        text,
        "categories"      text[] NOT NULL DEFAULT '{}',
        "is_security"     boolean NOT NULL DEFAULT false,
        "msrc_number"     text,
        "size_bytes"      bigint,
        "support_url"     text,
        "first_seen_at"   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `COMMENT ON COLUMN "updates"."update_id" IS 'IUpdateIdentity.UpdateID aus der Windows-Update-API.'`,
    );
    await queryRunner.query(`CREATE INDEX "idx_updates_kb_article" ON "updates" ("kb_article")`);
    await queryRunner.query(`CREATE INDEX "idx_updates_is_security" ON "updates" ("is_security")`);

    // -------------------------------------------------- device_update_states
    await queryRunner.query(`
      CREATE TABLE "device_update_states" (
        "device_id"           uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
        "update_id"           uuid NOT NULL REFERENCES "updates" ("id") ON DELETE CASCADE,
        "state"               "update_state" NOT NULL,
        "first_available_at"  timestamptz,
        "installed_at"        timestamptz,
        "result_code"         int,
        "hresult"             int,
        "reboot_required"     boolean NOT NULL DEFAULT false,
        "last_reported_at"    timestamptz NOT NULL,
        PRIMARY KEY ("device_id", "update_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_device_update_states_device_state" ON "device_update_states" ("device_id", "state")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_device_update_states_update" ON "device_update_states" ("update_id")`,
    );
    // Traegt die Auswertungen "kritisch offen seit N Tagen" und "Patch-Alter":
    // beide fragen ausschliesslich offene Updates ab, deshalb ein Teilindex.
    await queryRunner.query(`
      CREATE INDEX "idx_device_update_states_open" ON "device_update_states" ("first_available_at")
      WHERE "state" = 'available'
    `);

    // -------------------------------------------------- device_update_events
    await queryRunner.query(`
      CREATE TABLE "device_update_events" (
        "id"          bigserial PRIMARY KEY,
        "device_id"   uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
        "update_id"   uuid NOT NULL REFERENCES "updates" ("id") ON DELETE CASCADE,
        "event_type"  "update_event_type" NOT NULL,
        "occurred_at" timestamptz NOT NULL,
        "reported_at" timestamptz NOT NULL DEFAULT now(),
        "details"     jsonb
      )
    `);
    await queryRunner.query(
      `COMMENT ON COLUMN "device_update_events"."occurred_at" IS 'Lokaler Zeitpunkt auf dem Geraet — massgeblich fuer die Zeitreihe.'`,
    );
    await queryRunner.query(
      `COMMENT ON COLUMN "device_update_events"."reported_at" IS 'Eingang im Backend. Weicht bei nachgereichten Offline-Snapshots ab.'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_device_update_events_device_occurred" ON "device_update_events" ("device_id", "occurred_at")`,
    );
    // Der Retention-Job loescht ueber diese Spalte.
    await queryRunner.query(
      `CREATE INDEX "idx_device_update_events_occurred" ON "device_update_events" ("occurred_at")`,
    );

    // ------------------------------------------------------ device_checkins
    await queryRunner.query(`
      CREATE TABLE "device_checkins" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "device_id"       uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
        "snapshot_id"     uuid NOT NULL UNIQUE,
        "collected_at"    timestamptz NOT NULL,
        "reported_at"     timestamptz NOT NULL DEFAULT now(),
        "agent_version"   text,
        "update_source"   "update_source" NOT NULL DEFAULT 'unknown',
        "wsus_server_url" text,
        "pending_reboot"  boolean NOT NULL DEFAULT false,
        "raw_snapshot"    jsonb
      )
    `);
    await queryRunner.query(
      `COMMENT ON COLUMN "device_checkins"."snapshot_id" IS 'Vom Agent erzeugte GUID. Die Eindeutigkeit hier ist der Idempotenzmechanismus des Check-ins.'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_device_checkins_device_collected" ON "device_checkins" ("device_id", "collected_at")`,
    );

    // --------------------------------------------------------- ad_sync_runs
    await queryRunner.query(`
      CREATE TABLE "ad_sync_runs" (
        "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "started_at"       timestamptz NOT NULL DEFAULT now(),
        "finished_at"      timestamptz,
        "trigger"          "ad_sync_trigger" NOT NULL,
        "devices_found"    int NOT NULL DEFAULT 0,
        "devices_created"  int NOT NULL DEFAULT 0,
        "devices_archived" int NOT NULL DEFAULT 0,
        "status"           "ad_sync_status" NOT NULL DEFAULT 'running',
        "error"            text
      )
    `);

    // ------------------------------------------------------------- settings
    await queryRunner.query(`
      CREATE TABLE "settings" (
        "key"         text PRIMARY KEY,
        "value"       jsonb NOT NULL,
        "description" text,
        "updated_at"  timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ---------------------------------------------------------------- users
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "username"      text NOT NULL UNIQUE,
        "password_hash" text NOT NULL,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "last_login_at" timestamptz,
        "is_active"     boolean NOT NULL DEFAULT true
      )
    `);

    // ------------------------------------------------------- agent_releases
    await queryRunner.query(`
      CREATE TABLE "agent_releases" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "version"     text NOT NULL UNIQUE,
        "file_path"   text NOT NULL,
        "sha256"      text NOT NULL,
        "released_at" timestamptz NOT NULL DEFAULT now(),
        "is_current"  boolean NOT NULL DEFAULT false,
        "notes"       text
      )
    `);
    // Es darf immer nur genau eine Version als "aktuell" markiert sein.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_agent_releases_single_current" ON "agent_releases" ("is_current")
      WHERE "is_current" = true
    `);

    // ---------------------------------------------------- agent_update_jobs
    await queryRunner.query(`
      CREATE TABLE "agent_update_jobs" (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "device_id"      uuid NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE,
        "target_version" text NOT NULL,
        "state"          "agent_update_job_state" NOT NULL DEFAULT 'pending',
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "completed_at"   timestamptz,
        "error"          text
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_agent_update_jobs_device_state" ON "agent_update_jobs" ("device_id", "state")`,
    );

    // ------------------------------------------------- Standardeinstellungen
    await queryRunner.query(`
      INSERT INTO "settings" ("key", "value", "description") VALUES
        ('ad_sync_interval_minutes',      '60',      'Abstand zwischen zwei AD-Abgleichen in Minuten.'),
        ('retention_days',                '90',      'Aufbewahrung von Events und Check-ins in Tagen.'),
        ('agent_checkin_interval_hours',  '4',       'Vorgabe fuer den Meldeabstand des Agents.'),
        ('stale_agent_days',              '7',       'Ab so vielen Tagen ohne Check-in gilt ein Agent als abgemeldet.'),
        ('critical_open_days_threshold',  '14',      'Ab so vielen Tagen gilt ein offenes kritisches Update als ueberfaellig.'),
        ('reboot_pending_days_threshold', '7',       'Ab so vielen Tagen wird ein ausstehender Neustart bemaengelt.'),
        ('auth_provider',                 '"local"', 'local oder ldap.')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_update_jobs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_releases"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ad_sync_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "device_checkins"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "device_update_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "device_update_states"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "updates"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "device_secrets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "devices"`);

    await queryRunner.query(`DROP TYPE IF EXISTS "agent_update_job_state"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "ad_sync_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "ad_sync_trigger"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "update_source"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "update_event_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "update_state"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "device_status"`);
  }
}
