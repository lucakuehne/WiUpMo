import { Module } from '@nestjs/common';
import { LdapClient } from './ldap.client.js';

/**
 * Nur der Verzeichniszugriff, ohne Controller und ohne Abhaengigkeiten.
 *
 * Getrennt vom AdModule, weil auch die Anmeldung ihn braucht — fuer die
 * Gruppenpruefung. Laege er im AdModule, muessten sich AdModule und AuthModule
 * gegenseitig einbinden.
 */
@Module({
  providers: [LdapClient],
  exports: [LdapClient],
})
export class LdapModule {}
