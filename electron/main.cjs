const backups = require("./backups.cjs");
let restoringDb = false;
let lastAutoBackup = 0;
// Proceso principal de NetHub portable (Electron).
// - Guarda y lee devices-db.json junto al ejecutable.
// - Escaneo ARP nativo, ping ICMP real y Wake-on-LAN por UDP.
// - Servidor HTTP de respaldo en el puerto 8765 (/scan, /ping, /wol).
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  Tray,
  nativeImage,
  shell,
  screen,
} = require("electron");
const { readWindowState, windowSize, mergeWindowState } = require("./window-state.cjs");
const path = require("node:path");
const { resolveIconPath, persistentTaskbarIcon } = require("./icon-path.cjs");
const { createTrafficSampler } = require("./traffic-sampler.cjs");
const { interfaceConnectionTag, wifiTagForMac } = require("./local-connection.cjs");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const https = require("node:https");
const { detectInternetProvider } = require("./internet-provider.cjs");
ipcMain.handle("nethub:internet-provider", () => detectInternetProvider());
const dgram = require("node:dgram");
const net = require("node:net");
const { execFile, spawn } = require("node:child_process");

const DB_FILE = "devices-db.json";
const SETTINGS_FILE = "settings.json";
const AGENT_PORT = 8765;
const isWindows = process.platform === "win32";
const WINDOWS_APP_ID = "dev.lovable.nethub";
if (isWindows) app.setAppUserModelId(WINDOWS_APP_ID);
// Repositorio oficial de NetHub. Los antiguos solo se consultan como respaldo
// si el oficial no responde (GitHub redirige los repos transferidos).
const OFFICIAL_REPO = "NetHub2026/NetHub";
const GITHUB_REPOS = [OFFICIAL_REPO, "oyogor1985/nethub"];

const UPDATE_ASSET = "NetHub.exe";
/** Esquema oficial de versiones publicadas: v1.3.1 */
const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
const USER_AGENT = "NetHub-Updater";

/* ------------------------------------------------------------------ */
/* Validación centralizada de destinos IPv4                            */
/* ------------------------------------------------------------------ */

/** Devuelve la IPv4 normalizada o null. Exige 4 octetos decimales 0-255 sin ceros a la izquierda. */
function parseIPv4(value) {
  const text = String(value ?? "").trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map((p) => {
    if (p.length > 1 && p.startsWith("0")) return NaN; // evita ambigüedad octal
    return Number(p);
  });
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts.join(".");
}

function ipToInt(ip) {
  return ip.split(".").reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0);
}

function inCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}

/** Rangos privados domésticos (RFC 1918) y link-local. */
function isPrivateIPv4(ip) {
  return (
    inCidr(ip, "10.0.0.0", 8) ||
    inCidr(ip, "172.16.0.0", 12) ||
    inCidr(ip, "192.168.0.0", 16) ||
    inCidr(ip, "169.254.0.0", 16)
  );
}

/** Pertenece a la subred de alguna interfaz activa (máscaras > /16 se limitan a /16). */
function inActiveSubnet(ip) {
  for (const { address, netmask } of activeIPv4Interfaces()) {
    const addr = parseIPv4(address);
    const mask = parseIPv4(netmask);
    if (!addr || !mask) continue;
    let bits = ipToInt(mask).toString(2).replace(/0+$/, "").length;
    if (bits < 16) bits = 16;
    if (inCidr(ip, addr, bits)) return true;
  }
  return false;
}

/** Direcciones que nunca deben sondearse: 0/8, loopback, multicast, reservadas y broadcast. */
function isForbiddenIPv4(ip) {
  return inCidr(ip, "0.0.0.0", 8) || inCidr(ip, "127.0.0.0", 8) || inCidr(ip, "224.0.0.0", 3);
}

/** Destino LAN válido para descubrimiento/sondeo (ping, TCP, puertos, DNS del router, abrir panel). */
function lanTarget(value) {
  const ip = parseIPv4(value);
  if (!ip || isForbiddenIPv4(ip)) return null;
  return inActiveSubnet(ip) || isPrivateIPv4(ip) ? ip : null;
}

/** Destinos públicos fijos que usa el Health Radar (solo ping). */
const PUBLIC_PING_TARGETS = new Set(["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4"]);

function pingTarget(value) {
  const ip = parseIPv4(value);
  if (ip && PUBLIC_PING_TARGETS.has(ip)) return ip;
  return lanTarget(value);
}

/** Broadcast de Wake-on-LAN: global o dirigido dentro de una red local. */
function wolBroadcastTarget(value) {
  const ip = parseIPv4(value);
  if (!ip) return null;
  if (ip === "255.255.255.255") return ip;
  return inActiveSubnet(ip) || isPrivateIPv4(ip) ? ip : null;
}


/** Carpeta del ejecutable portable (o del proyecto en desarrollo). */
function baseDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  return app.isPackaged ? path.dirname(app.getPath("exe")) : path.join(__dirname, "..");
}

function dbPath() {
  return path.join(baseDir(), DB_FILE);
}

/** Ruta de settings.json, junto al ejecutable (misma carpeta que devices-db.json). */
function settingsPath() {
  return path.join(baseDir(), SETTINGS_FILE);
}

/** Lee settings.json; devuelve null si todavía no existe o está corrupto. */
function readSettings() {
  try {
    return fs.existsSync(settingsPath()) ? fs.readFileSync(settingsPath(), "utf8") : null;
  } catch {
    return null;
  }
}

let savedWindowState = null;

/** Escribe settings.json conservando el tamaño de ventana nativo. */
function writeSettings(json) {
  try {
    const state = savedWindowState || readWindowState(readSettings());
    backups.atomic(settingsPath(), mergeWindowState(String(json ?? "{}"), state));
    return { ok: true, path: settingsPath() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* Persistencia                                                        */
/* ------------------------------------------------------------------ */

function readDevices() {
  try {
    return fs.existsSync(dbPath()) ? fs.readFileSync(dbPath(), "utf8") : null;
  } catch {
    return null;
  }
}

function writeDevices(json) {
  try {
    if (restoringDb) return false;
    backups.atomic(dbPath(), json);
    if (Date.now() - lastAutoBackup >= 24 * 3600_000) {
      const existing = backups.entries(baseDir())[0];
      if (!existing || Date.now() - Date.parse(existing.at) >= 24 * 3600_000) backups.create(baseDir(), dbPath());
      lastAutoBackup = Date.now();
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Escaneo ARP + equipo local                                          */
/* ------------------------------------------------------------------ */

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (_err, stdout, stderr) => {
      resolve(`${stdout || ""}\n${stderr || ""}`);
    });
  });
}

function normalizeMac(mac) {
  return mac.replace(/-/g, ":").toLowerCase();
}

function connectionTagForInterfaceName(name = "") {
  return interfaceConnectionTag(name);
}

async function windowsConnectionTagForLocalDevice(ip, mac) {
  if (!isWindows) return null;
  const cleanMac = String(mac || "").replace(/:/g, "-").toUpperCase();
  const script = `
$configs = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq 'Up' -and $_.NetAdapter.HardwareInterface } | Sort-Object { if ($_.IPv4DefaultGateway) { 0 } else { 1 } }
foreach ($config in $configs) {
  $adapter = Get-NetAdapter -InterfaceIndex $config.InterfaceIndex -ErrorAction SilentlyContinue
  if (-not $adapter) { continue }
  $addr = [string]$config.IPv4Address.IPAddress
  $mac = [string]$adapter.MacAddress
  if ($addr -eq '${ip}' -or $mac.ToUpper() -eq '${cleanMac}') {
    Write-Output ($adapter.Name + ' ' + $adapter.InterfaceDescription + ' ' + $adapter.MediaType + ' ' + $adapter.NdisPhysicalMedium)
    exit
  }
}
`;
  const output = await run("powershell", ["-NoProfile", "-Command", script], 2500);
  return connectionTagForInterfaceName(output);
}

/** Interfaces IPv4 activas con su máscara, para calcular el rango a barrer. */
function activeIPv4Interfaces() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      result.push({
        name,
        address: iface.address,
        netmask: iface.netmask || "255.255.255.0",
        mac: normalizeMac(iface.mac || ""),
        connectionTag: connectionTagForInterfaceName(name),
      });
    }
  }
  return result;
}

/** IP, MAC y tipo de conexión de la primera interfaz activa de este equipo. */
async function localDevice() {
  const iface = activeIPv4Interfaces()[0];
  if (!iface) return null;
  let connectionTag = (await windowsConnectionTagForLocalDevice(iface.address, iface.mac)) || iface.connectionTag;
  if (isWindows && connectionTag === "Wi-Fi") {
    const wlan = await run("netsh", ["wlan", "show", "interfaces"], 2500);
    connectionTag = wifiTagForMac(wlan, iface.mac) || connectionTag;
  }
  return {
    ip: iface.address,
    mac: iface.mac,
    name: os.hostname(),
    type: "pc",
    online: true,
    tags: ["Este equipo", "Local", ...(connectionTag ? [connectionTag] : [])],
    connectionSource: "local",
  };
}

/** Lista de IPs a sondear (máximo /24: .1 a .254) para cada interfaz activa. */
function sweepTargets() {
  const targets = new Set();
  for (const { address, netmask } of activeIPv4Interfaces()) {
    const ipParts = address.split(".").map(Number);
    const maskParts = netmask.split(".").map(Number);
    // Solo barremos redes locales de tamaño /24 o menor (evita rangos enormes).
    if (maskParts[0] !== 255 || maskParts[1] !== 255 || maskParts[2] !== 255) {
      if (!(maskParts[0] === 255 && maskParts[1] === 255 && maskParts[2] >= 0)) continue;
    }
    const prefix = `${ipParts[0]}.${ipParts[1]}.${ipParts[2]}`;
    for (let host = 1; host <= 254; host++) {
      const ip = lanTarget(`${prefix}.${host}`);
      if (ip) targets.add(ip);
    }
  }
  return [...targets];
}

/**
 * Envía un datagrama UDP a cada IP del rango: el kernel debe resolver la MAC
 * antes de enviarlo, así que emite un ARP "Who has X?" y puebla la tabla ARP.
 * Es instantáneo (fire and forget) y no necesita respuesta del dispositivo.
 */
function udpTouch(ips) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = dgram.createSocket("udp4");
    } catch {
      resolve();
      return;
    }
    socket.on("error", () => {});
    const payload = Buffer.from([0x00]);
    let index = 0;
    const BATCH = 50;
    const step = () => {
      const end = Math.min(index + BATCH, ips.length);
      for (; index < end; index++) {
        try {
          socket.send(payload, 0, payload.length, 9, ips[index], () => {});
        } catch {
          /* ignoramos IPs inalcanzables */
        }
      }
      if (index < ips.length) setTimeout(step, 12);
      else
        setTimeout(() => {
          try {
            socket.close();
          } catch {
            /* ya cerrado */
          }
          resolve();
        }, 150);
    };
    step();
  });
}

/** Sondeo TCP ligero en lotes: refuerza el ARP en equipos que ignoran el UDP. */
async function tcpTouch(ips, ports = [80, 443], timeout = 320, batch = 48) {
  for (let i = 0; i < ips.length; i += batch) {
    const slice = ips.slice(i, i + batch);
    await Promise.all(
      slice.flatMap((ip) => ports.map((port) => tcpProbe(ip, port, timeout).catch(() => null))),
    );
  }
}

/** Barrido activo de la subred para forzar que Windows rellene su tabla ARP. */
async function sweepSubnet() {
  const ips = sweepTargets();
  if (ips.length === 0) return;
  await udpTouch(ips);
  await tcpTouch(ips);
}

async function scanNetwork() {
  // 1) Barrido activo: los móviles y la domótica no hablan con el PC, así que
  //    provocamos el ARP nosotros antes de leer la tabla.
  try {
    await sweepSubnet();
  } catch {
    /* si el barrido falla seguimos con la tabla ARP existente */
  }

  // 2) Recolectamos la tabla ARP ya poblada.
  const output = await run("arp", ["-a"]);
  const hosts = [];
  const seen = new Set();
  const local = await localDevice();
  if (local?.mac) seen.add(local.mac);

  const re = /(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})/g;
  let match;
  while ((match = re.exec(output))) {
    const ip = match[1];
    const mac = normalizeMac(match[2]);
    if (mac === "ff:ff:ff:ff:ff:ff" || mac.startsWith("01:00:5e") || seen.has(mac)) continue;
    if (mac === "00:00:00:00:00:00" || ip.endsWith(".255")) continue;
    seen.add(mac);
    hosts.push({ ip, mac, online: true });
  }
  if (local) hosts.push(local);
  return hosts;
}


/* ------------------------------------------------------------------ */
/* Ping ICMP                                                           */
/* ------------------------------------------------------------------ */

/** Prueba TCP: muchos equipos bloquean ICMP pero responden (o rechazan) en puertos comunes. */
function tcpProbe(rawIp, port, timeout = 800) {
  const ip = lanTarget(rawIp) || pingTarget(rawIp);
  return new Promise((resolve) => {
    if (!ip || !Number.isInteger(port) || port < 1 || port > 65535) return resolve(null);
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok ? { ok: true, rtt: Math.max(1, Date.now() - started) } : null);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", (error) => finish(error && error.code === "ECONNREFUSED"));
    try {
      socket.connect(port, ip);
    } catch {
      finish(false);
    }
  });
}

async function tcpPing(rawIp) {
  const ip = pingTarget(rawIp);
  if (!ip) return { ok: false, rtt: null };
  const ports = [80, 443, 445, 8080, 53, 22];
  const results = await Promise.all(ports.map((port) => tcpProbe(ip, port)));
  const alive = results.filter(Boolean);
  if (!alive.length) return { ok: false, rtt: null };
  return alive.reduce((best, cur) => (cur.rtt < best.rtt ? cur : best));
}

async function pingIp(rawIp) {
  const ip = pingTarget(rawIp);
  if (!ip) return { ok: false, rtt: null, error: "Destino no permitido." };
  const args = isWindows ? ["-n", "2", "-w", "1500", ip] : ["-c", "2", "-W", "1", ip];
  const output = await run("ping", args, 6000);

  const time = output.match(/(?:tiempo|time)\s*[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i);
  if (time) return { ok: true, rtt: Math.round(Number(time[1].replace(",", "."))) };
  const avg = output.match(/(?:media|promedio|average)\s*=\s*(\d+(?:[.,]\d+)?)\s*ms/i);
  if (avg) return { ok: true, rtt: Math.round(Number(avg[1].replace(",", "."))) };
  if (/(?:tiempo|time)\s*<\s*1\s*ms/i.test(output)) return { ok: true, rtt: 1 };

  return tcpPing(ip);
}

/* ------------------------------------------------------------------ */
/* Wake-on-LAN (Magic Packet)                                          */
/* ------------------------------------------------------------------ */

function sendWol(mac) {
  return new Promise((resolve) => {
    const clean = String(mac || "").replace(/[^0-9a-fA-F]/g, "");
    if (clean.length !== 12) return resolve(false);
    const target = Buffer.from(clean, "hex");
    const packet = Buffer.alloc(102, 0xff);
    for (let i = 0; i < 16; i++) target.copy(packet, 6 + i * 6);

    const socket = dgram.createSocket("udp4");
    socket.once("error", () => {
      socket.close();
      resolve(false);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      const port = Number(nativeSettings.wolPort);
      const broadcast = wolBroadcastTarget(nativeSettings.wolBroadcast);
      if (!broadcast || !Number.isInteger(port) || port < 1 || port > 65535) {
        socket.close();
        resolve(false);
        return;
      }
      socket.send(packet, 0, packet.length, port, broadcast, (err) => {
        socket.close();
        resolve(!err);
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Tráfico de red en vivo (delta por segundo → Mbps)                   */
/* ------------------------------------------------------------------ */

/** Contadores acumulados de bytes recibidos/enviados del sistema. */
async function readCounters() {
  if (isWindows) {
    const output = await run("netstat", ["-e"], 4000);
    const numbers = [];
    for (const line of output.split(/\r?\n/)) {
      const found = line.match(/^\s*\S+\s+(\d+)\s+(\d+)\s*$/);
      if (found) numbers.push([Number(found[1]), Number(found[2])]);
    }
    if (numbers.length === 0) return null;
    const [rx, tx] = numbers[0];
    return { rx, tx };
  }
  try {
    const content = fs.readFileSync("/proc/net/dev", "utf8");
    let rx = 0;
    let tx = 0;
    for (const line of content.split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest || name.trim() === "lo") continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0] || 0;
      tx += cols[8] || 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

const readTraffic = createTrafficSampler(readCounters);

/* ------------------------------------------------------------------ */
/* Actualización automática desde GitHub Releases                      */
/* ------------------------------------------------------------------ */

function currentVersion() {
  try {
    return app.getVersion();
  } catch {
    return "0.0.0";
  }
}

/** Petición HTTPS con seguimiento de redirecciones; devuelve el texto. */
function httpsText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          httpsText(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub respondió ${res.statusCode}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      },
    );
    request.on("error", reject);
    request.setTimeout(15000, () => request.destroy(new Error("Tiempo de espera agotado")));
  });
}

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

/** Compara versiones semánticas: >0 si a es mayor que b. */
function compareVersions(a, b) {
  const pa = normalizeVersion(a).split(/[.\-+]/).map((n) => Number(n) || 0);
  const pb = normalizeVersion(b).split(/[.\-+]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkUpdate() {
  const version = currentVersion();
  try {
    let raw = null;
    let lastError = null;
    for (const repo of GITHUB_REPOS) {
      try {
        raw = await httpsText(`https://api.github.com/repos/${repo}/releases?per_page=50`);
        break;
      } catch (error) {
        lastError = error;
        raw = null;
      }
    }
    if (!raw) throw lastError || new Error("No se pudo consultar GitHub");
    // Solo cuentan releases publicadas con tag semver estricto (vX.Y.Z) y asset NetHub.exe.
    // Así se ignoran etiquetas antiguas tipo "v15" que no siguen el esquema oficial.
    const findAsset = (r) =>
      (r.assets || []).find((a) => String(a.name || "") === UPDATE_ASSET);
    const candidates = (JSON.parse(raw) || []).filter(
      (r) => r && !r.draft && !r.prerelease && SEMVER_TAG.test(String(r.tag_name || "")) && findAsset(r),
    );
    candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
    const release = candidates[0] || {};
    const latest = release.tag_name ? normalizeVersion(release.tag_name) : "";
    const asset = release.tag_name ? findAsset(release) : null;
    return {
      ok: true,
      currentVersion: version,
      latestVersion: latest || version,
      available: Boolean(latest) && compareVersions(latest, version) > 0 && Boolean(asset),
      notes: release.body || "",
      downloadUrl: asset?.browser_download_url || null,
      size: asset?.size || 0,
      publishedAt: release.published_at || null,
    };
  } catch (error) {
    return {
      ok: false,
      currentVersion: version,
      latestVersion: version,
      available: false,
      notes: "",
      downloadUrl: null,
      size: 0,
      error: String(error?.message || error),
    };
  }
}

/** Descarga el asset informando del progreso al renderer. */
function downloadFile(url, target, total, onProgress) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadFile(res.headers.location, target, total, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Descarga fallida (${res.statusCode})`));
        return;
      }
      const size = Number(res.headers["content-length"]) || total || 0;
      let received = 0;
      const file = fs.createWriteStream(target);
      res.on("data", (chunk) => {
        received += chunk.length;
        onProgress(received, size);
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(true)));
      file.on("error", reject);
      res.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(60000, () => request.destroy(new Error("Tiempo de espera agotado")));
  });
}

async function downloadAndInstall(sender) {
  const info = await checkUpdate();
  if (!info.available || !info.downloadUrl) {
    return { ok: false, error: info.error || "No hay ninguna actualización disponible." };
  }

  const temp = path.join(os.tmpdir(), "NetHub-update.exe");
  try {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    await downloadFile(info.downloadUrl, temp, info.size, (received, size) => {
      const percent = size > 0 ? Math.min(100, Math.round((received / size) * 100)) : 0;
      try {
        sender?.send("nethub:update-progress", { received, total: size, percent });
      } catch {
        /* ventana cerrada */
      }
    });
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }

  const targetExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const script = path.join(os.tmpdir(), "nethub-update.bat");
  const content = `@echo off\r\ntimeout /t 1 /nobreak >nul\r\nmove /y "${temp}" "${targetExe}" >nul\r\nstart "" "${targetExe}"\r\n`;
  try {
    fs.writeFileSync(script, content, "utf8");
    spawn("cmd.exe", ["/c", script], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }

  setTimeout(() => app.quit(), 400);
  return { ok: true, version: info.latestVersion, restarting: true };
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** Preferencias nativas aplicadas desde la interfaz (Configuración). */
const nativeSettings = {
  startWithWindows: false,
  startMinimized: false,
  closeAction: "tray",
  minimizeToTray: true,
  wolPort: 9,
  wolBroadcast: "255.255.255.255",
};

function applySettings(settings) {
  const data = settings && typeof settings === "object" ? settings : {};
  nativeSettings.startWithWindows = Boolean(data.startWithWindows);
  nativeSettings.startMinimized = Boolean(data.startMinimized);
  nativeSettings.closeAction = data.closeAction === "quit" ? "quit" : "tray";
  nativeSettings.minimizeToTray = data.minimizeToTray !== false;
  const port = Number(data.wolPort);
  nativeSettings.wolPort = Number.isFinite(port) && port > 0 ? port : 9;
  nativeSettings.wolBroadcast = String(data.wolBroadcast || "255.255.255.255");
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(data.startWithWindows),
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      args: data.startMinimized ? ["--hidden"] : [],
    });
  } catch {
    /* algunas plataformas no lo soportan */
  }
  return { ok: true };
}

/** Al arrancar, aplica lo guardado en settings.json (cierre, bandeja, WoL, autoinicio). */
function loadNativeSettingsFromDisk() {
  try {
    const raw = readSettings();
    if (raw) {
      const parsed = JSON.parse(raw);
      applySettings(parsed?.settings && typeof parsed.settings === "object" ? parsed.settings : parsed);
    }
  } catch {
    /* archivo inexistente o corrupto: se usan los valores por defecto */
  }
}

loadNativeSettingsFromDisk();


function openDataFolder() {
  const folder = baseDir();
  return shell
    .openPath(folder)
    .then((error) => (error ? { ok: false, error } : { ok: true, path: folder }))
    .catch((error) => ({ ok: false, error: String(error) }));
}

function backupDb() {
  try {
    if (!fs.existsSync(dbPath())) {
      return { ok: false, error: "Todavía no hay datos guardados que copiar." };
    }
    const target = backups.create(baseDir(), dbPath());
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function notifyNative(payload) {
  try {
    if (!Notification.isSupported()) return { ok: false };
    const notification = new Notification({
      title: String(payload?.title || "NetHub"),
      body: String(payload?.body || ""),
      icon: iconPath(isWindows ? "favicon.ico" : "app-icon.png"),
    });
    notification.on("click", () => showWindow());
    notification.show();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

ipcMain.handle("nethub:apply-settings", (_e, settings) => applySettings(settings));
ipcMain.handle("nethub:read-settings", () => readSettings());
ipcMain.handle("nethub:write-settings", (_e, json) => writeSettings(json));
ipcMain.handle("nethub:open-data-folder", () => openDataFolder());
ipcMain.handle("nethub:backup-db", () => backupDb());
ipcMain.handle("nethub:list-backups", () => backups.entries(baseDir()));
ipcMain.handle("nethub:read-backup", (_e, id) => backups.read(baseDir(), String(id)));
ipcMain.handle("nethub:restore-backup", (event, id) => {
  backups.restore(baseDir(), dbPath(), String(id));
  restoringDb = true;
  event.sender.once("did-finish-load", () => { restoringDb = false; });
  return { ok: true };
});
ipcMain.handle("nethub:notify", (_e, payload) => notifyNative(payload));
ipcMain.handle("nethub:open-external", async (_e, url) => {
  let target;
  try {
    const parsed = new URL(String(url || ""));
    const okProto = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (!okProto || parsed.username || parsed.password || !lanTarget(parsed.hostname)) {
      return { ok: false, error: "Dirección no válida." };
    }
    target = parsed.toString();
  } catch {
    return { ok: false, error: "Dirección no válida." };
  }
  try {
    await shell.openExternal(target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});

ipcMain.handle("nethub:read", () => readDevices());
ipcMain.handle("nethub:write", (_e, json) => writeDevices(json));
ipcMain.handle("nethub:scan", () => scanNetwork());
ipcMain.handle("nethub:path", () => dbPath());
ipcMain.handle("nethub:ping", (_e, ip) => pingIp(ip));

/* ------------------------------------------------------------------ */
/* Detector de DNS secuestrado                                         */
/* ------------------------------------------------------------------ */

/** Construye un paquete DNS de consulta A sin dependencias externas. */
function buildDnsQuery(id, domain) {
  const labels = String(domain)
    .split(".")
    .filter(Boolean)
    .map((l) => Buffer.from(l, "ascii"));
  const qname = Buffer.concat([
    ...labels.map((l) => Buffer.concat([Buffer.from([l.length]), l])),
    Buffer.from([0]),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0x0100, 2); // recursión deseada
  header.writeUInt16BE(1, 4); // 1 pregunta
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0); // tipo A
  tail.writeUInt16BE(1, 2); // clase IN
  return Buffer.concat([header, qname, tail]);
}

/** Salta un nombre de DNS (soporta punteros de compresión 0xc0). */
function skipDnsName(buf, offset) {
  let ptr = offset;
  while (ptr < buf.length) {
    const len = buf[ptr];
    if (len === 0) return ptr + 1;
    if ((len & 0xc0) === 0xc0) return ptr + 2;
    ptr += len + 1;
  }
  return ptr;
}

/** Extrae las direcciones IPv4 de una respuesta DNS. */
function parseDnsAnswer(buf) {
  const rcode = buf.length > 3 ? buf[3] & 0x0f : 1;
  const ips = [];
  try {
    let ancount = buf.readUInt16BE(6);
    let ptr = skipDnsName(buf, 12);
    ptr += 4; // tipo + clase de la pregunta
    while (ancount-- > 0 && ptr + 12 <= buf.length) {
      ptr = skipDnsName(buf, ptr);
      const type = buf.readUInt16BE(ptr);
      const rdlength = buf.readUInt16BE(ptr + 8);
      const rdstart = ptr + 10;
      if (type === 1 && rdlength === 4 && rdstart + 4 <= buf.length) {
        ips.push(`${buf[rdstart]}.${buf[rdstart + 1]}.${buf[rdstart + 2]}.${buf[rdstart + 3]}`);
      }
      ptr = rdstart + rdlength;
    }
  } catch {
    /* respuesta malformada: se devuelven las IP encontradas */
  }
  return { rcode, ips };
}

/** Consulta DNS UDP directa con timeout. */
const PUBLIC_DNS = "8.8.8.8";

function dnsQuery(rawServer, domain, timeout = 1500) {
  const serverIp = rawServer === PUBLIC_DNS ? PUBLIC_DNS : lanTarget(rawServer);
  return new Promise((resolve) => {
    if (!serverIp) return resolve({ ok: false, ips: [], rtt: null });
    const id = Math.floor(Math.random() * 0xffff);
    const query = buildDnsQuery(id, domain);
    const socket = dgram.createSocket("udp4");
    const started = Date.now();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* ya cerrado */
      }
      resolve(result);
    };
    socket.once("message", (msg) => {
      const rtt = Date.now() - started;
      const { rcode, ips } = parseDnsAnswer(msg);
      finish({ ok: rcode === 0, ips, rtt });
    });
    socket.once("error", () => finish({ ok: false, ips: [], rtt: null }));
    socket.setTimeout(timeout, () => finish({ ok: false, ips: [], rtt: null }));
    socket.send(query, 53, serverIp, (err) => {
      if (err) finish({ ok: false, ips: [], rtt: null });
    });
  });
}

async function dnsCheck(gatewayIp, domain) {
  const clean = String(domain || "www.google.com")
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(clean)) {
    return { ok: false, error: "Dominio no válido." };
  }
  const gw = lanTarget(gatewayIp);
  if (!gw) {
    return { ok: false, domain: clean, error: "No se conoce la IP del router; escanea la red primero." };
  }
  const [local, pub] = await Promise.all([dnsQuery(gw, clean), dnsQuery(PUBLIC_DNS, clean)]);
  const common = local.ips.filter((ip) => pub.ips.includes(ip));
  const hijacked =
    local.ok && pub.ok && local.ips.length > 0 && pub.ips.length > 0 && common.length === 0;
  return {
    ok: local.ok || pub.ok,
    domain: clean,
    gateway: gw,
    gatewayIps: local.ips,
    publicIps: pub.ips,
    gatewayRtt: local.rtt,
    hijacked,
  };
}

ipcMain.handle("nethub:dns-check", (_e, gatewayIp, domain) => dnsCheck(gatewayIp, domain));


// Escaneo TCP real de puertos: abierto solo si el handshake se completa.
function probeTcpPort(rawIp, port, timeout) {
  const ip = lanTarget(rawIp);
  return new Promise((resolve) => {
    if (!ip) return resolve({ port, open: false, rtt: null });
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ port, open, rtt: open ? Math.max(1, Date.now() - started) : null });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ip);
  });
}

ipcMain.handle("nethub:scan-ports", async (_e, ip, ports, timeout) => {
  const target = lanTarget(ip);
  if (!target || !Array.isArray(ports)) return [];
  const list = ports.map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536).slice(0, 200);
  const ms = Math.min(Math.max(Number(timeout) || 900, 200), 5000);
  return Promise.all(list.map((port) => probeTcpPort(target, port, ms)));
});
ipcMain.handle("nethub:wol", (_e, mac) => sendWol(mac));
ipcMain.handle("nethub:traffic", () => readTraffic());
ipcMain.handle("nethub:check-update", () => checkUpdate());
ipcMain.handle("nethub:download-and-install", (event) => downloadAndInstall(event.sender));


/* ------------------------------------------------------------------ */
/* Servidor HTTP de respaldo (compatibilidad con el agente local)      */
/* ------------------------------------------------------------------ */

/** Orígenes de la propia interfaz de NetHub (servidor interno + desarrollo local). */
const allowedAgentOrigins = new Set(["http://localhost:8080", "http://127.0.0.1:8080"]);

function startAgentServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${AGENT_PORT}`);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Vary", "Origin");
    const deny = (code, msg) => res.writeHead(code).end(JSON.stringify({ error: msg }));
    // Anti DNS-rebinding: solo se acepta el host local exacto.
    const host = String(req.headers.host || "").toLowerCase();
    if (host !== `127.0.0.1:${AGENT_PORT}` && host !== `localhost:${AGENT_PORT}`) return deny(403, "host");
    // Solo la propia interfaz de NetHub puede usar este servicio desde un navegador.
    const origin = req.headers.origin;
    const fetchSite = String(req.headers["sec-fetch-site"] || "");
    if (origin) {
      if (!allowedAgentOrigins.has(origin)) return deny(403, "origin");
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    } else if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      // Peticiones del navegador sin Origin (imágenes, no-cors) desde otra web.
      return deny(403, "origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "GET") return deny(405, "method");
    try {
      if (url.pathname === "/scan") {
        res.end(JSON.stringify(await scanNetwork()));
        return;
      }
      if (url.pathname === "/ping") {
        res.end(JSON.stringify(await pingIp(url.searchParams.get("ip"))));
        return;
      }
      if (url.pathname === "/traffic") {
        res.end(JSON.stringify(await readTraffic()));
        return;
      }
      if (url.pathname === "/wol") {
        res.end(JSON.stringify({ ok: await sendWol(url.searchParams.get("mac")) }));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      res.writeHead(500).end(JSON.stringify({ error: String(error) }));
    }
  });
  server.on("error", () => {
    /* puerto ocupado: la app sigue funcionando con IPC */
  });
  server.listen(AGENT_PORT, "127.0.0.1");
}

/* ------------------------------------------------------------------ */
/* Ventana                                                             */
/* ------------------------------------------------------------------ */

/** Raíces posibles de la app compilada, en orden de preferencia. */
function staticRoots() {
  const roots = [];
  let appPath = "";
  try {
    appPath = app.getAppPath();
  } catch {
    appPath = "";
  }
  const bases = [
    path.join(__dirname, ".."),
    appPath,
    process.resourcesPath || "",
    path.join(process.resourcesPath || "", "app"),
    path.join(process.resourcesPath || "", "app.asar"),
  ];
  for (const base of bases) {
    if (!base) continue;
    roots.push(
      path.join(base, "dist", "client"),
      path.join(base, "dist"),
      path.join(base, ".output", "public"),
    );
  }
  return roots;
}

/**
 * Si existe la carpeta compilada pero falta index.html (build sin prerender),
 * genera uno mínimo enlazando los bundles encontrados en assets/.
 */
function ensureIndexHtml(dir) {
  try {
    const indexFile = path.join(dir, "index.html");
    if (fs.existsSync(indexFile)) return true;
    if (!fs.existsSync(dir)) return false;
    const assetsDir = path.join(dir, "assets");
    if (!fs.existsSync(assetsDir)) return false;
    const files = fs.readdirSync(assetsDir);
    const js = files.filter((f) => f.endsWith(".js") && /^(index|client|main|entry)/i.test(f));
    const css = files.filter((f) => f.endsWith(".css"));
    if (!js.length) return false;
    const html = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NetHub</title>
${css.map((f) => `    <link rel="stylesheet" href="/assets/${f}" />`).join("\n")}
  </head>
  <body>
    <div id="root"></div>
${js.map((f) => `    <script type="module" src="/assets/${f}"></script>`).join("\n")}
  </body>
</html>
`;
    fs.writeFileSync(indexFile, html, "utf8");
    return true;
  } catch {
    return false;
  }
}

function resolveStaticRoot() {
  const roots = staticRoots();
  const direct = roots.find((dir) => fs.existsSync(path.join(dir, "index.html")));
  if (direct) return direct;
  return roots.find((dir) => ensureIndexHtml(dir)) || null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Servidor de estáticos interno en un puerto efímero de localhost:
 * la app portable funciona sin vite, sin red y sin nada instalado.
 */
function startStaticServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let pathname = "/";
      try {
        pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      } catch {
        pathname = "/";
      }
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
      let file = path.join(root, safe);
      if (!file.startsWith(root)) file = path.join(root, "index.html");
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        file = path.join(file, "index.html");
      }
      if (!fs.existsSync(file)) file = path.join(root, "index.html"); // SPA fallback
      try {
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        });
        res.end(fs.readFileSync(file));
      } catch {
        res.writeHead(500);
        res.end("Error interno");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      allowedAgentOrigins.add(`http://127.0.0.1:${port}`);
      allowedAgentOrigins.add(`http://localhost:${port}`);
      resolve(`http://127.0.0.1:${port}/`);
    });
    server.on("error", () => resolve(null));
  });
}

/** Pantalla amigable si faltan los archivos compilados. */
function fallbackPage() {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>NetHub</title><style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#0b1120;color:#e2e8f0;
font-family:system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;padding:2rem}
h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#94a3b8;max-width:34rem;line-height:1.6}
code{background:#1e293b;padding:.15rem .4rem;border-radius:.35rem}
button{margin-top:1.5rem;padding:.6rem 1.2rem;border:0;border-radius:.6rem;background:#2563eb;color:#fff;font-size:.95rem;cursor:pointer}
</style></head><body><div><h1>No se han encontrado los archivos de NetHub</h1>
<p>Falta la carpeta compilada de la aplicación. Ejecuta <code>construir-exe.bat</code>
(o <code>npm run build</code>) en la carpeta del proyecto y vuelve a abrir NetHub.</p>
<button onclick="location.reload()">Reintentar</button></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}


/* ------------------------------------------------------------------ */
/* Icono en el área de notificación (bandeja del sistema)              */
/* ------------------------------------------------------------------ */

let tray = null;
let mainWindow = null;
/** true solo cuando el usuario elige «Salir»: permite cerrar de verdad. */
let quitting = false;

function iconPath(file) {
  let appPath = "";
  try {
    appPath = app.getAppPath();
  } catch {
    appPath = "";
  }
  return resolveIconPath(file, {
    resourcesPath: process.resourcesPath,
    appPath,
    electronDir: __dirname,
  });
}

function trayIconImage() {
  const candidates = [
    iconPath("favicon.ico"),
    iconPath("app-icon.png"),
    iconPath("favicon.png"),
  ];
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return isWindows ? image.resize({ width: 16, height: 16 }) : image;
  }
  const fallback = nativeImage.createEmpty();
  return fallback;
}

function showWindow() {
  if (!mainWindow) {
    mainWindow = createWindow();
    void loadApp(mainWindow);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return tray;
  const image = trayIconImage();
  try {
    tray = new Tray(image);
  } catch {
    return null;
  }
  tray.setToolTip("NetHub · monitor de red doméstica");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir NetHub", click: () => showWindow() },
      {
        label: "Escanear ahora",
        click: () => {
          showWindow();
          mainWindow?.webContents.send("nethub:scan-now");
          void scanNetwork().catch(() => null);
        },
      },
      { type: "separator" },
      {
        label: "Salir",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => showWindow());
  tray.on("click", () => showWindow());
  return tray;
}

function createWindow() {
  savedWindowState = readWindowState(readSettings());
  const size = windowSize(savedWindowState, screen.getPrimaryDisplay().workAreaSize);
  const win = new BrowserWindow({
    ...size,
    center: true,
    // Configure taskbar identity before Explorer sees the window.
    show: false,
    backgroundColor: "#0b1120",
    title: "NetHub",
    icon: iconPath(isWindows ? "favicon.ico" : "app-icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isWindows) {
    // The portable launcher survives extraction cleanup and application updates.
    // Never give Windows a pinned relaunch icon/command inside the temporary payload.
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
    const relaunchExe = portableExe || (app.isPackaged ? process.execPath : "");
    win.setAppDetails({
      appId: WINDOWS_APP_ID,
      appIconPath: persistentTaskbarIcon(iconPath("favicon.ico"), path.join(app.getPath("userData"), "taskbar-icons")),
      appIconIndex: 0,
      ...(relaunchExe
        ? { relaunchCommand: `"${relaunchExe}"`, relaunchDisplayName: "NetHub" }
        : {}),
    });
    const image = nativeImage.createFromPath(iconPath("app-icon.png"));
    if (!image.isEmpty()) win.setIcon(image);
  }
  const rememberWindow = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const { width, height } = win.getNormalBounds();
    savedWindowState = { width, height, maximized: win.isMaximized() };
    writeSettings(readSettings() || "{}");
  };
  let resizeTimer;
  win.on("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rememberWindow, 400);
  });
  win.on("maximize", rememberWindow);
  win.on("unmaximize", rememberWindow);
  win.on("close", rememberWindow);
  win.on("closed", () => clearTimeout(resizeTimer));

  // Sin barra de menú (File, Edit, View, Window, Help). En desarrollo
  // se pueden abrir las DevTools con Ctrl+Shift+I.
  win.setMenuBarVisibility(false);
  win.setMenu(null);

  // Minimizar o cerrar deja NetHub en la bandeja: el auto-escaneo y los avisos siguen activos.
  win.on("minimize", (event) => {
    if (!tray || !nativeSettings.minimizeToTray) return;
    event.preventDefault();
    win.hide();
  });

  win.on("close", (event) => {
    if (quitting || !tray || nativeSettings.closeAction === "quit") return;
    event.preventDefault();
    win.hide();
  });

  mainWindow = win;
  return win;
}

async function loadApp(win) {
  const devUrl = process.env.NETHUB_DEV_URL;
  if (devUrl) {
    try {
      allowedAgentOrigins.add(new URL(devUrl).origin);
    } catch {
      /* URL de desarrollo no válida */
    }
    await win.loadURL(devUrl).catch(() => win.loadURL(fallbackPage()));
    return;
  }

  const root = resolveStaticRoot();
  if (root) {
    const url = await startStaticServer(root);
    if (url) {
      await win.loadURL(url).catch(() => win.loadFile(path.join(root, "index.html")));
      return;
    }
    await win.loadFile(path.join(root, "index.html")).catch(() => win.loadURL(fallbackPage()));
    return;
  }

  // Último recurso en desarrollo: servidor de vite; si no responde, pantalla amigable.
  try {
    await win.loadURL("http://localhost:8080");
  } catch {
    await win.loadURL(fallbackPage());
  }
}

function shouldStartHidden() {
  if (!nativeSettings.startMinimized) return false;
  if (process.argv.includes("--hidden")) return true;
  try {
    return Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
  } catch {
    return false;
  }
}

// Panel "Acerca de" con el aviso de copyright del autor.
app.setAboutPanelOptions({
  applicationName: "NetHub",
  applicationVersion: app.getVersion(),
  copyright: "© 2026 oyogor. Todos los derechos reservados.",
  authors: ["oyogor <nethub2026@outlook.es>"],
  website: `https://github.com/${OFFICIAL_REPO}`,
});

app.whenReady().then(async () => {
  startAgentServer();
  createTray();
  const hidden = shouldStartHidden();
  const win = createWindow();
  await loadApp(win);
  if (!hidden) {
    if (savedWindowState?.maximized) win.maximize();
    win.show();
  }
  app.on("activate", () => showWindow());
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  // Con icono en la bandeja NetHub sigue trabajando en segundo plano.
  if (!tray && process.platform !== "darwin") app.quit();
});
