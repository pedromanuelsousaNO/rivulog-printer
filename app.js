import init, {render_image, WasmJob, lx_service_uuid, lx_write_uuid, lx_notify_uuid} from './pkg/printa_ble_web.js';

// RivuLog Printer v1.2 — Shared cut lines (2026-10-10)
// Keeps the existing LX-D02 Web Bluetooth engine; joins label PNGs in one
// 384-pixel-wide bitmap to avoid the printer's between-job paper advance.

const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const errMsg=e=>e instanceof Error?e.message:String(e);
const WATCHDOG_MS=10000;
const qs=new URLSearchParams(location.search);
const expectedOrigin=qs.get('origin')||'';
const bluetoothSupported=!!navigator.bluetooth;
let LX_SERVICE,LX_WRITE,LX_NOTIFY;
let device=null,writeChar=null,notifyChar=null,connected=false,batteryPct=null;
let labels=[],previewUrl=null,replyOrigin=expectedOrigin||'*';
let job=null,jobSettle=null,isPumping=false,watchdog=null,printing=false;

function log(msg){const e=$('log');e.textContent+='\n'+new Date().toLocaleTimeString()+'  '+msg;e.scrollTop=e.scrollHeight;}
function setStatus(s,error=false){$('status').textContent=s;$('status').className='tag '+(error?'err':'');}
function updateStatus(){if(!bluetoothSupported)return setStatus('Web Bluetooth unavailable',true);if(!connected)return setStatus('not connected');let s=device?.name||'connected';if(batteryPct!=null)s+=' · battery '+batteryPct+'%';setStatus(s);}
function notifyOpener(payload){if(!window.opener)return;try{window.opener.postMessage(payload,replyOrigin);}catch(e){log('Could not notify RivuLog: '+errMsg(e));}}
function dataUrlToBytes(dataUrl){if(typeof dataUrl!=='string'||!/^data:image\/png;base64,/i.test(dataUrl))throw Error('Expected base64 PNG label image');const b=atob(dataUrl.slice(dataUrl.indexOf(',')+1));const out=new Uint8Array(b.length);for(let i=0;i<b.length;i++)out[i]=b.charCodeAt(i);return out;}
async function showPreview(){if(!labels.length)return;let b=null;try{b=render_image(labels[0].bytes,'threshold');const png=b.to_png();if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(new Blob([png],{type:'image/png'}));$('preview').src=previewUrl;$('preview').hidden=false;}finally{if(b)b.free();}}
function acceptMessage(m,origin){if(printing)return log('New label payload ignored while printing.');if(!m||!['RIVULOG_PRINT_LABEL','RIVULOG_PRINT_BATCH'].includes(m.type))return;try{
 const raw=m.type==='RIVULOG_PRINT_BATCH'?m.labels:[m];
 if(!Array.isArray(raw)||!raw.length||raw.length>60)throw Error('Batch must contain 1–60 labels');
 const prepared=raw.map((x,i)=>({labelType:x.labelType||'Tank',recordId:x.recordId||'',title:x.title||`Label ${i+1}`,bytes:dataUrlToBytes(x.imageDataUrl)}));
 labels=prepared;replyOrigin=expectedOrigin||origin||'*';
 $('labelTitle').textContent=prepared.length===1?prepared[0].title:`${prepared.length} RivuLog labels`;
 $('labelMeta').textContent=prepared.length===1?`${prepared[0].labelType} · ${prepared[0].recordId}`:'Consecutive labels · one Bluetooth connection';
 $('labelState').textContent=prepared.length===1?'ready':'batch ready';$('printBtn').textContent=prepared.length===1?'Connect & Print':`Connect & Print ${prepared.length} Labels`;
 $('printBtn').disabled=false;log('Received '+prepared.length+' label(s) from RivuLog');showPreview().catch(e=>log('Preview error: '+errMsg(e)));
 }catch(e){log('Label rejected: '+errMsg(e));setStatus('label error',true);}}
window.addEventListener('message',e=>{if(window.opener&&e.source!==window.opener)return;if(expectedOrigin&&e.origin!==expectedOrigin){log('Ignored message from unexpected origin: '+e.origin);return;}acceptMessage(e.data,e.origin);});

async function connect(){if(!bluetoothSupported)throw Error('This browser does not support Web Bluetooth');if(connected&&device?.gatt?.connected)return;setStatus('connecting…');$('connectBtn').disabled=true;log('Opening Bluetooth chooser…');try{
 device=await navigator.bluetooth.requestDevice({filters:[{namePrefix:'LX'}],optionalServices:[LX_SERVICE]});device.addEventListener('gattserverdisconnected',onDisconnect);
 const server=await device.gatt.connect(),svc=await server.getPrimaryService(LX_SERVICE);writeChar=await svc.getCharacteristic(LX_WRITE);notifyChar=await svc.getCharacteristic(LX_NOTIFY);await notifyChar.startNotifications();notifyChar.addEventListener('characteristicvaluechanged',onNotify);connected=true;$('disconnectBtn').disabled=false;updateStatus();log('Connected to '+(device.name||'LX printer'));
 }catch(e){connected=false;device=null;writeChar=null;notifyChar=null;updateStatus();throw e;}finally{$('connectBtn').disabled=printing;}}
function onDisconnect(){const printingJob=job!==null;connected=false;device=null;writeChar=null;notifyChar=null;batteryPct=null;$('disconnectBtn').disabled=true;updateStatus();log('Printer disconnected');if(printingJob)finishJob(new Error('printer disconnected'));}
function disconnect(){if(printing)return log('Disconnect unavailable during printing');try{if(device?.gatt?.connected)device.gatt.disconnect();}catch{}onDisconnect();}
function onNotify(e){const v=e.target.value,bytes=new Uint8Array(v.buffer,v.byteOffset,v.byteLength);if(bytes.length>=3&&bytes[0]===0x5a&&bytes[1]===0x02){batteryPct=bytes[2];updateStatus();}if(job){clearWatchdog();try{job.on_notification(bytes);}catch(ex){finishJob(ex);return;}pump();}}
async function gattWrite(bytes){if(!writeChar)throw Error('Printer is not connected');if(writeChar.writeValueWithoutResponse)await writeChar.writeValueWithoutResponse(bytes);else await writeChar.writeValue(bytes);}
async function pump(){if(isPumping||!job)return;isPumping=true;try{while(job){const a=job.next_action();if(a.kind==='send')await gattWrite(a.bytes);else if(a.kind==='waitMs')await sleep(a.ms);else if(a.kind==='waitNotification'){armWatchdog();return;}else{finishJob(null);return;}}}catch(e){finishJob(e);}finally{isPumping=false;}}
function armWatchdog(){clearWatchdog();watchdog=setTimeout(()=>{watchdog=null;finishJob(new Error('printer stopped responding'));},WATCHDOG_MS);}
function clearWatchdog(){if(watchdog!==null){clearTimeout(watchdog);watchdog=null;}}
function finishJob(err){clearWatchdog();const j=job,settle=jobSettle;job=null;jobSettle=null;if(!j)return;const je=err||(j.error()?new Error(j.error()):null);j.free();if(settle){if(je)settle.reject(je);else settle.resolve();}}
function runJob(bitmap,density){if(job)return Promise.reject(Error('Print job already running'));return new Promise((resolve,reject)=>{try{const challenge=crypto.getRandomValues(new Uint8Array(10));job=new WasmJob(bitmap,density,challenge);jobSettle={resolve,reject};pump();}catch(e){reject(Error(errMsg(e)));}});}

// Compose original 384-dot PNG labels at 1:1 scale. No resizing, blank spacer,
// or independent end-of-job feed between individual labels.
async function combineLabelPngs(items){
 const decoded=[];
 let totalHeight=0;
 try{
  for(const item of items){
   const img=await createImageBitmap(new Blob([item.bytes],{type:'image/png'}));
   decoded.push(img);
   if(img.width!==384)throw Error(`Expected 384-dot label width, got ${img.width} for ${item.title}`);
   if(img.height<1||img.height>2000)throw Error(`Unexpected label height ${img.height} for ${item.title}`);
   totalHeight+=img.height;
  }
  // Chrome supports canvases this tall, but a very long print job is harder
  // to recover if the printer disconnects. Refuse rather than silently split.
  if(totalHeight>24000)throw Error('Batch too long for continuous printing. Select fewer labels.');
  const canvas=document.createElement('canvas');
  canvas.width=384;canvas.height=totalHeight;
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw Error('Could not create label-combining canvas.');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,384,totalHeight);
  ctx.imageSmoothingEnabled=false;
  let y=0;
  for(let i=0;i<decoded.length;i++){
   const img=decoded[i];
   ctx.drawImage(img,0,y);
   // V1.2: V5.4.3 tank labels have a top guide at y=5..6 and a bottom
   // guide at y=293..294. For a continuous batch, the PREVIOUS label's
   // bottom guide is the shared cut boundary. Suppress only the duplicate
   // top guide on subsequent tank labels; do not crop or resize the image.
   // Single-label jobs still keep both their own guides.
   if(i>0 && items[i].labelType==='Tank' && img.height===300){
    ctx.fillStyle='#fff';
    ctx.fillRect(8,y+5,368,2);
   }
   y+=img.height;
  }
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Could not encode continuous print image.')),'image/png'));
  log(`Continuous image ready: 384 × ${totalHeight} dots, ${items.length} labels, no extra gap`);
  return new Uint8Array(await blob.arrayBuffer());
 }finally{for(const img of decoded)img.close();}
}

async function printLabels(){
 if(printing)return;
 if(!labels.length)throw Error('No RivuLog labels received');
 printing=true;$('printBtn').disabled=true;$('connectBtn').disabled=true;$('disconnectBtn').disabled=true;let done=0;
 try{
  if(!connected)await connect();
  const density=Math.max(1,Math.min(7,Number($('density').value)||3));
  // Important: don't use `Number(value) || 40` — that turns a requested 0 into 40.
  const feedInput=Number($('feed').value);
  const lastFeed=Number.isFinite(feedInput)?Math.max(0,Math.min(300,Math.trunc(feedInput))):0;
  const continuous=labels.length>1 && $('continuousBatch')?.checked!==false;
  if(continuous){
   let bitmap=null;
   try{
    setStatus(`continuous batch: ${labels.length} labels…`);
    $('labelState').textContent=`printing ${labels.length} together`;
    const image=await combineLabelPngs(labels);
    bitmap=render_image(image,'threshold');
    if(bitmap.height()===0)throw Error('Batch rendered empty');
    if(lastFeed>0)bitmap.extend_blank(lastFeed);
    log(`Sending one Bluetooth print job: ${labels.length} labels, ${bitmap.height()} rows, feed=${lastFeed}`);
    await runJob(bitmap,density);
    done=labels.length;
    notifyOpener({type:'RIVULOG_PRINTER_PROGRESS',printed:done,total:labels.length,recordId:labels[labels.length-1].recordId});
   }finally{if(bitmap)bitmap.free();}
  }else{
   // Legacy fallback: individual jobs (may add unwanted paper between labels).
   for(let i=0;i<labels.length;i++){
    const item=labels[i];let bitmap=null;
    try{
     setStatus(`printing ${i+1}/${labels.length}…`);$('labelState').textContent=`${i+1}/${labels.length}`;
     log(`Individual job ${i+1}/${labels.length}: ${item.title}`);
     bitmap=render_image(item.bytes,'threshold');if(bitmap.height()===0)throw Error('Label rendered empty');
     if(i===labels.length-1&&lastFeed>0)bitmap.extend_blank(lastFeed);
     await runJob(bitmap,density);done++;
     notifyOpener({type:'RIVULOG_PRINTER_PROGRESS',printed:done,total:labels.length,recordId:item.recordId});
    }finally{if(bitmap)bitmap.free();}
   }
  }
  log('Batch complete: '+done+'/'+labels.length);
  notifyOpener({type:'RIVULOG_PRINTER_RESULT',ok:true,batch:labels.length>1,printed:done,total:labels.length,labelType:labels.length===1?labels[0].labelType:'Tank',recordId:labels.length===1?labels[0].recordId:''});
 }catch(e){log('Print stopped after '+done+'/'+labels.length+': '+errMsg(e));notifyOpener({type:'RIVULOG_PRINTER_RESULT',ok:false,error:errMsg(e),batch:labels.length>1,printed:done,total:labels.length});setStatus('print failed',true);
 }finally{printing=false;$('printBtn').disabled=!labels.length;$('connectBtn').disabled=false;$('disconnectBtn').disabled=!connected;if(connected)updateStatus();$('labelState').textContent=done+'/'+labels.length+' printed';}
}
$('density').addEventListener('input',()=>$('densityVal').textContent=$('density').value);
$('connectBtn').addEventListener('click',()=>connect().catch(e=>{log('Connection failed: '+errMsg(e));setStatus('connection failed',true);}));
$('printBtn').addEventListener('click',()=>printLabels().catch(e=>log('Print failed: '+errMsg(e))));
$('disconnectBtn').addEventListener('click',disconnect);
if(!bluetoothSupported){$('browserWarning').hidden=false;$('connectBtn').disabled=true;}updateStatus();
try{await init();LX_SERVICE=lx_service_uuid();LX_WRITE=lx_write_uuid();LX_NOTIFY=lx_notify_uuid();log('Printer engine ready · RivuLog Printer v1.1 continuous batch');notifyOpener({type:'RIVULOG_PRINTER_READY'});}catch(e){log('Printer engine failed to load: '+errMsg(e));setStatus('engine load failed',true);$('connectBtn').disabled=true;$('printBtn').disabled=true;}
