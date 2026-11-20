<script setup lang="ts">
import { computed } from 'vue';
import type { HardwareInfo } from '@/api/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDate, formatDateTime, formatRelative } from '@/format';
import {
  ADAPTER_LABELS,
  BITLOCKER_LABELS,
  CHASSIS_LABELS,
  batteryHealth,
  deviceName,
  formatCapacity,
  manufacturerName,
} from '@/hardware';

/**
 * Was für ein Gerät es ist und was darin steckt — so, wie der Agent es
 * zuletzt gemeldet hat. Er schickt die Angaben bei jeder Änderung und sonst
 * einmal am Tag. Freien Platz und Verbindungszustand meldet er mit, gezeigt
 * werden sie bewusst nicht: Sie sind Momentaufnahmen und hier nicht gefragt.
 *
 * Eine Karte je Bereich, zwei nebeneinander. Ein Desktop ohne Akku lässt
 * dessen Karte aus; die übrigen rücken nach.
 */
const props = defineProps<{
  hardware: HardwareInfo | null;
  reportedAt: string | null;
}>();

const hw = computed(() => props.hardware);

/** Nur für BitLocker unter „Sicherheit“; die Partitionen selbst stehen nicht auf der Seite. */
const systemVolume = computed(() => hw.value?.volumes?.find((volume) => volume.drive?.toUpperCase() === 'C:'));

const health = computed(() => batteryHealth(hw.value?.battery));

function yesNo(value: boolean | undefined, yes = 'ja', no = 'nein'): string {
  return value === undefined ? '—' : value ? yes : no;
}
</script>

<template>
  <div v-if="!hw" class="text-muted-foreground rounded-md border py-8 text-center text-sm">
    Noch keine Hardware gemeldet. Der Agent schickt sie ab Version 0.10.0.
  </div>

  <div v-else class="space-y-4">
    <p class="text-muted-foreground text-sm">
      Stand {{ formatDateTime(reportedAt) }} ({{ formatRelative(reportedAt) }}). Der Agent meldet
      Änderungen sofort und sonst einmal am Tag.
    </p>

    <div class="grid gap-4 lg:grid-cols-2">
      <!-- ===================== Gerät ===================== -->
      <Card>
        <CardHeader><CardTitle class="text-base">Gerät</CardTitle></CardHeader>
        <CardContent>
          <dl class="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt class="text-muted-foreground">Modell</dt>
            <dd>
              {{ deviceName(hw) ?? '—' }}
              <div v-if="hw.model && deviceName(hw) !== hw.model" class="text-muted-foreground text-xs">
                {{ hw.model }}
              </div>
            </dd>
            <dt class="text-muted-foreground">Gerätetyp</dt>
            <dd>{{ hw.chassis ? CHASSIS_LABELS[hw.chassis] : '—' }}</dd>
            <dt class="text-muted-foreground">Seriennummer</dt>
            <dd class="tabular">{{ hw.serialNumber ?? '—' }}</dd>
            <dt class="text-muted-foreground">BIOS</dt>
            <dd>
              {{ [manufacturerName(hw.biosVendor), hw.biosVersion].filter(Boolean).join(' ') || '—' }}
              <span v-if="hw.biosDate" class="text-muted-foreground text-xs">vom {{ formatDate(hw.biosDate) }}</span>
            </dd>
            <template v-if="hw.sku">
              <dt class="text-muted-foreground">SKU</dt>
              <dd class="truncate" :title="hw.sku">{{ hw.sku }}</dd>
            </template>
          </dl>
        </CardContent>
      </Card>

      <!-- ===================== Prozessor ===================== -->
      <Card>
        <CardHeader><CardTitle class="text-base">Prozessor</CardTitle></CardHeader>
        <CardContent>
          <dl class="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt class="text-muted-foreground">Modell</dt>
            <dd>{{ hw.processor?.name ?? '—' }}</dd>
            <dt class="text-muted-foreground">Kerne</dt>
            <dd class="tabular">{{ hw.processor?.cores ?? '—' }}</dd>
            <dt class="text-muted-foreground">Threads</dt>
            <dd class="tabular">{{ hw.processor?.logicalProcessors ?? '—' }}</dd>
            <dt class="text-muted-foreground">Takt</dt>
            <dd class="tabular">
              {{ hw.processor?.maxClockMhz ? `${(hw.processor.maxClockMhz / 1000).toFixed(1)} GHz` : '—' }}
            </dd>
            <template v-if="(hw.processor?.count ?? 1) > 1">
              <dt class="text-muted-foreground">Anzahl</dt>
              <dd class="tabular">{{ hw.processor?.count }}</dd>
            </template>
          </dl>
        </CardContent>
      </Card>

      <!-- ===================== Arbeitsspeicher ===================== -->
      <Card>
        <CardHeader><CardTitle class="text-base">Arbeitsspeicher</CardTitle></CardHeader>
        <CardContent>
          <p class="text-sm">
            {{ formatCapacity(hw.memoryBytes) }}
            <span v-if="hw.memoryModules?.length" class="text-muted-foreground text-xs">
              in {{ hw.memoryModules.length }} {{ hw.memoryModules.length === 1 ? 'Modul' : 'Modulen' }}
            </span>
          </p>

          <div v-if="hw.memoryModules?.length" class="mt-3 rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Steckplatz</TableHead>
                  <TableHead class="text-right">Grösse</TableHead>
                  <TableHead>Typ</TableHead>
                  <TableHead>Hersteller</TableHead>
                  <TableHead>Teilenummer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="(module, index) in hw.memoryModules" :key="index">
                  <TableCell>{{ module.slot ?? `Modul ${index + 1}` }}</TableCell>
                  <TableCell class="tabular text-right">{{ formatCapacity(module.capacityBytes) }}</TableCell>
                  <TableCell>
                    {{ [module.type, module.speedMhz ? `${module.speedMhz} MHz` : null].filter(Boolean).join(' ') || '—' }}
                  </TableCell>
                  <TableCell>{{ module.manufacturer ?? '—' }}</TableCell>
                  <TableCell class="tabular text-xs">{{ module.partNumber ?? '—' }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <!-- ===================== Datenträger ===================== -->
      <Card>
        <CardHeader><CardTitle class="text-base">Datenträger</CardTitle></CardHeader>
        <CardContent>
          <div v-if="hw.disks?.length" class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Laufwerk</TableHead>
                  <TableHead class="text-right">Grösse</TableHead>
                  <TableHead>Typ</TableHead>
                  <TableHead>Anschluss</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="(disk, index) in hw.disks" :key="index">
                  <TableCell class="whitespace-normal">{{ disk.model ?? '—' }}</TableCell>
                  <TableCell class="tabular text-right">{{ formatCapacity(disk.sizeBytes) }}</TableCell>
                  <TableCell>{{ disk.mediaType && disk.mediaType !== 'unknown' ? disk.mediaType.toUpperCase() : '—' }}</TableCell>
                  <TableCell>{{ disk.busType ?? '—' }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <p v-else class="text-muted-foreground text-sm">Keine Angaben.</p>
        </CardContent>
      </Card>

      <!-- ===================== Sicherheit ===================== -->
      <Card>
        <CardHeader><CardTitle class="text-base">Sicherheit</CardTitle></CardHeader>
        <CardContent>
          <dl class="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt class="text-muted-foreground">TPM</dt>
            <dd>
              <template v-if="!hw.tpm">—</template>
              <template v-else-if="!hw.tpm.present">
                <span class="text-destructive">nicht vorhanden</span>
              </template>
              <template v-else>
                {{ hw.tpm.version ? `Version ${hw.tpm.version}` : 'vorhanden' }}
                <span v-if="hw.tpm.enabled === false" class="text-destructive"> · deaktiviert</span>
                <span v-if="hw.tpm.manufacturer" class="text-muted-foreground text-xs"> · {{ hw.tpm.manufacturer }}</span>
              </template>
            </dd>
            <dt class="text-muted-foreground">Secure Boot</dt>
            <dd :class="hw.secureBoot === false ? 'text-destructive' : ''">
              {{ yesNo(hw.secureBoot, 'aktiv', 'aus') }}
            </dd>
            <dt class="text-muted-foreground">Firmware</dt>
            <dd>{{ hw.firmware === 'uefi' ? 'UEFI' : hw.firmware === 'bios' ? 'BIOS (Legacy)' : '—' }}</dd>
            <dt class="text-muted-foreground">BitLocker (C:)</dt>
            <dd :class="systemVolume?.bitLocker && systemVolume.bitLocker !== 'on' ? 'text-destructive' : ''">
              {{ systemVolume?.bitLocker ? BITLOCKER_LABELS[systemVolume.bitLocker] : '—' }}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <!-- ===================== Akku ===================== -->
      <Card v-if="hw.battery">
        <CardHeader><CardTitle class="text-base">Akku</CardTitle></CardHeader>
        <CardContent>
          <dl class="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt class="text-muted-foreground">Zustand</dt>
            <dd>
              <template v-if="health !== null">
                <span :class="health < 60 ? 'text-destructive font-medium' : ''">{{ health }} %</span>
                <span class="text-muted-foreground text-xs"> der ursprünglichen Kapazität</span>
              </template>
              <template v-else>—</template>
            </dd>
            <dt class="text-muted-foreground">Kapazität</dt>
            <dd class="tabular">
              {{ hw.battery.fullChargeCapacityMwh ? `${(hw.battery.fullChargeCapacityMwh / 1000).toFixed(1)} Wh` : '—' }}
              <span v-if="hw.battery.designCapacityMwh" class="text-muted-foreground text-xs">
                von {{ (hw.battery.designCapacityMwh / 1000).toFixed(1) }} Wh
              </span>
            </dd>
            <template v-if="hw.battery.cycleCount">
              <dt class="text-muted-foreground">Ladezyklen</dt>
              <dd class="tabular">{{ hw.battery.cycleCount }}</dd>
            </template>
            <dt class="text-muted-foreground">Akku</dt>
            <dd>{{ [hw.battery.manufacturer, hw.battery.name].filter(Boolean).join(' ') || '—' }}</dd>
          </dl>
        </CardContent>
      </Card>

      <!-- ===================== Netzwerkadapter ===================== -->
      <Card>
        <CardHeader><CardTitle class="text-base">Netzwerkadapter</CardTitle></CardHeader>
        <CardContent>
          <div v-if="hw.networkAdapters?.length" class="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Adapter</TableHead>
                  <TableHead>Art</TableHead>
                  <TableHead>MAC-Adresse</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow v-for="(adapter, index) in hw.networkAdapters" :key="index">
                  <TableCell class="whitespace-normal">
                    {{ adapter.name ?? '—' }}
                    <div v-if="adapter.connection" class="text-muted-foreground text-xs">{{ adapter.connection }}</div>
                  </TableCell>
                  <TableCell>{{ adapter.kind ? ADAPTER_LABELS[adapter.kind] : '—' }}</TableCell>
                  <TableCell class="tabular">{{ adapter.macAddress ?? '—' }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <p v-else class="text-muted-foreground text-sm">Keine Angaben.</p>
        </CardContent>
      </Card>

      <!-- ===================== Grafik und Monitore ===================== -->
      <Card>
        <CardHeader><CardTitle class="text-base">Grafik und Monitore</CardTitle></CardHeader>
        <CardContent class="space-y-4 text-sm">
          <div>
            <h3 class="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">Grafik</h3>
            <ul v-if="hw.graphics?.length" class="space-y-0.5">
              <li v-for="(card, index) in hw.graphics" :key="index">
                {{ card.name ?? '—' }}
                <span v-if="card.driverVersion" class="text-muted-foreground text-xs">Treiber {{ card.driverVersion }}</span>
              </li>
            </ul>
            <p v-else class="text-muted-foreground">—</p>
          </div>

          <div>
            <h3 class="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">Monitore</h3>
            <ul v-if="hw.monitors?.length" class="space-y-0.5">
              <li v-for="(monitor, index) in hw.monitors" :key="index">
                {{ monitor.name ?? (monitor.internal ? 'Eingebautes Display' : 'Monitor') }}
                <span class="text-muted-foreground text-xs">
                  {{
                    [
                      monitor.internal ? 'intern' : 'extern',
                      monitor.manufacturer,
                      monitor.year ? `Baujahr ${monitor.year}` : null,
                      monitor.serialNumber ? `S/N ${monitor.serialNumber}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  }}
                </span>
              </li>
            </ul>
            <p v-else class="text-muted-foreground">—</p>
            <p class="text-muted-foreground mt-1 text-xs">Externe Monitore nur, wenn sie beim Erfassen angeschlossen waren.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
