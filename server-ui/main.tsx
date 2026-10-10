import { InventoryToolbar } from "../src/components/network/InventoryToolbar";
import { PerformanceView } from "../src/components/network/PerformanceView";
import { SpeedTestPanel } from "../src/components/network/SpeedTestPanel";
import { InternetProviderCard } from "../src/components/network/InternetProviderCard";
import { SlaView } from "../src/components/network/SlaView";
import { SecurityView } from "../src/components/network/SecurityView";
import { AwayMode } from "../src/components/network/AwayMode";
import { emptyAwayState } from "../src/lib/away";
import { SettingsModal } from "../src/components/network/SettingsModal";
import { defaultSettings, type Settings as AppSettings } from "../src/lib/settings";
import { NetworkTabs } from "../src/components/network/NetworkTabs";
import { ALL_NETWORKS, UNKNOWN_NETWORK, networkOf } from "../src/lib/networks";
import { DashboardHeader } from "../src/components/network/DashboardHeader";
import {
  DashboardNavigation,
  type DashboardView,
} from "../src/components/network/DashboardNavigation";
import { InventoryDeviceCard } from "../src/components/network/InventoryDeviceCard";
import { NetworkTopology } from "../src/components/network/NetworkTopology";
import { HealthRadar } from "../src/components/network/HealthRadar";
import { FloorPlanView } from "../src/components/network/FloorPlanView";
import { BackupManager } from "../src/components/network/BackupManager";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster, toast } from "sonner";
import { LogOut, LockKeyhole, LoaderCircle, Download } from "lucide-react";
import type { Device, DeviceType } from "../src/lib/devices";
import { detectNetworks } from "../src/lib/networks";
import {
  arrangeInventory,
  type InventorySort,
  type InventoryGroup,
} from "../src/lib/inventory-view";
import { InventorySummary } from "../src/components/network/InventorySummary";
import { DeviceDetailPanel } from "../src/components/network/DeviceDetailPanel";
import { DirectoryManager } from "../src/components/network/DirectoryManager";
import { ActivityTimeline } from "../src/components/network/ActivityTimeline";
import { HomeTwin } from "../src/components/network/HomeTwin";
import { UsageView } from "../src/components/network/UsageView";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../src/components/ui/dialog";
import type { ServerSnapshot } from "../server/types";
import "./style.css";
import { InventoryExport } from "../src/components/network/InventoryExport";
import { commonServices, serviceUrl } from "../src/lib/services";

let csrf = "";
let latest: ServerSnapshot | null = null;
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers:
      data === undefined ? {} : { "Content-Type": "application/json", "X-NetHub-CSRF": csrf },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    credentials: "same-origin",
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.error ?? "No se pudo completar la solicitud."), {
      status: response.status,
    });
  return value as T;
}
const serverPing: typeof import("../src/lib/ping").pingIp = async (ip) => {
  const result = await api<{ ok: boolean; rtt: number | null }>("ping", { ip });
  return { rtt: result.rtt, reachable: result.ok, at: new Date().toISOString(), source: "native" };
};
const serverWake: typeof import("../src/lib/wol").wakeDevice = async (mac) => {
  const device = latest?.devices.find(
    (d) => d.mac === mac || d.networkEntries?.some((e) => e.mac === mac),
  );
  if (!device) throw new Error("Dispositivo no encontrado.");
  await api("wol", { id: device.id });
  return {
    ok: true,
    message:
      "Magic Packet enviado desde el NAS (UDP 9). El equipo debe tener Wake-on-LAN habilitado.",
  };
};
const serverProbe: typeof import("../src/lib/services").detectServices = async (ip, onProgress) => {
  const results = await api<Array<{ port: number; open: boolean; rtt: number | null }>>("ports", {
    ip,
    ports: commonServices.map((d) => d.port),
  });
  const hits = results
    .filter((r) => r.open)
    .flatMap((r) => {
      const def = commonServices.find((d) => d.port === r.port);
      return def
        ? [{ port: r.port, label: def.label, hint: def.hint, url: serviceUrl(ip, def), rtt: r.rtt }]
        : [];
    });
  onProgress?.({ done: commonServices.length, total: commonServices.length, found: hits.length });
  return { hits, native: true };
};
const editable = [
  "watch",
  "name",
  "vendor",
  "type",
  "person",
  "location",
  "notes",
  "tags",
  "connectionSource",
  "identityManual",
  "manualEdit",
  "roomPosition",
  "trusted",
  "isNew",
  "networkId",
  "brand",
  "latency",
  "services",
  "servicesScannedAt",
] as const;
type View = DashboardView | "settings";
const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })
    : "Pendiente";
function App() {
  const [theme, setTheme] = useState<"dark" | "light" | "auto">(() => {
    const saved = window.localStorage.getItem("nethub.server.theme");
    return saved === "light" || saved === "auto" ? saved : "dark";
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const dark = theme === "auto" ? systemDark : theme === "dark";
  const setDark = (value: boolean) => setTheme(value ? "dark" : "light");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [networkFilter, setNetworkFilter] = useState(ALL_NETWORKS);
  const [consent, setConsent] = useState<"provider" | "speed" | null>(null);
  const [intervalConsent, setIntervalConsent] = useState<number | null>(null);
  const [importData, setImportData] = useState<unknown>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    window.localStorage.setItem("nethub.server.theme", theme);
  }, [dark, theme]);
  const [session, setSession] = useState<"checking" | "login" | "ready">("checking");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [state, setState] = useState<ServerSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<View>("inventory");
  const [aboutOpen, setAboutOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<DeviceType[]>([]);
  const order: InventorySort = "ip";
  const group: InventoryGroup = "none";
  const [person, setPerson] = useState("all");
  const [location, setLocation] = useState("all");
  const [status, setStatus] = useState("all");
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const mounted = useRef(true);
  const apply = (value: ServerSnapshot) => {
    const previous = latest;
    if (value.floorPlan === undefined) value.floorPlan = previous?.floorPlan ?? null;
    latest = value;
    if (previous)
      for (const event of [...value.events].reverse()) {
        if (event.kind.startsWith("watch_") && !previous.events.some((e) => e.id === event.id))
          toast.warning(`${event.name}: ${event.detail}`);
      }
    setState(value);
    setConnected(true);
  };
  const refresh = async () => {
    try {
      const version = latest?.floorPlan?.updatedAt;
      const value = await api<ServerSnapshot>(
        "state" + (version ? `?planVersion=${encodeURIComponent(version)}` : ""),
      );
      if (!pending.current && mounted.current) apply(value);
    } catch (error) {
      if (mounted.current) setConnected(false);
      if ((error as { status?: number }).status === 401) setSession("login");
    }
  };
  useEffect(() => {
    mounted.current = true;
    void api<{ csrf: string }>("session")
      .then((value) => {
        csrf = value.csrf;
        setSession("ready");
      })
      .catch(() => setSession("login"));
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);
  useEffect(() => {
    if (session !== "ready") return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [session]);
  const mutate = (path: string, data: unknown) => {
    pending.current++;
    const job = queue.current.then(async () => {
      try {
        const value = await api<ServerSnapshot>(path, data);
        if (value.server && pending.current === 1) apply(value);
        else await refresh();
        return true;
      } catch (error) {
        toast.error((error as Error).message);
        if ((error as { status?: number }).status === 401) setSession("login");
        return false;
      } finally {
        pending.current--;
        if (!pending.current) await refresh();
      }
    });
    queue.current = job;
    return job;
  };
  const update = (device: Device) => {
    const previous = latest?.devices.find((d) => d.id === device.id);
    if (!previous) return;
    const changes: Record<string, unknown> = {},
      expected: Record<string, unknown> = {};
    for (const field of editable)
      if (JSON.stringify(previous[field] ?? null) !== JSON.stringify(device[field] ?? null)) {
        changes[field] = device[field] ?? null;
        expected[field] = previous[field] ?? null;
      }
    if (!Object.keys(changes).length) return;
    const optimistic = {
      ...latest!,
      devices: latest!.devices.map((d) => (d.id === device.id ? device : d)),
    };
    latest = optimistic;
    setState(optimistic);
    void mutate("device", { id: device.id, changes, expected });
  };
  const networks = useMemo(() => detectNetworks(state?.devices ?? []), [state?.devices]);
  const devices = state?.devices ?? [];
  const isp = state?.settings.ispName ?? "tu operador";
  const providerCard = (
    <InternetProviderCard
      name={isp}
      automatic={state?.settings.ispAuto === true}
      onDetected={(name) => {
        if (name !== isp) void mutate("settings", { ispName: name });
      }}
      onEnable={() =>
        state?.server.demo
          ? toast.message("Detección real desactivada en la demostración.")
          : setConsent("provider")
      }
      readProvider={() => api("provider", {})}
      compact={view === "performance"}
    />
  );
  const startTest = () =>
    state?.server.demo
      ? toast.message("Pruebas reales desactivadas en la demostración.")
      : setConsent("speed");
  const scheduleTest = (minutes: number) => {
    if (!minutes) void mutate("settings", { speedIntervalMinutes: 0 });
    else if (state?.server.demo) toast.message("Pruebas reales desactivadas en la demostración.");
    else setIntervalConsent(minutes);
  };
  const changeSettings = (patch: Partial<AppSettings>) => {
    if (patch.theme) setTheme(patch.theme);
    const changes: Record<string, unknown> = {};
    for (const key of [
      "scanIntervalSeconds",
      "healthIntervalSeconds",
      "ispName",
      "ispAuto",
      "awayAutoArm",
      "inventorySort",
      "inventoryGroup",
    ] as const)
      if (patch[key] !== undefined) changes[key] = patch[key];
    if (patch.linkSpeedMbps !== undefined) changes["contractedMbps"] = patch.linkSpeedMbps;
    if (patch.slaIntervalMinutes !== undefined) scheduleTest(patch.slaIntervalMinutes);
    if (Object.keys(changes).length) void mutate("settings", changes);
  };
  const filtered = devices.filter(
    (d) =>
      (networkFilter === ALL_NETWORKS || networkOf(d) === networkFilter) &&
      (!query ||
        `${d.name} ${d.ip} ${d.mac} ${d.vendor}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())) &&
      (!types.length || types.includes(d.type)) &&
      (person === "all" || (person === "" ? !d.person : d.person === person)) &&
      (location === "all" || (location === "" ? !d.location : d.location === location)) &&
      (status === "all" || d.status === status),
  );
  const groups = arrangeInventory(
    filtered,
    state?.settings.inventorySort ?? order,
    state?.settings.inventoryGroup ?? group,
  );
  const chosen = devices.find((d) => d.id === selected) ?? null;
  const download = async () => {
    const data = await api<unknown>("export");
    saveDownload(JSON.stringify(data, null, 2), "nethub-server-backup.json", "application/json");
  };
  if (session === "checking")
    return (
      <div className="grid min-h-screen place-items-center bg-background text-foreground">
        <LoaderCircle className="size-7 animate-spin" />
      </div>
    );
  if (session === "login")
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-5 py-10 text-foreground">
        <section className="w-full max-w-sm rounded-2xl border border-border bg-card p-7">
          <img src="/app-icon.png" alt="" className="mb-5 size-14" />
          <h1 className="text-2xl font-semibold">NetHub Server</h1>
          <p className="mt-2 text-sm text-muted-foreground">Tu red, vigilada desde el NAS.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setLoggingIn(true);
              setLoginError("");
              try {
                const result = await api<{ csrf: string }>("login", { password });
                csrf = result.csrf;
                setPassword("");
                setSession("ready");
              } catch (error) {
                setLoginError((error as Error).message);
              } finally {
                setLoggingIn(false);
              }
            }}
            className="mt-7 space-y-4"
          >
            <label className="block text-sm">
              Contraseña
              <input
                aria-label="Contraseña"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2.5"
              />
            </label>
            {loginError && (
              <p role="alert" className="text-sm text-destructive">
                {loginError}
              </p>
            )}
            <button
              disabled={loggingIn}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-foreground"
            >
              <LockKeyhole className="size-4" />
              {loggingIn ? "Entrando…" : "Entrar"}
            </button>
          </form>
          <p className="mt-5 text-xs text-muted-foreground">
            Usa la contraseña configurada en la instalación del NAS.
          </p>
        </section>
      </main>
    );
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Toaster richColors theme={dark ? "dark" : "light"} />
      <DashboardHeader
        version={state?.server.version ?? ""}
        status={connected ? "connected" : "disconnected"}
        scanning={state?.server.scanning ?? false}
        dark={dark}
        onUpdates={() => setUpdatesOpen(true)}
        onScan={() => void mutate("scan", {})}
        onSettings={() => setSettingsOpen(true)}
        onTheme={() => setDark(!dark)}
        extra={
          <button
            aria-label="Cerrar sesión"
            onClick={async () => {
              await api("logout", {});
              latest = null;
              setState(null);
              csrf = "";
              setSession("login");
            }}
            className="rounded-md border border-border p-2 text-muted-foreground hover:bg-accent"
          >
            <LogOut className="size-4" />
          </button>
        }
      />
      <Dialog open={updatesOpen} onOpenChange={setUpdatesOpen}>
        <DialogContent>
          <DialogTitle>Actualizaciones de NetHub</DialogTitle>
          <DialogDescription>
            Versión del servidor: {state?.server.version}. Para actualizar el NAS, descarga el nuevo
            paquete e importa su imagen Docker conservando el volumen de datos y la contraseña.
          </DialogDescription>
        </DialogContent>
      </Dialog>
      <main className="mx-auto max-w-[1720px] space-y-5 px-5 py-8 xl:px-8">
        <section className="flex flex-wrap items-center justify-end gap-2">
          <DashboardNavigation
            value={view === "settings" ? "inventory" : view}
            onChange={setView}
          />
          <InventoryExport devices={filtered} />
        </section>
        {state?.server.demo && (
          <p className="rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning">
            Demostración con datos de ejemplo. No se escanea tu red ni se realizan pruebas de
            velocidad.
          </p>
        )}
        {!connected && (
          <p role="alert" className="rounded-lg border border-warning p-3 text-sm text-warning">
            No se puede contactar con el NAS. Los datos mostrados corresponden a la última
            sincronización.
          </p>
        )}
        {!state ? (
          <p>Cargando inventario…</p>
        ) : (
          <>
            {state.lastScanError && (
              <p
                role="alert"
                className="rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning"
              >
                {state.lastScanError}
              </p>
            )}
            {view === "inventory" && (
              <>
                <InventorySummary devices={devices} networks={networks.length} />
                <section className="mt-8 space-y-3">
                  <h2 className="text-base font-semibold">Redes detectadas</h2>
                  <p className="text-xs text-muted-foreground">
                    Las subredes se detectan solas a partir de las IP encontradas; puedes cambiar la
                    red de un equipo en su ficha de detalle.
                  </p>
                  <NetworkTabs
                    value={networkFilter}
                    networks={networks}
                    counts={Object.fromEntries([
                      [ALL_NETWORKS, devices.length],
                      [
                        UNKNOWN_NETWORK,
                        devices.filter((d) => networkOf(d) === UNKNOWN_NETWORK).length,
                      ],
                      ...networks.map((n) => [
                        n.id,
                        devices.filter((d) => networkOf(d) === n.id).length,
                      ]),
                    ])}
                    onChange={setNetworkFilter}
                  />
                </section>
                <InventoryToolbar
                  count={filtered.length}
                  query={query}
                  onQuery={setQuery}
                  types={types}
                  onTypes={setTypes}
                  order={state.settings.inventorySort ?? order}
                  grouping={state.settings.inventoryGroup ?? group}
                  onViewChange={changeSettings}
                  person={person}
                  onPerson={setPerson}
                  location={location}
                  onLocation={setLocation}
                  status={status as "all" | "online" | "offline"}
                  onStatus={setStatus}
                  people={state.settings.people}
                  locations={state.settings.locations}
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {filtered.length} de {devices.length} dispositivos
                  </span>
                  <span>Último escaneo: {date(state.lastScanAt)}</span>
                </div>
                {groups.map((g) => (
                  <section key={g.key}>
                    {g.label && (
                      <h2 className="mb-3 mt-5 text-sm font-semibold">
                        {g.label} · {g.devices.length}
                      </h2>
                    )}
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {g.devices.map((d) => (
                        <InventoryDeviceCard
                          key={d.id}
                          device={d}
                          onSelect={setSelected}
                          trafficAvailable={false}
                        />
                      ))}
                    </div>
                  </section>
                ))}
                {!filtered.length && (
                  <p className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
                    {devices.length
                      ? "No hay dispositivos que coincidan con los filtros."
                      : "El inventario aparecerá al completar el primer escaneo."}
                  </p>
                )}
              </>
            )}
            {view === "home" && (
              <HomeTwin
                monitoringHost="este NAS"
                trafficAvailable={state.server.traffic.available}
                devices={devices}
                patterns={state.patterns}
                rxMbps={state.server.traffic.rxMbps}
                onUpdateDevice={update}
                onSelectDevice={setSelected}
                onReviewAnomaly={(id, reviewed) => void mutate("review", { id, reviewed })}
                onOpenPerformance={() => setView("performance")}
              />
            )}
            {view === "activity" && (
              <ActivityTimeline
                events={state.events}
                onSelectDevice={setSelected}
                onClear={() => void mutate("clear-events", {})}
              />
            )}
            {view === "usage" && (
              <UsageView devices={devices} usage={state.usage} onSelectDevice={setSelected} />
            )}
            {view === "topology" && (
              <NetworkTopology devices={devices} networks={networks} onSelectDevice={setSelected} />
            )}
            {view === "health" && (
              <HealthRadar
                samples={state.health}
                isp={isp}
                probing={healthBusy}
                intervalSeconds={state.settings.healthIntervalSeconds}
                onProbeNow={() => {
                  setHealthBusy(true);
                  void mutate("health", {}).finally(() => setHealthBusy(false));
                }}
                monitoringHost="Este NAS"
                targets={[
                  {
                    id: "gateway",
                    label: "Router local",
                    ip:
                      state.server.interfaces.find((n) => n.name === state.settings.interfaceName)
                        ?.gateway ?? "Sin detectar",
                  },
                  { id: "secondary", label: "Referencia DNS", ip: "8.8.8.8" },
                  { id: "internet", label: "Internet", ip: "1.1.1.1" },
                ]}
              />
            )}
            {view === "performance" && (
              <PerformanceView
                traffic={{
                  ...state.server.traffic,
                  totalMbps: state.server.traffic.rxMbps + state.server.traffic.txMbps,
                }}
                linkSpeedMbps={state.settings.contractedMbps}
                isp={isp}
                ispAuto={state.settings.ispAuto === true}
                onProviderDetected={() => {}}
                onProviderEnable={() => setConsent("provider")}
                providerCard={providerCard}
                monitoringHost="este NAS"
                speedPanel={
                  <SpeedTestPanel
                    controller={{
                      durationSeconds: 32,
                      phaseText: state.server.speedRunning
                        ? state.server.speedProgress?.phase === "latency"
                          ? "Midiendo latencia…"
                          : state.server.speedProgress?.phase === "upload"
                            ? "Midiendo subida…"
                            : "Midiendo descarga…"
                        : undefined,
                      running: state.server.speedRunning,
                      phase: state.server.speedRunning
                        ? state.server.speedProgress?.phase === "latency"
                          ? "ping"
                          : state.server.speedProgress?.phase === "upload"
                            ? "upload"
                            : "download"
                        : state.speedHistory.length
                          ? "done"
                          : "idle",
                      live: state.server.speedProgress?.value ?? 0,
                      peak: 0,
                      progress: {
                        total: state.server.speedProgress?.progress ?? 0,
                        secondsLeft: 0,
                      },
                      result: state.server.speedRunning ? null : (state.speedHistory[0] ?? null),
                      history: state.speedHistory,
                      historyLimit: state.settings.speedHistoryLimit,
                      error: state.lastSpeedError,
                      disabled: state.server.demo,
                      onStart: startTest,
                      onLimit: (limit) => void mutate("settings", { speedHistoryLimit: limit }),
                    }}
                  />
                }
              />
            )}
            {view === "sla" && (
              <SlaView
                samples={[...state.speedHistory].reverse()}
                healthSamples={state.health}
                contracted={state.settings.contractedMbps}
                isp={isp}
                ispAuto={state.settings.ispAuto === true}
                onProviderDetected={() => {}}
                onProviderEnable={() => setConsent("provider")}
                providerCard={providerCard}
                running={state.server.speedRunning}
                intervalMinutes={state.settings.speedIntervalMinutes}
                onTestNow={startTest}
                onIntervalChange={scheduleTest}
              />
            )}
            {view === "security" && (
              <div className="space-y-8">
                <AwayMode
                  state={state.away ?? emptyAwayState()}
                  devices={devices}
                  autoArm={state.settings.awayAutoArm === true}
                  onToggleAutoArm={(value) => void mutate("settings", { awayAutoArm: value })}
                  onArm={() => void mutate("away", { armed: true })}
                  onDisarm={() => void mutate("away", { armed: false })}
                  onToggleWatched={(id) => {
                    const ids = state.away?.watchedIds ?? [];
                    void mutate("away", {
                      watchedIds: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
                    });
                  }}
                  onSelectDevice={setSelected}
                />
                <SecurityView
                  devices={devices}
                  alerts={state.alerts ?? []}
                  gatewayIp={
                    state.server.interfaces.find((n) => n.name === state.settings.interfaceName)
                      ?.gateway ?? ""
                  }
                  onSelectDevice={setSelected}
                  onTrust={(id) => {
                    const d = devices.find((d) => d.id === id);
                    if (d) update({ ...d, trusted: true, isNew: false });
                  }}
                  onResolveAlert={(id) => void mutate("alerts", { id })}
                  onClearAlerts={() => void mutate("alerts", { clear: true })}
                  measureDns={async () => {
                    try {
                      return await api("dns", {});
                    } catch {
                      return {
                        available: false,
                        ok: false,
                        gateway: null,
                        domain: "example.com",
                        gatewayIps: [],
                        publicIps: [],
                        hijacked: false,
                        gatewayRtt: null,
                        error: "No se ha podido contactar con el NAS.",
                      };
                    }
                  }}
                />
              </div>
            )}
            {view === "floorplan" && (
              <FloorPlanView
                patterns={state.patterns}
                devices={devices}
                plan={state.floorPlan ?? null}
                canMeasure
                demo={state.server.demo}
                onSave={(plan, expected) => mutate("floor-plan", { plan, expected })}
              />
            )}
          </>
        )}
      </main>
      {state && (
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          settings={{
            ...defaultSettings,
            theme,
            scanIntervalSeconds: state.settings.scanIntervalSeconds,
            healthIntervalSeconds: state.settings.healthIntervalSeconds,
            linkSpeedMbps: state.settings.contractedMbps,
            ispName: isp,
            ispAuto: state.settings.ispAuto === true,
            awayAutoArm: state.settings.awayAutoArm === true,
            slaIntervalMinutes: state.settings.speedIntervalMinutes,
          }}
          onChange={changeSettings}
          onReset={() => {}}
          platform={{
            label: "Servidor NAS",
            version: state.server.version,
            description:
              "Las opciones de monitorización se guardan en el NAS y se comparten con todos los navegadores.",
          }}
          directoryManagers={{
            people: (
              <DirectoryManager
                kind="people"
                names={state.settings.people}
                devices={devices}
                onCreate={(replacement) =>
                  void mutate("directory", { kind: "people", previous: null, replacement })
                }
                onChange={(previous, replacement) =>
                  void mutate("directory", { kind: "people", previous, replacement })
                }
              />
            ),
            locations: (
              <DirectoryManager
                kind="locations"
                names={state.settings.locations}
                devices={devices}
                onCreate={(replacement) =>
                  void mutate("directory", { kind: "locations", previous: null, replacement })
                }
                onChange={(previous, replacement) =>
                  void mutate("directory", { kind: "locations", previous, replacement })
                }
              />
            ),
          }}
          overrides={{
            system: (
              <div className="space-y-4">
                <h3 className="font-semibold">Servicio continuo del NAS</h3>
                <p className="text-sm text-muted-foreground">
                  Docker mantiene NetHub activo aunque cierres el navegador. Reinicio automático
                  configurado en el contenedor.
                </p>
                <p className="text-sm">Iniciado: {date(state.server.startedAt)}</p>
                <p className="text-xs text-muted-foreground">
                  Para cambiar la contraseña, modifica el archivo privado configurado en Docker y
                  reinicia el contenedor.
                </p>
              </div>
            ),
            network: (
              <div className="grid gap-4 sm:grid-cols-2">
                {" "}
                <label className="grid gap-2 text-sm">
                  Interfaz de red
                  <select
                    aria-label="Interfaz de red"
                    value={state.settings.interfaceName}
                    onChange={(e) => void mutate("settings", { interfaceName: e.target.value })}
                    className="rounded-lg border border-border bg-background p-2"
                  >
                    <option value="">Seleccionar interfaz…</option>
                    {state.server.interfaces.map((n) => (
                      <option key={n.name + "-" + n.address} value={n.name}>
                        {n.name} · {n.cidr}
                      </option>
                    ))}
                  </select>
                </label>
                <Interval
                  label="Escaneo de dispositivos"
                  value={state.settings.scanIntervalSeconds}
                  options={[
                    [0, "Desactivado"],
                    [30, "Cada 30 segundos"],
                    [60, "Cada minuto"],
                    [120, "Cada 2 minutos"],
                    [300, "Cada 5 minutos"],
                    [600, "Cada 10 minutos"],
                  ]}
                  onChange={(value) => void mutate("settings", { scanIntervalSeconds: value })}
                />
                <Interval
                  label="Comprobación de conectividad"
                  value={state.settings.healthIntervalSeconds}
                  options={[
                    [0, "Desactivado"],
                    [15, "Cada 15 segundos"],
                    [30, "Cada 30 segundos"],
                    [60, "Cada minuto"],
                    [120, "Cada 2 minutos"],
                  ]}
                  onChange={(value) => void mutate("settings", { healthIntervalSeconds: value })}
                />
                <label className="grid gap-2 text-sm">
                  Velocidad contratada (Mbps)
                  <input
                    aria-label="Velocidad contratada"
                    type="number"
                    min="0"
                    max="100000"
                    defaultValue={state.settings.contractedMbps}
                    key={state.settings.contractedMbps}
                    onBlur={(e) =>
                      void mutate("settings", { contractedMbps: Number(e.target.value) })
                    }
                    className="rounded-lg border border-border bg-background p-2"
                  />
                </label>
                <label className="grid gap-2 text-sm">
                  Proveedor de Internet
                  <input
                    aria-label="Proveedor de Internet"
                    className="rounded-lg border border-border bg-background p-2"
                    defaultValue={isp}
                    key={isp}
                    maxLength={120}
                    onBlur={(e) =>
                      void mutate("settings", { ispName: e.target.value, ispAuto: false })
                    }
                  />
                </label>
              </div>
            ),
            alerts: (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Las alertas Sentinel y el modo ausente se consultan en Seguridad. Configura la
                  vigilancia individual en la ficha de cada equipo. Se registran en el NAS incluso
                  con el navegador cerrado.
                </p>
                <label className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={state.settings.awayAutoArm === true}
                    onChange={(e) => void mutate("settings", { awayAutoArm: e.target.checked })}
                  />
                  Activar automáticamente el modo ausente
                </label>
              </div>
            ),
            data: (
              <div className="space-y-4">
                {" "}
                <h2 className="text-lg font-semibold">Datos y copias</h2>
                <BackupManager
                  adapter={{
                    list: () => api("backups"),
                    create: async () => {
                      await api("backup", {});
                    },
                    read: (id) => api("backup-read", { id }),
                    restore: async (id) => {
                      await api("restore", { id });
                      await refresh();
                    },
                  }}
                />
                <p className="mt-2 text-sm text-muted-foreground">
                  Inventario, posiciones, actividad, rutinas y hasta 100 pruebas de velocidad se
                  guardan en el NAS. Se crea una copia cada 24 horas y se conservan las siete
                  últimas versiones.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <label className="cursor-pointer rounded-lg border border-border px-3 py-2 text-sm">
                    Importar JSON
                    <input
                      aria-label="Importar JSON de NetHub"
                      type="file"
                      accept=".json,application/json"
                      className="sr-only"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        if (file.size > 10 * 1024 * 1024) {
                          toast.error("El archivo supera los 10 MB.");
                          return;
                        }
                        try {
                          const data = JSON.parse(await file.text());
                          setImportData(data);
                        } catch {
                          toast.error("No se pudo leer el JSON.");
                        }
                      }}
                    />
                  </label>
                  <button
                    onClick={() => void download().catch((error) => toast.error(error.message))}
                    className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <Download className="size-4" />
                    Descargar estado actual
                  </button>
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                  Para cambiar la contraseña, actualiza el archivo configurado en Docker y reinicia
                  el contenedor. Para acceso desde fuera de casa, utiliza una VPN o un proxy HTTPS
                  autenticado.
                </p>
              </div>
            ),
          }}
        />
      )}
      <Dialog
        open={consent !== null || intervalConsent !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConsent(null);
            setIntervalConsent(null);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>
            {consent === "provider"
              ? "¿Detectar el proveedor de Internet?"
              : "¿Medir la conexión del NAS?"}
          </DialogTitle>
          <DialogDescription>
            {consent === "provider"
              ? "Se consultará IPWhois desde el NAS. Ese servicio verá tu IP pública y devolverá proveedor y ubicación aproximada; no se enviará el inventario."
              : "Se intercambiará tráfico con Cloudflare desde el NAS. Puede consumir varios GB y afectar temporalmente a otras conexiones; el inventario no se envía."}
          </DialogDescription>
          <button
            className="rounded-md bg-brand px-4 py-2 text-brand-foreground"
            onClick={() => {
              if (consent === "provider") void mutate("settings", { ispAuto: true });
              else if (intervalConsent)
                void mutate("settings", { speedIntervalMinutes: intervalConsent });
              else void mutate("speed", {});
              setConsent(null);
              setIntervalConsent(null);
            }}
          >
            Continuar
          </button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={importData !== null}
        onOpenChange={(open) => {
          if (!open) setImportData(null);
        }}
      >
        <DialogContent>
          <DialogTitle>¿Restaurar estos datos en el NAS?</DialogTitle>
          <DialogDescription>
            Se sustituirán inventario e historiales. Se guardará una copia previa y se conservarán
            la contraseña y las tareas del servidor.
          </DialogDescription>
          <button
            className="rounded-md bg-brand px-4 py-2 text-brand-foreground"
            onClick={() => {
              void mutate("import", { data: importData });
              setImportData(null);
            }}
          >
            Restaurar
          </button>
        </DialogContent>
      </Dialog>
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent>
          <DialogTitle>Acerca de NetHub</DialogTitle>
          <DialogDescription>
            NetHub Server {state?.server.version} · Monitorización continua desde el NAS · © 2026
            oyogor
          </DialogDescription>
          <a href="mailto:nethub2026@outlook.es" className="text-sm text-primary">
            nethub2026@outlook.es
          </a>
        </DialogContent>
      </Dialog>
      <DeviceDetailPanel
        measurePing={serverPing}
        sendWake={serverWake}
        probeServices={serverProbe}
        storageLabel="el NAS"
        pingSourceLabel={state?.server.demo ? "dato de ejemplo" : "NAS (ICMP real)"}
        deviceTrafficAvailable={false}
        device={chosen}
        devices={devices}
        networks={networks}
        people={state?.settings.people ?? []}
        locations={state?.settings.locations ?? []}
        events={state?.events ?? []}
        usage={state?.usage}
        onClose={() => setSelected(null)}
        onUpdate={update}
        onDelete={(device) => {
          void mutate("remove", { id: device.id });
          setSelected(null);
        }}
        onCreatePerson={(replacement) =>
          void mutate("directory", { kind: "people", previous: null, replacement })
        }
        onCreateLocation={(replacement) =>
          void mutate("directory", { kind: "locations", previous: null, replacement })
        }
        onUnify={(otherId, choices) => {
          if (chosen) void mutate("unify", { id: chosen.id, otherId, choices });
        }}
        onSeparate={() => {
          if (chosen) void mutate("separate", { id: chosen.id });
        }}
      />
    </div>
  );
}
function Interval({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: Array<[number, string]>;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 text-sm">
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="rounded-lg border border-border bg-background p-2"
      >
        {options.map(([n, text]) => (
          <option key={n} value={n}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function saveDownload(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
createRoot(document.getElementById("root")!).render(<App />);
