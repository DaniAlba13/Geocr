/* ================= FLOTA JOHN DEERE (telemetría ISO 15143-3 + Equipment API, sincronizada cada hora) ================= */
const FL={d:null,tipo:'',per:7,q:'',zm:{z:1},view:null,cargando:false};
const flHoras=h=>h==null?'–':fmt(h,1);
const flSenal=m=>{const f=m.f_pos||m.f_horas||m.f_motor;return f?new Date(f):null};
const flEstado=m=>{const f=flSenal(m);if(m.sin_iso||!f)return['Sin telemetría','#9AA5B1'];const h=(Date.now()-f)/36e5;if(h>24)return['Sin reportar > 24 h','#D32F2F'];return m.motor===true?['Motor encendido','#2E9E44']:m.motor===false?['Motor apagado','#0070C9']:['Reportando','#0070C9']};
/* tipo corto en español (Operations Center trae p. ej. "Two-wheel Drive Tractors - 90 Hp To Under 140 Hp") */
const flTipo=m=>{const t=String(m.tipo||''),hp=(t.match(/(\d+)\s*Hp\s*(?:To\s*Under\s*(\d+)|And\s*Above)/i)||[]),r=hp[1]?(hp[2]?` ${hp[1]}–${hp[2]} HP`:` ≥ ${hp[1]} HP`):'';
  if(/combine|harvest|cosech/i.test(t+' '+(m.modelo||''))||/^CH\d/i.test(m.modelo||''))return'Cosechadora';if(/sprayer|pulveri|fumig/i.test(t))return'Fumigadora';
  if(/tractor/i.test(t))return(/four|4wd|track/i.test(t)?'Tractor 4WD':'Tractor')+r;if(/loader|cargador/i.test(t))return'Cargador';if(/excavat/i.test(t))return'Excavadora';if(/grader|motonivel/i.test(t))return'Motoniveladora';
  return t||(/^\d+[A-Z]/.test(m.modelo||'')?'Tractor':'Otro')};
async function flCargar(){if(FL.cargando)return;FL.cargando=true;$('#flSt').textContent='Cargando…';
  try{const r=await fetch('/api/flota?dias=60',{cache:'no-store'});if(!r.ok)throw new Error(r.status===401?'Entra a la plataforma para ver la flota.':'No se pudo leer la flota ('+r.status+').');FL.d=await r.json();flDraw()}
  catch(e){$('#flSt').textContent=e.message;$('#flSt').className='status err'}finally{FL.cargando=false}}
function flFiltro(){const D=FL.d,q=FL.q.toLowerCase();return D.maq.filter(m=>(!FL.tipo||flTipo(m)===FL.tipo)&&(!q||[m.nombre,m.modelo,m.serie,m.pin,m.id].join(' ').toLowerCase().includes(q)))}
function flDraw(){if(!FL.d||!$('#s-flota').classList.contains('on'))return;const D=FL.d,E=D.estado;
  $('#flSt').className='status';$('#flSt').innerHTML=E?(E.ok?`Última sincronización: ${new Date(E.upd).toLocaleString('es-DO',{dateStyle:'medium',timeStyle:'short'})} · ${fmt(E.n_iso)} máquinas con telemetría${E.n_eq?` · ${fmt(E.n_eq)} equipos en Operations Center`:''}`:`<span style="color:var(--red)">La última sincronización falló: ${xesc(E.error||'')}</span>`):'Todavía no hay datos: dale "Sincronizar ahora".';
  const tipos=[...new Set(D.maq.map(flTipo))].sort();$('#flTipo').innerHTML='<option value="">Todos los tipos</option>'+tipos.map(t=>`<option${t===FL.tipo?' selected':''}>${xesc(t)}</option>`).join('');
  const M=flFiltro(),ids=new Set(M.map(m=>m.id)),desde=hoyISO().slice(0,10),lim=new Date(Date.now()-4*36e5-(FL.per-1)*864e5).toISOString().slice(0,10);
  const R=D.dia.filter(r=>ids.has(r.id)&&r.fecha>=lim),sum=(a,k)=>a.reduce((s,r)=>s+(r[k]||0),0),H=sum(R,'horas'),I=sum(R,'ralenti'),C=sum(R,'comb');
  const rep=M.filter(m=>{const f=flSenal(m);return f&&Date.now()-f<864e5}).length,on=M.filter(m=>flEstado(m)[0]==='Motor encendido').length,sinr=M.filter(m=>flEstado(m)[0]==='Sin reportar > 24 h').length,sint=M.filter(m=>flEstado(m)[0]==='Sin telemetría').length;
  $('#flK1').textContent=fmt(M.length);$('#flK1s').textContent=`${fmt(rep)} reportando hoy · ${fmt(sinr)} sin reportar · ${fmt(sint)} sin telemetría`;
  $('#flK2').textContent=fmt(H,0);$('#flK2s').textContent=(FL.per===1?'hoy':`últimos ${FL.per} días`)+(R.length&&!H?' · se calcula desde la 2.ª lectura':'');
  $('#flK3').textContent=H?fmt(I/H*100,0)+' %':'–';$('#flK3').style.color=H&&I/H>.3?'var(--red)':H&&I/H>.2?'#C77700':'';
  $('#flK4').textContent=C?fmt(C,0)+' L':'–';$('#flK4s').textContent=H&&C?fmt(C/H,1)+' L por hora de motor':'combustible usado';
  flMapa($('#flMap'),null);zoomable($('#flMap'),FL.zm,()=>flMapa($('#flMap'),null),()=>FL.view,()=>[]);
  const pd=new Map();R.forEach(r=>{if(!pd.has(r.fecha))pd.set(r.fecha,{fecha:r.fecha,h:0,i:0});const o=pd.get(r.fecha);o.h+=r.horas||0;o.i+=r.ralenti||0});
  periodBars($('#flCh1'),[...pd.values()].map(o=>({fecha:o.fecha,v:o.h})),rs=>rs.reduce((s,r)=>s+r.v,0),{fmt:v=>fmt(v,0)},'dia');
  const pm=new Map();R.forEach(r=>{pm.set(r.id,(pm.get(r.id)||0)+(r.horas||0))});const nm=new Map(M.map(m=>[m.id,m]));
  hbars($('#flCh2'),[...pm.entries()].filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([id,h])=>{const m=nm.get(id),ii=R.filter(r=>r.id===id).reduce((s,r)=>s+(r.ralenti||0),0);return[xesc((m&&m.nombre)||id).slice(0,18),h,ii/h>.3?'#D32F2F':ii/h>.2?'#F2A900':'#0070C9',`ralentí ${fmt(ii/h*100,0)} %`]}),v=>fmt(v,1)+' h',{L:150});
  const ag=id=>{const L=R.filter(r=>r.id===id);return{h:sum(L,'horas'),i:sum(L,'ralenti'),c:sum(L,'comb')}};
  $('#flTbl').innerHTML=`<tr><th>Máquina</th><th>Tipo</th><th>Modelo</th><th>Estado</th><th class="n">Horas motor (acum.)</th><th class="n">Horas ${FL.per===1?'hoy':FL.per+' d'}</th><th class="n">Ralentí</th><th class="n">Combustible</th><th class="n">Tanque</th><th class="n">DEF</th><th>Última señal</th></tr>`+
    M.slice().sort((a,b)=>(flSenal(b)||0)-(flSenal(a)||0)).map(m=>{const[e,c]=flEstado(m),a=ag(m.id),f=flSenal(m);return`<tr><td><b>${xesc(m.nombre||m.id)}</b><br><small class="note">${xesc(m.pin||m.serie||'')}</small></td><td>${xesc(flTipo(m))}</td><td>${xesc(m.modelo||'')}</td><td><span style="color:${c};font-weight:700">● ${e}</span></td>
      <td class="n">${flHoras(m.horas)}</td><td class="n">${a.h?fmt(a.h,1):'–'}</td><td class="n" style="${a.h&&a.i/a.h>.3?'color:var(--red);font-weight:700':''}">${a.h?fmt(a.i/a.h*100,0)+' %':'–'}</td><td class="n">${a.c?fmt(a.c,0)+' L':'–'}</td>
      <td class="n" style="${m.comb_pct!=null&&m.comb_pct<15?'color:var(--red);font-weight:700':''}">${m.comb_pct!=null?fmt(m.comb_pct,0)+' %':'–'}</td><td class="n" style="${m.def_pct!=null&&m.def_pct<15?'color:var(--red);font-weight:700':''}">${m.def_pct!=null?fmt(m.def_pct,0)+' %':'–'}</td>
      <td>${f?f.toLocaleString('es-DO',{dateStyle:'short',timeStyle:'short'}):'–'}</td></tr>`}).join('')}
function flMapa(cv,T){const W=T?T.W:Math.max(cv.parentElement.clientWidth,600),H=Math.round(W*.62),dpr=T?1:(window.devicePixelRatio||1);cv.width=W*dpr;cv.height=H*dpr;if(!T)cv.style.height=H+'px';
  const ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);const F={x:10,y:10,w:W-20,h:H-20},clip=EMBED_LAYERS.mask,UT=(lo,la)=>llToUtm(lo,la);
  let bb=bboxPts(polyPts(clip).map(q=>UT(q[0],q[1])));const pd=Math.max(bb[2]-bb[0],bb[3]-bb[1])*.03;bb=[bb[0]-pd,bb[1]-pd,bb[2]+pd,bb[3]+pd];
  let sc=Math.min(F.w/(bb[2]-bb[0]),F.h/(bb[3]-bb[1])),cx=(bb[0]+bb[2])/2,cy=(bb[1]+bb[3])/2;{const v=aplicaZoom(FL.zm,F,{sc,cx,cy,bb});sc=v.sc;cx=v.cx;cy=v.cy}
  const toPx=(E,N)=>[F.x+F.w/2+(E-cx)*sc,F.y+F.h/2-(N-cy)*sc],toE=(x,y)=>[cx+(x-F.x-F.w/2)/sc,cy-(y-F.y-F.h/2)/sc],px=(lo,la)=>toPx(...UT(lo,la));
  const ring=r=>{let x0,y0;r.forEach((q,i)=>{const[x,y]=px(q[0],q[1]);if(i)ctx.lineTo(x,y);else{ctx.moveTo(x,y);x0=x;y0=y}});ctx.lineTo(x0,y0)},path=Pl=>{ctx.beginPath();for(const p of Pl)for(const r of p)ring(r)};
  ctx.save();ctx.beginPath();ctx.rect(F.x,F.y,F.w,F.h);ctx.clip();path(clip);ctx.fillStyle='#EEF2F6';ctx.fill('evenodd');
  if(FL.zm.z>2.5){ctx.beginPath();EMBED_PIECES.forEach(p=>ring(p[3]));ctx.strokeStyle='rgba(120,135,150,.45)';ctx.lineWidth=.5;ctx.stroke()}
  EMBED_LAYERS.divs.forEach(d=>{path(d.polys);ctx.strokeStyle='#8A99AA';ctx.lineWidth=1.2;ctx.stroke()});path(clip);ctx.strokeStyle='#334';ctx.lineWidth=1.6;ctx.stroke();
  ctx.font='bold 12px Arial';ctx.textAlign='center';EMBED_LAYERS.divs.forEach(d=>{const[x,y]=px(d.lab[0],d.lab[1]);ctx.fillStyle='#7A8A9C';ctx.fillText(d.name,x,y)});
  const pts=[];flFiltro().forEach(m=>{if(m.lat==null||m.lon==null)return;const[x,y]=px(m.lon,m.lat),[e,c]=flEstado(m);pts.push({m,x,y});const cos=/cosech/i.test(flTipo(m));
    ctx.beginPath();if(cos)ctx.rect(x-6,y-6,12,12);else ctx.arc(x,y,6,0,7);ctx.fillStyle=c;ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#fff';ctx.stroke();
    if(FL.zm.z>2){ctx.font='600 11px Arial';ctx.textAlign='left';ctx.lineWidth=3;ctx.strokeStyle='rgba(255,255,255,.9)';ctx.strokeText(m.nombre||'',x+9,y+4);ctx.fillStyle='#0E2A47';ctx.fillText(m.nombre||'',x+9,y+4)}});
  ctx.restore();ctx.strokeStyle='#C9D2DC';ctx.strokeRect(F.x,F.y,F.w,F.h);if(!T){FL.view={toPx,toE,px,F,sc};FL.pts=pts}}
function flInit(){if(flInit.ok)return;flInit.ok=true;
  $('#flTipo').onchange=()=>{FL.tipo=$('#flTipo').value;flDraw()};$('#flQ').oninput=()=>{FL.q=$('#flQ').value;flDraw()};
  $$('#flPer button').forEach(b=>b.onclick=()=>{FL.per=+b.dataset.d;$$('#flPer button').forEach(x=>x.classList.toggle('on',x===b));flDraw()});
  $('#flSync').onclick=async()=>{const b=$('#flSync');b.disabled=true;$('#flSt').className='status';$('#flSt').textContent='Sincronizando con John Deere…';
    try{const r=await fetch('/api/flota/sync',{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'falló la sincronización');await flCargar()}catch(e){$('#flSt').className='status err';$('#flSt').textContent=e.message}finally{b.disabled=false}};
  $('#flMap').addEventListener('click',e=>{const r=e.target.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,t=$('#flTip');let best=null,bd=14;(FL.pts||[]).forEach(p=>{const d=Math.hypot(p.x-x,p.y-y);if(d<bd){bd=d;best=p}});
    if(!best){t.style.display='none';return}const m=best.m,[e2,c]=flEstado(m),f=flSenal(m);
    t.innerHTML=`<b>${xesc(m.nombre||m.id)}</b><br>${xesc(flTipo(m))} · ${xesc(m.modelo||'')}<br><span style="color:${c};font-weight:700">● ${e2}</span><br>Horas motor: <b>${flHoras(m.horas)}</b> · ralentí acum.: ${flHoras(m.ralenti)}<br>Tanque: ${m.comb_pct!=null?fmt(m.comb_pct,0)+' %':'–'} · DEF: ${m.def_pct!=null?fmt(m.def_pct,0)+' %':'–'}<br><small>Última posición: ${f?f.toLocaleString('es-DO',{dateStyle:'short',timeStyle:'short'}):'–'}</small>`;
    t.style.left=Math.min(x+12,r.width-240)+'px';t.style.top=(y+12)+'px';t.style.display='block'});
  addEventListener('resize',()=>{if($('#s-flota').classList.contains('on'))flDraw()})}
function flShow(){flInit();if(FL.d)flDraw();flCargar()}
