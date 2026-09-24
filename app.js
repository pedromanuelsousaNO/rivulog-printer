import init, {
  render_image,
  WasmJob,
  lx_service_uuid,
  lx_write_uuid,
  lx_notify_uuid,
} from "./pkg/printa_ble_web.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => (e instanceof Error ? e.message : String(e));
const WATCHDOG_MS = 10000;

const qs = new URLSearchParams(location.search);
const expectedOrigin = qs.get("origin") || "";
const bluetoothSupported = !!navigator.bluetooth;

let LX_SERVICE, LX_WRITE, LX_NOTIFY;
let device = null;
let writeChar = null;
let notifyChar = null;
let connected = false;
let batteryPct = null;

let label = null;
let labelBytes = null;
let previewUrl = null;
let replyOrigin = expectedOrigin || "*";

let job = null;
let jobSettle = null;
let isPumping = false;
let watchdog = null;

function log(msg) {
  const el = $("log");
  const stamp = new Date().toLocaleTimeString();
  el.textContent += `\n${stamp}  ${msg}`;
  el.scrollTop = el.scrollHeight;
}
function setStatus(text, error=false) {
  $("status").textContent = text;
  $("status").className = "tag " + (error ? "err" : "");
}
function updateStatus() {
  if (!bluetoothSupported) return setStatus("Web Bluetooth unavailable", true);
  if (!connected) return setStatus("not connected");
  let s = device?.name || "connected";
  if (batteryPct != null) s += ` · battery ${batteryPct}%`;
  setStatus(s);
}
function notifyOpener(payload) {
  if (!window.opener) return;
  try {
    window.opener.postMessage(payload, replyOrigin === "*" ? "*" : replyOrigin);
  } catch (e) {
    log("Could not notify RivuLog: " + errMsg(e));
  }
}
function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Invalid label image");
  const meta = dataUrl.slice(0, comma);
  if (!/;base64/i.test(meta)) throw new Error("Label image is not base64 PNG");
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function showPreview() {
  if (!labelBytes) return;
  let bitmap;
  try {
    bitmap = render_image(labelBytes, "threshold");
    const png = bitmap.to_png();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([png], {type:"image/png"}));
    $("preview").src = previewUrl;
    $("preview").hidden = false;
  } finally {
    if (bitmap) bitmap.free();
  }
}
function acceptLabel(m, origin) {
  if (!m?.imageDataUrl || m.type !== "RIVULOG_PRINT_LABEL") return;
  label = m;
  labelBytes = dataUrlToBytes(m.imageDataUrl);
  replyOrigin = origin || expectedOrigin || "*";
  $("labelTitle").textContent = m.title || `${m.labelType || "Label"} ${m.recordId || ""}`;
  $("labelMeta").textContent = [m.labelType, m.recordId].filter(Boolean).join(" · ");
  $("labelState").textContent = "ready";
  $("printBtn").disabled = false;
  log(`Received ${m.labelType || "label"} ${m.recordId || ""} from RivuLog`);
  showPreview().catch((e) => log("Preview error: " + errMsg(e)));
}

window.addEventListener("message", (e) => {
  if (window.opener && e.source !== window.opener) return;
  if (expectedOrigin && e.origin !== expectedOrigin) {
    log(`Ignored message from unexpected origin: ${e.origin}`);
    return;
  }
  acceptLabel(e.data, e.origin);
});

async function connect() {
  if (!bluetoothSupported) throw new Error("This browser does not support Web Bluetooth");
  if (connected && device?.gatt?.connected) return;

  setStatus("connecting…");
  $("connectBtn").disabled = true;
  log("Opening Bluetooth chooser…");

  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{namePrefix:"LX"}],
      optionalServices: [LX_SERVICE],
    });
    device.addEventListener("gattserverdisconnected", onDisconnect);

    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(LX_SERVICE);
    writeChar = await svc.getCharacteristic(LX_WRITE);
    notifyChar = await svc.getCharacteristic(LX_NOTIFY);
    await notifyChar.startNotifications();
    notifyChar.addEventListener("characteristicvaluechanged", onNotify);

    connected = true;
    $("disconnectBtn").disabled = false;
    $("connectBtn").disabled = false;
    updateStatus();
    log(`Connected to ${device.name || "LX printer"}`);
  } catch (e) {
    connected = false;
    device = null;
    writeChar = null;
    notifyChar = null;
    $("connectBtn").disabled = false;
    updateStatus();
    throw e;
  }
}
function onDisconnect() {
  const wasPrinting = job !== null;
  connected = false;
  device = null;
  writeChar = null;
  notifyChar = null;
  batteryPct = null;
  $("disconnectBtn").disabled = true;
  updateStatus();
  log("Printer disconnected");
  if (wasPrinting) finishJob(new Error("printer disconnected"));
}
function disconnect() {
  try {
    if (device?.gatt?.connected) device.gatt.disconnect();
  } catch {}
  onDisconnect();
}
function onNotify(e) {
  const v = e.target.value;
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (bytes.length >= 3 && bytes[0] === 0x5a && bytes[1] === 0x02) {
    batteryPct = bytes[2];
    updateStatus();
  }
  clearWatchdog();
  if (job) {
    job.on_notification(bytes);
    pump();
  }
}
async function gattWrite(bytes) {
  if (!writeChar) throw new Error("Printer is not connected");
  if (writeChar.writeValueWithoutResponse) {
    await writeChar.writeValueWithoutResponse(bytes);
  } else {
    await writeChar.writeValue(bytes);
  }
}
async function pump() {
  if (isPumping || !job) return;
  isPumping = true;
  try {
    while (job) {
      const a = job.next_action();
      if (a.kind === "send") {
        await gattWrite(a.bytes);
      } else if (a.kind === "waitMs") {
        await sleep(a.ms);
      } else if (a.kind === "waitNotification") {
        armWatchdog();
        return;
      } else {
        finishJob(null);
        return;
      }
    }
  } catch (e) {
    finishJob(e);
  } finally {
    isPumping = false;
  }
}
function armWatchdog() {
  clearWatchdog();
  watchdog = setTimeout(() => {
    watchdog = null;
    finishJob(new Error("printer stopped responding"));
  }, WATCHDOG_MS);
}
function clearWatchdog() {
  if (watchdog !== null) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}
function finishJob(err) {
  clearWatchdog();
  const j = job;
  const settle = jobSettle;
  job = null;
  jobSettle = null;
  if (!j) return;
  const jobErr = err || (j.error() ? new Error(j.error()) : null);
  j.free();
  if (!settle) return;
  if (jobErr) settle.reject(jobErr);
  else settle.resolve();
}
function runJob(bitmap, density) {
  return new Promise((resolve, reject) => {
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(10));
      job = new WasmJob(bitmap, density, challenge);
      jobSettle = {resolve, reject};
      pump();
    } catch (e) {
      reject(new Error(errMsg(e)));
    }
  });
}
async function printLabel() {
  if (!labelBytes) throw new Error("No RivuLog label has been received");
  $("printBtn").disabled = true;
  $("connectBtn").disabled = true;
  let bitmap = null;
  try {
    if (!connected) await connect();

    const density = Math.max(1, Math.min(7, Number($("density").value) || 3));
    const feed = Math.max(0, Math.min(300, Number($("feed").value) || 40));

    bitmap = render_image(labelBytes, "threshold");
    if (bitmap.height() === 0) throw new Error("Label rendered empty");
    bitmap.extend_blank(feed);

    const lines = bitmap.height();
    log(`Printing ${lines} raster lines at density ${density}…`);
    setStatus("printing…");
    await runJob(bitmap, density);

    updateStatus();
    log("Print complete");
    notifyOpener({
      type:"RIVULOG_PRINTER_RESULT",
      ok:true,
      labelType:label?.labelType || "",
      recordId:label?.recordId || "",
      printedLines:lines
    });
  } catch (e) {
    updateStatus();
    log("Print failed: " + errMsg(e));
    notifyOpener({
      type:"RIVULOG_PRINTER_RESULT",
      ok:false,
      error:errMsg(e),
      labelType:label?.labelType || "",
      recordId:label?.recordId || ""
    });
    throw e;
  } finally {
    if (bitmap) bitmap.free();
    $("printBtn").disabled = !labelBytes;
    $("connectBtn").disabled = false;
  }
}

$("density").addEventListener("input", () => $("densityVal").textContent = $("density").value);
$("connectBtn").addEventListener("click", () => connect().catch((e) => {
  log("Connection failed: " + errMsg(e));
  setStatus("connection failed", true);
}));
$("printBtn").addEventListener("click", () => printLabel().catch(() => {}));
$("disconnectBtn").addEventListener("click", disconnect);

if (!bluetoothSupported) {
  $("browserWarning").hidden = false;
  $("connectBtn").disabled = true;
}
updateStatus();

try {
  await init();
  LX_SERVICE = lx_service_uuid();
  LX_WRITE = lx_write_uuid();
  LX_NOTIFY = lx_notify_uuid();
  log("Printer engine ready");
  notifyOpener({type:"RIVULOG_PRINTER_READY"});
} catch (e) {
  log("Printer engine failed to load: " + errMsg(e));
  setStatus("engine load failed", true);
  $("connectBtn").disabled = true;
  $("printBtn").disabled = true;
}
