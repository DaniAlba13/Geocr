/* ================= ALERTAS NAX (lógica de reporte.py) ================= */
const NX_DIVORD=['Higueral','Guaymate','La Higuera','Chavón Abajo','Cuyá','Lechugas','Baigua'],NX_RIEGO=['Higueral','Baigua'];
const NX_HUM='moisture_percentage_optical_and_sar';
const NX_RANGOS={
  [NX_HUM]:{n:'Humedad',k:'hum',d:'Este modelo estima el contenido de humedad del suelo a partir de sensores ópticos y de radar, permitiendo identificar de forma temprana los campos con déficit hídrico que podrían requerir riego o atención agronómica.',t:[[72,'Bien','#2E7D32'],[70,'Revisar','#EF6C00'],[-Infinity,'Alerta por deficit de humedad','#C62828']]},
  ndvi_optical:{n:'NDVI (vigor vegetal)',k:'ndvi',d:'El NDVI mide el vigor vegetativo del cultivo a partir de imágenes satelitales, permitiendo identificar zonas con crecimiento saludable frente a otras con posibles deficiencias nutricionales, hídricas o de manejo.',t:[[0.57,'Vigor alto','#2E7D32'],[0.53,'Vigor normal','#9E9D24'],[0.50,'Vigor bajo','#EF6C00'],[-Infinity,'Vigor critico','#C62828']]},
  biomass_optical:{n:'Biomasa (Área Foliar)',k:'bio',d:'Este modelo estima la biomasa foliar del cultivo, un indicador del desarrollo y la densidad de la cobertura vegetal, útil para monitorear el crecimiento a lo largo del ciclo y detectar variaciones respecto al comportamiento esperado.',t:[[1.5,'Biomasa alta','#2E7D32'],[1.0,'Biomasa normal','#9E9D24'],[0.5,'Biomasa baja','#EF6C00'],[-Infinity,'Biomasa critica','#C62828']]}};
const NX_FAC=2.47,NX_TCAMIN=10,NX_DPM=30.44;
function nxCSV(text){const rows=[];let row=[],f='',q=false,i=0,n=text.length;
  while(i<n){const c=text[i];if(q){if(c==='"'){if(text[i+1]==='"'){f+='"';i++}else q=false}else f+=c}
    else if(c==='"')q=true;else if(c===','){row.push(f);f=''}else if(c==='\n'){row.push(f.replace(/\r$/,''));rows.push(row);row=[];f=''}else f+=c;i++}
  if(f||row.length){row.push(f.replace(/\r$/,''));rows.push(row)}
  const h=rows.shift()||[];return{h,rows:rows.filter(r=>r.length>1)}}
const nxNum=v=>{if(v===undefined||v===null||v==='')return NaN;const x=+v;return isFinite(x)?x:NaN};
const nxEmpty=v=>v===undefined||v===null||(typeof v==='number'&&!isFinite(v))||['N/D','Todos los tablones','None','nan',''].includes(String(v));
function nxName(v){if(v===undefined||v===null||v==='')return null;let t=String(v).trim();if(t.endsWith('.0'))t=t.slice(0,-2);if(/^\d+$/.test(t)&&t.length<=11)t=t.padStart(11,'0');return t}
function nxDiv(v){if(v===undefined||v===null||v==='')return null;let t=String(v).trim();if(t.endsWith('.0'))t=t.slice(0,-2);const m=t.match(/^0*(\d+)/);const k=m?m[1]:t;return DIVN[k]||t}
function nxRiego(v){const t=String(v??'').trim().toUpperCase();if(['1','1.0','TRUE','SI','SÍ','S','YES','Y','R','REGADIO','REGADÍO'].includes(t))return 1;return +t===1?1:0}
const nxDate=v=>{const t=Date.parse(String(v||'').slice(0,10));return isFinite(t)?t:NaN};
/* filas crudas -> registros normalizados (equivalente a _normalizar_columnas) */
function nxNormalize(csv){const H=csv.h,ix=n=>H.indexOf(n),get=(r,n)=>{const i=ix(n);return i<0?undefined:r[i]};
  const numCount=c=>{const i=ix(c);let k=0;for(const r of csv.rows)if(isFinite(nxNum(r[i])))k++;return k};
  let humCol=ix(NX_HUM)>=0?NX_HUM:null;if(!humCol){const cs=H.filter(c=>/humid|moisture/i.test(c));if(cs.length)humCol=cs.reduce((a,b)=>numCount(b)>numCount(a)?b:a)}
  const tshC=H.filter(c=>/tsh|yield_sugarcane/i.test(c)&&c!=='estimated_crop_yield'&&c!=='crop_yield');const tshCol=tshC.length?tshC.reduce((a,b)=>numCount(b)>numCount(a)?b:a):null;
  const mets=Object.keys(NX_RANGOS).filter(m=>m===NX_HUM?!!humCol:ix(m)>=0);
  const hasName=ix('name')>=0,hasTab=ix('grouping_unit_04')>=0,hasIrr=ix('irrigation')>=0;
  if(!hasName&&!hasTab)throw new Error('El archivo no trae las columnas name ni grouping_unit_04.');
  const recs=csv.rows.map(r=>{const nm=hasName?nxName(get(r,'name')):null;let tab=hasTab?String(get(r,'grouping_unit_04')||'').replace(/\.0$/,''):'',pz=String(get(r,'grouping_unit_05')??'N/D').replace(/\.0$/,'')||'N/D';
    if(nm&&nm.length<=11){tab=nm.slice(4,8);pz=nm.slice(8,11)}
    let div=ix('grouping_unit_02')>=0?(nxDiv(get(r,'grouping_unit_02'))||'Todos los tablones'):'Todos los tablones';
    const reg=hasIrr?nxRiego(get(r,'irrigation')):null;if(hasIrr&&NX_RIEGO.includes(div))div+=reg?' (R)':' (S)';
    const o={id:nm||tab,tab,pz,div,reg,var:get(r,'variety')||'N/D',ac:nxNum(get(r,'effective_area')),fi:nxDate(get(r,'start_date')),ts:nxDate(get(r,'timestamp')),
      tcaN:tshCol?nxNum(get(r,tshCol))/NX_FAC:NaN,tcaI:nxNum(get(r,'estimated_crop_yield'))/NX_FAC,tcaR:nxNum(get(r,'crop_yield'))/NX_FAC};
    mets.forEach(m=>o[m]=nxNum(get(r,m===NX_HUM?humCol:m)));return o});
  return{recs,mets}}
function nxMaestro(csv){if(!csv)return null;const{recs}=nxNormalize(csv);const m=new Map();recs.forEach(r=>{if(!m.has(r.id))m.set(r.id,r)});return m}
/* última lectura por pieza, cada columna por separado */
function nxUltima(recs,cols){const by=new Map();recs.forEach(r=>{const a=by.get(r.id);if(!a)by.set(r.id,[r]);else a.push(r)});const out=[];
  by.forEach(arr=>{arr.sort((a,b)=>(a.ts||0)-(b.ts||0));const o={...arr[arr.length-1]};cols.forEach(c=>{o[c]=NaN;for(let i=arr.length-1;i>=0;i--)if(isFinite(arr[i][c])){o[c]=arr[i][c];break}});out.push(o)});return out}
const NX_ATTR=['tab','pz','div','var','ac','fi','reg','tcaN','tcaR','tcaI'];
function nxCompletar(rows,maestro,cols){if(!maestro)return rows;const seen=new Set();
  rows.forEach(r=>{seen.add(r.id);const m=maestro.get(r.id);if(!m)return;NX_ATTR.forEach(a=>{if(nxEmpty(r[a])&&!nxEmpty(m[a]))r[a]=m[a]})});
  maestro.forEach((m,id)=>{if(seen.has(id))return;const o={id,ts:NaN};NX_ATTR.forEach(a=>o[a]=m[a]);cols.forEach(c=>o[c]=NaN);rows.push(o)});return rows}
const nxMedian=a=>{if(!a.length)return NaN;const s=[...a].sort((x,y)=>x-y),k=s.length>>1;return s.length%2?s[k]:(s[k-1]+s[k])/2};
function nxProyectar(rows,col,etq='Satelital',minimo){const hoy=nxHoy();const val=rows.map(r=>{const v=r[col];return isFinite(v)&&(minimo===undefined||v>=minimo)?v:NaN}),obs=val.map(isFinite);
  if(!obs.some(Boolean)){rows.forEach(r=>{r[col]=NaN;r[col+'_o']='Sin dato'});return}
  const keyP=r=>[r.div==null?'':String(r.div),r.reg==null?'':String(r.reg),isFinite(r.fi)?String(Math.round((hoy-r.fi)/864e5/NX_DPM)):''];
  const ks=rows.map(keyP),cur=[...val];
  for(const n of[3,2,1]){if(!cur.some(v=>!isFinite(v)))break;const g=new Map();rows.forEach((r,i)=>{if(!obs[i])return;const k=ks[i].slice(0,n).join('|');if(!g.has(k))g.set(k,[]);g.get(k).push(val[i])});
    const med=new Map([...g].map(([k,a])=>[k,nxMedian(a)]));rows.forEach((r,i)=>{if(isFinite(cur[i]))return;const m=med.get(ks[i].slice(0,n).join('|'));if(m!==undefined&&isFinite(m))cur[i]=m})}
  const gm=nxMedian(val.filter(isFinite));rows.forEach((r,i)=>{r[col]=isFinite(cur[i])?cur[i]:gm;r[col+'_o']=obs[i]?etq:'Proyectado'})}
function nxClasificar(v,t){if(!isFinite(v))return'Sin dato';for(const[u,e]of t)if(v>=u)return e;return null}
let NX_TODAY=null;const nxHoy=()=>NX_TODAY||(()=>{const d=new Date();return Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())})();
/* proceso completo -> snapshot compacto */
function nxProcesar(F){
  const act=nxNormalize(F.hist),mets=act.mets,cols=[...mets,'tcaN','tcaR','tcaI'];
  const maestro=nxMaestro(F.maestro);let rows=nxUltima(act.recs,cols);const antes=rows.length;rows=nxCompletar(rows,maestro,mets);
  mets.forEach(m=>nxProyectar(rows,m));nxProyectar(rows,'tcaN','Estimado NAX',NX_TCAMIN);
  const hoy=nxHoy();
  const ts=act.recs.map(r=>r.ts).filter(isFinite);const rango=[iso(new Date(Math.min(...ts))),iso(new Date(Math.max(...ts)))];
  // campaña anterior
  let ant=null;if(F.histAnt||F.maestroAnt){ant={obs:{},tca:[]};const prev=F.histAnt?nxNormalize(F.histAnt):{recs:[],mets:[]};const mA=nxMaestro(F.maestroAnt);
    mets.forEach(m=>{if(!prev.recs.length||!prev.mets.includes(m))return;ant.obs[NX_RANGOS[m].k]=nxUltima(prev.recs.filter(r=>isFinite(r[m])),[m]).map(r=>[r.div,+r[m].toFixed(4)])});
    let base=prev.recs.length?nxUltima(prev.recs.filter(r=>isFinite(r.tcaN)),['tcaN']):[];base=nxCompletar(base,mA,['tcaN']);
    if(base.length){nxProyectar(base,'tcaN','Estimado NAX',NX_TCAMIN);ant.tca=base.filter(r=>isFinite(r.tcaN)&&r.reg!=null).map(r=>[r.div,r.reg,+r.tcaN.toFixed(3)])}}
  const P=rows.map(r=>{const o={id:r.id,tab:r.tab,pz:r.pz,div:r.div||'Todos los tablones',v:r.var,ac:isFinite(+r.ac)?+(+r.ac).toFixed(3):null,fi:isFinite(r.fi)?iso(new Date(r.fi)):null,reg:r.reg,
      tN:isFinite(r.tcaN)?+r.tcaN.toFixed(3):null,tNo:r.tcaN_o,tI:isFinite(r.tcaI)?+r.tcaI.toFixed(3):null,tR:isFinite(r.tcaR)?+r.tcaR.toFixed(3):null};
    mets.forEach(m=>{const k=NX_RANGOS[m].k;o[k]=isFinite(r[m])?+r[m].toFixed(4):null;o[k+'o']=r[m+'_o']});return o});
  return{v:1,fecha:new Date().toISOString(),hoy:iso(new Date(hoy)),rango,mets:mets.map(m=>NX_RANGOS[m].k),P,ant,agregadas:rows.length-antes,maestro:!!maestro}}
const NX_OR=['Satelital','Proyectado','Estimado NAX','Sin dato'];
function nxPack(S){const D=[...new Set([...S.P.map(p=>p.div),...(S.ant?[...Object.values(S.ant.obs).flat(),...S.ant.tca].map(a=>a[0]):[])])],di=d=>D.indexOf(d),cols=Object.keys(S.P[0]);
  const enc=(c,v)=>c==='div'?di(v):/o$/.test(c)&&c!=='pz'?NX_OR.indexOf(v):v;
  return{...S,v:2,D,cols,P:S.P.map(p=>cols.map(c=>enc(c,p[c]))),ant:S.ant&&{obs:Object.fromEntries(Object.entries(S.ant.obs).map(([k,a])=>[k,a.map(x=>[di(x[0]),x[1]])])),tca:S.ant.tca.map(x=>[di(x[0]),x[1],x[2]])}}}
function nxUnpack(S){if(S.v!==2)return S;const D=S.D,cols=S.cols;
  return{...S,P:S.P.map(r=>{const o={};cols.forEach((c,i)=>{const v=r[i];o[c]=c==='div'?D[v]:/o$/.test(c)&&c!=='pz'?NX_OR[v]:v});return o}),ant:S.ant&&{obs:Object.fromEntries(Object.entries(S.ant.obs).map(([k,a])=>[k,a.map(x=>[D[x[0]],x[1]])])),tca:S.ant.tca.map(x=>[D[x[0]],x[1],x[2]])}}}
