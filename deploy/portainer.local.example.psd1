# Vorlage fuer deploy\portainer.local.psd1 - kopieren und ausfuellen.
# Die ausgefuellte Datei ist per .gitignore ausgeschlossen: Serveradressen
# gehoeren nicht ins oeffentliche Repository.
#
# Daneben braucht es deploy\portainer-token.txt mit einem API-Token aus
# Portainer (My account -> Access tokens), ebenfalls ausgeschlossen.
@{
  # Adresse von Portainer, mit Port.
  Url        = 'https://docker-host.example.local:9443'

  # Environment-Id des Docker-Servers in Portainer (steht in der Adresszeile
  # unter Environments, z. B. .../#!/4/docker/...).
  EndpointId = 1

  # Optional: Adresse, unter der WiUpMo im Netz erreichbar ist. Ist sie
  # gesetzt, prueft release.ps1 den Healthcheck auch von aussen.
  PublicUrl  = ''
}
