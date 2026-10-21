#!/bin/sh
# Richtet den Samba-AD des Test-Stacks fuer test/ad-smoke.mjs ein. Laeuft im
# Container "samba"; deploy/test-stack.ps1 legt das Skript nach /tmp und ruft
# die Schritte in dieser Reihenfolge auf:
#
#   sh /tmp/ad-setup.sh warten        wartet, bis LDAPS antwortet
#   sh /tmp/ad-setup.sh zertifikat    Zertifikat aus /testfiles/tls einspielen
#                                     (danach den Container neu starten und wieder warten)
#   sh /tmp/ad-setup.sh daten         OUs, Computerkonten, Benutzer und Gruppen
#
# Alle Schritte lassen sich wiederholen; was schon da ist, bleibt.
#
# Domaene test.wiupmo:
#   OU=Clients
#     OU=Notebooks       NB-001, NB-002, NB-003 (deaktiviert)
#     OU=Arbeitsplaetze  PC-001
#   OU=Server            SRV-001 (Windows Server)
#   Benutzer: svc-wiupmo (Dienstkonto), lena (in wiupmo-zugang),
#             nina (ueber it-team in wiupmo-zugang), sam (ohne Freigabe)
set -eu

BASE='DC=test,DC=wiupmo'
SAM=/var/lib/samba/private/sam.ldb
TLS=/var/lib/samba/private/tls

exists() {
  [ "$(ldbsearch -H "$SAM" -b "$BASE" "(distinguishedName=$1)" dn 2>/dev/null | grep -c '^dn: ')" -gt 0 ]
}

# Neuere Samba-Versionen nennen "create" "add"; beide Namen ausprobieren.
samba_add() {
  kind=$1
  shift
  samba-tool "$kind" add "$@" >/dev/null 2>&1 || samba-tool "$kind" create "$@" >/dev/null
}

ou() {
  exists "$1" || samba_add ou "$1"
}

# computer NAME OU BETRIEBSSYSTEM VERSION [deaktiviert]
computer() {
  dn="CN=$1,$2"
  exists "$dn" || samba_add computer "$1" --computerou="$2"
  # samba-tool legt Computerkonten ohne Passwort deaktiviert an (4098). Der
  # Zustand wird deshalb immer ausdruecklich gesetzt: 4096 Arbeitsstation
  # + 32 kein Passwort noetig, wie ein vorab angelegtes Konto in Windows;
  # deaktiviert 4096 + 2.
  uac=4128
  if [ "${5:-}" = deaktiviert ]; then uac=4098; fi
  printf 'dn: %s\nchangetype: modify\nreplace: operatingSystem\noperatingSystem: %s\n-\nreplace: operatingSystemVersion\noperatingSystemVersion: %s\n-\nreplace: userAccountControl\nuserAccountControl: %s\n' \
    "$dn" "$3" "$4" "$uac" | ldbmodify -H "$SAM" >/dev/null
}

user() {
  exists "CN=$1,CN=Users,$BASE" || samba_add user "$1" "$2"
}

group() {
  exists "CN=$1,CN=Users,$BASE" || samba-tool group add "$1" >/dev/null
}

case "${1:-}" in
  warten)
    i=0
    until LDAPTLS_REQCERT=never ldapsearch -H ldaps://localhost -x -s base -b '' >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "$i" -ge 90 ]; then
        echo 'Samba antwortet nicht.' >&2
        exit 1
      fi
      sleep 2
    done
    echo 'Samba antwortet.'
    ;;

  zertifikat)
    for f in ca.pem cert.pem key.pem; do
      cp "/testfiles/tls/$f" "$TLS/$f"
    done
    chown root:root "$TLS"/*.pem
    chmod 600 "$TLS/key.pem"
    chmod 644 "$TLS/ca.pem" "$TLS/cert.pem"
    echo 'Zertifikat eingespielt.'
    ;;

  daten)
    ou "OU=Clients,$BASE"
    ou "OU=Notebooks,OU=Clients,$BASE"
    ou "OU=Arbeitsplaetze,OU=Clients,$BASE"
    ou "OU=Server,$BASE"

    computer NB-001 "OU=Notebooks,OU=Clients,$BASE" 'Windows 11 Pro' '10.0 (26100)'
    computer NB-002 "OU=Notebooks,OU=Clients,$BASE" 'Windows 11 Pro' '10.0 (26100)'
    computer NB-003 "OU=Notebooks,OU=Clients,$BASE" 'Windows 10 Pro' '10.0 (19045)' deaktiviert
    computer PC-001 "OU=Arbeitsplaetze,OU=Clients,$BASE" 'Windows 11 Enterprise' '10.0 (26100)'
    computer SRV-001 "OU=Server,$BASE" 'Windows Server 2022 Standard' '10.0 (20348)'

    user svc-wiupmo 'Svc-Passw0rd!'
    user lena 'Lena-Passw0rd!'
    user nina 'Nina-Passw0rd!'
    user sam 'Sam-Passw0rd!'

    group wiupmo-zugang
    group it-team
    # Bereits vorhandene Mitglieder lehnt samba-tool ab; das ist hier kein Fehler.
    samba-tool group addmembers wiupmo-zugang lena,it-team >/dev/null 2>&1 || true
    samba-tool group addmembers it-team nina >/dev/null 2>&1 || true

    echo 'Testdaten im AD angelegt.'
    ;;

  *)
    echo "Aufruf: sh $0 warten|zertifikat|daten" >&2
    exit 2
    ;;
esac
