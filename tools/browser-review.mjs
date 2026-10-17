import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root=new URL('../',import.meta.url).pathname.replace(/\/$/,'');
const shots=root+'/docs/screenshots';
await mkdir(shots,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'alive-review-'));
const browser=spawn('/usr/bin/chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-proxy-server','--password-store=basic','--remote-debugging-address=127.0.0.1','--remote-debugging-port=13491','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let ws; const errors=[],failed=[];
try{
 let pages;
 for(let i=0;i<70;i++){try{pages=await(await fetch('http://127.0.0.1:13491/json/list')).json();break;}catch{await wait(250);}}
 if(!pages)throw Error('Chromium did not start');
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let id=0;const pending=new Map();
 ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.exception?.description??d.params.exceptionDetails.text);if(d.method==='Network.responseReceived'&&d.params.response.status>=400)failed.push({url:d.params.response.url,status:d.params.response.status});if(d.id){const p=pending.get(d.id);if(p){clearTimeout(p.timer);pending.delete(d.id);d.error?p.reject(d.error):p.resolve(d.result);}}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>reject(Error(method+' timeout')),25000);pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));});
 const run=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const shot=async name=>{await wait(450);const small=await run(`(()=>{const found=[];const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;if(!node.textContent.trim())continue;const el=node.parentElement;const style=getComputedStyle(el);const range=document.createRange();range.selectNodeContents(node);const rect=range.getBoundingClientRect();if(rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&parseFloat(style.fontSize)<17)found.push({text:node.textContent.trim().slice(0,50),font:style.fontSize,tag:el.tagName,class:el.className});}return found.slice(0,15);})()`);console.log(JSON.stringify({typography:name,smallText:small}));const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(shots+'/'+name+'.png',Buffer.from(data,'base64'));if(small.length)throw Error(name+' contains text below 17px');};
 await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
 const base=process.argv.find(x=>x.startsWith('--url='))?.slice(6)??'http://127.0.0.1:8085/';
 const inspect=()=>run('({title:document.title,text:document.body.innerText.slice(0,6500),buttons:[...document.querySelectorAll("button")].filter(b=>b.getBoundingClientRect().width>0).map(b=>({id:b.id,text:b.innerText,aria:b.getAttribute("aria-label"),data:{...b.dataset}})),inputs:[...document.querySelectorAll("input")].map(x=>({id:x.id,name:x.name,type:x.type})),width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:base});await wait(1100);await run('document.fonts.ready.then(()=>true)');
 console.log(JSON.stringify({stage:'desktop',data:await inspect()}));await shot(base.endsWith('/about')?'介绍页-桌面':'01-登录-桌面');
 if(process.argv.includes('--fonts')){
   await call('DOM.enable');await call('CSS.enable');
   const {root:document}=await call('DOM.getDocument');
   for(const selector of ['.brand-name','#login-form label','#login-form button[type="submit"]']){
     const {nodeId}=await call('DOM.querySelector',{nodeId:document.nodeId,selector});
     const {fonts}=await call('CSS.getPlatformFontsForNode',{nodeId});
     console.log(JSON.stringify({renderedFonts:selector,fonts}));
     if(!fonts.some(font=>font.isCustomFont&&font.glyphCount>0))throw Error(selector+' did not render the hosted font on this Linux browser');
   }
 }
 if(process.argv.includes('--full')){
   // Scenario actions are supplied after inspecting the Claude-authored markup.
   const actionFile=process.argv.find(x=>x.startsWith('--actions='))?.slice(10);
   if(actionFile){const {readFile}=await import('node:fs/promises');const actions=JSON.parse(await readFile(actionFile,'utf8'));
     for(const a of actions){
       if(a.reducedMotion!==undefined)await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:a.reducedMotion?'reduce':'no-preference'}]});
       if(a.timezone)await call('Emulation.setTimezoneOverride',{timezoneId:a.timezone});
       if(a.width)await call('Emulation.setDeviceMetricsOverride',{width:a.width,height:a.height??900,deviceScaleFactor:1,mobile:a.width<700});
       if(a.reload){await call('Page.reload');await wait(650);}
       if(a.hover){const point=await run(`(()=>{const r=document.querySelector(${JSON.stringify(a.hover)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await wait(320);}
       if(a.upload){const {root}=await call('DOM.getDocument');const {nodeId}=await call('DOM.querySelector',{nodeId:root.nodeId,selector:a.upload.selector});await call('DOM.setFileInputFiles',{nodeId,files:[a.upload.path]});await wait(300);}
       if(a.drag){const rect=await run(`(()=>{const r=document.querySelector(${JSON.stringify(a.drag.selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);const from={x:rect.x+rect.width*a.drag.from[0],y:rect.y+rect.height*a.drag.from[1]},to={x:rect.x+rect.width*a.drag.to[0],y:rect.y+rect.height*a.drag.to[1]};await call('Input.dispatchMouseEvent',{type:'mouseMoved',...from});await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...from});for(let i=1;i<=8;i++){await call('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:1,x:from.x+(to.x-from.x)*i/8,y:from.y+(to.y-from.y)*i/8});await wait(20);}await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...to});await wait(100);}
       if(a.expression){const value=await run(a.expression);console.log(JSON.stringify({action:a.name,result:value}));if(a.expect!==undefined&&JSON.stringify(value)!==JSON.stringify(a.expect))throw Error(a.name+' failed: '+JSON.stringify(value));}
       if(a.exportImage){const data=await run(`(()=>{const image=document.querySelector(${JSON.stringify(a.exportImage.selector)});const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);return canvas.toDataURL('image/png').split(',')[1];})()`);await writeFile(root+'/'+a.exportImage.path,Buffer.from(data,'base64'));}
       await wait(a.wait??400);if(a.screenshot)await shot(a.screenshot);if(a.inspect)console.log(JSON.stringify({stage:a.name,data:await inspect()}));
     }
   }
 }
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await wait(400);console.log(JSON.stringify({stage:'mobile',data:await inspect()}));await shot(base.endsWith('/about')?'介绍页-手机':'02-当前页-手机');
 console.log(JSON.stringify({errors,failed,screenshots:shots}));
 if(errors.length||failed.length)process.exitCode=1;
}finally{ws?.close();browser.kill('SIGTERM');}
