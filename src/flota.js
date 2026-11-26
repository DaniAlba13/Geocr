/* ================= FLOTA JOHN DEERE · tablero interactivo (filtros cruzados al estilo Power BI) =================
   Datos: /api/flota (máquinas con su última lectura + lecturas diarias), sincronizado cada hora desde John Deere. */
const FL={d:null,per:7,q:'',f:{div:new Set(),tipo:new Set(),est:new Set()},sel:null,zm:{z:1},view:null,pts:[],cargando:false,orden:{k:'senal',d:-1}};
const FL_CFG=(()=>{try{return Object.assign({pr:null,idl:3,srv:250},JSON.parse(localStorage.getItem('agroap-fl-cfg')||'{}'))}catch(e){return{pr:null,idl:3,srv:250}}})();
const FLC={on:'#1F9D55',off:'#0070C9',rep:'#3B82C4',sinr:'#E5484D',sint:'#A3AEBB',ral:'#F2A900',nav:'#0E2A47'};
const flSenal=m=>{const f=m.f_pos||m.f_horas||m.f_motor;return f?new Date(f):null};
const flEst=m=>{const f=flSenal(m);if(m.sin_iso||!f)return'Sin telemetría';if((Date.now()-f)/36e5>24)return'Sin reportar';return m.motor===true?'Encendida':m.motor===false?'Apagada':'Reportando'};
const FL_EC={'Encendida':FLC.on,'Apagada':FLC.off,'Reportando':FLC.rep,'Sin reportar':FLC.sinr,'Sin telemetría':FLC.sint};
const flTipo=m=>{if(m._t)return m._t;const t=String(m.tipo||''),hp=(t.match(/(\d+)\s*Hp\s*(?:To\s*Under\s*(\d+)|And\s*Above)/i)||[]),r=hp[1]?(hp[2]?` ${hp[1]}–${hp[2]} HP`:` ≥ ${hp[1]} HP`):'';let o;
  if(/combine|harvest|cosech/i.test(t+' '+(m.modelo||''))||/^CH\d/i.test(m.modelo||''))o='Cosechadora';else if(/sprayer|pulveri|fumig/i.test(t))o='Fumigadora';
  else if(/tractor/i.test(t))o=(/four|4wd|track/i.test(t)?'Tractor 4WD':'Tractor')+r;else if(/loader|cargador/i.test(t))o='Cargador';else if(/excavat/i.test(t))o='Excavadora';else if(/grader|motonivel/i.test(t))o='Motoniveladora';
  else o=t||(/^\d+[A-Z]/.test(m.modelo||'')?'Tractor':'Otro');return m._t=o};
/* división según la última posición; si la máquina está fuera (en tránsito, en un camino), se asigna la división más cercana */
const flDiv=m=>{if(m._d!==undefined)return m._d;if(m.lat==null||m.lon==null)return m._d='Sin ubicación';const d=EMBED_LAYERS.divs.find(d=>pip(m.lon,m.lat,d.polys));if(d)return m._d=d.name;
  const[E,N]=llToUtm(m.lon,m.lat);let best=null,bd=Infinity;EMBED_LAYERS.divs.forEach(dv=>{for(const p of dv.polys)for(const r of p){let a=llToUtm(r[0][0],r[0][1]);for(let i=1;i<r.length;i++){const b=llToUtm(r[i][0],r[i][1]),dx=b[0]-a[0],dy=b[1]-a[1],L=dx*dx+dy*dy,t=L?Math.max(0,Math.min(1,((E-a[0])*dx+(N-a[1])*dy)/L)):0,x=a[0]+t*dx-E,y=a[1]+t*dy-N,q=x*x+y*y;if(q<bd){bd=q;best=dv.name}a=b}}});
  m._fuera=Math.sqrt(bd);return m._d=best||'Sin ubicación'};
const flH=h=>h==null||!isFinite(h)?'–':fmt(h,1);
const flFecha=f=>f?f.toLocaleString('es-DO',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'–';
async function flCargar(){if(FL.cargando)return;FL.cargando=true;fetch('/api/flota/pos?dias=14',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(p=>{if(p){FL.pos=p;flDraw()}}).catch(()=>{});
  try{const r=await fetch('/api/flota?dias=90',{cache:'no-store'});if(!r.ok)throw new Error(r.status===401?'Entra a la plataforma para ver la flota.':'No se pudo leer la flota ('+r.status+').');FL.d=await r.json();flDraw()}
  catch(e){$('#flSt').innerHTML=`<span class="fl-err">${xesc(e.message)}</span>`}finally{FL.cargando=false}}
/* ---- filtros: cada visual filtra por todos los filtros menos el propio (filtro cruzado) ---- */
function flPasa(m,salvo){const F=FL.f,q=FL.q.toLowerCase();
  if(salvo!=='div'&&F.div.size&&!F.div.has(flDiv(m)))return false;if(salvo!=='tipo'&&F.tipo.size&&!F.tipo.has(flTipo(m)))return false;if(salvo!=='est'&&F.est.size&&!F.est.has(flEst(m)))return false;
  if(q&&![m.nombre,m.modelo,m.serie,m.pin,m.id,flTipo(m)].join(' ').toLowerCase().includes(q))return false;return true}
const flTog=(k,v)=>{const S=FL.f[k];S.has(v)?S.delete(v):S.add(v);FL.sel=null;flDraw()};
function flRango(off){const fin=Date.now()-4*36e5-off*FL.per*864e5,a=new Date(fin-(FL.per-1)*864e5).toISOString().slice(0,10),b=new Date(fin).toISOString().slice(0,10);return[a,b]}
/* consumo del día: el de la telemetría si John Deere lo envía; si no, el estimado del servidor (bajada del % de tanque × capacidad, o horas × consumo típico del modelo) */
const flC=r=>r.comb>0?r.comb:(r.comb24>0?r.comb24:(r.comb_est>0?r.comb_est:0));
function flAgg(ids,[a,b]){const R=FL.d.dia.filter(r=>ids.has(r.id)&&r.fecha>=a&&r.fecha<=b),s=k=>R.reduce((t,r)=>t+(r[k]||0),0);return{R,h:s('horas'),i:s('ralenti'),c:R.reduce((t,r)=>t+flC(r),0)}}
const flDelta=(v,p)=>!p||!isFinite(v)?'':`<span class="fl-dl ${v>=p?'up':'dn'}">${v>=p?'▲':'▼'} ${fmt(Math.abs(v-p)/p*100,0)} %</span>`;
/* ---------- dibujo ---------- */
function flDraw(){if(!FL.d||!$('#s-flota').classList.contains('on'))return;const D=FL.d,E=D.estado;
  $('#flSt').innerHTML=E?(E.ok?`<i class="fl-live"></i>Actualizado ${flFecha(new Date(E.upd))} · ${fmt(E.n_iso)} con telemetría · ${fmt(E.n_eq)} equipos en Operations Center`:`<span class="fl-err">Falló la última sincronización: ${xesc(E.error||'')}</span>`):'Sin datos todavía: dale "Sincronizar".';
  const M=D.maq.filter(m=>flPasa(m)),ids=new Set(M.map(m=>m.id)),A=flAgg(ids,flRango(0)),P=flAgg(ids,flRango(1));
  const act=[...FL.f.div].map(v=>['div',v]).concat([...FL.f.tipo].map(v=>['tipo',v]),[...FL.f.est].map(v=>['est',v]),FL.q&&FL.q.trim()?[['q','Búsqueda: '+FL.q.trim()]]:[]);$('#flQx').hidden=!FL.q;
  $('#flAct').innerHTML=act.length?act.map(([k,v])=>`<button class="fl-chip on" data-k="${k}" data-v="${xesc(v)}">${xesc(v)} ✕</button>`).join('')+`<button class="fl-clr" id="flClr">Limpiar filtros</button>`:'<span class="fl-hint">Haz clic en cualquier gráfico para filtrar todo el tablero.</span>';
  $$('#flAct .fl-chip').forEach(b=>b.onclick=()=>{if(b.dataset.k==='q'){FL.q='';$('#flQ').value='';flDraw()}else flTog(b.dataset.k,b.dataset.v)});if($('#flClr'))$('#flClr').onclick=()=>{Object.values(FL.f).forEach(S=>S.clear());FL.q='';$('#flQ').value='';flDraw()};
  const rep=M.filter(m=>['Encendida','Apagada','Reportando'].includes(flEst(m))).length,dias=FL.per,act7=new Set(A.R.filter(r=>r.horas>0).map(r=>r.id)).size,md=A.R.filter(r=>r.horas>0).length;
  const spark=k=>{const L=[];for(let i=13;i>=0;i--){const f=new Date(Date.now()-4*36e5-i*864e5).toISOString().slice(0,10);L.push(FL.d.dia.filter(r=>ids.has(r.id)&&r.fecha===f).reduce((t,r)=>t+(k==='comb'?flC(r):(r[k]||0)),0))}return flSpark(L)};
  const K=[['Máquinas reportando',`${fmt(rep)}<small> / ${fmt(M.length)}</small>`,`${fmt(M.filter(m=>flEst(m)==='Sin reportar').length)} sin reportar más de 24 h`,''],
    ['Horas de motor',fmt(A.h,0),`${dias===1?'hoy':'últimos '+dias+' días'} ${flDelta(A.h,P.h)}`,spark('horas')],
    ['Promedio diario por máquina',md?fmt(A.h/md,1)+' h':'–',`horas de motor en los días que trabajó · ${fmt(act7)} máquinas trabajaron`,''],
    ['Ralentí',A.h?fmt(A.i/A.h*100,0)+' %':'–','motor encendido sin trabajar',spark('ralenti')],
    ['Combustible estimado',A.c?fmt(A.c,0)+' L':'–',A.h&&A.c?fmt(A.c/A.h,1)+' L por hora de motor':'por nivel de tanque u horas de motor',spark('comb')]];
  $('#flKpis').innerHTML=K.slice(0,3).map(([t,v,s,g],i)=>`<div class="fl-k k${i+1}"><div class="fl-kt">${t}</div><div class="fl-kv">${v}</div><div class="fl-ks">${s}</div>${g}</div>`).join('');
  {const tot=A.R.length,w=A.R.filter(r=>r.horas>0).length,u=tot?w/tot*100:null;$('#flGs').textContent=FL.per===1?'hoy':`últimos ${FL.per} días`;
    $('#flGauge').innerHTML=flGauge(u,tot?`${fmt(w)} de ${fmt(tot)} días-máquina con horas`:'se calcula con las lecturas diarias')+`<div class="fl-gx"><div><small>Ralentí</small><b style="color:${A.h&&A.i/A.h>.3?'#FF8A8A':A.h&&A.i/A.h>.2?'#FFD166':'#7CF2B0'}">${A.h?fmt(A.i/A.h*100,0)+' %':'–'}</b></div><div><small>Combustible est. ${FL.per===1?'hoy':FL.per+' días'}</small><b>${A.c?fmt(A.c,0)+' L':'–'}</b></div>${(()=>{const hoy=new Date(Date.now()-4*36e5).toISOString().slice(0,10),pd=new Map();A.R.forEach(r=>pd.set(r.fecha,(pd.get(r.fecha)||0)+flC(r)));const fs=[...pd.keys()].filter(f=>pd.get(f)>0).sort(),ul=fs[fs.length-1],dm=fs.length?fs.reduce((t,f)=>t+pd.get(f),0)/fs.length:0;
      return`<div><small>${ul&&ul!==hoy?'Consumo del '+ul.slice(8,10)+'/'+ul.slice(5,7):'Consumo de hoy'}</small><b>${ul?fmt(pd.get(ul),0)+' L':'–'}</b></div><div><small>Promedio diario</small><b>${fs.length?fmt(dm,0)+' L':'–'}</b><small style="text-transform:none;letter-spacing:0;font-weight:500;margin-top:2px">${fs.length?'en '+fs.length+(fs.length===1?' día':' días')+' con datos':'sin datos todavía'}</small></div>`})()}</div>`}
  const est=['Encendida','Apagada','Reportando','Sin reportar','Sin telemetría'].map(e=>[e,D.maq.filter(m=>flPasa(m,'est')&&flEst(m)===e).length,FL_EC[e]]).filter(x=>x[1]);
  flDonut($('#flEst'),est,FL.f.est,v=>flTog('est',v),fmt(est.reduce((t,x)=>t+x[1],0)),'máquinas');
  const cnt=(k,fn)=>{const g=new Map();D.maq.filter(m=>flPasa(m,k)).forEach(m=>{const v=fn(m);g.set(v,(g.get(v)||0)+1)});return[...g.entries()].sort((a,b)=>b[1]-a[1])};
  flHB($('#flDiv'),cnt('div',flDiv),FL.f.div,v=>flTog('div',v),v=>fmt(v));
  const nd=Math.max(14,FL.per),dd=[];for(let i=nd-1;i>=0;i--){const f=new Date(Date.now()-4*36e5-i*864e5).toISOString().slice(0,10),R=FL.d.dia.filter(r=>ids.has(r.id)&&r.fecha===f);
    const h=R.reduce((t,r)=>t+(r.horas||0),0),ii=R.reduce((t,r)=>t+(r.ralenti||0),0);dd.push({f,t:Math.max(h-ii,0),i:ii,n:R.filter(r=>r.horas>0).length})}
  flCols($('#flDia'),dd);
  const dc=dd.map(d=>{const R=FL.d.dia.filter(r=>ids.has(r.id)&&r.fecha===d.f);return{f:d.f,c:R.reduce((t,r)=>t+flC(r),0),h:d.t+d.i}});flComb($('#flComb'),dc,M);
  const pm=new Map();A.R.forEach(r=>{const o=pm.get(r.id)||{h:0,i:0,c:0};o.h+=r.horas||0;o.i+=r.ralenti||0;o.c+=flC(r);pm.set(r.id,o)});const byId=new Map(D.maq.map(m=>[m.id,m]));
  {const g=new Map(),cn=new Map();D.maq.filter(m=>flPasa(m,'tipo')).forEach(m=>{const t=flTipo(m);cn.set(t,(cn.get(t)||0)+1)});
    FL.d.dia.forEach(r=>{const m=byId.get(r.id);if(!m||!flPasa(m,'tipo'))return;const[a,b]=flRango(0);if(r.fecha<a||r.fecha>b)return;const t=flTipo(m),o=g.get(t)||{h:0,i:0};o.h+=r.horas||0;o.i+=r.ralenti||0;g.set(t,o)});
    const L=[...cn.keys()].map(t=>[t,(g.get(t)||{h:0}).h,(g.get(t)||{i:0}).i,cn.get(t)]).sort((a,b)=>b[1]-a[1]||b[3]-a[3]).slice(0,10),mx=Math.max(...L.map(x=>x[1]),1);
    $('#flTipoCh').innerHTML=L.map(([t,h,i,n])=>`<button class="fl-hb fl-hb2${FL.f.tipo.size&&!FL.f.tipo.has(t)?' dim':''}${FL.f.tipo.has(t)?' on':''}" data-v="${xesc(t)}"><span>${xesc(t)}<small>${fmt(n)} máquinas</small></span><i><em style="width:${h/mx*100}%"></em><em class="r" style="width:${i/mx*100}%"></em></i><b>${h?fmt(h,0)+' h':'–'}<small>${h&&i?'ralentí '+fmt(i/h*100,0)+' %':''}</small></b></button>`).join('')||'<div class="fl-empty">Sin datos</div>';
    $$('#flTipoCh .fl-hb').forEach(e=>e.onclick=()=>flTog('tipo',e.dataset.v))}
  const top=[...pm.entries()].filter(x=>x[1].h>0).sort((a,b)=>b[1].h-a[1].h).slice(0,10);
  $('#flTop').innerHTML=top.length?top.map(([id,o],i)=>{const m=byId.get(id),mx=top[0][1].h,ri=o.h?o.i/o.h:0;return`<div class="fl-tr${FL.sel===id?' sel':''}" data-id="${xesc(id)}"><span class="fl-tn">${i+1}</span><span class="fl-tl"><b>${xesc(m?m.nombre:id)}</b><small>${xesc(m?flTipo(m):'')}</small></span><span class="fl-tb"><i style="width:${o.h/mx*100}%;background:${ri>.3?FLC.sinr:ri>.2?FLC.ral:FLC.off}"></i></span><span class="fl-tv">${fmt(o.h,1)} h<small>${o.i?'ralentí '+fmt(ri*100,0)+' %':''}</small></span></div>`}).join(''):'<div class="fl-empty">Las horas trabajadas aparecen desde la segunda sincronización: cada hora se compara la lectura nueva con la anterior.</div>';
  $$('#flTop .fl-tr').forEach(e=>e.onclick=()=>flSel(e.dataset.id));
  const al=[];M.forEach(m=>{const e=flEst(m);if(e==='Sin reportar')al.push([3,FLC.sinr,'Sin reportar',m,`última señal ${flFecha(flSenal(m))}`]);if(m.comb_pct!=null&&m.comb_pct<20&&e!=='Sin telemetría')al.push([2,FLC.ral,'Tanque bajo',m,`${fmt(m.comb_pct,0)} % de combustible`]);
    if(m.def_pct!=null&&m.def_pct<15)al.push([2,FLC.ral,'DEF bajo',m,`${fmt(m.def_pct,0)} % de DEF`]);const o=pm.get(m.id);if(o&&o.h>=4&&o.i/o.h>.35)al.push([1,FLC.ral,'Ralentí alto',m,`${fmt(o.i/o.h*100,0)} % del tiempo encendida`])});
  al.sort((a,b)=>b[0]-a[0]);$('#flAlN').textContent=al.length;
  $('#flAl').innerHTML=al.length?al.slice(0,40).map(([,c,t,m,d])=>`<div class="fl-al" data-id="${xesc(m.id)}"><i style="background:${c}"></i><span><b>${t}</b> · ${xesc(m.nombre||m.id)}<small>${xesc(flTipo(m))} · ${d}</small></span></div>`).join(''):'<div class="fl-empty">Sin alertas con los filtros actuales.</div>';
  $$('#flAl .fl-al').forEach(e=>e.onclick=()=>flSel(e.dataset.id));
  flExtra(M,ids,A,pm,byId);flTabla(M,pm);flDet()}
/* ---------- visuales SVG ---------- */
function flGauge(v,sub){const W=260,H=160,cx=130,cy=138,R=104,a=t=>Math.PI*(1-t),P=(r,t)=>`${(cx+r*Math.cos(a(t))).toFixed(1)},${(cy-r*Math.sin(a(t))).toFixed(1)}`;
  const seg=(t0,t1,c)=>`<path d="M${P(R,t0)} A${R},${R} 0 0 1 ${P(R,t1)}" stroke="${c}" stroke-width="20" fill="none"/>`;
  const C=[['#E5484D',0,.2],['#F97316',.2,.4],['#F2A900',.4,.6],['#A3E635',.6,.8],['#22C55E',.8,1]];let h=C.map(([c,a0,a1])=>seg(a0+.004,a1-.004,c)).join('');
  for(let i=0;i<=10;i++){const t=i/10;h+=`<line x1="${P(R-16,t).split(',')[0]}" y1="${P(R-16,t).split(',')[1]}" x2="${P(R-22,t).split(',')[0]}" y2="${P(R-22,t).split(',')[1]}" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>`}
  if(v!=null){const t=Math.max(0,Math.min(1,v/100));h+=`<line x1="${cx}" y1="${cy}" x2="${P(R-30,t).split(',')[0]}" y2="${P(R-30,t).split(',')[1]}" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="7" fill="#fff"/>`}
  return`<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:300px">${h}</svg><div style="font-size:44px;font-weight:800;color:#fff;line-height:1;margin-top:-8px">${v==null?'–':fmt(v,0)+'%'}</div><div style="font-size:12px;color:#8EA3B8;margin-top:4px">${sub}</div>`}
function flSpark(v){const W=120,H=30,mx=Math.max(...v,1e-9);if(!v.some(x=>x>0))return'';const p=v.map((x,i)=>`${(i/(v.length-1)*W).toFixed(1)},${(H-2-x/mx*(H-6)).toFixed(1)}`).join(' ');
  return`<svg class="fl-sp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="0,${H} ${p} ${W},${H}" fill="rgba(0,112,201,.12)" stroke="none"/><polyline points="${p}" fill="none" stroke="#0070C9" stroke-width="1.6"/></svg>`}
function flDonut(el,items,S,on,c,sub){const tot=items.reduce((t,x)=>t+x[1],0)||1,R1=74,R0=50,cx=86,cy=86;let a0=-Math.PI/2,h='';
  items.forEach(([t,n,col])=>{const a1=a0+n/tot*Math.PI*2-1e-4,lg=a1-a0>Math.PI?1:0,P=(r,a)=>`${cx+r*Math.cos(a)},${cy+r*Math.sin(a)}`,dim=S.size&&!S.has(t);
    h+=`<path class="fl-hit" data-v="${xesc(t)}" d="M${P(R1,a0)} A${R1},${R1} 0 ${lg} 1 ${P(R1,a1)} L${P(R0,a1)} A${R0},${R0} 0 ${lg} 0 ${P(R0,a0)}Z" fill="${col}" opacity="${dim?.25:1}" stroke="#fff" stroke-width="2"><title>${t}: ${fmt(n)}</title></path>`;a0=a1+1e-4});
  h+=`<text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="26" font-weight="800" fill="#0E2A47">${c}</text><text x="${cx}" y="${cy+21}" text-anchor="middle" font-size="11" fill="#6B7785">${sub}</text>`;
  el.innerHTML=`<svg viewBox="0 0 172 172" class="fl-dn">${h}</svg><div class="fl-lg">${items.map(([t,n,col])=>`<button class="fl-hit${S.size&&!S.has(t)?' dim':''}" data-v="${xesc(t)}"><i style="background:${col}"></i>${t}<b>${fmt(n)}</b><small>${fmt(n/tot*100,0)} %</small></button>`).join('')}</div>`;
  el.querySelectorAll('.fl-hit').forEach(e=>e.onclick=()=>on(e.dataset.v))}
function flHB(el,items,S,on,fv){const mx=Math.max(...items.map(x=>x[1]),1);el.innerHTML=items.length?items.map(([t,v])=>`<button class="fl-hb${S.size&&!S.has(t)?' dim':''}${S.has(t)?' on':''}" data-v="${xesc(t)}"><span>${xesc(t)}</span><i><em style="width:${v/mx*100}%"></em></i><b>${fv(v)}</b></button>`).join(''):'<div class="fl-empty">Sin datos</div>';
  el.querySelectorAll('.fl-hb').forEach(e=>e.onclick=()=>on(e.dataset.v))}
function flCols(el,dd){const W=Math.max(el.clientWidth,320),H=230,L=40,B=28,T=14,mx=Math.max(...dd.map(d=>d.t+d.i),1),bw=(W-L-6)/Math.max(dd.length,1),y=v=>H-B-(H-B-T)*v/mx;let h='';
  niceBreaks(mx,4).forEach(t=>{if(t>mx)return;h+=`<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="#EEF1F5"/><text x="${L-6}" y="${y(t)+4}" font-size="10" text-anchor="end" fill="#6B7785">${fmt(t)}</text>`});
  dd.forEach((d,i)=>{const x=L+i*bw+3,w=Math.max(bw-6,2),ht=(H-B-T)*d.t/mx,hi=(H-B-T)*d.i/mx;
    h+=`<g class="fl-col"><rect x="${x}" y="${y(d.t+d.i)}" width="${w}" height="${hi}" rx="2" fill="${FLC.ral}"/><rect x="${x}" y="${y(d.t)}" width="${w}" height="${ht}" rx="2" fill="#0070C9"/><rect x="${x-3}" y="${T}" width="${bw}" height="${H-B-T}" fill="transparent"><title>${d.f.slice(8,10)}/${d.f.slice(5,7)}: ${fmt(d.t+d.i,1)} h de motor · ${fmt(d.i,1)} h en ralentí · ${d.n} máquinas</title></rect></g>`;
    if(dd.length<=16||i%2===0)h+=`<text x="${x+w/2}" y="${H-B+14}" font-size="10" text-anchor="middle" fill="#6B7785">${+d.f.slice(8,10)}</text>`});
  if(!dd.some(d=>d.t+d.i>0))h+=`<text x="${(L+W)/2}" y="${H/2}" text-anchor="middle" font-size="12" fill="#6B7785">Las horas por día aparecen desde la segunda sincronización</text>`;
  el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${h}</svg><div class="fl-lgh"><span><i style="background:#0070C9"></i>Trabajando</span><span><i style="background:${FLC.ral}"></i>Ralentí</span></div>`}
function flComb(el,dc,M){
  if(!dc.some(d=>d.c>0)){const n=(M||[]).length,a=(M||[]).filter(m=>m.comb!=null||m.comb24!=null).length,t=(M||[]).filter(m=>m.comb_pct!=null).length;
    el.innerHTML=`<div class="fl-empty"><b>Todavía no hay consumo de combustible para mostrar</b><span>Este gráfico suma los litros que gasta la flota cada día. Se estima con la bajada del nivel de tanque o con las horas de motor de cada máquina; aparecerá en cuanto haya horas trabajadas en el período${t?` (${fmt(t)} de ${fmt(n)} máquinas reportan nivel de tanque)`:''}.</span></div>`;return}
  let k=dc.findIndex(d=>d.c>0);k=Math.max(0,Math.min(k,dc.length-7));dc=dc.slice(k);
  const W=Math.max(el.clientWidth,280),H=220,L=44,R=12,B=30,T=22,mx=Math.max(...dc.map(d=>d.c),1)*1.08,bw=(W-L-R)/dc.length,y=v=>H-B-(H-B-T)*v/mx;let h='';
  niceBreaks(mx,4).forEach(t=>{if(t>mx)return;h+=`<line x1="${L}" x2="${W-R}" y1="${y(t)}" y2="${y(t)}" stroke="#1E3247"/><text x="${L-6}" y="${y(t)+4}" font-size="10" text-anchor="end" fill="#7F95AB">${fmt(t)}</text>`});
  dc.forEach((d,i)=>{const x=L+i*bw+bw*.15,w=Math.max(bw*.7,3),lh=d.c>0&&d.h>0?d.c/d.h:null;
    if(d.c>0){h+=`<rect x="${x}" y="${y(d.c)}" width="${w}" height="${H-B-y(d.c)}" rx="3" fill="#1F9D55"><title>${d.f.slice(8,10)}/${d.f.slice(5,7)}: ${fmt(d.c,0)} L${lh!=null?' · '+fmt(lh,1)+' L por hora de motor':''}</title></rect>`;
      if(bw>=30)h+=`<text x="${x+w/2}" y="${y(d.c)-6}" font-size="11" font-weight="700" text-anchor="middle" fill="#E8F0F8">${fmt(d.c,0)}</text>`}
    else h+=`<text x="${x+w/2}" y="${H-B-6}" font-size="10" text-anchor="middle" fill="#4F6378">sin dato</text>`.repeat(bw>=40?1:0);
    const st=Math.ceil((bw>=34?34:20)/bw);if(i%st===0)h+=`<text x="${x+w/2}" y="${H-B+16}" font-size="10" text-anchor="middle" fill="#7F95AB">${+d.f.slice(8,10)}${bw>=34?'/'+(+d.f.slice(5,7)):''}</text>`});
  const C=dc.filter(d=>d.c>0),tot=C.reduce((t,d)=>t+d.c,0),hh=C.reduce((t,d)=>t+d.h,0);
  const ids=new Set((M||[]).map(m=>m.id)),f0=dc[0].f,f1=dc[dc.length-1].f,cm={telemetria:0,tanque:0,horas:0};FL.d.dia.forEach(r=>{if(ids.has(r.id)&&r.fecha>=f0&&r.fecha<=f1&&flC(r)>0)cm[r.comb_met||'telemetria']=(cm[r.comb_met||'telemetria']||0)+flC(r)});const ct=cm.telemetria+cm.tanque+cm.horas||1,pc=v=>fmt(v/ct*100,0)+' %';
  el.innerHTML=`<div class="fl-cres"><div><small>Promedio por día</small><b>${fmt(tot/C.length,0)} L</b></div><div><small>Por hora de motor</small><b>${hh?fmt(tot/hh,1)+' L/h':'–'}</b></div><div><small>Días con datos</small><b>${C.length}</b></div></div><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Litros de combustible por día">${h}</svg><p class="fl-nota">Litros <b>estimados</b>: John Deere no envía el combustible usado de esta flota. ${cm.tanque?`${pc(cm.tanque)} sale de la bajada del nivel de tanque × capacidad del tanque del modelo; `:''}${cm.horas?`${pc(cm.horas)} de las horas de motor × consumo típico del modelo (≈ 0.25 L por kWh a media carga; en ralentí, mucho menos)`:''}${cm.telemetria?`; ${pc(cm.telemetria)} reportado por la telemetría`:''}.</p>`}
/* ---------- utilización, horario, costo del ralentí, servicio y paradas ---------- */
function flExtra(M,ids,A,pm,byId){const D=FL.d,hoy=new Date(Date.now()-4*36e5).toISOString().slice(0,10);
  /* utilización diaria: máquinas con horas / máquinas con lectura ese día */
  const nd=Math.max(14,FL.per),U=[];for(let i=nd-1;i>=0;i--){const f=new Date(Date.now()-4*36e5-i*864e5).toISOString().slice(0,10),R=D.dia.filter(r=>ids.has(r.id)&&r.fecha===f),w=R.filter(r=>r.horas>0).length;U.push({f,v:R.length?w/R.length*100:null,w,n:R.length})}
  {const el=$('#flUti'),W=Math.max(el.clientWidth,300),H=190,L=36,B=26,T=12,bw=(W-L-6)/U.length,y=v=>H-B-(H-B-T)*v/100;let h='';[0,25,50,75,100].forEach(t=>{h+=`<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="#EEF1F5"/><text x="${L-6}" y="${y(t)+4}" font-size="10" text-anchor="end" fill="#6B7785">${t}%</text>`});
    const pts=U.map((u,i)=>u.v==null?null:[L+i*bw+bw/2,y(u.v),u]).filter(Boolean);if(pts.length>1)h+=`<polygon points="${pts[0][0]},${y(0)} ${pts.map(p=>p[0]+','+p[1]).join(' ')} ${pts[pts.length-1][0]},${y(0)}" fill="rgba(0,112,201,.10)"/><polyline points="${pts.map(p=>p[0]+','+p[1]).join(' ')}" fill="none" stroke="#0070C9" stroke-width="2.2"/>`;
    pts.forEach(([x,yy,u])=>{h+=`<circle cx="${x}" cy="${yy}" r="3.4" fill="#fff" stroke="#0070C9" stroke-width="2"><title>${u.f.slice(8,10)}/${u.f.slice(5,7)}: ${fmt(u.v,0)} % · ${u.w} de ${u.n} máquinas trabajaron</title></circle>`});
    U.forEach((u,i)=>{if(U.length<=16||i%2===0)h+=`<text x="${L+i*bw+bw/2}" y="${H-B+14}" font-size="10" text-anchor="middle" fill="#6B7785">${+u.f.slice(8,10)}</text>`});
    if(!pts.some(p=>p[2].w))h+=`<text x="${(L+W)/2}" y="${H/2}" text-anchor="middle" font-size="12" fill="#6B7785">Se llena con las lecturas de cada día</text>`;el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${h}</svg>`}
  /* mapa de calor día × hora con las lecturas horarias */
  if(FL.pos){const G=Array.from({length:7},()=>new Array(24).fill(0)),prev=new Map();FL.pos.forEach(o=>{if(!ids.has(o.id))return;const p=prev.get(o.id);prev.set(o.id,o);if(!p||o.horas==null||p.horas==null)return;const dh=o.horas-p.horas,dt=(new Date(o.ts)-new Date(p.ts))/36e5;if(!(dh>0)||dt<=0||dt>3||dh>dt*1.05+.05)return;
      const t=new Date(new Date(o.ts).getTime()-4*36e5),d=(t.getUTCDay()+6)%7,hr=t.getUTCHours();G[d][hr]+=dh});const mx=Math.max(...G.flat(),1e-9),DS=['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
    $('#flHeat').innerHTML=G.flat().some(v=>v>0)?`<div class="fl-hm"><span></span>${Array.from({length:24},(_,h)=>`<em>${h%3===0?h:''}</em>`).join('')}${G.map((r,d)=>`<span>${DS[d]}</span>${r.map((v,h)=>`<i style="background:${v?`rgba(0,112,201,${(.12+.88*v/mx).toFixed(2)})`:'#EEF2F6'}" title="${DS[d]} ${h}:00 · ${fmt(v,1)} h de motor"></i>`).join('')}`).join('')}</div><div class="fl-lgh" style="margin-top:8px"><span>Más claro = menos horas · más oscuro = más horas de motor en esa hora</span></div>`:'<div class="fl-empty">Se arma con las lecturas de cada hora; en uno o dos días ya se ve el patrón de trabajo de la flota.</div>'}
  else $('#flHeat').innerHTML='<div class="fl-empty">Cargando lecturas por hora…</div>';
  /* costo del ralentí */
  {const ES=new Map(FL.d.maq.map(m=>[m.id,m.espec])),L=A.R.reduce((t,r)=>{const e=ES.get(r.id);return t+Math.min(r.ralenti||0,r.horas||0)*(e?e.lh_ral:2.5)},0),gal=L/3.785,pr=+FL_CFG.pr||0;$('#flCost').innerHTML=A.i?`<div class="fl-big">${fmt(A.i,A.i<10?1:0)} h<small> en ralentí</small></div>
      <div class="fl-cl"><span>Combustible estimado en ralentí</span><b>${fmt(L,0)} L · ${fmt(gal,0)} gal</b><span>Costo estimado</span><b>${pr?'RD$ '+fmt(gal*pr,0):'<a href="#" id="flPrL">pon el precio del gasoil</a>'}</b><span>Ralentí sobre horas de motor</span><b>${fmt(A.h?A.i/A.h*100:0,0)} %</b></div>
      <p class="note" style="margin-top:8px">Estimado con el consumo en ralentí de cada modelo (≈ ${fmt(A.i?L/A.i:0,1)} L/h en promedio: de 1.5 a 3 L/h en tractores y unos 5 L/h en cosechadoras).</p>`:'<div class="fl-empty">El costo se calcula cuando la telemetría reporta horas de ralentí.</div>';
    const pl=$('#flPrL');if(pl)pl.onclick=e=>{e.preventDefault();$('#flCfg').hidden=false;$('#flPr').focus()}}
  /* próximo servicio por horas de motor */
  {const S=+FL_CFG.srv||250,L=M.filter(m=>m.horas!=null&&!m.sin_iso).map(m=>({m,f:S-(m.horas%S)})).filter(x=>x.f<=S*.1).sort((a,b)=>a.f-b.f);$('#flMtN').textContent=L.length;$('#flMtS').textContent=`cada ${fmt(S)} h · faltan ≤ ${fmt(S*.1)} h`;
    $('#flMt').innerHTML=L.length?L.slice(0,40).map(({m,f})=>`<div class="fl-al" data-id="${xesc(m.id)}"><i style="background:${f<=S*.03?FLC.sinr:FLC.ral}"></i><span><b>${xesc(m.nombre||m.id)}</b> · faltan ${fmt(f,0)} h<small>${xesc(flTipo(m))} · ${flH(m.horas)} h · servicio a las ${fmt(Math.ceil(m.horas/S)*S)} h</small></span></div>`).join(''):`<div class="fl-empty">Ninguna máquina a menos de ${fmt(S*.1)} h de su servicio.</div>`}
  /* paradas: reportan, pero sin horas en los últimos 3 días */
  {const lim=new Date(Date.now()-4*36e5-2*864e5).toISOString().slice(0,10),L=M.filter(m=>['Reportando','Apagada','Encendida'].includes(flEst(m))).filter(m=>{const R=D.dia.filter(r=>r.id===m.id&&r.fecha>=lim);return R.length>=2&&!R.some(r=>r.horas>0)});
    $('#flPaN').textContent=L.length;$('#flPa').innerHTML=L.length?L.slice(0,40).map(m=>`<div class="fl-al" data-id="${xesc(m.id)}"><i style="background:${FLC.sint}"></i><span><b>${xesc(m.nombre||m.id)}</b><small>${xesc(flTipo(m))} · ${xesc(flDiv(m))} · ${flH(m.horas)} h</small></span></div>`).join(''):'<div class="fl-empty">Se identifican después de 3 días de lecturas.</div>'}
  $$('#flMt .fl-al,#flPa .fl-al').forEach(e=>e.onclick=()=>flSel(e.dataset.id))}
/* ---------- mapa (ya no se muestra en el tablero; se conserva por si se usa en Avance de cosecha) ---------- */
function flMapa(cv,T){const W=T?T.W:Math.max(cv.parentElement.clientWidth,500),H=Math.round(W*.66),dpr=T?1:(window.devicePixelRatio||1);cv.width=W*dpr;cv.height=H*dpr;if(!T)cv.style.height=H+'px';
  const ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#F4F7FA';ctx.fillRect(0,0,W,H);const F={x:0,y:0,w:W,h:H},clip=EMBED_LAYERS.mask,UT=(lo,la)=>llToUtm(lo,la);
  let bb=bboxPts(polyPts(clip).map(q=>UT(q[0],q[1])));const pd=Math.max(bb[2]-bb[0],bb[3]-bb[1])*.04;bb=[bb[0]-pd,bb[1]-pd,bb[2]+pd,bb[3]+pd];
  let sc=Math.min(F.w/(bb[2]-bb[0]),F.h/(bb[3]-bb[1])),cx=(bb[0]+bb[2])/2,cy=(bb[1]+bb[3])/2;{const v=aplicaZoom(FL.zm,F,{sc,cx,cy,bb});sc=v.sc;cx=v.cx;cy=v.cy}
  const toPx=(E,N)=>[F.x+F.w/2+(E-cx)*sc,F.y+F.h/2-(N-cy)*sc],toE=(x,y)=>[cx+(x-F.x-F.w/2)/sc,cy-(y-F.y-F.h/2)/sc],px=(lo,la)=>toPx(...UT(lo,la));
  const ring=r=>{let x0,y0;r.forEach((q,i)=>{const[x,y]=px(q[0],q[1]);if(i)ctx.lineTo(x,y);else{ctx.moveTo(x,y);x0=x;y0=y}});ctx.lineTo(x0,y0)},path=Pl=>{ctx.beginPath();for(const p of Pl)for(const r of p)ring(r)};
  EMBED_LAYERS.divs.forEach(d=>{path(d.polys);ctx.fillStyle=FL.f.div.has(d.name)?'#DCEBFA':'#FFFFFF';ctx.fill('evenodd')});
  if(FL.zm.z>2.5){ctx.beginPath();EMBED_PIECES.forEach(p=>ring(p[3]));ctx.strokeStyle='rgba(140,155,170,.35)';ctx.lineWidth=.5;ctx.stroke()}
  EMBED_LAYERS.divs.forEach(d=>{path(d.polys);ctx.strokeStyle='#B6C2CF';ctx.lineWidth=1.1;ctx.stroke()});path(clip);ctx.strokeStyle='#5B6B7C';ctx.lineWidth=1.4;ctx.stroke();
  ctx.font='700 11px Inter,Arial';ctx.textAlign='center';EMBED_LAYERS.divs.forEach(d=>{const[x,y]=px(d.lab[0],d.lab[1]);ctx.fillStyle='#9AA8B6';ctx.fillText(d.name.toUpperCase(),x,y)});
  const pts=[];FL.d.maq.forEach(m=>{if(m.lat==null||m.lon==null)return;const ok=flPasa(m),[x,y]=px(m.lon,m.lat),c=FL_EC[flEst(m)],cos=/cosech/i.test(flTipo(m)),s=FL.sel===m.id;pts.push({m,x,y});
    ctx.globalAlpha=ok?1:.15;ctx.beginPath();if(cos)ctx.rect(x-6,y-6,12,12);else ctx.arc(x,y,5.5,0,7);ctx.fillStyle=c;ctx.fill();ctx.lineWidth=s?3:1.6;ctx.strokeStyle=s?'#0E2A47':'#fff';ctx.stroke();
    if(ok&&(s||FL.zm.z>2.2)){ctx.font='600 11px Inter,Arial';ctx.textAlign='left';ctx.lineWidth=3;ctx.strokeStyle='rgba(255,255,255,.95)';ctx.strokeText(m.nombre||'',x+9,y+4);ctx.fillStyle='#0E2A47';ctx.fillText(m.nombre||'',x+9,y+4)}ctx.globalAlpha=1});
  if(!T){FL.view={toPx,toE,px,F,sc};FL.pts=pts}}
/* ---------- tabla ---------- */
function flTabla(M,pm){const o=FL.orden,val={nombre:m=>m.nombre||'',tipo:flTipo,div:flDiv,est:flEst,hacum:m=>m.horas??-1,h:m=>(pm.get(m.id)||{}).h||0,ral:m=>{const x=pm.get(m.id);return x&&x.h?x.i/x.h:-1},tq:m=>m.comb_pct??-1,senal:m=>+(flSenal(m)||0)};
  const L=M.slice().sort((a,b)=>{const x=val[o.k](a),y=val[o.k](b);return(x>y?1:x<y?-1:0)*o.d}),mxh=Math.max(...M.map(m=>(pm.get(m.id)||{}).h||0),1);
  const th=(k,t,n)=>`<th class="${n?'n':''}" data-k="${k}">${t}${o.k===k?(o.d>0?' ▲':' ▼'):''}</th>`;
  $('#flTbl').innerHTML=`<thead><tr>${th('nombre','Máquina')}${th('tipo','Tipo')}${th('div','División')}${th('est','Estado')}${th('hacum','Horas acum.',1)}${th('h','Horas periodo',1)}${th('ral','Ralentí',1)}${th('tq','Tanque',1)}${th('senal','Última señal')}</tr></thead><tbody>`+
    L.map(m=>{const x=pm.get(m.id)||{h:0,i:0},e=flEst(m),ri=x.h&&x.i?x.i/x.h:null;return`<tr data-id="${xesc(m.id)}" class="${FL.sel===m.id?'sel':''}"><td><b>${xesc(m.nombre||m.id)}</b><small>${xesc(m.modelo||'')} · ${xesc(m.pin||m.serie||'')}</small></td><td>${xesc(flTipo(m))}</td><td>${xesc(flDiv(m))}${m._fuera?`<small>en tránsito · a ${fmt(m._fuera/1000,1)} km</small>`:''}</td>
      <td><span class="fl-pill" style="--c:${FL_EC[e]}">${e}</span></td><td class="n">${flH(m.horas)}</td><td class="n"><span class="fl-db"><i style="width:${x.h/mxh*100}%"></i><b>${x.h?fmt(x.h,1):'–'}</b></span></td>
      <td class="n" style="${ri>.3?'color:#C62828;font-weight:700':''}">${ri==null?'–':fmt(ri*100,0)+' %'}</td><td class="n">${m.comb_pct==null?'–':`<span class="fl-tq"><i style="width:${m.comb_pct}%;background:${m.comb_pct<20?FLC.sinr:m.comb_pct<40?FLC.ral:FLC.on}"></i></span>${fmt(m.comb_pct,0)} %`}</td><td>${flFecha(flSenal(m))}</td></tr>`}).join('')+'</tbody>';
  $$('#flTbl th').forEach(t=>t.onclick=()=>{const k=t.dataset.k;FL.orden=o.k===k?{k,d:-o.d}:{k,d:k==='nombre'||k==='tipo'||k==='div'?1:-1};flDraw()});
  $$('#flTbl tbody tr').forEach(r=>r.onclick=()=>flSel(r.dataset.id));$('#flTn').textContent=fmt(L.length)}
/* ---------- máquina seleccionada ---------- */
function flSel(id){FL.sel=FL.sel===id?null:id;flDraw();
  if(FL.sel)$('#flDet').scrollIntoView({behavior:'smooth',block:'nearest'})}
function flDet(){const el=$('#flDet'),m=FL.sel&&FL.d.maq.find(x=>x.id===FL.sel);if(!m){el.hidden=true;return}el.hidden=false;const e=flEst(m),R=FL.d.dia.filter(r=>r.id===m.id).sort((a,b)=>a.fecha<b.fecha?-1:1).slice(-30);
  const dd=R.map(r=>({f:r.fecha,t:Math.max((r.horas||0)-(r.ralenti||0),0),i:r.ralenti||0,n:1}));
  el.innerHTML=`<div class="fl-dh"><div><span class="fl-pill" style="--c:${FL_EC[e]}">${e}</span><h3>${xesc(m.nombre||m.id)}</h3><small>${xesc(flTipo(m))} · ${xesc(m.marca||'')} ${xesc(m.modelo||'')} · ${xesc(m.pin||m.serie||'')} · ${xesc(flDiv(m))}</small></div><button class="fl-x" id="flDx" title="Cerrar">✕</button></div>
    <div class="fl-dk"><div><small>Horas de motor</small><b>${flH(m.horas)}</b></div><div><small>Ralentí acumulado</small><b>${flH(m.ralenti)}</b></div>${m.espec?`<div><small>Consumo típico (${m.espec.fuente==='ficha'?m.espec.mod+' · '+m.espec.hp+' hp':'clase ~'+m.espec.hp+' hp'})</small><b>${fmt(m.espec.lh,1)} L/h</b></div>`:''}<div><small>Tanque</small><b>${m.comb_pct==null?'–':fmt(m.comb_pct,0)+' %'}</b></div><div><small>DEF</small><b>${m.def_pct==null?'–':fmt(m.def_pct,0)+' %'}</b></div><div><small>Combustible acumulado</small><b>${m.comb==null?'–':fmt(m.comb,0)+' '+(m.comb_u||'L')}</b></div><div><small>Última señal</small><b style="font-size:14px">${flFecha(flSenal(m))}</b></div></div>
    <div id="flDch"></div>`;flCols($('#flDch'),dd);$('#flDx').onclick=()=>{FL.sel=null;flDraw()}}
function flInit(){if(flInit.ok)return;flInit.ok=true;
  const flQset=v=>{$('#flQ').value=v;FL.q=v;$('#flQx').hidden=!v;flDraw()};$('#flQ').oninput=()=>flQset($('#flQ').value);$('#flQ').onkeydown=e=>{if(e.key==='Escape')flQset('')};$('#flQx').onclick=()=>{flQset('');$('#flQ').focus()};
  $('#flCfgB').onclick=()=>{$('#flCfg').hidden=!$('#flCfg').hidden};$('#flPr').value=FL_CFG.pr||'';$('#flIdl').value=FL_CFG.idl;$('#flSrv').value=FL_CFG.srv;
  ['flPr','flIdl','flSrv'].forEach(id=>$('#'+id).onchange=()=>{const v=x=>{x=parseFloat(String(x).replace(',','.'));return isFinite(x)&&x>0?x:null};FL_CFG.pr=v($('#flPr').value);FL_CFG.idl=v($('#flIdl').value)||3;FL_CFG.srv=v($('#flSrv').value)||250;
    try{localStorage.setItem('agroap-fl-cfg',JSON.stringify(FL_CFG))}catch(e){}flDraw()});
  $$('#flPer button').forEach(b=>b.onclick=()=>{FL.per=+b.dataset.d;$$('#flPer button').forEach(x=>x.classList.toggle('on',x===b));flDraw()});
  $('#flSync').onclick=async()=>{const b=$('#flSync');b.disabled=true;b.classList.add('spin');$('#flSt').textContent='Sincronizando con John Deere…';
    try{const r=await fetch('/api/flota/sync',{method:'POST'});const j=await r.json();if(!j.ok)throw new Error(j.error||'falló la sincronización');await flCargar()}catch(e){$('#flSt').innerHTML=`<span class="fl-err">${xesc(e.message)}</span>`}finally{b.disabled=false;b.classList.remove('spin')}};
  let rt;addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(()=>{if($('#s-flota').classList.contains('on'))flDraw()},150)});
  setInterval(()=>{if($('#s-flota').classList.contains('on')&&!document.hidden)flCargar()},10*60e3)}
function flShow(){flInit();if(FL.d)flDraw();flCargar()}
