/* ================= AVANCE DE COSECHA =================
   Une dos fuentes:  · Piezas terminadas (última quincena cargada en Cosecha): piezas con fecha de fin de corte.
                     · Cosechadoras John Deere (posición cada hora): piezas donde hay cosechadora trabajando ahora = "en cosecha".
   El mapa "se alumbra" a medida que se terminan piezas; con la línea de tiempo se puede reproducir el avance de la zafra. */
const AV={rows:null,q:null,pos:null,maq:null,fecha:null,min:null,max:null,div:'',zm:{z:1},view:null,play:null,enCos:new Map(),cargando:false};
const AV_C={old:'#1B5E20',mid:'#43A047',new:'#C6F432',cos:'#FF9F1C',none:'#E4E9EF'};
const avK=(d,t,p)=>`${+d}|${String(+t)}|${+p}`;
const avDays=(a,b)=>(Date.UTC(+b.slice(0,4),+b.slice(5,7)-1,+b.slice(8,10))-Date.UTC(+a.slice(0,4),+a.slice(5,7)-1,+a.slice(8,10)))/864e5;
const avAdd=(f,n)=>new Date(Date.UTC(+f.slice(0,4),+f.slice(5,7)-1,+f.slice(8,10))+n*864e5).toISOString().slice(0,10);
async function avCargar(){if(AV.cargando)return;AV.cargando=true;$('#avSt').textContent='Cargando…';
  try{for(let t=0;t<200&&!CO.listo;t++)await new Promise(r=>setTimeout(r,50));
    const q=coOrden()[0];if(q){AV.q=q;const rows=await coCargar(q);AV.rows=new Map();rows.forEach(r=>{if(!r.ffin&&!r.fin)return;AV.rows.set(avK(r.div,r.tab,r.pz),{...coCalc(r),k:avK(r.div,r.tab,r.pz)})})}
    try{const[a,b]=await Promise.all([fetch('/api/flota?dias=3',{cache:'no-store'}),fetch('/api/flota/pos?dias=3',{cache:'no-store'})]);if(a.ok&&b.ok){AV.maq=(await a.json()).maq;AV.pos=await b.json()}}catch(e){}
    avEnCosecha();const F=[...(AV.rows||new Map()).values()].map(r=>r.ffin).filter(Boolean).sort();AV.min=F[0]||hoyISO().slice(0,10);AV.max=hoyISO().slice(0,10);if(!AV.fecha)AV.fecha=AV.max;
    $('#avT').max=Math.max(0,avDays(AV.min,AV.max));$('#avT').value=avDays(AV.min,AV.fecha);avDraw()}
  catch(e){$('#avSt').innerHTML=`<span class="fl-err">${xesc(e.message||e)}</span>`}finally{AV.cargando=false}}
/* piezas con cosechadora trabajando (horas de motor subieron entre lecturas) en las últimas 48 h */
function avEnCosecha(){AV.enCos=new Map();if(!AV.maq||!AV.pos)return;const cos=new Set(AV.maq.filter(m=>/cosech/i.test(flTipo(m))).map(m=>m.id)),nm=new Map(AV.maq.map(m=>[m.id,m.nombre||m.id]));
  const lim=new Date(Date.now()-48*36e5).toISOString(),prev=new Map(),idx=new Map(),cell=.01;
  EMBED_PIECES.forEach(p=>{let a=1e9,b=1e9,c=-1e9,d=-1e9;p[3].forEach(q=>{a=Math.min(a,q[0]);c=Math.max(c,q[0]);b=Math.min(b,q[1]);d=Math.max(d,q[1])});p._bb=[a,b,c,d];
    for(let x=Math.floor(a/cell);x<=Math.floor(c/cell);x++)for(let y=Math.floor(b/cell);y<=Math.floor(d/cell);y++){const k=x+','+y;if(!idx.has(k))idx.set(k,[]);idx.get(k).push(p)}});
  AV.pos.forEach(o=>{if(!cos.has(o.id))return;const p0=prev.get(o.id);prev.set(o.id,o);if(o.ts<lim||!p0||o.horas==null||p0.horas==null||!(o.horas>p0.horas))return;
    const L=idx.get(Math.floor(o.lon/cell)+','+Math.floor(o.lat/cell))||[];const pz=L.find(p=>o.lon>=p._bb[0]&&o.lon<=p._bb[2]&&o.lat>=p._bb[1]&&o.lat<=p._bb[3]&&pip(o.lon,o.lat,[[p[3]]]));if(!pz)return;
    const k=avK(pz[0],pz[1],pz[2]),e=AV.enCos.get(k)||{maq:new Set(),ult:''};e.maq.add(nm.get(o.id));if(o.ts>e.ult)e.ult=o.ts;AV.enCos.set(k,e)})}
function avEstado(k){const r=AV.rows&&AV.rows.get(k);if(r&&r.ffin&&r.ffin<=AV.fecha)return'term';if(AV.fecha===AV.max&&AV.enCos.has(k))return'cos';if(r&&r.fin&&r.fin<=AV.fecha&&(!r.ffin||r.ffin>AV.fecha))return'cos';return''}
function avColor(k){const e=avEstado(k);if(e==='cos')return AV_C.cos;if(e!=='term')return null;const r=AV.rows.get(k),d=avDays(r.ffin,AV.fecha);return d<=3?AV_C.new:d<=14?AV_C.mid:AV_C.old}
function avDraw(){if(!$('#s-avance').classList.contains('on'))return;const hayQ=!!AV.q;
  $('#avSt').innerHTML=(hayQ?`Piezas terminadas: quincena ${AV.q.n} · zafra ${xesc(AV.q.zafra||'')} (hasta ${coDF(AV.q.fecha)})`:'Todavía no hay quincenas cargadas en Piezas terminadas')+` · ${AV.maq?`cosechadoras en vivo: ${fmt(AV.maq.filter(m=>/cosech/i.test(flTipo(m))).length)}`:'sin datos de la flota'}`;
  $('#avFecha').textContent=AV.fecha===AV.max?'Hoy':coDF(AV.fecha);
  /* totales */
  const tot=new Map(),hech=new Map(),cos=new Map();let ac=0,acT=0,ton=0,nT=0,acC=0,nC=0;const sem=new Map();
  SU_PZ.forEach((o,k)=>{const d=+k.split('|')[0];if(!d||!DIVN[d]||(AV.div&&d!==+AV.div))return;tot.set(d,(tot.get(d)||0)+o.ac);acT+=o.ac;const e=avEstado(k),r=AV.rows&&AV.rows.get(k);
    if(e==='term'){const a=r&&r.acR>0?r.acR:o.ac;hech.set(d,(hech.get(d)||0)+a);ac+=a;nT++;ton+=r&&r.ton>0?r.ton:0;const w=avAdd(r.ffin,-((new Date(r.ffin+'T12:00:00Z').getUTCDay()+6)%7));sem.set(w,(sem.get(w)||0)+a)}
    else if(e==='cos'){cos.set(d,(cos.get(d)||0)+o.ac);acC+=o.ac;nC++}});
  const trab=AV.maq?new Set([...AV.enCos.values()].flatMap(e=>[...e.maq])).size:0;
  const K=[['Acres cosechados',fmt(ac,0),`${fmt(nT)} piezas terminadas`],['Avance',acT?fmt(ac/acT*100,1)+' %':'–',`del área total (${fmt(acT,0)} acres)`],['Toneladas',ton?fmt(ton,0):'–',ac&&ton?`${fmt(ton/ac,1)} TCA`:'caña molida'],
    ['En cosecha ahora',fmt(nC),`${fmt(acC,0)} acres · ${fmt(trab)} cosechadoras trabajando`]];
  $('#avKpis').innerHTML=K.map(([t,v,s],i)=>`<div class="fl-k${i===3?' warn':''}"><div class="fl-kt">${t}</div><div class="fl-kv">${v}</div><div class="fl-ks">${s}</div></div>`).join('');
  $('#avDivs').innerHTML=[...tot.entries()].sort((a,b)=>a[0]-b[0]).map(([d,t])=>{const h=hech.get(d)||0,c=cos.get(d)||0;return`<button class="av-dv${AV.div==d?' on':''}" data-d="${d}"><span><b>${xesc(DIVN[d]||'Div. '+d)}</b><small>${fmt(h,0)} de ${fmt(t,0)} acres${c?` · ${fmt(c,0)} en cosecha`:''}</small></span><i><em style="width:${h/t*100}%"></em><em class="c" style="left:${h/t*100}%;width:${c/t*100}%"></em></i><strong>${fmt(h/t*100,1)} %</strong></button>`}).join('');
  $$('#avDivs .av-dv').forEach(b=>b.onclick=()=>{AV.div=AV.div==b.dataset.d?'':b.dataset.d;const im=$('#avMap')._im;if(im)im.hl=null;avDraw()});
  const S=[...sem.entries()].sort((a,b)=>a[0]<b[0]?-1:1).slice(-16);avSem($('#avSem'),S);
  const L=[...AV.enCos.entries()].filter(([k])=>!AV.div||+k.split('|')[0]===+AV.div).sort((a,b)=>a[1].ult<b[1].ult?1:-1);
  $('#avCos').innerHTML=L.length?L.slice(0,30).map(([k,e])=>{const[d,t,p]=k.split('|');return`<div class="fl-al" data-k="${k}"><i style="background:${AV_C.cos}"></i><span><b>${xesc(DIVN[d]||d)} · Tablón ${t} · Pieza ${p}</b><small>${xesc([...e.maq].join(', '))} · ${flFecha(new Date(e.ult))}</small></span></div>`}).join(''):`<div class="fl-empty">${AV.maq?'Ninguna cosechadora trabajando dentro de una pieza en las últimas 48 h.':'Conecta la flota John Deere para ver qué piezas se están cosechando ahora.'}</div>`;
  $$('#avCos .fl-al').forEach(e=>e.onclick=()=>avIr(e.dataset.k));
  avMapa()}
function avSem(el,S){const W=Math.max(el.clientWidth,280),H=190,L=44,B=26,T=12,mx=Math.max(...S.map(x=>x[1]),1),bw=(W-L-4)/Math.max(S.length,1),y=v=>H-B-(H-B-T)*v/mx;let h='';
  niceBreaks(mx,4).forEach(t=>{if(t>mx)return;h+=`<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="#EEF1F5"/><text x="${L-6}" y="${y(t)+4}" font-size="10" text-anchor="end" fill="#6B7785">${fmt(t)}</text>`});
  S.forEach(([w,v],i)=>{const x=L+i*bw+3,bwi=Math.max(bw-6,2);h+=`<rect x="${x}" y="${y(v)}" width="${bwi}" height="${(H-B-T)*v/mx}" rx="2" fill="${i===S.length-1?'#7CB342':'#2E7D32'}"><title>Semana del ${coDF(w)}: ${fmt(v,0)} acres</title></rect><text x="${x+bwi/2}" y="${H-B+13}" font-size="9.5" text-anchor="middle" fill="#6B7785">${w.slice(8,10)}/${w.slice(5,7)}</text>`});
  if(!S.length)h+=`<text x="${(L+W)/2}" y="${H/2}" text-anchor="middle" font-size="12" fill="#6B7785">Sin piezas terminadas en el periodo</text>`;el.innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${h}</svg>`}
/* mapa: imap (acercar/alejar, mover, satélite) + buscador de tablón que lo delimita y rotula */
function avMapa(){const cv=$('#avMap'),nuevo=!cv._im,im=imap(cv,{maxH:680,bg:'#0F2338'});
  if(nuevo){imBuscar(im,()=>AV.div?EMBED_PIECES.filter(p=>p[0]===+AV.div):EMBED_PIECES);
    im.draw=v=>{const ctx=v.ctx,ring=r=>{r.forEach((q,i)=>{const[x,y]=v.px(q[0],q[1]);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.closePath()},zr=im.home?v.scale/im.home.sc:1,poly=P=>{ctx.beginPath();P.forEach(p=>p.forEach(ring))};
      if(!v.sat){ctx.fillStyle='#0F2338';ctx.fillRect(0,0,v.W,v.H);poly(EMBED_LAYERS.mask);ctx.fillStyle='#16324F';ctx.fill('evenodd')}
      const g=new Map();EMBED_PIECES.forEach((p,i)=>{if(!v.vis(i))return;const c=avColor(avK(p[0],p[1],p[2]))||'';if(!g.has(c))g.set(c,[]);g.get(c).push(p[3])});
      g.forEach((rs,c)=>{if(!c){if(v.sat)return;c='#294A6B'}ctx.beginPath();rs.forEach(ring);if(c===AV_C.new||c===AV_C.cos){ctx.shadowColor=c;ctx.shadowBlur=10}ctx.globalAlpha=v.sat?.82:1;ctx.fillStyle=c;ctx.fill();ctx.shadowBlur=0;ctx.globalAlpha=1});
      ctx.beginPath();EMBED_PIECES.forEach((p,i)=>{if(v.vis(i))ring(p[3])});ctx.strokeStyle=v.sat?'rgba(255,255,255,.5)':'rgba(15,35,56,.55)';ctx.lineWidth=Math.min(1.2,.3*Math.sqrt(zr));ctx.stroke();
      EMBED_LAYERS.divs.forEach(d=>{const on=AV.div&&d.name===DIVN[AV.div];poly(d.polys);ctx.strokeStyle=on?'#FFFFFF':'rgba(255,255,255,.55)';ctx.lineWidth=on?2.4:1.3;ctx.stroke()});
      ctx.textAlign='center';ctx.textBaseline='alphabetic';
      if(zr>7&&!im.hl){ctx.font='700 10.5px Inter,Arial';const vis=new Map();EMBED_PIECES.forEach((p,i)=>{if(!v.vis(i))return;const k=p[0]+'|'+p[1];if(!vis.has(k))vis.set(k,[]);vis.get(k).push(p)});
        vis.forEach(L=>{const b=bboxPts(L.flatMap(p=>p[3])),[x,y]=v.px((b[0]+b[2])/2,(b[1]+b[3])/2);if(x<0||y<0||x>v.W||y>v.H)return;ctx.lineWidth=3;ctx.strokeStyle='rgba(15,35,56,.85)';ctx.strokeText(L[0][1],x,y);ctx.fillStyle='#fff';ctx.fillText(L[0][1],x,y)})}
      else if(zr<=7){ctx.font='800 12px Inter,Arial';EMBED_LAYERS.divs.forEach(d=>{const[x,y]=v.px(d.lab[0],d.lab[1]);ctx.lineWidth=3;ctx.strokeStyle='rgba(15,35,56,.85)';ctx.strokeText(d.name.toUpperCase(),x,y);ctx.fillStyle='#E8F0F8';ctx.fillText(d.name.toUpperCase(),x,y)});
        if(EMBED_LAYERS.kalil){const b=bboxPts(EMBED_LAYERS.kalil.flatMap(p=>p[0])),[x,y]=v.px((b[0]+b[2])/2,b[3]);ctx.font='700 10.5px Inter,Arial';ctx.lineWidth=3;ctx.strokeText('KALIL HACHE',x,y-5);ctx.fillStyle='#E8F0F8';ctx.fillText('KALIL HACHE',x,y-5)}}
      if(AV.maq&&AV.fecha===AV.max)AV.maq.filter(m=>/cosech/i.test(flTipo(m))&&m.lat!=null).forEach(m=>{const[x,y]=v.px(m.lon,m.lat),ok=flEst(m)!=='Sin reportar';ctx.beginPath();ctx.rect(x-5,y-5,10,10);ctx.fillStyle=ok?'#FFFFFF':'#8FA3B8';ctx.fill();ctx.lineWidth=2;ctx.strokeStyle=ok?AV_C.cos:'#5B6B7C';ctx.stroke();
        if(zr>3){ctx.font='700 11px Inter,Arial';ctx.textAlign='left';ctx.lineWidth=3;ctx.strokeStyle='rgba(15,35,56,.85)';ctx.strokeText(m.nombre||'',x+8,y+4);ctx.fillStyle='#fff';ctx.fillText(m.nombre||'',x+8,y+4);ctx.textAlign='center'}})}}
  const sel=AV.div?EMBED_PIECES.filter(p=>p[0]===+AV.div):[],bb=bboxPts(sel.length?sel.flatMap(p=>p[3]):EMBED_LAYERS.mask.flatMap(p=>p[0])),key=AV.div||'all';
  if(AV.vkey!==key&&im.fit(bb,im.H||undefined))AV.vkey=key;
  im.render()}
function avIr(k){const[d,t,p]=k.split('|'),L=EMBED_PIECES.filter(q=>q[0]===+d&&String(q[1])===t&&+q[2]===+p),im=$('#avMap')._im;if(!L.length||!im||!im.buscar)return;
  im.buscar(L,`${DIVN[d]||'Div. '+d} · Tablón ${t} · Pieza ${p}`);$('#avMap').scrollIntoView({behavior:'smooth',block:'center'})}
function avInit(){if(avInit.ok)return;avInit.ok=true;
  const set=v=>{AV.fecha=avAdd(AV.min,+v);if(AV.fecha>AV.max)AV.fecha=AV.max;avDraw()};
  $('#avT').oninput=e=>set(e.target.value);
  $('#avPlay').onclick=()=>{if(AV.play){clearInterval(AV.play);AV.play=null;$('#avPlay').textContent='▶ Reproducir zafra';return}
    let v=+$('#avT').value>=+$('#avT').max?0:+$('#avT').value;$('#avPlay').textContent='❚❚ Pausar';const paso=Math.max(1,Math.round(+$('#avT').max/90));
    AV.play=setInterval(()=>{v=Math.min(v+paso,+$('#avT').max);$('#avT').value=v;set(v);if(v>=+$('#avT').max){clearInterval(AV.play);AV.play=null;$('#avPlay').textContent='▶ Reproducir zafra'}},120)};
  $('#avHoy').onclick=()=>{$('#avT').value=$('#avT').max;set($('#avT').max)};
  $('#avMap').addEventListener('click',e=>{const im=$('#avMap')._im;if(!im||!im.v)return;const r=e.target.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,[lon,lat]=im.v.geo(x,y),pi=pieceAt(lon,lat),hit=pi<0||(AV.div&&EMBED_PIECES[pi][0]!==+AV.div)?null:EMBED_PIECES[pi];
    const t=$('#avTip');if(!hit){t.style.display='none';return}const k=avK(hit[0],hit[1],hit[2]),r2=AV.rows&&AV.rows.get(k),e2=avEstado(k),c=AV.enCos.get(k),o=SU_PZ.get(k);
    t.innerHTML=`<b>${xesc(DIVN[hit[0]]||'')} · Tablón ${hit[1]} · Pieza ${hit[2]}</b><br>${e2==='term'?`<span style="color:#2E7D32;font-weight:700">● Terminada el ${coDF(r2.ffin)}</span>`:e2==='cos'?`<span style="color:#C77700;font-weight:700">● En cosecha</span>`:'Sin cosechar'}<br>${fmt(r2&&r2.acR>0?r2.acR:(o?o.ac:0),1)} acres${r2&&r2.ton>0?` · ${fmt(r2.ton,0)} t · ${fmt(r2.tca,1)} TCA`:''}${r2&&r2.var?`<br>Variedad ${xesc(r2.var)}`:''}${c?`<br><small>${xesc([...c.maq].join(', '))} · ${flFecha(new Date(c.ult))}</small>`:''}`;
    t.style.left=Math.min(x+12,r.width-250)+'px';t.style.top=(y+12)+'px';t.style.display='block'});
  let rt;addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(()=>{if($('#s-avance').classList.contains('on'))avDraw()},150)});
  setInterval(()=>{if($('#s-avance').classList.contains('on')&&!document.hidden&&!AV.play)avCargar()},15*60e3)}
function avShow(){avInit();if(AV.rows||AV.maq)avDraw();avCargar()}
