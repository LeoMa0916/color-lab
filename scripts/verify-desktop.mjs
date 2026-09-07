import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const profile = mkdtempSync(resolve('qa-private/desktop-profile-'));
const executable = resolve('release/win-unpacked/Color Lab.exe');
if (!existsSync(executable)) throw new Error('Build the Windows package first');
const child = spawn(executable, ['--remote-debugging-port=0', `--user-data-dir=${profile}`], { windowsHide:true, stdio:'ignore', env:{...process.env,COLORLAB_SMOKE_TEST:'1'} });
let socket;
try {
  const deadline = Date.now() + 60000;
  while (!existsSync(join(profile,'DevToolsActivePort')) && Date.now() < deadline) await delay(300);
  const port = readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
  let target;
  while (!target && Date.now() < deadline) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((item)=>item.type === 'page');
    if (!target) await delay(300);
  }
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let id = 0; const pending = new Map();
  socket.onmessage = ({data}) => { const message=JSON.parse(data); if(message.id) { const callback=pending.get(message.id); pending.delete(message.id); message.error?callback?.reject(new Error(message.error.message)):callback?.resolve(message.result); } };
  const send=(method,params={})=>new Promise((resolve,reject)=>{const request=++id;pending.set(request,{resolve,reject});socket.send(JSON.stringify({id:request,method,params}));});
  let page;
  do {
    page = (await send('Runtime.evaluate',{expression:'({title:document.title,url:location.href,ready:!!document.querySelector(".landing-brand"),node:typeof require})',returnByValue:true})).result?.value;
    if(page?.ready) break;
    await delay(500);
  } while(Date.now()<deadline);
  if(!page?.ready || !page.url.startsWith('https://colorslab.top') || page.node !== 'undefined') throw new Error(`Desktop launch failed: ${JSON.stringify(page)}`);
  const screenshot = await send('Page.captureScreenshot',{format:'png'});
  writeFileSync('qa-private/desktop-app.png',Buffer.from(screenshot.data,'base64'));
  console.log('Packaged Windows app launch verified',page);
  await send('Runtime.evaluate',{expression:'document.querySelector(".app-download-trigger").click()'});
  let downloads=[];
  const downloadDeadline=Date.now()+15000;
  do {
    downloads=(await send('Runtime.evaluate',{expression:'Array.from(document.querySelectorAll(".app-download-row a"),a=>a.href)',returnByValue:true})).result?.value || [];
    if(downloads.length===2) break;
    await delay(300);
  } while(Date.now()<downloadDeadline);
  if(downloads.length!==2 || downloads.some(url=>!url.startsWith('https://github.com/LeoMa0916/color-lab/releases/download/'))) throw new Error('Production download dialog unavailable');
  const downloadShot=await send('Page.captureScreenshot',{format:'png'});
  writeFileSync('qa-private/desktop-downloads.png',Buffer.from(downloadShot.data,'base64'));
  console.log('Production download dialog verified', downloads);
  await Promise.race([send('Browser.close').catch(()=>{}), delay(1000)]);
} finally { socket?.close(); child.kill(); }
