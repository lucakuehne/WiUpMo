# shared — API-Vertrag

`openapi.json` wird beim Start des Backends im Entwicklungsmodus automatisch
aus den Controllern und DTOs erzeugt (siehe `backend/src/main.ts`). Die Datei
ist damit immer der Stand des Codes und wird nicht von Hand gepflegt.

Sie ist der Kopplungspunkt zwischen Agent, Backend und — ab Phase 4 — Frontend.
Aendert sich das Snapshot-Format, ist das hier sichtbar.
