/* ================= RIEGO · BALANCE HÍDRICO (beta) ================= */
/* Balance hídrico diario del suelo por pieza (método FAO-56, coeficiente simple):
     Dr(i) = Dr(i-1) − P(i) − I(i) + ETc(i)        con 0 ≤ Dr ≤ ADT
     ETc   = Ks · Kc · ETo
   Dr = agotamiento de la zona de raíces (mm), P = lluvia, I = riego aplicado, ETo = evapotranspiración de referencia,
   Kc = coeficiente del cultivo según la edad de la caña (días desde el inicio del ciclo en NAX), Ks = estrés hídrico,
   ADT = agua disponible total = CAD × Zr, AFA = p × ADT (agua fácilmente aprovechable).
   Lluvia: pluviómetros de AgroAP-CR (promedio de la división ese día); si la división no tiene lectura ese día, lluvia del modelo
   meteorológico (Open-Meteo). ETo y pronóstico de 7 días: Open-Meteo (FAO Penman-Monteith), en el centro de cada división. */
const RG_DEF={cad:140,zr0:0.3,zrMax:1.2,p:0.65,kcIni:0.40,kcMid:1.25,kcEnd:0.75,lIni:30,lDev:90,lMid:180,lLate:65,dias:90,vig:60,cadDiv:{}};
const RG={par:null,clima:null,climaErr:null,cargando:false,res:null,div:'',reg:'1',un:'in',riego:new Map(),ej:''};
const RG_COL={ok:'#2E7D32',vig:'#F2A900',reg:'#C62828',sin:'#E6E9ED'};
try{RG.par={...RG_DEF,...JSON.parse(localStorage.getItem('geocr-riego-par')||'{}')}}catch(e){RG.par={...RG_DEF}}
try{RG.un=localStorage.getItem('geocr-riego-un')||'in'}catch(e){}
const rgDivBase=d=>String(d||'').replace(/\s*\((R|S)\)\s*$/,'').trim();
const rgL=mm=>RG.un==='in'?mm/25.4:mm, rgU=()=>RG.un==='in'?'in':'mm', rgF=(mm,d)=>isFinite(mm)?fmt(rgL(mm),d==null?(RG.un==='in'?2:0):d):'–';
const rgISO=t=>new Date(t).toISOString().slice(0,10), rgHoy=()=>{const d=new Date();return Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())};
/* Kc y profundidad de raíces según la edad (días desde el inicio del ciclo) */
function rgKc(e,P){if(!isFinite(e))return{kc:P.kcMid,zr:P.zrMax,et:'sin fecha'};const a=P.lIni,b=a+P.lDev,c=b+P.lMid,d=c+P.lLate;
  const zr=Math.min(P.zrMax,P.zr0+(P.zrMax-P.zr0)*Math.max(0,e)/Math.max(1,b));
  if(e<a)return{kc:P.kcIni,zr,et:'inicial'};if(e<b)return{kc:P.kcIni+(P.kcMid-P.kcIni)*(e-a)/P.lDev,zr,et:'desarrollo'};
  if(e<c)return{kc:P.kcMid,zr,et:'máximo desarrollo'};if(e<d)return{kc:P.kcMid+(P.kcEnd-P.kcMid)*(e-c)/P.lLate,zr,et:'maduración'};return{kc:P.kcEnd,zr,et:'maduración'}}
/* centro de cada división (para pedir el clima) */
function rgDivs(){return EMBED_LAYERS.divs.map(d=>({name:d.name,lon:d.lab[0],lat:d.lab[1]}))}
/* clima: ETo y lluvia del modelo, 92 días atrás + 7 de pronóstico, una sola consulta para las 7 divisiones */
async function rgClima(force){const k='geocr-riego-clima';if(!force){try{const c=JSON.parse(sessionStorage.getItem(k)||'null');if(c&&Date.now()-c.t<3*3600e3){RG.clima=c;return c}}catch(e){}}
  const D=rgDivs(),u=`https://api.open-meteo.com/v1/forecast?latitude=${D.map(d=>d.lat.toFixed(4)).join(',')}&longitude=${D.map(d=>d.lon.toFixed(4)).join(',')}&daily=et0_fao_evapotranspiration,precipitation_sum&past_days=92&forecast_days=7&timezone=America%2FSanto_Domingo`;
  const r=await fetch(u);if(!r.ok)throw new Error('El servicio de clima respondió '+r.status);let j=await r.json();if(!Array.isArray(j))j=[j];
  const c={t:Date.now(),fuente:'Open-Meteo (FAO Penman-Monteith)',divs:{}};D.forEach((d,i)=>{const x=j[i]&&j[i].daily;if(!x)return;c.divs[d.name]={f:x.time,eto:x.et0_fao_evapotranspiration,p:x.precipitation_sum}});
  try{sessionStorage.setItem(k,JSON.stringify(c))}catch(e){}RG.clima=c;return c}
/* lluvia diaria de los pluviómetros por división (pulgadas → mm) */
function rgLluviaPluv(){const m=new Map();if(typeof R==='undefined'||!R.recs)return m;const gd=new Map([...R.gauges.values()].map(g=>[g.id,g.div]));
  R.recs.forEach(r=>{if(r.src!=='dia'||r.s!==r.e)return;const dv=gd.get(r.p);if(!dv||!isFinite(r.v))return;const k=dv+'|'+r.s;if(!m.has(k))m.set(k,[]);m.get(k).push(r.v*25.4)});
  const o=new Map();m.forEach((a,k)=>o.set(k,a.reduce((s,x)=>s+x,0)/a.length));return o}
/* riego aplicado: Map clave(div|tab|pz o div|tab|*) → Map(fecha → mm) */
function rgRiegoDe(p,f){const a=RG.riego.get(rgDivBase(p.div)+'|'+(+p.tab)+'|'+(+p.pz)),b=RG.riego.get(rgDivBase(p.div)+'|'+(+p.tab)+'|*');return((a&&a.get(f))||0)+((b&&b.get(f))||0)}
/* corre el balance de todas las piezas */
function rgCorrer(){if(!NX||!NX.P||!RG.clima)return null;const P=RG.par,C=RG.clima,hoy=rgHoy(),hoyS=rgISO(hoy),pl=rgLluviaPluv();
  const dias={};let usoPl=0,totPl=0;
  Object.entries(C.divs).forEach(([dv,c])=>{const L=[];c.f.forEach((f,i)=>{const t=Date.parse(f);if(t<hoy-P.dias*864e5)return;const fut=f>hoyS,kp=pl.get(dv+'|'+f);
      let p=+c.p[i]||0,src='modelo';if(!fut&&kp!==undefined){p=kp;src='pluviómetro';usoPl++}if(!fut)totPl++;L.push({f,eto:+c.eto[i]||0,p,src,fut})});dias[dv]=L});
  const out=[],serie={};
  NX.P.forEach(p=>{const dv=rgDivBase(p.div),L=dias[dv];if(!L||!L.length)return;const cad=+(P.cadDiv[dv]||P.cad),fi=p.fi?Date.parse(p.fi):NaN;
    let Dr=0,hoyR=null,dUmb=null,et30=0,p30=0,i30=0;const tr=[];
    L.forEach(d=>{const e=(Date.parse(d.f)-fi)/864e5,k=rgKc(e,P),TAW=cad*k.zr,RAW=P.p*TAW,I=d.fut?0:rgRiegoDe(p,d.f);
      const Ks=Dr>RAW?Math.max(0,(TAW-Dr)/((1-P.p)*TAW)):1,ETc=Ks*k.kc*d.eto;Dr=Math.min(TAW,Math.max(0,Dr-d.p-I+ETc));
      const ad=100*(1-Dr/TAW);if(!d.fut&&Date.parse(d.f)>hoy-30*864e5){et30+=ETc;p30+=d.p;i30+=I}
      if(d.f<=hoyS)hoyR={f:d.f,Dr,TAW,RAW,ad,kc:k.kc,zr:k.zr,et:k.et,e,ks:Ks};else if(dUmb===null&&Dr>=RAW)dUmb=Math.round((Date.parse(d.f)-hoy)/864e5);
      tr.push({f:d.f,fut:d.fut,p:d.p,src:d.src,I,eto:d.eto,kc:k.kc,ks:Ks,etc:ETc,Dr,TAW,RAW,ad})});
    if(!hoyR)return;if(hoyR.Dr>=hoyR.RAW)dUmb=0;
    const est=hoyR.Dr>=hoyR.RAW?'reg':hoyR.ad<P.vig?'vig':'ok';
    out.push({p,dv,ac:+p.ac||0,reg:p.reg===1||/\(R\)/.test(p.div),...hoyR,est,dUmb,et30,p30,i30,hum:p.hum,tr});
    const sk=dv;if(!serie[sk])serie[sk]=new Map();tr.forEach(t=>{const s=serie[sk].get(t.f)||{f:t.f,fut:t.fut,p:t.p,src:t.src,w:0,ad:0,I:0,etc:0,eto:t.eto};const w=+p.ac||1;s.w+=w;s.ad+=t.ad*w;s.I+=t.I*w;s.etc+=t.etc*w;serie[sk].set(t.f,s)})});
  return{out,serie,usoPl,totPl,hoy:hoyS,fecha:new Date().toISOString()}}
/* ---------- dibujo ---------- */
function rgEstadoTxt(o){return o.est==='reg'?(o.reg?'Regar':'Estrés'):o.est==='vig'?'Vigilar':'Adecuada'}
async function rgDraw(force){const st=$('#rgSt');if(!$('#s-riego'))return;if(DB&&!RG.sub)rgRiegoCargas();
  if(!NX||!NX.P){$('#rgBody').style.display='none';$('#rgEmpty').style.display='';$('#rgEmpty').innerHTML='Para calcular el balance hace falta el reporte NAX publicado (edad del cultivo, riego/secano y área de cada pieza). Se toma del Monitoreo NAX en cuanto esté disponible.';return}
  if(!RG.clima||force){if(RG.cargando)return;RG.cargando=true;st.textContent='Consultando el clima (ETo y pronóstico)…';
    try{await rgClima(force);RG.climaErr=null}catch(e){RG.climaErr=e.message||String(e)}finally{RG.cargando=false}}
  if(!RG.clima){$('#rgBody').style.display='none';$('#rgEmpty').style.display='';$('#rgEmpty').innerHTML=`No se pudo consultar el clima (${RG.climaErr||'sin conexión'}). El balance necesita la ETo diaria; revisa la conexión y vuelve a intentar. <button class="btn sec" onclick="rgDraw(true)">Reintentar</button>`;st.textContent='';return}
  RG.res=rgCorrer();const S=RG.res;if(!S||!S.out.length){$('#rgEmpty').style.display='';$('#rgEmpty').textContent='No hay piezas con datos suficientes para el balance.';$('#rgBody').style.display='none';return}
  $('#rgEmpty').style.display='none';$('#rgBody').style.display='';
  const pct=S.totPl?S.usoPl/S.totPl*100:0;
  st.innerHTML=`Balance al ${coDF?coDF(S.hoy):S.hoy} · ETo y pronóstico: ${RG.clima.fuente}, consultado ${new Date(RG.clima.t).toLocaleString('es-DO',{dateStyle:'short',timeStyle:'short'})} · lluvia de pluviómetros en ${fmt(pct,0)} % de los días-división (el resto, lluvia del modelo) · edad y régimen: reporte NAX del ${NX.hoy?coDF(NX.hoy):''}`;
  const dv=RG.div,F=S.out.filter(o=>(!dv||o.dv===dv)&&(RG.reg===''||(RG.reg==='1')===o.reg)),A=sumBy(F,o=>o.ac)||1;
  const wav=f=>sumBy(F,o=>f(o)*o.ac)/A,un=rgU();
  const regA=sumBy(F.filter(o=>o.est==='reg'),o=>o.ac),vigA=sumBy(F.filter(o=>o.est==='vig'),o=>o.ac),p30=wav(o=>o.p30),e30=wav(o=>o.et30),i30=wav(o=>o.i30),bal=p30+i30-e30;
  const prox=sumBy(F.filter(o=>o.est!=='reg'&&o.dUmb!==null&&o.dUmb<=7),o=>o.ac);
  $('#rgK').innerHTML=[['Lluvia 30 días',rgF(p30)+' '+un,'promedio ponderado por área'],['ETc 30 días',rgF(e30)+' '+un,`consumo del cultivo · ETo ${rgF(wav(o=>o.tr.filter(t=>!t.fut).slice(-30).reduce((s,t)=>s+t.eto,0)))} ${un}`],
    ['Balance 30 días',(bal>=0?'+':'')+rgF(bal)+' '+un,`lluvia${i30>0?' + riego':''} − ETc`],
    [RG.reg==='0'?'Acres en estrés hoy':'Acres para regar hoy',fmt(regA),`${fmt(regA/A*100,0)} % del área · ${fmt(vigA)} ac en vigilar`],['Llegan al umbral en 7 días',fmt(prox),'acres, según el pronóstico']]
    .map(([t,v,s],i)=>`<div class="kpi"><small>${t}</small><div style="${i===2?`color:${bal<0?'#C62828':'#2E7D32'}`:i===3&&regA>0?'color:#C62828':''}">${v}</div><em>${s}</em></div>`).join('');
  /* mapa */
  const col=new Map(),info=new Map();S.out.forEach(o=>{const rs=keyMatch(String(o.p.id).padStart(11,'0'))||keyMatch(o.p.id)||[];const c=(!dv||o.dv===dv)&&(RG.reg===''||(RG.reg==='1')===o.reg)?RG_COL[o.est]:'#F3F4F6';rs.forEach(i=>{col.set(i,c);info.set(i,o)})});
  dashMap('rg',col);RG.tip=ri=>{const o=info.get(ri);if(!o)return'';return`${o.reg?'Riego (R)':'Secano (S)'} · edad ${isFinite(o.e)?fmt(o.e/30.44,1)+' meses':'s/d'} · Kc ${fmt(o.kc,2)}<br>Agua disponible <b>${fmt(o.ad,0)} %</b> · déficit ${rgF(o.Dr)} ${rgU()} de ${rgF(o.TAW)} · <b style="color:${RG_COL[o.est]}">${rgEstadoTxt(o)}</b>${o.dUmb!==null&&o.est!=='reg'?`<br>Llega al umbral en ${o.dUmb} días`:''}${o.hum!=null?`<br>Humedad NAX ${fmt(o.hum,1)} %`:''}`};
  $('#rgLeg').innerHTML=[[RG_COL.ok,`Adecuada (≥ ${RG.par.vig} % de agua disponible)`],[RG_COL.vig,'Vigilar'],[RG_COL.reg,`Regar / estrés (por debajo del umbral ${fmt((1-RG.par.p)*100,0)} %)`],['#F3F4F6','Fuera del filtro']].map(([c,t])=>`<span><i style="background:${c}"></i>${t}</span>`).join('');
  rgChart();rgTabla(F);rgValid(F);rgEjemplo()}
function rgChart(){const S=RG.res,sel=$('#rgChDiv');const ds=Object.keys(S.serie).sort((a,b)=>(LR_DIVC[a]||9)-(LR_DIVC[b]||9));if(!sel.options.length||sel.dataset.n!==ds.join()){sel.innerHTML=ds.map(d=>`<option>${d}</option>`).join('');sel.dataset.n=ds.join();sel.value=RG.div&&ds.includes(RG.div)?RG.div:(ds.includes('Higueral')?'Higueral':ds[0])}
  const L=[...S.serie[sel.value].values()].sort((a,b)=>a.f<b.f?-1:1).slice(-67).map(s=>({...s,ad:s.ad/s.w,I:s.I/s.w,etc:s.etc/s.w}));
  const svg=svgEl('rgCh'),H=280,W=svgSize(svg,H),Lm=44,Rm=40,B=30,Tp=12,n=L.length,gw=(W-Lm-Rm)/n,mxP=Math.max(10,...L.map(s=>s.p+s.I))*1.1,thr=(1-RG.par.p)*100;
  const yA=v=>Tp+(H-B-Tp)*(1-v/100),yP=v=>H-B-(H-B-Tp)*v/mxP;let h='';
  const fi=L.findIndex(s=>s.fut);if(fi>=0)h+=`<rect x="${Lm+fi*gw}" y="${Tp}" width="${(n-fi)*gw}" height="${H-B-Tp}" fill="#F2F5F9"/><text x="${Lm+fi*gw+4}" y="${Tp+12}" font-size="10" fill="#5B6673">pronóstico</text>`;
  [0,25,50,75,100].forEach(v=>{h+=`<line x1="${Lm}" x2="${W-Rm}" y1="${yA(v)}" y2="${yA(v)}" stroke="#EEF1F5"/><text x="${Lm-6}" y="${yA(v)+4}" font-size="10" text-anchor="end" fill="#0E2A47">${v}%</text>`});
  niceBreaks(rgL(mxP),4).forEach(v=>{const y=H-B-(H-B-Tp)*(RG.un==='in'?v*25.4:v)/mxP;if(y<Tp)return;h+=`<text x="${W-Rm+6}" y="${y+4}" font-size="10" fill="#0070C9">${fmt(v,RG.un==='in'?1:0)}</text>`});
  L.forEach((s,i)=>{const x=Lm+i*gw;if(s.p>0)h+=`<rect x="${x+gw*.15}" y="${yP(s.p)}" width="${gw*.7}" height="${H-B-yP(s.p)}" fill="${s.src==='pluviómetro'?'#0070C9':'#85B4DF'}"><title>${s.f}: lluvia ${rgF(s.p)} ${rgU()} (${s.src})</title></rect>`;
    if(s.I>0.05)h+=`<rect x="${x+gw*.15}" y="${yP(s.p+s.I)}" width="${gw*.7}" height="${yP(s.p)-yP(s.p+s.I)}" fill="#2E7D32"><title>${s.f}: riego ${rgF(s.I)} ${rgU()}</title></rect>`;
    if(i%7===0)h+=`<text x="${x+gw/2}" y="${H-B+14}" font-size="10" text-anchor="middle" fill="#5B6673">${s.f.slice(8,10)}/${s.f.slice(5,7)}</text>`});
  h+=`<line x1="${Lm}" x2="${W-Rm}" y1="${yA(thr)}" y2="${yA(thr)}" stroke="#C62828" stroke-dasharray="5 4"/><text x="${Lm+4}" y="${yA(thr)+13}" font-size="10" fill="#C62828">umbral ${fmt(thr,0)} %</text>`;
  h+=`<path d="${L.map((s,i)=>(i?'L':'M')+(Lm+i*gw+gw/2)+' '+yA(s.ad)).join('')}" fill="none" stroke="#0E2A47" stroke-width="2.5"/>`;
  $('#rgChLeg').innerHTML=`<span><i style="background:#0E2A47;height:3px"></i>Agua disponible (% de ADT)</span><span><i style="background:#0070C9"></i>Lluvia pluviómetro</span><span><i style="background:#85B4DF"></i>Lluvia modelo</span><span><i style="background:#2E7D32"></i>Riego</span><span><i style="background:#C62828;height:2px"></i>Umbral de riego</span><span class="note">eje derecho: lluvia y riego (${rgU()})</span>`;
  svg.innerHTML=h}
function rgAgr(F){const g=new Map();F.forEach(o=>{const k=o.dv+'|'+(+o.p.tab);if(!g.has(k))g.set(k,[]);g.get(k).push(o)});
  return[...g.values()].map(a=>{const A=sumBy(a,o=>o.ac)||a.length,w=f=>sumBy(a,o=>f(o)*(o.ac||1))/A,ds=a.map(o=>o.dUmb).filter(x=>x!==null);
    const est=a.some(o=>o.est==='reg')?(sumBy(a.filter(o=>o.est==='reg'),o=>o.ac)/A>=.3?'reg':'vig'):a.some(o=>o.est==='vig')?'vig':'ok';
    return{dv:a[0].dv,tab:+a[0].p.tab,reg:a[0].reg,ac:sumBy(a,o=>o.ac),n:a.length,e:w(o=>isFinite(o.e)?o.e:0),kc:w(o=>o.kc),ad:w(o=>o.ad),Dr:w(o=>o.Dr),TAW:w(o=>o.TAW),dUmb:ds.length?Math.min(...ds):null,hum:(()=>{const h=a.filter(o=>o.hum!=null);return h.length?sumBy(h,o=>o.hum*(o.ac||1))/(sumBy(h,o=>o.ac||1)):null})(),est,ps:a}})}
function rgTabla(F){const T=rgAgr(F).sort((a,b)=>(a.dUmb??99)-(b.dUmb??99)||a.ad-b.ad);RG.tabla=T;const un=rgU(),reg=RG.reg!=='0';
  $('#rgTblT').textContent=reg?'Prioridad de riego por tablón':'Tablones con más estrés hídrico';
  $('#rgTbl').innerHTML=`<tr><th>Tablón</th><th>División</th><th class="n">Acres</th><th class="n">Edad (meses)</th><th class="n">Kc</th><th class="n">Agua disp.</th><th class="n">Déficit (${un})</th><th class="n">Días al umbral</th>${reg?`<th class="n">Lámina a aplicar (${un})</th><th class="n">Volumen (m³)</th>`:''}<th class="n">Humedad NAX</th><th>Estado</th></tr>`+
    T.slice(0,60).map(t=>`<tr><td><b>${t.tab}</b></td><td>${t.dv} ${t.reg?'(R)':'(S)'}</td><td class="n">${fmt(t.ac,1)}</td><td class="n">${t.e?fmt(t.e/30.44,1):'–'}</td><td class="n">${fmt(t.kc,2)}</td><td class="n" style="font-weight:700;color:${RG_COL[t.est]}">${fmt(t.ad,0)} %</td><td class="n">${rgF(t.Dr)}</td><td class="n">${t.dUmb===0?'<b style="color:#C62828">hoy</b>':t.dUmb===null?'> 7':t.dUmb}</td>${reg?`<td class="n">${t.est!=='ok'?rgF(t.Dr):'–'}</td><td class="n">${t.est!=='ok'?fmt(t.Dr/1000*t.ac*4046.86,0):'–'}</td>`:''}<td class="n">${t.hum!=null?fmt(t.hum,1)+' %':'–'}</td><td>${chip(rgEstadoTxtT(t),RG_COL[t.est])}</td></tr>`).join('')+(T.length>60?`<tr><td colspan="12" class="note">… y ${T.length-60} tablones más en el Excel.</td></tr>`:'')}
const rgEstadoTxtT=t=>t.est==='reg'?(t.reg?'Regar':'Estrés'):t.est==='vig'?'Vigilar':'Adecuada';
/* contraste con la humedad NAX (validación de la beta) */
function rgValid(F){const g={ok:[],vig:[],reg:[]};F.forEach(o=>{if(o.hum!=null&&isFinite(o.hum))g[o.est].push(o.hum)});const m=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;
  const xs=F.filter(o=>o.hum!=null&&isFinite(o.hum)),n=xs.length;let r=NaN;if(n>10){const mx=m(xs.map(o=>o.ad)),my=m(xs.map(o=>o.hum));let a=0,b=0,c=0;xs.forEach(o=>{a+=(o.ad-mx)*(o.hum-my);b+=(o.ad-mx)**2;c+=(o.hum-my)**2});r=a/Math.sqrt(b*c)}
  $('#rgVal').innerHTML=`<table><tr><th>Estado del balance</th><th class="n">Piezas con humedad NAX</th><th class="n">Humedad NAX promedio</th></tr>${[['ok','Adecuada'],['vig','Vigilar'],['reg',RG.reg==='0'?'Estrés':'Regar']].map(([k,t])=>`<tr><td>${chip(t,RG_COL[k])}</td><td class="n">${fmt(g[k].length)}</td><td class="n">${isFinite(m(g[k]))?fmt(m(g[k]),1)+' %':'–'}</td></tr>`).join('')}</table>
  <p class="note">Si el balance va bien, la humedad satelital de NAX debería bajar de "Adecuada" a "${RG.reg==='0'?'Estrés':'Regar'}". Correlación entre agua disponible del balance y humedad NAX: <b>${isFinite(r)?fmt(r,2):'–'}</b> (${fmt(n)} piezas). Es una señal de coherencia, no una calibración: el sensor mide los primeros centímetros del suelo y el balance toda la zona de raíces.</p>`}
/* ejemplo trabajado: un tablón, últimos 10 días, todos los términos de la ecuación */
function rgEjemplo(){const box=$('#rgEj');if(!box||!RG.res)return;const inp=$('#rgEjTab');let T=RG.res.out;
  const q=(inp.value||'').trim();let a=q?T.filter(o=>String(+o.p.tab)===String(+q.split('-')[0])&&(!q.includes('-')||String(+o.p.pz)===String(+q.split('-')[1]))):[];
  if(!a.length){a=[T.filter(o=>o.reg).sort((x,y)=>y.ac-x.ac)[0]||T[0]];if(!q)inp.placeholder=`p. ej. ${+a[0].p.tab}-${+a[0].p.pz}`}
  const o=a.sort((x,y)=>y.ac-x.ac)[0],P=RG.par,un=rgU(),rows=o.tr.filter(t=>!t.fut).slice(-10);
  box.innerHTML=`<p><b>Tablón ${+o.p.tab}, pieza ${+o.p.pz} · ${o.dv} ${o.reg?'(R)':'(S)'}</b> · ${fmt(o.ac,1)} acres · inicio del ciclo ${o.p.fi?coDF(o.p.fi):'sin fecha'} → edad ${isFinite(o.e)?fmt(o.e,0)+' días':'s/d'} (etapa ${rgKc(o.e,P).et}) · Zr = ${fmt(o.zr,2)} m · CAD = ${fmt(+(P.cadDiv[o.dv]||P.cad),0)} mm/m → <b>ADT = ${fmt(o.TAW,0)} mm</b>, <b>AFA = ${fmt(P.p,2)} × ADT = ${fmt(o.TAW*P.p,0)} mm</b></p>
  <div class="rgx"><table><tr><th>Fecha</th><th class="n">P lluvia (mm)</th><th>Fuente</th><th class="n">I riego (mm)</th><th class="n">ETo (mm)</th><th class="n">Kc</th><th class="n">Ks</th><th class="n">ETc = Ks·Kc·ETo</th><th class="n">Dr (mm)</th><th class="n">Agua disp.</th></tr>
  ${rows.map(t=>`<tr><td>${coDF(t.f)}</td><td class="n">${fmt(t.p,1)}</td><td>${t.src}</td><td class="n">${fmt(t.I,1)}</td><td class="n">${fmt(t.eto,2)}</td><td class="n">${fmt(t.kc,2)}</td><td class="n">${fmt(t.ks,2)}</td><td class="n">${fmt(t.etc,2)}</td><td class="n"><b>${fmt(t.Dr,1)}</b></td><td class="n" style="color:${t.Dr>=t.RAW?RG_COL.reg:t.ad<P.vig?'#B07800':RG_COL.ok};font-weight:700">${fmt(t.ad,0)} %</td></tr>`).join('')}</table></div>
  <p class="note">Cada fila aplica Dr(hoy) = Dr(ayer) − P − I + ETc, con Dr entre 0 (suelo a capacidad de campo; el exceso se pierde por drenaje o escorrentía) y ADT. Ks baja de 1 cuando Dr pasa la AFA: el cultivo cierra estomas y consume menos.</p>`}
/* ---------- riego aplicado ---------- */
function rgRiegoIndex(L){const m=new Map();L.forEach(c=>(c.filas||[]).forEach(([f,dv,tab,pz,mm])=>{const k=dv+'|'+(+tab)+'|'+(pz===''||pz==null?'*':+pz);if(!m.has(k))m.set(k,new Map());const x=m.get(k);x.set(f,(x.get(f)||0)+mm)}));RG.riego=m}
function rgRiegoSet(L){const k=JSON.stringify(L.map(c=>c.id));RG.cargas=L;rgRiegoIndex(L);if($('#rgCargas'))rgRiegoLista();if(RG.ck!==undefined&&RG.ck!==k&&RG.clima){RG.res=null;if($('#s-riego').classList.contains('on')||location.hash.startsWith('#riego'))rgDraw()}RG.ck=k}
async function rgRiegoCargas(){if(DB){if(!RG.sub){RG.sub=true;DB.collection('riego_aplicado').orderBy('fecha','desc').limit(300).onSnapshot(s=>rgRiegoSet(s.docs.map(d=>({id:d.id,...d.data()}))),()=>{})}return}
  let L=[];try{L=JSON.parse(localStorage.getItem('geocr-riego-apl')||'[]')}catch(e){}rgRiegoSet(L)}
function rgRiegoLista(){const L=RG.cargas||[];$('#rgCargas').innerHTML=L.length?`<table><tr><th>Archivo</th><th>Fechas</th><th class="n">Filas</th><th class="n">Lámina media</th><th></th></tr>${L.map(c=>{const fs=(c.filas||[]).map(r=>r[0]).sort();return`<tr><td>${c.archivo||'—'}</td><td>${fs.length?coDF(fs[0])+' – '+coDF(fs.at(-1)):'—'}</td><td class="n">${fmt((c.filas||[]).length)}</td><td class="n">${rgF(coAvg((c.filas||[]).map(r=>r[4])))} ${rgU()}</td><td><button class="xdel" title="Eliminar" onclick="rgRiegoBorrar('${c.id}',this)">✕</button></td></tr>`}).join('')}</table>`:'<p class="note">Todavía no se ha cargado riego aplicado: el balance asume que no se regó.</p>'}
async function rgRiegoBorrar(id,b){if(!await askConfirm('¿Desea eliminar el elemento seleccionado?','Se quitará ese archivo de riego aplicado y el balance se recalculará sin él.'))return;try{if(DB){await DB.collection('riego_aplicado').doc(id).delete();rgRiegoSet((RG.cargas||[]).filter(c=>c.id!==id))}else localStorage.setItem('geocr-riego-apl',JSON.stringify((RG.cargas||[]).filter(c=>c.id!==id)))}catch(e){$('#rgRSt').textContent='No se pudo eliminar: '+e.message;return}await rgRiegoCargas();RG.res=null;if(RG.clima)rgDraw()}
async function rgRiegoLeer(f){let rows;if(/\.(xlsx|xls)$/i.test(f.name)){const wb=XLSX.read(await f.arrayBuffer(),{type:'array',cellDates:true});rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,defval:''})}
  else{const c=nxCSV(await f.text());rows=[c.h,...c.rows]}const H=rows.shift().map(h=>String(h).trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,''));
  const ix=(...ns)=>H.findIndex(h=>ns.some(n=>h===n||h.startsWith(n)));const iF=ix('FECHA'),iD=ix('DIVISION','DIV'),iT=ix('TABLON','TAB'),iP=ix('PIEZA','PZ'),iMM=ix('LAMINA_MM','MM','LAMINA (MM)'),iIN=ix('LAMINA_IN','PULGADAS','IN','LAMINA (IN)'),iL=ix('LAMINA');
  if(iF<0||iT<0||iD<0||(iMM<0&&iIN<0&&iL<0))throw new Error('Faltan columnas: FECHA, DIVISION, TABLON y LAMINA_MM o LAMINA_IN (PIEZA es opcional).');
  const fF=v=>{if(v instanceof Date)return rgISO(Date.UTC(v.getFullYear(),v.getMonth(),v.getDate()));if(typeof v==='number')return rgISO(Date.UTC(1899,11,30)+v*864e5);return coFecha(v)};
  const fD=v=>{const t=String(v).trim();if(/^\d+$/.test(t))return DIVN[+t]||null;const n=t.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();return Object.values(DIVN).find(d=>d.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()===n)||null};
  const out=[],mal=[];rows.forEach((r,i)=>{const f=fF(r[iF]),dv=fD(r[iD]),tab=parseInt(r[iT]),pz=iP>=0&&String(r[iP]).trim()!==''?parseInt(r[iP]):'';let mm=iMM>=0?coN(r[iMM]):iIN>=0?coN(r[iIN])*25.4:coN(r[iL]);
    if(iMM<0&&iIN<0&&iL>=0&&!/MM/.test(H[iL]))mm=mm*25.4;if(!f||!dv||!isFinite(tab)||!(mm>0)){if(r.some(x=>String(x).trim()!==''))mal.push(i+2);return}out.push([f,dv,tab,pz,+mm.toFixed(2)])});
  return{out,mal}}
function rgInit(){
  $('#rgDiv').innerHTML='<option value="">Todas</option>'+Object.values(DIVN).map(d=>`<option>${d}</option>`).join('');
  $('#rgDiv').onchange=e=>{RG.div=e.target.value;if(RG.div)$('#rgChDiv').value=RG.div;rgDraw()};$('#rgReg').value=RG.reg;$('#rgReg').onchange=e=>{RG.reg=e.target.value;rgDraw()};
  $('#rgUn').value=RG.un;$('#rgUn').onchange=e=>{RG.un=e.target.value;try{localStorage.setItem('geocr-riego-un',RG.un)}catch(x){}rgDraw()};
  $('#rgChDiv').onchange=()=>rgChart();$('#rgRef').onclick=()=>rgDraw(true);$('#rgEjTab').onchange=()=>rgEjemplo();
  $('#rgMap').addEventListener('click',e=>dashTip('rg',e,ri=>RG.tip?RG.tip(ri):''));
  $('#rgXls').onclick=()=>{if(!RG.tabla)return;const un=rgU(),wb=XLSX.utils.book_new(),T=RG.tabla;
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Tablón','División','Régimen','Acres','Edad (meses)','Kc','Agua disponible %',`Déficit (${un})`,`ADT (${un})`,'Días al umbral',`Lámina a aplicar (${un})`,'Volumen (m3)','Humedad NAX %','Estado'],
      ...T.map(t=>[t.tab,t.dv,t.reg?'R':'S',+t.ac.toFixed(2),t.e?+(t.e/30.44).toFixed(1):'',+t.kc.toFixed(2),+t.ad.toFixed(1),+rgL(t.Dr).toFixed(2),+rgL(t.TAW).toFixed(2),t.dUmb===null?'>7':t.dUmb,t.est!=='ok'&&t.reg?+rgL(t.Dr).toFixed(2):'',t.est!=='ok'&&t.reg?Math.round(t.Dr/1000*t.ac*4046.86):'',t.hum!=null?+t.hum.toFixed(1):'',rgEstadoTxtT(t)])]),'Tablones');
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['ID','Tablón','Pieza','División','Régimen','Acres','Inicio ciclo','Edad (días)','Kc','Zr (m)',`ADT (${un})`,`AFA (${un})`,`Dr (${un})`,'Agua disponible %','Días al umbral','Estado'],
      ...RG.res.out.map(o=>[o.p.id,+o.p.tab,+o.p.pz,o.dv,o.reg?'R':'S',o.ac,o.p.fi||'',isFinite(o.e)?Math.round(o.e):'',+o.kc.toFixed(2),+o.zr.toFixed(2),+rgL(o.TAW).toFixed(2),+rgL(o.RAW).toFixed(2),+rgL(o.Dr).toFixed(2),+o.ad.toFixed(1),o.dUmb===null?'>7':o.dUmb,rgEstadoTxt(o)])]),'Piezas');
    saveFile(`Balance_hidrico_${RG.res.hoy}.xlsx`,new Blob([XLSX.write(wb,{type:'array',bookType:'xlsx'})],{type:'application/octet-stream'}),$('#rgSt2'))};
  $('#rgFile').onchange=async e=>{const f=e.target.files[0],st=$('#rgRSt');if(!f)return;try{const{out,mal}=await rgRiegoLeer(f);if(!out.length)throw new Error('No encontré filas válidas.');
      const doc={archivo:f.name,fecha:new Date().toISOString(),filas:out};if(DB){const id='r'+Date.now();await DB.collection('riego_aplicado').doc(id).set(doc);rgRiegoSet([{id,...doc},...(RG.cargas||[])])}else{const L=JSON.parse(localStorage.getItem('geocr-riego-apl')||'[]');L.unshift({id:'r'+Date.now(),...doc});localStorage.setItem('geocr-riego-apl',JSON.stringify(L))}
      st.className='status';st.textContent=`${out.length} riegos cargados${mal.length?` · ${mal.length} filas ignoradas (por ejemplo la ${mal.slice(0,3).join(', ')})`:''}.`;e.target.value='';await rgRiegoCargas();RG.res=null}catch(err){st.className='status err';st.textContent=err.message}};
  $('#rgParSave').onclick=()=>{const P={...RG.par};$$('#rgPar [data-k]').forEach(x=>{const v=parseFloat(x.value);if(isFinite(v))P[x.dataset.k]=v});P.cadDiv={};$$('#rgPar [data-cd]').forEach(x=>{const v=parseFloat(x.value);if(isFinite(v)&&v>0)P.cadDiv[x.dataset.cd]=v});
    RG.par=P;try{localStorage.setItem('geocr-riego-par',JSON.stringify(P))}catch(e){}RG.res=null;$('#rgParSt').textContent='Parámetros guardados en este navegador. El balance se recalcula con ellos.'};
  $('#rgParDef').onclick=()=>{RG.par={...RG_DEF,cadDiv:{}};try{localStorage.removeItem('geocr-riego-par')}catch(e){}rgParForm();RG.res=null;$('#rgParSt').textContent='Valores de referencia restablecidos.'};
  rgRiegoCargas()}
function rgParForm(){const P=RG.par,f=(k,t,u,st)=>`<label>${t}<span class="note"> ${u}</span></label><input type="number" step="${st||'any'}" data-k="${k}" value="${P[k]}">`;
  $('#rgPar').innerHTML=`<div class="rgpar">${f('cad','Capacidad de agua disponible del suelo (CAD)','mm por m de suelo',1)}${f('zrMax','Profundidad máxima de raíces (Zr)','m',0.05)}${f('zr0','Profundidad de raíces al inicio','m',0.05)}${f('p','Fracción de agotamiento sin estrés (p)','0–1',0.05)}${f('vig','Pasa a "Vigilar" por debajo de','% de agua disponible',1)}${f('dias','Días de historia del balance','máx. 92',1)}
    ${f('kcIni','Kc inicial','',0.05)}${f('kcMid','Kc de máximo desarrollo','',0.05)}${f('kcEnd','Kc de maduración','',0.05)}${f('lIni','Etapa inicial','días',1)}${f('lDev','Etapa de desarrollo','días',1)}${f('lMid','Etapa de máximo desarrollo','días',1)}${f('lLate','Etapa de maduración','días',1)}</div>
    <h3 style="margin:16px 0 6px;font-size:14px">CAD por división <span class="note">(vacío = valor general)</span></h3><div class="rgpar">${Object.values(DIVN).map(d=>`<label>${d}</label><input type="number" step="1" data-cd="${d}" value="${P.cadDiv[d]||''}" placeholder="${P.cad}">`).join('')}</div>`}
function rgMetodo(){const P=RG.par,v=(x,d)=>`<b>${fmt(x,d==null?2:d)}</b>`;
  $$('#riego-met [data-pv]').forEach(e=>{const k=e.dataset.pv;e.innerHTML=k==='raw'?fmt((1-P.p)*100,0)+' %':k==='taw'?fmt(P.cad*P.zrMax,0)+' mm':k==='afa'?fmt(P.cad*P.zrMax*P.p,0)+' mm':fmt(P[k],/^l|cad|vig|dias/.test(k)?0:2)});
  /* curva de Kc */
  const svg=svgEl('rgKc');if(!svg)return;const H=200,W=svgSize(svg,H),Lm=40,Rm=16,B=34,Tp=14,tot=P.lIni+P.lDev+P.lMid+P.lLate+40,x=d=>Lm+(W-Lm-Rm)*d/tot,y=k=>H-B-(H-B-Tp)*k/1.4;let h='';
  [0,0.4,0.8,1.2].forEach(k=>h+=`<line x1="${Lm}" x2="${W-Rm}" y1="${y(k)}" y2="${y(k)}" stroke="#EEF1F5"/><text x="${Lm-6}" y="${y(k)+4}" font-size="10" text-anchor="end" fill="#5B6673">${k.toFixed(1)}</text>`);
  const a=P.lIni,b=a+P.lDev,c=b+P.lMid,d=c+P.lLate;[[0,a,'inicial'],[a,b,'desarrollo'],[b,c,'máximo desarrollo'],[c,d,'maduración']].forEach(([s,e,t],i)=>h+=`<rect x="${x(s)}" y="${Tp}" width="${x(e)-x(s)}" height="${H-B-Tp}" fill="${i%2?'#F7F9FB':'#fff'}"/><text x="${(x(s)+x(e))/2}" y="${H-B+14}" font-size="10" text-anchor="middle" fill="#0E2A47">${t}</text><text x="${(x(s)+x(e))/2}" y="${H-B+27}" font-size="9.5" text-anchor="middle" fill="#5B6673">${e-s} d</text>`);
  h+=`<path d="M${x(0)} ${y(P.kcIni)}L${x(a)} ${y(P.kcIni)}L${x(b)} ${y(P.kcMid)}L${x(c)} ${y(P.kcMid)}L${x(d)} ${y(P.kcEnd)}L${x(tot)} ${y(P.kcEnd)}" fill="none" stroke="#0070C9" stroke-width="2.5"/>`;
  [[0,P.kcIni],[b,P.kcMid],[d,P.kcEnd]].forEach(([dd,k])=>h+=`<text x="${x(dd)+4}" y="${y(k)-6}" font-size="10.5" font-weight="700" fill="#0070C9">${k.toFixed(2)}</text>`);svg.innerHTML=h;rgEjemplo()}

rgInit();
