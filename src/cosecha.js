/* ================= COSECHA: piezas terminadas + guías, informe por quincena ================= */
/* Cada quincena se publica en la red el CSV de piezas terminadas (acumulado de la zafra) y el de guías.
   GeoCR calcula las mismas columnas del Excel (TCA, TCA_EST, REND 96, pureza, TCH, TSH, diferencias),
   la dinámica por división (R)/(S) con promedios simples (igual que la tabla dinámica), la de
   índice de maduración NAX, y genera el Excel (datos + dinámica + gráficos) y el PDF "Informe quincena N". */
const CO={qs:new Map(),cur:null,cache:new Map(),data:null,adm:'',reg:'',imp:null,recOf:new Map()};
const CO_COLS=['id','adm','div','dist','tab','pz','var','cla','reg','acE','tonE','acR','ton','az','fsb','fin','ffin','brix','sac','peso','tN','mad','q','ccl'];
const CO_DIVUP={1:'HIGUERAL',2:'GUAYMATE',3:'LA HIGUERA',4:'CHAVON ABAJO',5:'CUYA',6:'LECHUGAS',7:'BAIGUA'};
const CO_MES={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12,ENE:1,ABR:4,AGO:8,DIC:12};
function coFecha(v){if(v==null||v==='')return null;const t=String(v).trim();let m=t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/);
  if(m){const mo=CO_MES[m[2].toUpperCase()];if(!mo)return null;let y=+m[3];if(y<100)y+=2000;return`${y}-${String(mo).padStart(2,'0')}-${m[1].padStart(2,'0')}`}
  m=t.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)return m[0];m=t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);return m?`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`:null}
const coN=v=>{if(v==null||v==='')return NaN;const x=parseFloat(String(v).replace(/,/g,''));return isFinite(x)?x:NaN};
const coId=(adm,div,dist,tab,pz)=>`${+adm}${+div}${+dist}${String(+tab).padStart(4,'0')}${String(+pz).padStart(3,'0')}`;
const coDF=d=>d?d.split('-').reverse().join('/'):'–';
const coDivLab=(d,r)=>`${String(d).padStart(2,'0')}-${CO_DIVUP[d]||'SIN ASIGNAR'}(${+r===1?'R':'S'})`;
const coZafraTxt=z=>z||'';
/* columnas calculadas (mismas fórmulas del Excel) */
function coCalc(r){const o={...r};o.tca=r.acR>0?r.ton/r.acR:NaN;o.tcae=r.acE>0?r.tonE/r.acE:NaN;o.r96=r.ton>0?r.az/r.ton:NaN;o.pur=r.brix>0?r.sac/r.brix:NaN;
  o.tch=o.tca*2.47;o.tsh=o.tch*o.r96;o.dif=o.tca-o.tcae;o.pdif=o.dif/o.tcae;o.ok=r.acR>0&&r.acE>0&&isFinite(o.tca)&&isFinite(o.tcae);return o}
const coAvg=a=>{const v=a.filter(isFinite);return v.length?v.reduce((s,x)=>s+x,0)/v.length:NaN};
function coFiltrar(rows){return rows.filter(r=>(!CO.adm||String(r.adm)===CO.adm)&&(!CO.reg||String(r.reg)===CO.reg))}
/* dinámica por división (R)/(S): sumas de acres y toneladas, promedios simples por pieza (como la tabla dinámica) */
function coDinamica(rows){const R=rows.filter(r=>r.ok),g=new Map();R.forEach(r=>{const k=r.div+'|'+r.reg;if(!g.has(k))g.set(k,[]);g.get(k).push(r)});
  const fila=(lab,a)=>({lab,n:a.length,ac:sumBy(a,r=>r.acR),ton:sumBy(a,r=>r.ton),tca:coAvg(a.map(r=>r.tca)),tcae:coAvg(a.map(r=>r.tcae)),tN:coAvg(a.map(r=>r.tN==null?NaN:r.tN)),
    nN:a.filter(r=>r.tN!=null&&isFinite(r.tN)).length,dif:coAvg(a.map(r=>r.dif)),pdif:coAvg(a.map(r=>r.pdif)),r96:coAvg(a.map(r=>r.r96)),
    dN:coAvg(a.map(r=>r.tN!=null&&isFinite(r.tN)?r.tN-r.tcae:NaN)),reg:a[0]&&a[0].reg,div:a[0]&&a[0].div});
  const filas=[...g].sort((a,b)=>{const[da,ra]=a[0].split('|'),[db,rb]=b[0].split('|');return(+da)-(+db)||(+ra)-(+rb)}).map(([k,a])=>{const[d,r]=k.split('|');return fila(coDivLab(d,r),a)});
  return{filas,tot:fila('Total general',R)}}
function coMadur(rows){const b=new Map();rows.filter(r=>r.ok&&r.mad!=null&&isFinite(r.mad)).forEach(r=>{const i=Math.max(0,Math.min(9,Math.floor(r.mad*10+1e-9)));if(!b.has(i))b.set(i,[]);b.get(i).push(r)});
  const f=[...b].sort((x,y)=>x[0]-y[0]).map(([i,a])=>({lab:`${+(i/10).toFixed(1)}-${+((i+1)/10).toFixed(1)}`,r96:coAvg(a.map(r=>r.r96)),ton:sumBy(a,r=>r.ton),n:a.length}));
  const all=[...b.values()].flat();return{f,tot:{lab:'Total general',r96:coAvg(all.map(r=>r.r96)),ton:sumBy(all,r=>r.ton),n:all.length}}}

/* ---------- lectura de los CSV ---------- */
function coLeerPiezas(text){const C=nxCSV(text),H=C.h.map(x=>String(x).trim().toUpperCase().replace(/^﻿/,'')),ix=n=>H.indexOf(n);
  ['DIVISION_CODE','TABLON','PIEZA','ACRES_REAL','TON_MOL'].forEach(c=>{if(ix(c)<0)throw new Error(`El archivo de piezas no trae la columna ${c}.`)});
  const g=(r,n)=>{const i=ix(n);return i<0?'':String(r[i]??'').trim()},zs=new Map();
  const rows=C.rows.map(r=>{const adm=g(r,'ADM_O_COL')||'1',div=+g(r,'DIVISION_CODE'),dist=+g(r,'DISTRITO_CODE')||0,tab=+g(r,'TABLON'),pz=+g(r,'PIEZA');
    const z=`${String(g(r,'INICIO_ZFA')).slice(-2)}-${String(g(r,'FINAL_ZFA')).slice(-2)}`;if(z!=='-')zs.set(z,(zs.get(z)||0)+1);
    return{id:coId(adm,div,dist,tab,pz),adm:+adm,div,dist,tab,pz,var:+g(r,'VARIEDAD_CODE')||g(r,'VARIEDAD_CODE'),cla:+g(r,'CLASE')||g(r,'CLASE'),reg:+g(r,'REG_SECANO')||2,
      acE:coN(g(r,'ACRES_EST')),tonE:coN(g(r,'TON_EST')),acR:coN(g(r,'ACRES_REAL')),ton:coN(g(r,'TON_MOL')),az:coN(g(r,'TON_AZUCAR')),
      fsb:coFecha(g(r,'FECHA_SBRA')),fin:coFecha(g(r,'FECHA_INICIO')),ffin:coFecha(g(r,'FECHA_FIN'))}}).filter(r=>isFinite(r.div)&&r.div>0&&isFinite(r.tab));
  const zafra=[...zs].sort((a,b)=>b[1]-a[1])[0]?.[0]||'';return{rows,zafra}}
/* guías: brix y sacarosa ponderados por el peso de molino de todas las guías de la pieza (y su variedad) */
function coLeerGuias(text){const C=nxCSV(text),H=C.h.map(x=>String(x).trim().toUpperCase().replace(/^﻿/,'')),ix=n=>H.indexOf(n);
  ['BRIX','SACAROSA'].forEach(c=>{if(ix(c)<0)throw new Error(`El archivo de guías no trae la columna ${c}.`)});
  const iId=ix('ID'),iV=ix('VARIEDAD'),iB=ix('BRIX'),iS=ix('SACAROSA'),iP=ix('PESO_MOLINO')>=0?ix('PESO_MOLINO'):ix('PESO_MOLINO_TC'),iA=ix('ADM_O_COL'),iD=ix('DIVISION_CODE'),iDi=ix('DISTRITO_CODE'),iT=ix('TABLON'),iPz=ix('PIEZA');
  const m=new Map(),add=(k,b,s,p)=>{let a=m.get(k);if(!a){a=[0,0,0,0,0];m.set(k,a)}a[4]+=isFinite(p)?p:0;const w=isFinite(p)&&p>0?p:1;if(isFinite(b)&&isFinite(s)){a[0]+=b*w;a[1]+=s*w;a[2]+=w;a[3]++}};
  C.rows.forEach(r=>{const id=iA>=0&&iD>=0&&iT>=0&&iPz>=0?coId(r[iA]||1,r[iD],r[iDi]||0,r[iT],r[iPz]):String(r[iId]||'').trim();if(!id)return;
    const b=coN(r[iB]),s=coN(r[iS]),p=coN(r[iP]);add(id,b,s,p);if(iV>=0)add(id+'|'+(+r[iV]),b,s,p)});
  return{m,n:C.rows.length}}
function coNaxMap(){const m=new Map();if(NX&&NX.P)NX.P.forEach(p=>m.set(String(p.id).padStart(11,'0'),p));return m}
function coPrevData(zafra,n){const L=[...CO.qs.values()].filter(q=>q.zafra===zafra&&q.n<n).sort((a,b)=>b.n-a.n);return L[0]||null}
async function coProcesar(fp,fg,n){const P=coLeerPiezas(await fp.text());if(!P.rows.length)throw new Error('El archivo de piezas no trae filas.');
  const G=fg?coLeerGuias(await fg.text()):null,nx=coNaxMap();
  const prevMeta=coPrevData(P.zafra,n),prev=prevMeta?await coCargar(prevMeta):null,pm=new Map();(prev||[]).forEach(r=>pm.set(`${r.id}|${r.var}|${r.fin}`,r));
  let conG=0,conN=0,arr=0;
  const rows=P.rows.map(r=>{const k11=r.id.padStart(11,'0');let gg=G&&(G.m.get(r.id+'|'+r.var)||G.m.get(r.id));if(gg&&gg[2]){r.brix=+(gg[0]/gg[2]).toFixed(3);r.sac=+(gg[1]/gg[2]).toFixed(3);conG++}else{r.brix=null;r.sac=null}
    r.peso=gg?+gg[4].toFixed(2):null;const old=pm.get(`${r.id}|${r.var}|${r.fin}`);
    if(old){r.tN=old.tN;r.mad=old.mad;r.q=old.q;arr++}else{const p=nx.get(k11);r.tN=p&&p.tN!=null?p.tN:null;r.mad=p&&p.mad!=null?p.mad:null;r.q=n}
    if(r.tN!=null)conN++;const c=CAMPO&&CAMPO.d&&CAMPO.d[k11];r.ccl=c?c[3]:null;return r});
  const ff=rows.map(r=>r.ffin).filter(Boolean).sort();
  return{zafra:P.zafra,n,rows,fecha:ff[ff.length-1]||null,desde:ff[0]||null,conG,conN,arr,guias:G?G.n:0,nuevas:rows.filter(r=>r.q===n).length,nx:!!(NX&&NX.P)}}

/* ---------- base de datos ---------- */
const coPack=rows=>JSON.stringify({cols:CO_COLS,rows:rows.map(r=>CO_COLS.map(c=>r[c]??null))});
const coUnpack=s=>{const o=JSON.parse(s);return o.rows.map(a=>{const r={};o.cols.forEach((c,i)=>r[c]=a[i]);return r})};
async function coCargar(meta){if(CO.cache.has(meta.sid))return CO.cache.get(meta.sid);let s='';
  if(DB){for(let i=0;i<meta.parts;i++){const d=await DB.collection('cosecha_snap').doc(meta.sid+'-'+i).get();if(!d.exists)throw new Error('Datos incompletos');s+=d.data().s}}
  else s=localStorage.getItem('geocr-co-'+meta.sid)||'';const rows=coUnpack(s);CO.cache.set(meta.sid,rows);return rows}
async function coGuardar(imp,archivos){const js=coPack(imp.rows),sid='c'+Date.now(),CH=180000,parts=[];for(let i=0;i<js.length;i+=CH)parts.push(js.slice(i,i+CH));
  const id=`z${imp.zafra||'s'}-q${String(imp.n).padStart(2,'0')}`,por=await quienSoy();
  const meta={zafra:imp.zafra,n:imp.n,fecha:imp.fecha,desde:imp.desde,filas:imp.rows.length,nuevas:imp.nuevas,archivos,por,sid,parts:parts.length,creado:new Date().toISOString()};
  if(DB){let prev=null;try{const d=await DB.collection('cosecha_q').doc(id).get();if(d.exists)prev=d.data()}catch(e){}
    for(let i=0;i<parts.length;i++){$('#coSt').textContent=`Guardando ${i+1}/${parts.length}…`;await DB.collection('cosecha_snap').doc(sid+'-'+i).set({i,s:parts[i]})}
    await DB.collection('cosecha_q').doc(id).set(meta);if(prev&&prev.sid)for(let i=0;i<(prev.parts||0);i++)DB.collection('cosecha_snap').doc(prev.sid+'-'+i).delete().catch(()=>{})}
  else{try{localStorage.setItem('geocr-co-'+sid,js);const L=JSON.parse(localStorage.getItem('geocr-coq')||'{}');if(L[id])localStorage.removeItem('geocr-co-'+L[id].sid);L[id]=meta;localStorage.setItem('geocr-coq',JSON.stringify(L))}
    catch(e){throw new Error('No cabe en este navegador; en AgroAP-CR publicado se guarda en la base.')}CO.qs.set(id,{...meta,id})}
  CO.cache.set(sid,imp.rows);CO.cur=id;return id}
async function coBorrar(id){const q=CO.qs.get(id);if(!q)return;
  if(!await askConfirm('¿Desea eliminar el elemento seleccionado?',`Se eliminará la quincena ${q.n} de la zafra ${q.zafra} (${fmt(q.filas)} filas${q.archivos?' · '+q.archivos:''}). El tablero se actualizará sin esa información.`))return;
  try{if(DB){await DB.collection('cosecha_q').doc(id).delete();for(let i=0;i<(q.parts||0);i++)DB.collection('cosecha_snap').doc(q.sid+'-'+i).delete().catch(()=>{})}
    else{const L=JSON.parse(localStorage.getItem('geocr-coq')||'{}');delete L[id];localStorage.setItem('geocr-coq',JSON.stringify(L));localStorage.removeItem('geocr-co-'+q.sid)}
    CO.qs.delete(id);if(CO.cur===id)CO.cur=null;coDraw()}catch(e){$('#coInfo').innerHTML=`<span class="qc">No se pudo eliminar (${e.message||e}).</span>`}}
(async()=>{for(let t=0;t<200&&!DB&&DBSTATE==='cargando';t++)await new Promise(r=>setTimeout(r,50));
  if(!DB){try{const L=JSON.parse(localStorage.getItem('geocr-coq')||'{}');Object.entries(L).forEach(([id,m])=>CO.qs.set(id,{...m,id}))}catch(e){}CO.listo=true;coDraw();return}
  DB.collection('cosecha_q').orderBy('creado','desc').limit(200).onSnapshot(s=>{CO.qs=new Map(s.docs.map(d=>[d.id,{...d.data(),id:d.id}]));CO.listo=true;coDraw()},()=>{CO.listo=true;coDraw()})})();

/* ---------- tablero ---------- */
const coOrden=()=>[...CO.qs.values()].sort((a,b)=>String(b.zafra).localeCompare(String(a.zafra))||b.n-a.n);
function coRamp(n,N){const t=N<=1?1:(n-1)/(N-1),a=[191,224,255],b=[14,42,71];return`rgb(${a.map((x,i)=>Math.round(x+(b[i]-x)*t)).join(',')})`}
async function coDraw(){const sec=$('#cosecha-tab');if(!sec||!sec.classList.contains('on')||!sec.offsetParent)return;
  const L=coOrden(),sel=$('#coSel');if(!CO.cur||!CO.qs.has(CO.cur))CO.cur=L[0]?L[0].id:null;
  sel.innerHTML=L.map(q=>`<option value="${q.id}"${q.id===CO.cur?' selected':''}>Quincena ${q.n} · zafra ${coZafraTxt(q.zafra)} · cosecha al ${coDF(q.fecha)}</option>`).join('')||'<option>Sin quincenas cargadas</option>';
  $('#coChips').innerHTML=L.length?`<div class="note" style="margin-bottom:4px">Quincenas cargadas:</div>`+L.map(q=>`<span class="upchip">Q${q.n} · ${coZafraTxt(q.zafra)} · al ${coDF(q.fecha)} · ${fmt(q.filas)} filas<button data-del="${q.id}" title="Eliminar esta quincena">✕ Eliminar</button></span>`).join(''):'';
  $$('#coChips [data-del]').forEach(b=>b.onclick=()=>coBorrar(b.dataset.del));
  const body=$('#coBody'),emp=$('#coEmpty');
  if(!CO.cur){body.style.display='none';emp.style.display='block';emp.innerHTML=!CO.listo?'Cargando quincenas…':'Todavía no hay quincenas cargadas.<br>Ve a <b>Cargar quincena</b> y sube el CSV de piezas terminadas y el de guías que se publican cada 15 días.';return}
  const meta=CO.qs.get(CO.cur);let rows;try{emp.style.display='block';emp.textContent='Cargando la quincena…';rows=await coCargar(meta)}catch(e){emp.innerHTML=`<span class="qc">No se pudo leer la quincena (${e.message}).</span>`;return}
  emp.style.display='none';body.style.display='';
  const all=rows.map(coCalc),R=coFiltrar(all),D=coDinamica(R),T=D.tot;CO.data={meta,all,R,D};
  $('#coInfo').innerHTML=`Quincena ${meta.n} · zafra ${coZafraTxt(meta.zafra)} · piezas terminadas del ${coDF(meta.desde)} al ${coDF(meta.fecha)} · ${fmt(meta.nuevas||0)} filas nuevas en esta quincena${meta.por?' · cargado por '+meta.por:''}`;
  const sg=v=>isFinite(v)?(v>0?'+':'')+fmt(v,2):'–';
  $('#coK').innerHTML=[['Piezas cosechadas',fmt(new Set(R.map(r=>r.id)).size),`${fmt(R.length)} filas (pieza y variedad)`],['Acres cosechados',fmt(T.ac),''],['Toneladas molidas',fmt(T.ton),''],
    ['TCA real',fmt(T.tca,2),`Ingenio ${fmt(T.tcae,2)} (${sg(T.dif)})`],['TCA NAX',fmt(T.tN,2),T.nN?`${fmt(T.nN)} filas con dato NAX`:'sin dato NAX'],['REND 96',isFinite(T.r96)?fmt(T.r96*100,2)+'%':'–','promedio']]
    .map(([t,v,s])=>`<div class="kpi"><small>${t}</small><div>${v}</div><em>${s}</em></div>`).join('');
  /* mapa por quincena de cosecha */
  const N=Math.max(1,...all.map(r=>+r.q||0)),col=new Map(),info=new Map();
  R.forEach(r=>{let rec=CO.recOf.get(r.id);if(rec===undefined){rec=keyMatch(r.id)||keyMatch(r.id.padStart(11,'0'))||[];CO.recOf.set(r.id,rec)}rec.forEach(i=>{col.set(i,coRamp(+r.q||N,N));if(!info.has(i))info.set(i,[]);info.get(i).push(r)})});
  dashMap('co',col);const qs=[...new Set(R.map(r=>+r.q||N))].sort((a,b)=>a-b);
  $('#coLeg').innerHTML=qs.map(q=>`<span><i style="background:${coRamp(q,N)}"></i>Quincena ${q}</span>`).join('')+'<span><i style="background:#E6E9ED"></i>Sin cosechar / sin ubicar</span>';
  CO.tip=ri=>{const a=info.get(ri);if(!a)return'';return a.map(r=>`Cosechada ${coDF(r.ffin)} (quincena ${r.q}) · var. ${r.var}<br>TCA real ${fmt(r.tca,1)} · ingenio ${fmt(r.tcae,1)}${r.tN!=null?' · NAX '+fmt(r.tN,1):''}`).join('<br>')};
  coBarras(svgEl('coBar'),D.filas);coMadSvg(svgEl('coMad'),coMadur(R));
  const td=(v,d,c)=>`<td class="n"${c?` style="color:${c};font-weight:700"`:''}>${fmt(v,d)}</td>`,cl=v=>isFinite(v)?(v>=0?'#2E7D32':'#C62828'):'';
  const fil=f=>`<tr${f.lab==='Total general'?' style="font-weight:700;background:#EEF4FB"':''}><td>${f.lab}</td>${td(f.ac,0)}${td(f.ton,0)}${td(f.tcae,2)}${td(f.tca,2)}${td(f.tN,2)}<td class="n" style="color:${cl(f.dif)};font-weight:700">${sg(f.dif)}</td><td class="n" style="color:${cl(f.pdif)}">${isFinite(f.pdif)?(f.pdif>0?'+':'')+fmt(f.pdif*100,1)+'%':'–'}</td><td class="n" style="color:${cl(f.dN)}">${sg(f.dN)}</td><td class="n">${isFinite(f.r96)?fmt(f.r96*100,2)+'%':'–'}</td></tr>`;
  $('#coTbl').innerHTML='<tr><th>División (S/R)</th><th class="n">Acres</th><th class="n">Toneladas</th><th class="n">TCA ingenio</th><th class="n">TCA real</th><th class="n">TCA NAX</th><th class="n">Real vs ing.</th><th class="n">Dif. %</th><th class="n">NAX vs ing.</th><th class="n">REND 96</th></tr>'+D.filas.map(fil).join('')+fil(T)}
function coBarras(svg,F){const H=280,W=svgSize(svg,H),L=40,B=78,Tp=26,S=[['tcae','Estimado ingenio','#A6A6A6'],['tca','Real','#0E2A47'],['tN','NAX','#0070C9']];
  const vals=F.flatMap(f=>S.map(s=>f[s[0]])).filter(isFinite),mx=Math.max(1,...vals)*1.15,gw=(W-L-6)/Math.max(1,F.length),bw=Math.min(22,(gw-10)/3);let h='';
  niceBreaks(mx,5).forEach(t=>{if(t>mx)return;const y=H-B-(H-B-Tp)*t/mx;h+=`<line x1="${L}" x2="${W}" y1="${y}" y2="${y}" stroke="#EEF1F5"/><text x="${L-5}" y="${y+4}" font-size="10" text-anchor="end" fill="#5B6673">${fmt(t)}</text>`});
  F.forEach((f,i)=>{const x0=L+i*gw+(gw-bw*3)/2;S.forEach(([k,n,c],j)=>{const v=f[k];if(!isFinite(v))return;const bh=(H-B-Tp)*v/mx,x=x0+j*bw;h+=`<rect x="${x}" y="${H-B-bh}" width="${bw-2}" height="${bh}" fill="${c}"><title>${f.lab} · ${n}: ${fmt(v,2)}</title></rect><text x="${x+bw/2-1}" y="${H-B-bh-3}" font-size="8.5" text-anchor="middle" fill="#1F2933">${fmt(v,1)}</text>`});
    const cx=L+i*gw+gw/2;h+=`<text transform="translate(${cx},${H-B+12}) rotate(-35)" font-size="9.5" text-anchor="end" fill="#1F2933">${f.lab}</text>`});
  h+=S.map(([k,n,c],j)=>`<rect x="${L+j*130}" y="2" width="12" height="12" fill="${c}"/><text x="${L+j*130+17}" y="12" font-size="11" fill="#1F2933">${n}</text>`).join('');svg.innerHTML=h}
function coMadSvg(svg,M){const H=260,W=svgSize(svg,H),L=46,R=60,B=34,Tp=22;if(!M.f.length){svg.innerHTML=`<text x="6" y="24" font-size="12" fill="#5B6673">Sin índice de maduración NAX para estas piezas.</text><text x="6" y="42" font-size="12" fill="#5B6673">El robot NAX diario lo descarga desde ahora:</text><text x="6" y="60" font-size="12" fill="#5B6673">las próximas quincenas ya lo traen.</text>`;return}
  const mr=Math.max(...M.f.map(f=>f.r96).filter(isFinite))*1.15,mt=Math.max(...M.f.map(f=>f.ton))*1.15,gw=(W-L-R)/M.f.length;let h='';
  niceBreaks(mr*100,5).forEach(t=>{const y=H-B-(H-B-Tp)*t/100/mr;if(y<Tp)return;h+=`<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" stroke="#EEF1F5"/><text x="${L-5}" y="${y+4}" font-size="10" text-anchor="end" fill="#5B6673">${fmt(t,1)}%</text>`});
  niceBreaks(mt,5).forEach(t=>{const y=H-B-(H-B-Tp)*t/mt;if(y<Tp)return;h+=`<text x="${W-R+5}" y="${y+4}" font-size="10" fill="#0070C9">${fmt(t/1000,0)}k</text>`});
  let d='';M.f.forEach((f,i)=>{const x=L+i*gw;if(isFinite(f.r96)){const bh=(H-B-Tp)*f.r96/mr;h+=`<rect x="${x+gw*.18}" y="${H-B-bh}" width="${gw*.64}" height="${bh}" fill="#0E2A47"><title>${f.lab}: REND 96 ${fmt(f.r96*100,2)}% · ${fmt(f.n)} filas</title></rect>`}
    const y=H-B-(H-B-Tp)*f.ton/mt;d+=(i?'L':'M')+(x+gw/2)+' '+y;h+=`<text x="${x+gw/2}" y="${H-B+14}" font-size="10" text-anchor="middle" fill="#1F2933">${f.lab}</text>`});
  h+=`<path d="${d}" fill="none" stroke="#0070C9" stroke-width="2.5"/>`+M.f.map((f,i)=>`<circle cx="${L+i*gw+gw/2}" cy="${H-B-(H-B-Tp)*f.ton/mt}" r="3.5" fill="#0070C9"><title>${f.lab}: ${fmt(f.ton)} t</title></circle>`).join('');
  h+=`<rect x="${L}" y="2" width="12" height="12" fill="#0E2A47"/><text x="${L+17}" y="12" font-size="11">Promedio de REND 96</text><line x1="${L+170}" x2="${L+186}" y1="8" y2="8" stroke="#0070C9" stroke-width="2.5"/><text x="${L+191}" y="12" font-size="11">Suma de TON_MOL</text>`;svg.innerHTML=h}

/* ---------- carga de la quincena ---------- */
function coSigN(z){const L=[...CO.qs.values()].filter(q=>!z||q.zafra===z);return L.length?Math.max(...L.map(q=>q.n))+1:1}
$('#coN').value=1;
['coFP','coFG'].forEach(id=>$('#'+id).onchange=async()=>{CO.imp=null;$('#coSave').disabled=true;$('#coPrev').innerHTML='';const fp=$('#coFP').files[0],fg=$('#coFG').files[0],st=$('#coSt');
  if(!fp){st.textContent='Falta el CSV de piezas terminadas.';return}if(id==='coFP'){try{const z=coLeerPiezas((await fp.slice(0,400000).text()).replace(/\n[^\n]*$/,'')).zafra;$('#coN').value=coSigN(z)}catch(e){}}
  if(!fg){st.textContent='Ahora sube el CSV de guías (para brix, sacarosa y peso de molino).';return}await coPrepare()});
$('#coN').onchange=()=>{if($('#coFP').files[0]&&$('#coFG').files[0])coPrepare()};
async function coPrepare(){const st=$('#coSt'),fp=$('#coFP').files[0],fg=$('#coFG').files[0],n=Math.max(1,parseInt($('#coN').value)||1);st.className='status';st.textContent='Procesando piezas y guías…';
  try{await new Promise(r=>setTimeout(r,30));const imp=await coProcesar(fp,fg,n);CO.imp={...imp,archivos:[fp.name,fg&&fg.name].filter(Boolean).join(', ')};
    const ex=CO.qs.get(`z${imp.zafra||'s'}-q${String(n).padStart(2,'0')}`),rows=imp.rows.map(coCalc),T=coDinamica(rows).tot;
    $('#coPrev').innerHTML=`<table><tr><td>Zafra</td><td><b>${imp.zafra||'–'}</b></td></tr><tr><td>Quincena</td><td><b>${n}</b>${ex?' <span class="qc">(ya existe: se reemplaza)</span>':''}</td></tr>
      <tr><td>Piezas terminadas</td><td>${fmt(rows.length)} filas · del ${coDF(imp.desde)} al ${coDF(imp.fecha)}</td></tr><tr><td>Nuevas en esta quincena</td><td>${fmt(imp.nuevas)}${imp.arr?` · ${fmt(imp.arr)} ya venían de quincenas anteriores`:''}</td></tr>
      <tr><td>Con brix y sacarosa (guías)</td><td>${fmt(imp.conG)} de ${fmt(rows.length)} · ${fmt(imp.guias)} guías leídas</td></tr>
      <tr><td>Con TCA NAX</td><td>${fmt(imp.conN)} de ${fmt(rows.length)}${imp.nx?'':' <span class="qc">(no hay reporte NAX publicado)</span>'}</td></tr>
      <tr><td>Acres / toneladas</td><td>${fmt(T.ac)} acres · ${fmt(T.ton)} t</td></tr><tr><td>TCA real / ingenio / NAX</td><td>${fmt(T.tca,2)} / ${fmt(T.tcae,2)} / ${fmt(T.tN,2)}</td></tr></table>`;
    st.textContent='Revisa el resumen y pulsa Guardar quincena.';$('#coSave').disabled=false}
  catch(e){st.className='status err';st.textContent=e.message||String(e)}}
$('#coSave').onclick=async()=>{const st=$('#coSt'),b=$('#coSave');if(!CO.imp)return;b.disabled=true;
  try{await coGuardar(CO.imp,CO.imp.archivos);st.className='status';st.textContent=`Quincena ${CO.imp.n} guardada.`;CO.imp=null;$('#coPrev').innerHTML='';$('#coFP').value='';$('#coFG').value='';showModSub('cosecha','tab')}
  catch(e){st.className='status err';st.textContent=e.message||'No se pudo guardar.';b.disabled=false}};
$('#coSel').onchange=e=>{CO.cur=e.target.value;coDraw()};
$('#coAdm').onchange=e=>{CO.adm=e.target.value;coDraw()};$('#coReg').onchange=e=>{CO.reg=e.target.value;coDraw()};
$('#coMap').addEventListener('click',e=>dashTip('co',e,ri=>CO.tip?CO.tip(ri):''));
const coFiltTxt=()=>[CO.adm?(CO.adm==='1'?'Administración':'Colonos'):'',CO.reg?(CO.reg==='1'?'Riego':'Secano'):''].filter(Boolean).join(' · ');

/* ---------- Excel: datos calculados + dinámica + gráficos ---------- */
const coXmlEsc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function coChartXml(o){const NS='xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const tx=(t,sz,b)=>`<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${b?1:0}"/></a:pPr><a:r><a:rPr lang="es-ES" sz="${sz}" b="${b?1:0}"/><a:t>${coXmlEsc(t)}</a:t></a:r></a:p></c:rich></c:tx>`;
  const lbl=f=>`<c:dLbls><c:numFmt formatCode="${f}" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr><a:endParaRPr lang="es-ES"/></a:p></c:txPr><c:dLblPos val="${o.lblPos||'outEnd'}"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;
  const ser=(s,i,line)=>`<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef><c:f>${coXmlEsc(s.name)}</c:f></c:strRef></c:tx>`+
    (line?`<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></c:spPr></c:marker>`
      :`<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>`)+(s.lbl?lbl(s.lbl).replace(line?/<c:dLblPos val="[^"]*"\/>/:/^$/,line?'<c:dLblPos val="t"/>':''):'')+
    `<c:cat><c:strRef><c:f>${coXmlEsc(o.cats)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${coXmlEsc(s.ref)}</c:f></c:numRef></c:val>${line?'<c:smooth val="0"/>':''}</c:ser>`;
  const cat=(id,cross,del,pos)=>`<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="${del}"/><c:axPos val="${pos}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:txPr><a:bodyPr rot="-2700000"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr><a:endParaRPr lang="es-ES"/></a:p></c:txPr><c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const val=(id,cross,pos,title,f,crosses,grid)=>`<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${grid?'<c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="E5E8EC"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>':''}${title?`<c:title>${tx(title,900,0)}<c:overlay val="0"/></c:title>`:''}<c:numFmt formatCode="${f}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="${crosses}"/><c:crossBetween val="between"/></c:valAx>`;
  const bars=o.ser.filter(s=>!s.line),lines=o.ser.filter(s=>s.line);
  return`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace ${NS}><c:roundedCorners val="0"/><c:chart><c:title>${tx(o.title,1400,1)}<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>`+
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${bars.map((s,i)=>ser(s,i,false)).join('')}<c:gapWidth val="80"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>`+
    (lines.length?`<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${lines.map((s,i)=>ser(s,bars.length+i,true)).join('')}<c:marker val="1"/><c:axId val="5003"/><c:axId val="5004"/></c:lineChart>`:'')+
    cat(5001,5002,0,'b')+val(5002,5001,'l',o.yTitle,o.yFmt||'0.0','autoZero',true)+(lines.length?cat(5003,5004,1,'b')+val(5004,5003,'r',o.y2Title,o.y2Fmt||'#,##0','max',false):'')+
    `</c:plotArea><c:legend><c:legendPos val="t"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`}
async function coXlsxChart(buf,charts){/* charts: [{sheet:n (1-based), xml, from:[col,row], to:[col,row]}] */
  const z=await JSZip.loadAsync(buf);let ct=await z.file('[Content_Types].xml').async('string'),add='';
  for(let k=0;k<charts.length;k++){const c=charts[k],n=k+1,sh=`xl/worksheets/sheet${c.sheet}.xml`,rel=`xl/worksheets/_rels/sheet${c.sheet}.xml.rels`;
    z.file(`xl/charts/chart${n}.xml`,c.xml);
    z.file(`xl/drawings/drawing${n}.xml`,`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${c.from[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.from[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${c.to[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${c.to[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${n+1}" name="Gráfico ${n}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`);
    z.file(`xl/drawings/_rels/drawing${n}.xml.rels`,`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${n}.xml"/></Relationships>`);
    let rx=z.file(rel)?await z.file(rel).async('string'):`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    rx=rx.replace('</Relationships>',`<Relationship Id="rIdDr${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`);z.file(rel,rx);
    let sx=await z.file(sh).async('string');if(!/xmlns:r=/.test(sx))sx=sx.replace('<worksheet ','<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
    sx=sx.replace('</worksheet>',`<drawing r:id="rIdDr${n}"/></worksheet>`);z.file(sh,sx);
    add+=`<Override PartName="/xl/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`}
  if(!/Extension="rels"/.test(ct))add+='<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
  z.file('[Content_Types].xml',ct.replace('</Types>',add+'</Types>'));return z.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6},mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})}
$('#coXls').onclick=async()=>{const st=$('#coDlSt');if(!CO.data)return;if(!window.XLSX||!window.JSZip){st.textContent='No se pudo cargar el generador de Excel.';return}st.textContent='Armando el Excel…';
  try{const{meta,R,D}=CO.data,M=coMadur(R),nm=r=>isFinite(r)?+(+r).toFixed(6):null,dn=d=>DIVN[d]||'Sin asignar';
    const head=['ID','ADM_O_COL','DIVISION_CODE','DISTRITO_CODE','TABLON','PIEZA','VARIEDAD_CODE','CLASE','REG_SECANO','ACRES_EST','TON_EST','ACRES_REAL','TON_MOL','TON_AZUCAR','FECHA_SBRA','FECHA_INICIO','FECHA_FIN','QUINCENA_COSECHA',
      'BRIX','SACAROSA','PUR %','REND 96','TCA','TCA_EST','TCH','TSH','DIV_NOM','DIV_REG','DIFERENCIA','% DIF','PESO_MOLINO','TCA NAX','MAD NAX','Clase Caña'];
    const data=R.map(r=>[+r.id,r.adm,r.div,r.dist,r.tab,r.pz,r.var,r.cla,r.reg,nm(r.acE),nm(r.tonE),nm(r.acR),nm(r.ton),nm(r.az),r.fsb,r.fin,r.ffin,r.q,r.brix,r.sac,nm(r.pur),nm(r.r96),nm(r.tca),nm(r.tcae),nm(r.tch),nm(r.tsh),dn(r.div),coDivLab(r.div,r.reg),nm(r.dif),nm(r.pdif),r.peso,r.tN,r.mad,r.ccl||'']);
    const wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet([head,...data]);ws['!cols']=head.map(h=>({wch:Math.max(9,h.length+2)}));ws['!autofilter']={ref:`A1:${XLSX.utils.encode_col(head.length-1)}${data.length+1}`};
    const pctCols=['PUR %','REND 96','% DIF'].map(h=>head.indexOf(h));for(let i=0;i<data.length;i++)pctCols.forEach(c=>{const a=XLSX.utils.encode_cell({r:i+1,c});if(ws[a])ws[a].z='0.0%'});
    const t1=[[`Informe quincena ${meta.n} · zafra ${meta.zafra} · cosecha al ${coDF(meta.fecha)}`],[`ADM_O_COL: ${CO.adm||'(Todas)'} · REG_SECANO: ${CO.reg||'(Todas)'}`],[],
      ['División (S/R)','Suma de ACRES_REAL','Suma de TON_MOL','Promedio de TCA','Promedio de TCA_EST','Promedio de TCA NAX','Promedio de DIFERENCIA','Promedio de % DIF','Promedio de REND 96'],
      ...[...D.filas,D.tot].map(f=>[f.lab,nm(f.ac),nm(f.ton),nm(f.tca),nm(f.tcae),nm(f.tN),nm(f.dif),nm(f.pdif),nm(f.r96)])];
    const w2=XLSX.utils.aoa_to_sheet(t1);w2['!cols']=[{wch:22},...Array(8).fill({wch:15})];for(let i=4;i<t1.length;i++){[1,2].forEach(c=>{const a=XLSX.utils.encode_cell({r:i,c});if(w2[a])w2[a].z='#,##0'});[3,4,5,6].forEach(c=>{const a=XLSX.utils.encode_cell({r:i,c});if(w2[a])w2[a].z='0.00'});[7,8].forEach(c=>{const a=XLSX.utils.encode_cell({r:i,c});if(w2[a])w2[a].z='0.0%'})}
    const t3=[['Índice de maduración NAX'],[],['Etiquetas de fila','Promedio de REND 96','Suma de TON_MOL'],...M.f.map(f=>[f.lab,nm(f.r96),nm(f.ton)]),['Total general',nm(M.tot.r96),nm(M.tot.ton)]];
    const w3=XLSX.utils.aoa_to_sheet(t3);w3['!cols']=[{wch:18},{wch:20},{wch:18}];for(let i=3;i<t3.length;i++){const a=XLSX.utils.encode_cell({r:i,c:1});if(w3[a])w3[a].z='0.00%';const b=XLSX.utils.encode_cell({r:i,c:2});if(w3[b])w3[b].z='#,##0'}
    XLSX.utils.book_append_sheet(wb,ws,'Datos');XLSX.utils.book_append_sheet(wb,w2,'Dinámica');XLSX.utils.book_append_sheet(wb,w3,'Maduración');
    const n1=D.filas.length,last=4+n1,buf=XLSX.write(wb,{bookType:'xlsx',type:'array',compression:true});
    const charts=[{sheet:2,from:[10,3],to:[22,26],xml:coChartXml({title:'TCA promedio por división y régimen',cats:`'Dinámica'!$A$5:$A$${last}`,yTitle:'TCA (t/acre)',yFmt:'0',
      ser:[{name:`'Dinámica'!$E$4`,ref:`'Dinámica'!$E$5:$E$${last}`,color:'A6A6A6',lbl:'0.0'},{name:`'Dinámica'!$D$4`,ref:`'Dinámica'!$D$5:$D$${last}`,color:'0E2A47',lbl:'0.0'},{name:`'Dinámica'!$F$4`,ref:`'Dinámica'!$F$5:$F$${last}`,color:'0070C9',lbl:'0.0'}]})}];
    if(M.f.length){const l3=3+M.f.length;charts.push({sheet:3,from:[5,2],to:[16,22],xml:coChartXml({title:'Índice de maduración NAX',cats:`'Maduración'!$A$4:$A$${l3}`,yTitle:'REND 96',yFmt:'0.0%',y2Title:'Toneladas',y2Fmt:'#,##0',lblPos:'inEnd',
      ser:[{name:`'Maduración'!$B$3`,ref:`'Maduración'!$B$4:$B$${l3}`,color:'0E2A47'},{name:`'Maduración'!$C$3`,ref:`'Maduración'!$C$4:$C$${l3}`,color:'0070C9',line:true}]})})}
    const blob=await coXlsxChart(buf,charts);saveFile(`Cosecha_quincena_${meta.n}_zafra_${meta.zafra}.xlsx`,blob,st)}catch(e){st.textContent='No se pudo armar el Excel: '+(e.message||e)}};

/* ---------- PDF "Informe quincena N" (formato del informe Ingenio vs NAX) ---------- */
function coWrap(ctx,text,x,y,w,lh){/* texto con **negritas** */const parts=text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).flatMap(p=>{const b=p.startsWith('**');return(b?p.slice(2,-2):p).split(/(\s+)/).filter(Boolean).map(t=>({t,b}))});
  let cx=x;const base=ctx.font.replace(/^(bold |700 )/,'');parts.forEach(({t,b})=>{ctx.font=(b?'700 ':'')+base;const tw=ctx.measureText(t).width;if(cx+tw>x+w&&t.trim()){cx=x;y+=lh}if(!(cx===x&&!t.trim())){ctx.fillText(t,cx,y);cx+=tw}});ctx.font=base;return y+lh}
function coPdfPagina(n,tot,meta){const W=1632,H=2112,cv=document.createElement('canvas');cv.width=W;cv.height=H;const c=cv.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,W,H);
  c.fillStyle='#8A94A3';c.font='22px Inter, Arial';c.textAlign='left';c.fillText('Agricultura de Precisión – Central Romana',90,H-60);c.textAlign='right';c.fillText(`Página ${n} de ${tot}`,W-90,H-60);c.textAlign='left';
  c.strokeStyle='#E1E5EA';c.lineWidth=2;c.beginPath();c.moveTo(90,H-95);c.lineTo(W-90,H-95);c.stroke();return{cv,c,W,H}}
function coPdfTabla(c,x,y,cols,rows,opt={}){const rh=opt.rh||54,W=cols.reduce((s,k)=>s+k.w,0);c.fillStyle='#1F4E79';c.fillRect(x,y,W,rh);c.font='700 21px Inter, Arial';c.fillStyle='#fff';
  let cx=x;cols.forEach(k=>{c.textAlign=k.a||'center';c.fillText(k.t,k.a==='left'?cx+14:cx+k.w/2,y+rh/2+8);cx+=k.w});y+=rh;
  rows.forEach((r,i)=>{const tot=r._tot;c.fillStyle=tot?'#DCE9F5':(i%2?'#F7F9FB':'#fff');c.fillRect(x,y,W,rh);c.strokeStyle='#D5DCE4';c.lineWidth=1.5;c.strokeRect(x,y,W,rh);cx=x;
    cols.forEach((k,j)=>{const v=r[j];c.font=(tot?'700 ':'')+'21px Inter, Arial';c.fillStyle=r._col&&r._col[j]?r._col[j]:'#1F2933';c.textAlign=k.a||'center';c.fillText(v,k.a==='left'?cx+14:cx+k.w/2,y+rh/2+8);cx+=k.w});y+=rh});return y}
function coPdfBarras(c,x,y,w,h,F,S,ttl,yt){c.fillStyle='#0E2A47';c.font='700 30px Inter, Arial';c.textAlign='left';c.fillText(ttl,x,y);y+=26;
  S.forEach(([k,n,col],j)=>{const lx=x+w/2-S.length*130+j*260+60;c.fillStyle=col;c.fillRect(lx,y+6,40,20);c.fillStyle='#1F2933';c.font='22px Inter, Arial';c.fillText(n,lx+50,y+24)});y+=50;
  const L=90,B=170,PH=h-B,vals=F.flatMap(f=>S.map(s=>f[s[0]])).filter(isFinite),mx=Math.max(1,...vals)*1.12,gw=(w-L)/Math.max(1,F.length),bw=Math.min(60,(gw-24)/S.length);
  c.font='20px Inter, Arial';niceBreaks(mx,6).forEach(t=>{if(t>mx)return;const yy=y+PH-PH*t/mx;c.strokeStyle='#E5E8EC';c.lineWidth=1.5;c.beginPath();c.moveTo(x+L,yy);c.lineTo(x+w,yy);c.stroke();c.fillStyle='#5B6673';c.textAlign='right';c.fillText(fmt(t),x+L-12,yy+7)});
  c.save();c.translate(x+22,y+PH/2);c.rotate(-Math.PI/2);c.textAlign='center';c.fillStyle='#1F2933';c.font='22px Inter, Arial';c.fillText(yt,0,0);c.restore();
  F.forEach((f,i)=>{const x0=x+L+i*gw+(gw-bw*S.length)/2;S.forEach(([k,n,col],j)=>{const v=f[k];if(!isFinite(v))return;const bh=PH*v/mx;c.fillStyle=col;c.fillRect(x0+j*bw,y+PH-bh,bw-6,bh);c.fillStyle='#1F2933';c.font='17px Inter, Arial';c.textAlign='center';c.fillText(fmt(v,1),x0+j*bw+(bw-6)/2,y+PH-bh-8)});
    c.save();c.translate(x+L+i*gw+gw/2+10,y+PH+18);c.rotate(-Math.PI/6);c.textAlign='right';c.font='19px Inter, Arial';c.fillStyle='#1F2933';c.fillText(f.lab,0,10);c.restore()});
  c.strokeStyle='#8A94A3';c.lineWidth=2;c.beginPath();c.moveTo(x+L,y+PH);c.lineTo(x+w,y+PH);c.stroke();return y+h}
$('#coPdf').onclick=async()=>{const st=$('#coDlSt');if(!CO.data)return;if(!window.jspdf){st.textContent='No se pudo cargar el generador de PDF.';return}st.textContent='Armando el informe…';
  try{await document.fonts.ready;const{meta,R,D}=CO.data,T=D.tot,M=coMadur(R),sg=(v,d=2)=>isFinite(v)?(v>0?'+':'')+fmt(v,d):'–',pc=v=>isFinite(v)?(v>0?'+':'')+fmt(v*100,1)+'%':'–';
    const rg=k=>{const a=R.filter(r=>r.ok&&String(r.reg)===k);return{dif:coAvg(a.map(r=>r.dif)),dN:coAvg(a.map(r=>r.tN!=null&&isFinite(r.tN)?r.tN-r.tcae:NaN)),n:a.length}},RR=rg('1'),SS=rg('2');
    const bajo=D.filas.filter(f=>isFinite(f.dif)&&f.dif<0).map(f=>f.lab.replace(/^\d+-/,'').toLowerCase().replace(/\b\w/g,m=>m.toUpperCase()).replace('(R)',' riego').replace('(S)',' secano'));
    const nNax=D.filas.filter(f=>isFinite(f.tN)).length,pN=isFinite(T.tN)?(T.tN-T.tcae)/T.tcae:NaN;
    const txt=`Al cierre de la **quincena ${meta.n}** de la zafra ${meta.zafra} (piezas terminadas al ${coDF(meta.fecha)}) se han cosechado **${fmt(new Set(R.map(r=>r.id)).size)} piezas**, **${fmt(T.ac)} acres** y **${fmt(T.ton)} t** de caña molida. `+
      `Tomando como referencia el estimado del Ingenio (**${fmt(T.tcae,2)} TCA** promedio), el TCA real promedia **${fmt(T.tca,2)} TCA**, es decir **${sg(T.dif)} TCA (${pc(T.pdif)})**`+(nNax?`; NAX promedia **${fmt(T.tN,2)} TCA**, ${sg(T.tN-T.tcae)} TCA (${pc(pN)}) respecto al Ingenio`:'')+'. '+
      (RR.n&&SS.n?`La diferencia real vs Ingenio es de **${sg(RR.dif)} TCA** en riego y **${sg(SS.dif)} TCA** en secano. `:'')+
      (bajo.length?`${bajo.join(', ')} ${bajo.length>1?'son las divisiones':'es la división'} donde el real queda por debajo del Ingenio. `:'En todas las divisiones el real supera al estimado del Ingenio. ')+`REND 96 promedio: **${fmt(T.r96*100,2)}%**.`;
    const pags=M.f.length?2:1;let{cv,c,W}=coPdfPagina(1,pags,meta);const X=90,CW=W-180;
    c.fillStyle='#1F4E79';c.font='700 50px Inter, Arial';c.fillText(`Informe quincena ${meta.n}`,X,140);
    c.fillStyle='#5B6673';c.font='24px Inter, Arial';c.fillText(`Central Romana Corporation · Área de Agricultura de Precisión · Zafra ${meta.zafra} · Cosecha al ${coDF(meta.fecha)}${NX&&NX.rango?' · Corte NAX '+coDF(NX.rango[1]):''}${coFiltTxt()?' · '+coFiltTxt():''}`,X,186);
    c.fillStyle='#1F2933';c.font='27px Inter, Arial';let y=coWrap(c,txt,X,250,CW,40);
    y+=30;c.fillStyle='#1F4E79';c.font='700 32px Inter, Arial';c.fillText('Tabla resumen',X,y);y+=24;
    const cols=[{t:'División (S/R)',w:280,a:'left'},{t:'Acres',w:130},{t:'TCA Ingenio',w:160},{t:'TCA Real',w:150},{t:'TCA NAX',w:150},{t:'Real vs Ing.',w:160},{t:'Dif. %',w:140},{t:'NAX vs Ing.',w:160},{t:'REND 96',w:122}];
    const cc=v=>isFinite(v)?(v>=0?'#2E7D32':'#C62828'):'#1F2933';
    const fila=(f,tot)=>{const r=[f.lab,fmt(f.ac),fmt(f.tcae,2),fmt(f.tca,2),fmt(f.tN,2),sg(f.dif),pc(f.pdif),sg(f.dN),isFinite(f.r96)?fmt(f.r96*100,2)+'%':'–'];r._col=[0,0,0,0,0,cc(f.dif),cc(f.pdif),cc(f.dN),0];r._tot=tot;return r};
    y=coPdfTabla(c,X,y,cols,[...D.filas.map(f=>fila(f)),fila(T,true)],{rh:50});
    y+=70;coPdfBarras(c,X,y,CW,Math.min(720,2000-y-60),D.filas,[['tcae','Estimado Ingenio','#A6A6A6'],['tca','Real','#1F4E79'],['tN','NAX','#0070C9']],'TCA promedio por división y régimen','TCA (t/acre)');
    const pages=[cv];
    if(M.f.length){const p2=coPdfPagina(2,pags,meta);const c2=p2.c;c2.fillStyle='#1F4E79';c2.font='700 40px Inter, Arial';c2.textAlign='left';c2.fillText('Índice de maduración NAX',X,140);
      c2.fillStyle='#1F2933';c2.font='27px Inter, Arial';let y2=coWrap(c2,`Rendimiento (REND 96 promedio) y toneladas molidas según el índice de maduración que reportaba NAX para cada pieza al momento de cargar la quincena en que se cosechó. ${fmt(M.tot.n)} filas con índice de maduración.`,X,200,CW,40)+20;
      const L=110,R2=130,PH=700,ch=y2+40,gw=(CW-L-R2)/M.f.length,mr=Math.max(...M.f.map(f=>f.r96).filter(isFinite))*1.15,mt=Math.max(...M.f.map(f=>f.ton))*1.15;
      c2.font='22px Inter, Arial';[['#1F4E79','Promedio de REND 96'],['#0070C9','Suma de TON_MOL']].forEach(([col,n],j)=>{const lx=X+CW/2-300+j*330;c2.fillStyle=col;c2.fillRect(lx,y2,40,20);c2.fillStyle='#1F2933';c2.fillText(n,lx+50,y2+19)});
      niceBreaks(mr*100,6).forEach(t=>{const yy=ch+PH-PH*t/100/mr;if(yy<ch)return;c2.strokeStyle='#E5E8EC';c2.lineWidth=1.5;c2.beginPath();c2.moveTo(X+L,yy);c2.lineTo(X+CW-R2,yy);c2.stroke();c2.fillStyle='#5B6673';c2.textAlign='right';c2.fillText(fmt(t,1)+'%',X+L-12,yy+7)});
      niceBreaks(mt,6).forEach(t=>{const yy=ch+PH-PH*t/mt;if(yy<ch)return;c2.fillStyle='#0070C9';c2.textAlign='left';c2.fillText(fmt(t),X+CW-R2+12,yy+7)});
      M.f.forEach((f,i)=>{const x=X+L+i*gw;if(isFinite(f.r96)){const bh=PH*f.r96/mr;c2.fillStyle='#1F4E79';c2.fillRect(x+gw*.18,ch+PH-bh,gw*.64,bh);c2.fillStyle='#1F2933';c2.textAlign='center';c2.font='19px Inter, Arial';c2.fillText(fmt(f.r96*100,2)+'%',x+gw/2,ch+PH-bh-10)}
        c2.fillStyle='#1F2933';c2.textAlign='center';c2.font='21px Inter, Arial';c2.fillText(f.lab,x+gw/2,ch+PH+34)});
      c2.strokeStyle='#0070C9';c2.lineWidth=4;c2.beginPath();M.f.forEach((f,i)=>{const xx=X+L+i*gw+gw/2,yy=ch+PH-PH*f.ton/mt;i?c2.lineTo(xx,yy):c2.moveTo(xx,yy)});c2.stroke();
      M.f.forEach((f,i)=>{c2.fillStyle='#0070C9';c2.beginPath();c2.arc(X+L+i*gw+gw/2,ch+PH-PH*f.ton/mt,8,0,7);c2.fill()});
      c2.fillStyle='#1F2933';c2.textAlign='center';c2.font='22px Inter, Arial';c2.fillText('Índice de maduración NAX',X+L+(CW-L-R2)/2,ch+PH+80);
      let y3=ch+PH+140;c2.fillStyle='#1F4E79';c2.font='700 32px Inter, Arial';c2.textAlign='left';c2.fillText('Tabla de maduración',X,y3);y3+=24;
      coPdfTabla(c2,X,y3,[{t:'Índice de maduración',w:500,a:'left'},{t:'Promedio de REND 96',w:450},{t:'Suma de TON_MOL',w:502}],[...M.f.map(f=>[f.lab,isFinite(f.r96)?fmt(f.r96*100,2)+'%':'–',fmt(f.ton)]),Object.assign([M.tot.lab,fmt(M.tot.r96*100,2)+'%',fmt(M.tot.ton)],{_tot:true})],{rh:48});pages.push(p2.cv)}
    const{jsPDF}=window.jspdf,pdf=new jsPDF({orientation:'portrait',unit:'mm',format:'letter'});pdf.setProperties({title:`Informe quincena ${meta.n}`});
    pages.forEach((p,i)=>{if(i)pdf.addPage('letter','portrait');pdf.addImage(p.toDataURL('image/jpeg',0.93),'JPEG',0,0,215.9,279.4,undefined,'SLOW')});
    saveFile(`Informe_quincena_${meta.n}_zafra_${meta.zafra}.pdf`,pdf.output('blob'),st)}catch(e){st.textContent='No se pudo armar el PDF: '+(e.message||e)}};
