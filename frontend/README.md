# Frontend

Vue 3 mit PrimeVue. Wird im Container gebaut und vom Backend unter `/` als
statische Dateien ausgeliefert — es gibt keinen eigenen Webserver.

## Entwicklung

```bash
cd frontend
pnpm install
pnpm dev            # http://localhost:5173
```

Das Backend muss parallel laufen (`cd backend && pnpm start:dev`). Vite leitet
`/api` dorthin weiter. Der Umweg über den Proxy statt einer absoluten
Backend-Adresse ist nicht Bequemlichkeit: Das Sitzungscookie gehört sonst zu
einer anderen Herkunft und würde vom Browser nicht mitgeschickt.

Zeigt das Backend woanders hin:

```bash
VITE_BACKEND_URL=http://cel-sv-docker02:3001 pnpm dev
```

## Aufbau

| Datei | Aufgabe |
|---|---|
| `src/router.ts` | Routen und der Wachposten für Einrichtung / Anmeldung |
| `src/auth.ts` | Anmeldezustand als reaktives Objekt |
| `src/api/client.ts` | `fetch`-Aufsatz mit Cookie und Fehlerbehandlung |
| `src/api/types.ts` | Gegenstücke zu den Backend-DTOs |
| `src/format.ts` | Datums-, Grössen- und Fehlercode-Formatierung, Beschriftungen |
| `src/views/` | Einrichtung, Anmeldung, Geräteliste, Gerätedetail, Update-Katalog |

## Entscheidungen

**Kein Pinia.** Es gibt einen Benutzer ohne Rollen und drei Zustände. Ein
reaktives Objekt in `auth.ts` reicht; ein Store wäre eine Abhängigkeit ohne
Gegenwert.

**Keine Typerzeugung aus `shared/openapi.json`.** Die Typen in `api/types.ts`
sind von Hand gepflegt. Bei diesem Umfang ist ein Generator mehr Werkzeugkette
als Nutzen — ändert sich der Vertrag, fällt es beim Übersetzen auf.

**Serverseitiges Filtern und Sortieren.** Die Tabellen laufen im
`lazy`-Modus; Seiten, Sortierung und Filter gehen als Abfrageparameter ans
Backend. Eine Flotte im vierstelligen Bereich soll nie vollständig in den
Browser geladen werden.

**Zeitstempel** kommen in UTC und werden erst hier lokalisiert. Laptops reisen —
das steht so als Risikopunkt im Entwicklungsplan.
