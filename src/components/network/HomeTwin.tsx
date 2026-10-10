import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Clock,
  Home,
  MapPin,
  Moon,
  Radio,
  ShieldAlert,
  Zap,
} from "lucide-react";
import type { Device } from "@/lib/devices";
import { DeviceTypeIcon } from "@/components/network/DeviceTypeIcon";
import {
  learningDays,
  MIN_LEARNING_DAYS,
  onlineProbability,
  type Anomaly,
  type PatternState,
} from "@/lib/patterns";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDocumentScrollLock } from "@/hooks/use-document-scroll-lock";
import { cn } from "@/lib/utils";
const UNASSIGNED = "Sin ubicar";
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}
function timeAgo(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}
const kindLabel: Record<Anomaly["kind"], { label: string; icon: typeof Moon }> = {
  unusual_online: { label: "Conexión fuera de rutina", icon: Moon },
  unusual_offline: { label: "Ausencia inesperada", icon: AlertTriangle },
  traffic_spike: { label: "Pico de tráfico anómalo", icon: Zap },
};
export function HomeTwin({
  devices,
  patterns,
  rxMbps,
  onSelectDevice,
  onUpdateDevice,
  onReviewAnomaly,
  onOpenPerformance,
  monitoringHost = "este PC",
  trafficAvailable = true,
}: {
  devices: Device[];
  monitoringHost?: string;
  trafficAvailable?: boolean;
  onUpdateDevice?: (device: Device) => void;
  patterns: PatternState;
  rxMbps: number;
  onSelectDevice: (id: string) => void;
  onReviewAnomaly: (id: string, reviewed: boolean) => void;
  onOpenPerformance: () => void;
}) {
  const [placing, setPlacing] = useState(false);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const dragging = useRef<string | null>(null);
  const [selectedAnomalyId, setSelectedAnomalyId] = useState<string | null>(null);
  const [anomalyFilter, setAnomalyFilter] = useState<"pending" | "reviewed" | "all">("pending");
  const selectedAnomaly = patterns.anomalies.find((a) => a.id === selectedAnomalyId);
  const anomalyDevice = selectedAnomaly
    ? devices.find((d) => d.id === selectedAnomaly.deviceId)
    : undefined;
  const pendingCount = patterns.anomalies.filter((a) => !a.reviewedAt).length;
  const listedAnomalies = patterns.anomalies.filter(
    (a) =>
      anomalyFilter === "all" ||
      (anomalyFilter === "reviewed" ? Boolean(a.reviewedAt) : !a.reviewedAt),
  );
  useDocumentScrollLock(Boolean(selectedAnomaly));
  const nowHour = new Date().getHours();
  const [hour, setHour] = useState<number | null>(null);
  const viewingPast = hour !== null && hour !== nowHour;
  const learned = learningDays(patterns);
  const ready = learned >= MIN_LEARNING_DAYS;
  const anomalous = useMemo(() => {
    const since = Date.now() - 6 * 3600_000;
    return new Set(
      patterns.anomalies
        .filter((a) => !a.reviewedAt && new Date(a.at).getTime() > since)
        .map((a) => a.deviceId),
    );
  }, [patterns.anomalies]);
  const rooms = useMemo(() => {
    const map = new Map<string, Device[]>();
    for (const d of devices) {
      const room = d.location?.trim() || UNASSIGNED;
      map.set(room, [...(map.get(room) ?? []), d]);
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === UNASSIGNED) return 1;
      if (b[0] === UNASSIGNED) return -1;
      return b[1].length - a[1].length;
    });
  }, [devices]);
  const online = devices.filter((d) => d.status === "online").length;
  const pulse = Math.min(1, rxMbps / 200);
  return (
    <>
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="relative flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Home className="size-4" />
                <span
                  className="absolute inset-0 rounded-lg ring-2 ring-primary/60 animate-ping"
                  style={{
                    animationDuration: `${2.6 - pulse * 1.8}s`,
                    opacity: 0.25 + pulse * 0.5,
                  }}
                />
              </span>
              <div>
                <h2 className="text-sm font-semibold">Gemelo digital de tu casa</h2>
                <p className="text-xs text-muted-foreground">
                  {online} de {devices.length} equipos encendidos ·{" "}
                  {monitoringHost === "este PC" ? "la casa late con" : "descarga del NAS:"}{" "}
                  {trafficAvailable ? `${rxMbps.toFixed(1)} Mbps` : "sin datos"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <Button
                variant="outline"
                size="sm"
                disabled={!onUpdateDevice}
                onClick={() => setPlacing(!placing)}
              >
                {placing ? "Terminar" : "Colocar dispositivos"}
              </Button>
              <Clock className="size-3.5 text-muted-foreground" />
              <input
                type="range"
                min={0}
                max={23}
                value={hour ?? nowHour}
                onChange={(e) => setHour(Number(e.target.value))}
                disabled={!ready}
                aria-label="Hora de la rutina"
                className="w-40 accent-primary disabled:opacity-40"
              />
              <span className="w-28 font-mono tabular-nums">
                {viewingPast ? `Rutina ${String(hour).padStart(2, "0")}:00` : "En directo"}
              </span>
              {viewingPast && (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => setHour(null)}
                >
                  Volver
                </button>
              )}
            </div>
          </header>
          {devices.length === 0 ? (
            <p className="p-10 text-center text-sm text-muted-foreground">
              Escanea la red para dibujar tu casa.
            </p>
          ) : (
            <div
              className="grid auto-rows-[220px] grid-cols-2 gap-px bg-border p-px lg:grid-cols-4"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--color-muted-foreground) 25%, transparent) 1px, transparent 0)",
                backgroundSize: "18px 18px",
              }}
            >
              {rooms.map(([room, list], i) => {
                const big = i === 0 && list.length > 3;
                const active = list.filter((d) => d.status === "online").length;
                return (
                  <div
                    key={room}
                    className={cn(
                      "relative overflow-hidden bg-background/90",
                      big && "col-span-2 row-span-2",
                      room === UNASSIGNED && "bg-muted/40",
                    )}
                  >
                    <div className="absolute inset-2 rounded-md border-2 border-dashed border-border/70" />
                    <div className="absolute left-4 top-3 z-10 flex items-center gap-1.5 text-xs font-semibold">
                      <MapPin className="size-3 text-muted-foreground" />
                      {room}
                      <span className="font-normal text-muted-foreground">
                        {active}/{list.length}
                      </span>
                    </div>
                    {list.map((d) => {
                      const h = hash(d.id);
                      const saved =
                        d.roomPosition?.room === room &&
                        Number.isFinite(d.roomPosition.x) &&
                        Number.isFinite(d.roomPosition.y)
                          ? {
                              x: Math.max(12, Math.min(88, d.roomPosition.x)),
                              y: Math.max(24, Math.min(86, d.roomPosition.y)),
                            }
                          : undefined;
                      const position = positions[d.id] ?? saved;
                      const x = position?.x ?? 12 + (h % 76);
                      const y = position?.y ?? 24 + ((h >>> 8) % 62);
                      const prob = viewingPast
                        ? (onlineProbability(patterns, d.id, hour!) ?? 0)
                        : null;
                      const on = prob === null ? d.status === "online" : prob > 0.5;
                      const threat = !d.trusted && d.isNew;
                      const weird = anomalous.has(d.id);
                      const tone = threat
                        ? "destructive"
                        : weird
                          ? "warning"
                          : on
                            ? "primary"
                            : "muted";
                      return (
                        <button
                          key={d.id}
                          type="button"
                          aria-label={placing ? `Colocar ${d.name}` : d.name}
                          onClick={() => {
                            if (!placing) onSelectDevice(d.id);
                          }}
                          onPointerDown={(e) => {
                            if (!placing) return;
                            e.preventDefault();
                            dragging.current = d.id;
                            e.currentTarget.setPointerCapture(e.pointerId);
                          }}
                          onPointerMove={(e) => {
                            if (dragging.current !== d.id) return;
                            const rect = e.currentTarget.parentElement!.getBoundingClientRect();
                            setPositions((prev) => ({
                              ...prev,
                              [d.id]: {
                                x: Math.max(
                                  12,
                                  Math.min(88, ((e.clientX - rect.left) / rect.width) * 100),
                                ),
                                y: Math.max(
                                  24,
                                  Math.min(86, ((e.clientY - rect.top) / rect.height) * 100),
                                ),
                              },
                            }));
                          }}
                          onPointerUp={() => {
                            if (dragging.current !== d.id) return;
                            dragging.current = null;
                            const position = positions[d.id];
                            if (position)
                              onUpdateDevice?.({ ...d, roomPosition: { room, ...position } });
                            setPositions((prev) => {
                              const next = { ...prev };
                              delete next[d.id];
                              return next;
                            });
                          }}
                          onPointerCancel={() => {
                            dragging.current = null;
                            setPositions({});
                          }}
                          onKeyDown={(e) => {
                            if (
                              !placing ||
                              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
                            )
                              return;
                            e.preventDefault();
                            onUpdateDevice?.({
                              ...d,
                              roomPosition: {
                                room,
                                x: Math.max(
                                  12,
                                  Math.min(
                                    88,
                                    x +
                                      (e.key === "ArrowRight" ? 4 : e.key === "ArrowLeft" ? -4 : 0),
                                  ),
                                ),
                                y: Math.max(
                                  24,
                                  Math.min(
                                    86,
                                    y + (e.key === "ArrowDown" ? 4 : e.key === "ArrowUp" ? -4 : 0),
                                  ),
                                ),
                              },
                            });
                          }}
                          title={`${d.name} · ${d.ip}${prob !== null ? ` · ${Math.round(prob * 100)} % a esa hora` : ""}`}
                          className={cn(
                            "group absolute -translate-x-1/2 -translate-y-1/2",
                            placing ? "touch-none cursor-move" : "transition-all duration-700",
                          )}
                          style={{
                            left: `${x}%`,
                            top: `${y}%`,
                            opacity: prob === null ? (on ? 1 : 0.45) : 0.25 + prob * 0.75,
                          }}
                        >
                          {on && (
                            <span
                              className={cn(
                                "absolute inset-0 rounded-full animate-ping",
                                tone === "destructive"
                                  ? "bg-destructive/50"
                                  : tone === "warning"
                                    ? "bg-amber-500/40"
                                    : "bg-primary/40",
                              )}
                              style={{ animationDuration: `${2 + (h % 20) / 10}s` }}
                            />
                          )}
                          <span
                            className={cn(
                              "relative flex size-9 items-center justify-center rounded-full border-2 transition-transform group-hover:scale-125",
                              tone === "destructive" &&
                                "border-destructive bg-destructive/20 text-destructive",
                              tone === "primary" &&
                                "border-primary bg-primary/15 text-primary shadow-[0_0_18px_-2px_var(--color-primary)]",
                              tone === "warning" &&
                                "border-amber-500 bg-amber-500/20 text-amber-500",
                              tone === "muted" && "border-border bg-muted text-muted-foreground",
                            )}
                          >
                            <DeviceTypeIcon type={d.type} className="size-4" />
                          </span>
                          <span className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-[10px] font-medium text-popover-foreground opacity-0 shadow group-hover:opacity-100">
                            {d.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
          <footer className="flex flex-wrap gap-4 border-t border-border px-5 py-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary" /> Encendido
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-muted-foreground/40" /> Apagado
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-destructive" /> Intruso
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-amber-500" /> Anomalía
            </span>
            <span>
              {placing
                ? "Arrastra los dispositivos o usa las flechas del teclado. La posición se guarda automáticamente."
                : "Asigna habitaciones desde la ficha de cada equipo."}
            </span>
          </footer>
        </section>
        <aside className="rounded-xl border border-border bg-card">
          <header className="flex items-center gap-3 border-b border-border px-5 py-4">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Brain className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Anomalías aprendidas</h2>
              <p className="text-xs text-muted-foreground">
                Solo te avisa de lo que se sale de tu rutina
              </p>
            </div>
          </header>
          {!ready && (
            <div className="border-b border-border px-5 py-4">
              <div className="mb-2 flex justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <Radio className="size-3.5 text-primary" /> Aprendiendo tu rutina…
                </span>
                <span className="font-mono">
                  {learned}/{MIN_LEARNING_DAYS} días
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${(learned / MIN_LEARNING_DAYS) * 100}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {monitoringHost === "este PC"
                  ? "Deja NetHub abierto (o en la bandeja) con el escaneo automático activo. Cada hora vigilada cuenta."
                  : "El monitor del NAS aprende con el escaneo automático activo, aunque cierres los navegadores."}
              </p>
            </div>
          )}
          <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-xs">
            <label htmlFor="anomaly-filter">Mostrar</label>
            <select
              id="anomaly-filter"
              value={anomalyFilter}
              onChange={(e) => setAnomalyFilter(e.target.value as typeof anomalyFilter)}
              className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1.5"
            >
              <option value="pending">Pendientes ({pendingCount})</option>
              <option value="reviewed">
                Revisadas ({patterns.anomalies.length - pendingCount})
              </option>
              <option value="all">Todas ({patterns.anomalies.length})</option>
            </select>
          </div>
          <ul className="max-h-[620px] divide-y divide-border overflow-y-auto">
            {listedAnomalies.length === 0 && (
              <li className="px-5 py-10 text-center text-xs text-muted-foreground">
                <ShieldAlert className="mx-auto mb-2 size-5" />
                {anomalyFilter === "reviewed"
                  ? "No hay anomalías revisadas."
                  : "No hay anomalías pendientes."}
              </li>
            )}
            {listedAnomalies.map((a) => {
              const k = kindLabel[a.kind];
              const Icon = k.icon;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedAnomalyId(a.id)}
                    className="flex w-full gap-3 px-5 py-3 text-left hover:bg-muted/50"
                  >
                    <Icon
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        a.score >= 85 ? "text-destructive" : "text-primary",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold">{a.deviceName}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {timeAgo(a.at)}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {k.label} · rareza {a.score}/100
                      </p>
                      <p className="mt-0.5 text-xs">{a.detail}</p>
                      <span className="mt-1 inline-block text-[11px] text-primary">
                        Investigar · {a.reviewedAt ? "Revisada" : "Pendiente"}
                      </span>
                    </div>
                  </button>
                  <div className="px-5 pb-3">
                    <button
                      type="button"
                      onClick={() => onReviewAnomaly(a.id, !a.reviewedAt)}
                      className="text-xs text-primary hover:underline"
                    >
                      {a.reviewedAt ? "Volver a pendiente" : "Marcar como revisada"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
      <Dialog
        open={Boolean(selectedAnomaly)}
        onOpenChange={(open) => {
          if (!open) setSelectedAnomalyId(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto overscroll-none">
          {selectedAnomaly && (
            <>
              <DialogTitle>{kindLabel[selectedAnomaly.kind].label}</DialogTitle>
              <DialogDescription>
                {selectedAnomaly.deviceName} · {selectedAnomaly.ip} ·{" "}
                {new Date(selectedAnomaly.at).toLocaleString("es-ES")}
              </DialogDescription>
              <div className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium">{selectedAnomaly.detail}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Rareza {selectedAnomaly.score}/100: indica cuánto se aparta de la rutina
                  aprendida; no confirma una amenaza.
                </p>
              </div>
              <div className="text-sm">
                <h3 className="font-semibold">Qué comprobar</h3>
                <ul className="mt-2 list-disc space-y-2 pl-5 text-muted-foreground">
                  {selectedAnomaly.kind === "unusual_online" ? (
                    <>
                      <li>Comprueba quién estaba usando el equipo a esa hora.</li>
                      <li>Revisa actualizaciones, tareas programadas o un cambio de horario.</li>
                    </>
                  ) : selectedAnomaly.kind === "unusual_offline" ? (
                    <>
                      <li>Comprueba si el equipo estaba apagado, suspendido o fuera de casa.</li>
                      <li>
                        {anomalyDevice
                          ? "Abre su ficha para probar la conexión y revisar su actividad."
                          : "Comprueba si retiraste el equipo del inventario o cambió su dirección de red."}
                      </li>
                    </>
                  ) : (
                    <>
                      <li>
                        Revisa descargas, copias de seguridad, streaming y actualizaciones en este
                        PC.
                      </li>
                      <li>
                        Abre Rendimiento para consultar el tráfico actual. La medida corresponde al
                        adaptador de {monitoringHost}.
                      </li>
                    </>
                  )}
                </ul>
              </div>
              {anomalyDevice ? (
                <p className="text-xs text-muted-foreground">
                  Estado actual: {anomalyDevice.status === "online" ? "activo" : "inactivo"}. Puede
                  haber cambiado desde la detección.
                </p>
              ) : (
                selectedAnomaly.kind !== "traffic_spike" && (
                  <p className="text-xs text-muted-foreground">
                    Este dispositivo ya no está en el inventario. Se conserva la información de la
                    detección.
                  </p>
                )
              )}
              {selectedAnomaly.reviewedAt && (
                <p className="text-xs text-muted-foreground">
                  Revisada el {new Date(selectedAnomaly.reviewedAt).toLocaleString("es-ES")}.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Marcar como revisada guarda esta revisión. Una nueva anomalía volverá a aparecer
                como pendiente.
              </p>
              <div className="flex flex-wrap gap-2">
                {anomalyDevice && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSelectedAnomalyId(null);
                      onSelectDevice(anomalyDevice.id);
                    }}
                  >
                    Ver dispositivo
                  </Button>
                )}
                {selectedAnomaly.kind === "traffic_spike" && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSelectedAnomalyId(null);
                      onOpenPerformance();
                    }}
                  >
                    Ver rendimiento
                  </Button>
                )}
                <Button
                  onClick={() => {
                    onReviewAnomaly(selectedAnomaly.id, !selectedAnomaly.reviewedAt);
                  }}
                >
                  {selectedAnomaly.reviewedAt ? "Volver a pendiente" : "Marcar como revisada"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
