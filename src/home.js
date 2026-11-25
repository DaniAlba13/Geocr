/* ================= INICIO (portada) ================= */
const HM_GR=[
  ['GIS','Cartografía, mapas y muestreo',[['cartografia','Cartografía','Busca cualquier tablón o pieza y ve su ficha completa.'],['mapas','Gestión de mapas','Lluvias, mapas temáticos y análisis de suelo listos para imprimir.'],['muestreo','Puntos de muestreo','Muestreo aleatorio representativo por ambiente.']]],
  ['Teledetección','Dron e imágenes',[['surcos','Surcos y despoblación','Conteo de plantas y fallas a partir del vuelo de dron.'],['malezas','Detección de malezas','Focos de maleza para aplicación localizada.',1]]],
  ['Monitoreo','Satélite y aplicaciones',[['alertas','Monitoreo satelital NAX','Qué piezas necesitan atención, cada día.'],['tasa-variada','Mapas de prescripción','Tasa variada para el dron desde las zonas NAX.'],['calidad','Calidad de aplicación','Cobertura y uniformidad de cada vuelo.']]],
  ['Cosecha','Zafra y maquinaria',[['avance','Avance de cosecha','El mapa se ilumina a medida que se cosecha.'],['cosecha','Piezas terminadas','Informe de cada quincena: TCA, rendimiento y más.'],['flota','Flota John Deere','Horas, ralentí y combustible de cada máquina.']]],
  ['Riego','Agua y clima',[['riego','Balance hídrico','Lámina a aplicar por pieza con datos de clima.',0,'BETA']]]];
const HM_IC=id=>{const a=HOME_APPS.find(x=>x.id===id);return a?a.ic:'<circle cx="12" cy="12" r="8" fill="#E3EEF8" stroke="#0E2A47" stroke-width="1.4"/><path d="M8 12h8M12 8v8" stroke="#0070C9" stroke-width="1.6"/>'};
function hmInit(){const el=$('#hm');if(!el||el._ok)return;el._ok=1;
  const ac=[...SU_PZ.values()].reduce((s,o)=>s+o.ac,0),np=SU_PZ.size;
  $('#hmStats').innerHTML=[[fmt(ac,0),'acres en la plataforma'],[fmt(np),'piezas georreferenciadas'],[String(HM_GR.reduce((t,g)=>t+g[2].filter(x=>!x[3]).length,0)),'herramientas'],['—','máquinas conectadas','hmMaq']].map(([v,t,id])=>`<div class="hm-st"><b${id?` id="${id}"`:''} data-n="${v}">${v}</b><span>${t}</span></div>`).join('');
  $('#hmGrid').innerHTML=HM_GR.map(([g,sub,L])=>`<div class="hm-g"><div class="hm-gh"><b>${g}</b><span>${sub}</span></div>${L.map(([id,t,d,prox,tag])=>`<a class="hm-m${prox?' prox':''}" href="#${id}"><i><svg viewBox="0 0 24 24">${HM_IC(id==='flota'||id==='avance'?'cosecha':id==='malezas'?'surcos':id)}</svg></i><span><b>${t}${tag?` <em class="beta">${tag}</em>`:''}${prox?' <em class="pr">Próximamente</em>':''}</b><small>${d}</small></span><u>→</u></a>`).join('')}</div>`).join('');
  const q=$('#hmQ');const ir=()=>{const v=q.value.trim();location.hash='#cartografia';if(!v)return;setTimeout(()=>{const c=$('#cgQ');if(!c)return;c.value=v;['input','change'].forEach(t=>c.dispatchEvent(new Event(t,{bubbles:true})));c.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))},350)};
  q.onkeydown=e=>{if(e.key==='Enter')ir()};$('#hmGo').onclick=ir;
  hmMapa();hmVivo();let rt;addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(()=>{if($('#s-inicio').classList.contains('on'))hmMapa()},200)});
  hmCount()}
function hmCount(){$$('#hmStats b').forEach(b=>{const raw=b.dataset.n,n=parseFloat(String(raw).replace(/,/g,''));if(!isFinite(n))return;const t0=performance.now(),D=1400;const st=t=>{const k=Math.min(1,(t-t0)/D),e=1-Math.pow(1-k,3);b.textContent=Math.round(n*e).toLocaleString('en-US');if(k<1)requestAnimationFrame(st)};requestAnimationFrame(st)})}
/* datos en vivo de la portada: flota, cosecha, calidad y lluvia (si no hay datos, la tarjeta lo dice) */
async function hmVivo(){const C=[];
  try{const r=await fetch('/api/flota?dias=2',{cache:'no-store'});if(r.ok){const d=await r.json(),M=d.maq||[],rep=M.filter(m=>{const f=flSenal(m);return f&&Date.now()-f<864e5}).length;
    $('#hmMaq').dataset.n=String(M.filter(m=>!m.sin_iso).length);hmCount();C.push(['flota','Flota John Deere',`${fmt(rep)}`,`máquinas reportando hoy de ${fmt(M.length)}`,'#1F9D55'])}}catch(e){}
  try{for(let t=0;t<100&&!CO.listo;t++)await new Promise(r=>setTimeout(r,50));const q=coOrden()[0];if(q)C.push(['avance','Cosecha',`Q${q.n}`,`zafra ${q.zafra||''} · ${fmt(q.filas)} piezas terminadas`,'#7CB342'])}catch(e){}
  try{const L=(STORE.ca||[]);if(L.length){const u=L.slice().sort((a,b)=>String(b.fecha||'').localeCompare(String(a.fecha||'')))[0];C.push(['calidad','Calidad de aplicación',fmt(L.length),`evaluaciones · última ${coDF(String(u.fecha||'').slice(0,10))}`,'#0070C9'])}}catch(e){}
  const rain=$('#homeRain');if(rain&&rain.textContent)C.push(['mapas','Lluvias',rain.textContent.replace(/^Última lluvia registrada:\s*/,'').split(',')[0],rain.textContent.split(',').slice(1).join(',').trim()||'último mes registrado','#3B82C4']);
  $('#hmLive').innerHTML=C.length?C.map(([id,t,v,s,c])=>`<a class="hm-lv" href="#${id}" style="--c:${c}"><span><i></i>${t}</span><b>${v}</b><small>${s}</small></a>`).join(''):''}
/* mapa animado del hero: piezas que se encienden como un escaneo satelital */
function hmMapa(){const cv=$('#hmMap');if(!cv)return;const W=cv.parentElement.clientWidth,H=cv.parentElement.clientHeight||460;if(W<60||H<60)return;const dpr=window.devicePixelRatio||1;cv.width=W*dpr;cv.height=H*dpr;cv.style.width=W+'px';cv.style.height=H+'px';
  const ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);const UT=(lo,la)=>llToUtm(lo,la),bb0=bboxPts(polyPts(EMBED_LAYERS.mask).map(q=>UT(q[0],q[1]))),pd=(bb0[2]-bb0[0])*.06;
  const bb=[bb0[0]-pd,bb0[1]-pd,bb0[2]+pd,bb0[3]+pd],sc=Math.min(W/(bb[2]-bb[0]),H/(bb[3]-bb[1]))*1.02,cx=(bb[0]+bb[2])/2,cy=(bb[1]+bb[3])/2,px=(lo,la)=>{const[E,N]=UT(lo,la);return[W*.5+(E-cx)*sc,H/2-(N-cy)*sc]};
  const P=EMBED_PIECES.map(p=>{const pa=new Path2D();p[3].forEach((q,i)=>{const[x,y]=px(q[0],q[1]);i?pa.lineTo(x,y):pa.moveTo(x,y)});pa.closePath();const[x,y]=px(p[3][0][0],p[3][0][1]);return{pa,x,y}});
  const base=document.createElement('canvas');base.width=W*dpr;base.height=H*dpr;const b=base.getContext('2d');b.setTransform(dpr,0,0,dpr,0,0);
  const ring=r=>{r.forEach((q,i)=>{const[x,y]=px(q[0],q[1]);i?b.lineTo(x,y):b.moveTo(x,y)});b.closePath()};
  b.beginPath();for(const p of EMBED_LAYERS.mask)for(const r of p)ring(r);b.fillStyle='rgba(255,255,255,.04)';b.fill('evenodd');
  b.fillStyle='rgba(120,170,220,.10)';P.forEach(o=>b.fill(o.pa));b.strokeStyle='rgba(150,190,235,.16)';b.lineWidth=.4;P.forEach(o=>b.stroke(o.pa));
  EMBED_LAYERS.divs.forEach(d=>{b.beginPath();for(const p of d.polys)for(const r of p)ring(r);b.strokeStyle='rgba(190,220,255,.45)';b.lineWidth=1;b.stroke()});
  const COLS=['#4ADE80','#A3E635','#38BDF8','#FACC15','#4ADE80'],lit=[];let raf=0,last=0,scan=0;cancelAnimationFrame(hmMapa._raf);
  const red=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const frame=t=>{hmMapa._raf=raf=requestAnimationFrame(frame);if(t-last<40)return;last=t;if(!$('#s-inicio').classList.contains('on')||document.hidden)return;
    ctx.clearRect(0,0,W,H);ctx.drawImage(base,0,0,W,H);scan=(scan+W/260)%(W*1.3);
    for(let k=0;k<6;k++){const o=P[(Math.random()*P.length)|0];if(Math.abs(o.x-scan)<W*.12||Math.random()<.35)lit.push({o,c:COLS[(Math.random()*COLS.length)|0],a:0,v:1})}
    for(let i=lit.length-1;i>=0;i--){const L=lit[i];L.a+=L.v*.06;if(L.a>=1)L.v=-.35;if(L.a<=0&&L.v<0){lit.splice(i,1);continue}ctx.globalAlpha=Math.max(0,Math.min(1,L.a))*.85;ctx.fillStyle=L.c;ctx.fill(L.o.pa)}
    ctx.globalAlpha=1;const g=ctx.createLinearGradient(scan-120,0,scan,0);g.addColorStop(0,'rgba(56,189,248,0)');g.addColorStop(1,'rgba(56,189,248,.18)');ctx.fillStyle=g;ctx.fillRect(scan-120,0,120,H);
    ctx.fillStyle='rgba(56,189,248,.7)';ctx.fillRect(scan,0,1.5,H)};
  if(red){ctx.drawImage(base,0,0,W,H)}else hmMapa._raf=requestAnimationFrame(frame)}
