/* ================= SUELOS: análisis de suelo por pieza e interpolación (IDW) ================= */
/* Base: hoja "AREA REVISADA FINAL V2" (una fila por pieza). Cada análisis se ubica en el centroide de su pieza y
   la superficie se interpola con distancia inversa ponderada (IDW) dentro de un radio máximo, recortada a las piezas. */
const SU_BASE=__SUELOS__;
const SU_NUT=['#C62828','#F59E0B','#FDD835','#7CB342','#1E5E14'],SU_TEX=['#E3F2FD','#90CAF9','#42A5F5','#1565C0','#0D2E5C'];
const SU_PAR={
  mo:{n:'Materia orgánica',u:'%',d:2,br:[2,3,4,6],lab:['Muy baja','Baja','Media','Alta','Muy alta'],pal:SU_NUT},
  ph:{n:'pH',u:'',d:2,br:[5.5,6.5,7.3,7.8],lab:['Fuertemente ácido','Ligeramente ácido','Neutro','Ligeramente alcalino','Alcalino'],pal:['#C62828','#F59E0B','#2E7D32','#5C6BC0','#4A148C']},
  p:{n:'Fósforo (P)',u:'ppm',d:1,br:[10,20,40,80],lab:['Muy bajo','Bajo','Medio','Alto','Muy alto'],pal:SU_NUT},
  k:{n:'Potasio (K)',u:'ppm',d:0,br:[100,200,300,500],lab:['Muy bajo','Bajo','Medio','Alto','Muy alto'],pal:SU_NUT},
  ca:{n:'Calcio (Ca)',u:'ppm',d:0,br:[1000,3000,5000,7000],lab:['Muy bajo','Bajo','Medio','Alto','Muy alto'],pal:SU_NUT},
  mg:{n:'Magnesio (Mg)',u:'ppm',d:0,br:[120,250,400,700],lab:['Muy bajo','Bajo','Medio','Alto','Muy alto'],pal:SU_NUT},
  cic:{n:'CIC',u:'cmol/kg',d:1,br:[10,20,35,50],lab:['Muy baja','Baja','Media','Alta','Muy alta'],pal:SU_NUT},
  n:{n:'Nitrógeno total',u:'%',d:3,br:[.1,.15,.2,.3],lab:['Muy bajo','Bajo','Medio','Alto','Muy alto'],pal:SU_NUT},
  na:{n:'Sodio (Na)',u:'ppm',d:0,br:[50,100,200,400],lab:['Muy bajo','Bajo','Medio','Alto','Muy alto'],pal:SU_TEX},
  ce:{n:'Conductividad eléctrica',u:'µS/cm',d:0,br:[200,400,800,1500],lab:['Muy baja','Baja','Media','Alta','Muy alta'],pal:SU_TEX},
  arcilla:{n:'Arcilla',u:'%',d:0,br:[20,35,45,55],lab:['Muy baja','Baja','Media','Alta','Muy alta'],pal:SU_TEX},
  arena:{n:'Arena',u:'%',d:0,br:[15,20,30,40],lab:['Muy baja','Baja','Media','Alta','Muy alta'],pal:SU_TEX},
  limo:{n:'Limo',u:'%',d:0,br:[20,25,30,35],lab:['Muy bajo','Bajo','Medio','Alto','Muy alto'],pal:SU_TEX},
  gravas:{n:'Gravas',u:'%',d:0,br:[5,15,30,40],lab:['Muy bajas','Bajas','Medias','Altas','Muy altas'],pal:SU_TEX},
};
const SU={base:SU_BASE,pts:null,idx:null,key:'mo',modo:'interp',div:'',anio:0,R:1500,pot:2,lo:null,hi:null,br:null,view:null,res:null,hi_c:new Set()};
/* centroide (UTM) y acres de cada pieza de la capa */
const SU_PZ=(()=>{const m=new Map();EMBED_PIECES.forEach(p=>{const k=p[0]+'|'+p[1]+'|'+p[2],U=p[3].map(q=>llToUtm(q[0],q[1]));let a=0,cx=0,cy=0;
  for(let i=0,j=U.length-1;i<U.length;j=i++){const f=U[j][0]*U[i][1]-U[i][0]*U[j][1];a+=f;cx+=(U[j][0]+U[i][0])*f;cy+=(U[j][1]+U[i][1])*f}
  a/=2;if(!m.has(k))m.set(k,{A:0,X:0,Y:0,p});const o=m.get(k);if(Math.abs(a)>1){o.A+=Math.abs(a);o.X+=cx/(6*a)*Math.abs(a);o.Y+=cy/(6*a)*Math.abs(a)}});
  m.forEach(o=>{if(o.A>0){o.x=o.X/o.A;o.y=o.Y/o.A}else{const U=o.p[3].map(q=>llToUtm(q[0],q[1]));o.x=U.reduce((s,q)=>s+q[0],0)/U.length;o.y=U.reduce((s,q)=>s+q[1],0)/U.length}o.ac=o.A/M2_PER_ACRE});return m})();
function suBuild(){const B=SU.base,ci=B.campos.indexOf(SU.key),pts=[];let sinCapa=0;
  for(const f of B.filas){const v=f[4+ci];if(v==null)continue;if(SU.anio&&(!f[3]||f[3]<SU.anio))continue;const k=f[0]+'|'+f[1]+'|'+f[2],pz=SU_PZ.get(k);if(!pz){sinCapa++;continue}
    pts.push({k,div:f[0],tab:f[1],pz:f[2],anio:f[3],v,x:pz.x,y:pz.y,ac:pz.ac,f})}
  /* índice espacial en celdas del tamaño del radio */
  const R=SU.R,idx=new Map();pts.forEach(q=>{const c=Math.floor(q.x/R)+','+Math.floor(q.y/R);if(!idx.has(c))idx.set(c,[]);idx.get(c).push(q)});
  SU.pts=pts;SU.idx=idx;SU.sinCapa=sinCapa;SU.med=new Map(pts.map(q=>[q.k,q]))}
function suIdw(E,N){const R=SU.R,R2=R*R,cx=Math.floor(E/R),cy=Math.floor(N/R);let ws=0,s=0,hit=false;
  for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++){const L=SU.idx.get((cx+i)+','+(cy+j));if(!L)continue;
    for(const q of L){const dx=q.x-E,dy=q.y-N,d2=dx*dx+dy*dy;if(d2>R2)continue;hit=true;const w=1/Math.pow(Math.max(d2,400),SU.pot/2);ws+=w;s+=w*q.v}}
  return hit?s/ws:null}
const suBr=()=>SU.br||SU_PAR[SU.key].br;
const suCls=v=>{const b=suBr();let i=0;while(i<b.length&&v>=b[i])i++;return i};
const suLab=i=>{const P=SU_PAR[SU.key],b=suBr(),f=x=>fmt(x,P.d>2?2:P.d),u=P.u?' '+P.u:'';const r=i===0?`< ${f(b[0])}`:i===b.length?`≥ ${f(b[b.length-1])}`:`${f(b[i-1])} – ${f(b[i])}`;return`${P.lab[i]||''} (${r}${u})`};
const suPass=v=>(SU.lo==null||v>=SU.lo)&&(SU.hi==null||v<=SU.hi);
const suColor=v=>{if(v==null)return null;const i=suCls(v);if(SU.hi_c.size&&!SU.hi_c.has(i))return'#D5DAE1';if(!suPass(v))return'#D5DAE1';return SU_PAR[SU.key].pal[i]};
/* valor por pieza: medido o (en modo interpolado) estimado en su centroide */
function suValPieza(k){const m=SU.med.get(k);if(m)return{v:m.v,med:true};if(SU.modo!=='interp')return null;const pz=SU_PZ.get(k);if(!pz)return null;const v=suIdw(pz.x,pz.y);return v==null?null:{v,med:false}}
function suResumen(){const P=SU_PAR[SU.key],n=suBr().length+1,cl=Array.from({length:n},()=>({n:0,ac:0,med:0}));let sv=0,sa=0,mn=1e9,mx=-1e9,nm=0,ac=0;
  SU_PZ.forEach((pz,k)=>{if(SU.div&&+k.split('|')[0]!==+SU.div)return;const r=suValPieza(k);if(!r)return;const i=suCls(r.v);cl[i].n++;cl[i].ac+=pz.ac;if(r.med)cl[i].med++;
    if(suPass(r.v)){sv+=r.v*pz.ac;sa+=pz.ac}ac+=pz.ac;if(r.med){nm++;mn=Math.min(mn,r.v);mx=Math.max(mx,r.v)}});
  SU.res={cl,media:sa?sv/sa:NaN,mn,mx,nm,ac,acF:sa}}
function suTitulo(){const P=SU_PAR[SU.key];let t=`${P.n}${P.u?' ('+P.u+')':''} · ${SU.modo==='interp'?'interpolado por IDW':'valor medido por pieza'}`;if(SU.div)t+=' · Div. '+DIVN[SU.div];if(SU.anio)t+=` · análisis desde ${SU.anio}`;return t}
function suDraw(){if(!$('#s-suelos')||!$('#s-suelos').classList.contains('on'))return;suBuild();suResumen();suLayout($('#suMap'),null);suPanel()}
function suPanel(){const P=SU_PAR[SU.key],R=SU.res,u=P.u?' '+P.u:'';
  $('#suK1').textContent=fmt(SU.div?SU.pts.filter(q=>q.div===+SU.div).length:SU.pts.length);$('#suK2l').textContent=SU.lo!=null||SU.hi!=null?'Media ponderada (filtro)':'Media ponderada';$('#suK2').textContent=isFinite(R.media)?fmt(R.media,P.d)+u:'–';$('#suK3').textContent=R.nm?`${fmt(R.mn,P.d)} – ${fmt(R.mx,P.d)}`:'–';$('#suK4').textContent=fmt(R.ac);
  const tot=R.cl.reduce((s,c)=>s+c.ac,0)||1;
  $('#suTbl').innerHTML=`<tr><th>Rango</th><th class="n">Piezas</th><th class="n">Con análisis</th><th class="n">Acres</th><th class="n">% acres</th><th></th></tr>`+R.cl.map((c,i)=>`<tr data-i="${i}" style="cursor:pointer;${SU.hi_c.size&&!SU.hi_c.has(i)?'opacity:.45':''}"><td><i style="display:inline-block;width:12px;height:12px;background:${P.pal[i]};margin-right:8px;vertical-align:-1px"></i>${suLab(i)}</td><td class="n">${fmt(c.n)}</td><td class="n">${fmt(c.med)}</td><td class="n">${fmt(c.ac)}</td><td class="n">${fmt(c.ac/tot*100,1)}</td><td><span class="sevbar" style="width:${Math.max(2,c.ac/tot*140)}px;background:${P.pal[i]}"></span></td></tr>`).join('');
  $$('#suTbl tr[data-i]').forEach(tr=>tr.onclick=()=>{const i=+tr.dataset.i;SU.hi_c.has(i)?SU.hi_c.delete(i):SU.hi_c.add(i);suDraw()});
  $('#suNota').innerHTML=`${fmt(SU.pts.length)} piezas con análisis de ${P.n==='pH'||P.n==='CIC'?P.n:P.n.toLowerCase()} ubicadas en su centroide${SU.sinCapa?` (${fmt(SU.sinCapa)} del archivo no están en la capa CR)`:''}. `+
    (SU.modo==='interp'?`Cada punto del mapa se estima con los análisis a menos de ${fmt(SU.R)} m (IDW, potencia ${SU.pot}); las piezas sin análisis cercano quedan en gris. `:'Solo se colorean las piezas con análisis. ')+
    (SU.lo!=null||SU.hi!=null?`Filtro: ${SU.lo!=null?'≥ '+fmt(SU.lo,P.d):''}${SU.lo!=null&&SU.hi!=null?' y ':''}${SU.hi!=null?'≤ '+fmt(SU.hi,P.d):''}${u} (lo demás en gris). `:'')+`Fuente: ${xesc(SU.base.fuente||'base de suelos')}.`}
function suLayout(cv,T){
  const W=T?T.W:Math.max(cv.parentElement.clientWidth,700),H=Math.round(W*0.70),dpr=T?1:(window.devicePixelRatio||1);
  cv.width=W*dpr;cv.height=H*dpr;if(!T)cv.style.height=H+'px';const ctx=cv.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
  const s=W/1290,F={x:28*s,y:72*s,w:950*s,h:770*s},PN={x:1010*s,y:78*s,w:265*s,h:768*s},P=SU_PAR[SU.key],clip=EMBED_LAYERS.mask,UT=(lon,lat)=>llToUtm(lon,lat);
  const sel=SU.div?EMBED_PIECES.filter(p=>p[0]===+SU.div):[];
  let bb=bboxPts((sel.length?sel.flatMap(p=>p[3]):polyPts(clip)).map(q=>UT(q[0],q[1])));const pd=Math.max(bb[2]-bb[0],bb[3]-bb[1])*.05;bb=[bb[0]-pd,bb[1]-pd,bb[2]+pd,bb[3]+pd];
  const sc=Math.min(F.w/(bb[2]-bb[0]),F.h/(bb[3]-bb[1])),cx=(bb[0]+bb[2])/2,cy=(bb[1]+bb[3])/2;
  const toPx=(E,N)=>[F.x+F.w/2+(E-cx)*sc,F.y+F.h/2-(N-cy)*sc],toE=(x,y)=>[cx+(x-F.x-F.w/2)/sc,cy-(y-F.y-F.h/2)/sc],px=(lon,lat)=>toPx(...UT(lon,lat));
  const ring=r=>{let x0,y0;r.forEach((q,i)=>{const[x,y]=px(q[0],q[1]);if(i)ctx.lineTo(x,y);else{ctx.moveTo(x,y);x0=x;y0=y}});ctx.lineTo(x0,y0)};
  const path=Pl=>{ctx.beginPath();for(const p of Pl)for(const r of p)ring(r)};
  ctx.save();ctx.beginPath();ctx.rect(F.x,F.y,F.w,F.h);ctx.clip();
  const span=Math.max(bb[2]-bb[0],bb[3]-bb[1]),gs=[1000,2000,5000,10000,20000].find(g=>span/g<=10)||50000,ticks={x:[],y:[]};ctx.strokeStyle='rgba(120,120,120,.3)';ctx.lineWidth=.6;
  for(let E=Math.ceil(bb[0]/gs)*gs;E<=bb[2];E+=gs){const[x]=toPx(E,cy);ticks.x.push([x,E]);ctx.beginPath();ctx.moveTo(x,F.y);ctx.lineTo(x,F.y+F.h);ctx.stroke()}
  for(let N=Math.ceil(bb[1]/gs)*gs;N<=bb[3];N+=gs){const[,y]=toPx(cx,N);ticks.y.push([y,N]);ctx.beginPath();ctx.moveTo(F.x,y);ctx.lineTo(F.x+F.w,y);ctx.stroke()}
  path(clip);ctx.fillStyle='#F7F8FA';ctx.fill('evenodd');
  const pzs=SU.div?sel:EMBED_PIECES;
  ctx.beginPath();pzs.forEach(p=>ring(p[3]));ctx.fillStyle='#E6E9ED';ctx.fill();
  if(SU.modo==='interp'){
    /* superficie IDW: se calcula en una malla de pantalla y se recorta a las piezas */
    const cell=Math.max(2,Math.round(3*s*(T?1.4:1))),nx=Math.ceil(F.w/cell),ny=Math.ceil(F.h/cell),oc=document.createElement('canvas');oc.width=nx;oc.height=ny;
    const oct=oc.getContext('2d'),im=oct.createImageData(nx,ny),d=im.data,rgb=new Map();const hx=c=>{if(!rgb.has(c))rgb.set(c,[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)));return rgb.get(c)};
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const[E,N]=toE(F.x+(i+.5)*cell,F.y+(j+.5)*cell),v=suIdw(E,N);if(v==null)continue;const c=suColor(v);if(!c)continue;const[r,g,b]=hx(c),o=(j*nx+i)*4;d[o]=r;d[o+1]=g;d[o+2]=b;d[o+3]=255}
    oct.putImageData(im,0,0);ctx.save();ctx.beginPath();pzs.forEach(p=>ring(p[3]));ctx.clip();ctx.imageSmoothingEnabled=false;ctx.drawImage(oc,F.x,F.y,nx*cell,ny*cell);ctx.restore();
  }else{const groups=new Map();pzs.forEach(p=>{const m=SU.med.get(p[0]+'|'+p[1]+'|'+p[2]),c=m?suColor(m.v):null;if(!c)return;if(!groups.has(c))groups.set(c,[]);groups.get(c).push(p[3])});
    groups.forEach((rs,c)=>{ctx.beginPath();rs.forEach(ring);ctx.fillStyle=c;ctx.fill()})}
  ctx.beginPath();pzs.forEach(p=>ring(p[3]));ctx.strokeStyle='rgba(255,255,255,.75)';ctx.lineWidth=.35*s;ctx.stroke();
  if($('#suPts').checked){ctx.fillStyle='#111';SU.pts.forEach(q=>{if(SU.div&&q.div!==+SU.div)return;const[x,y]=toPx(q.x,q.y);ctx.beginPath();ctx.arc(x,y,Math.max(1,1.3*s),0,7);ctx.fill()})}
  EMBED_LAYERS.divs.forEach(d=>{path(d.polys);ctx.strokeStyle='#2B2B2B';ctx.lineWidth=1.5*s;ctx.stroke()});
  path(clip);ctx.strokeStyle='#111';ctx.lineWidth=2*s;ctx.stroke();
  ctx.font=`bold ${16*s}px Arial`;ctx.textAlign='center';EMBED_LAYERS.divs.forEach(d=>{const[x,y]=px(d.lab[0],d.lab[1]);ctx.lineWidth=4*s;ctx.strokeStyle='rgba(255,255,255,.9)';ctx.strokeText('Div. '+d.name,x,y);ctx.fillStyle='#0E2A47';ctx.fillText('Div. '+d.name,x,y)});
  {if(ROSA.complete&&ROSA.naturalWidth){const w=78*s,hh=w*ROSA.naturalHeight/ROSA.naturalWidth;ctx.drawImage(ROSA,855*s-w/2,170*s-hh/2,w,hh)}}
  {const nice=[500,1000,2000,2500,5000,10000].find(m=>m*sc>=60*s)||5000,len=nice*sc,x0=F.x+F.w-70*s-2*len,y0=F.y+F.h-55*s;ctx.fillStyle='#000';ctx.fillRect(x0,y0,len,8*s);ctx.fillStyle='#fff';ctx.fillRect(x0+len,y0,len,8*s);ctx.strokeStyle='#000';ctx.strokeRect(x0,y0,2*len,8*s);
    ctx.fillStyle='#000';ctx.font=`${12*s}px Arial`;ctx.textAlign='center';ctx.fillText('0',x0,y0-6*s);ctx.fillText(fmt(nice),x0+len,y0-6*s);ctx.fillText(fmt(2*nice)+' m',x0+2*len+10*s,y0-6*s)}
  ctx.restore();
  ctx.strokeStyle='#444';ctx.lineWidth=1;ctx.strokeRect(F.x,F.y,F.w,F.h);ctx.fillStyle='#333';ctx.font=`${9*s}px Arial`;
  ticks.x.forEach(([x,E])=>{if(x<F.x||x>F.x+F.w)return;ctx.textAlign='center';ctx.fillText(E+'E',x,F.y-6*s);ctx.fillText(E+'E',x,F.y+F.h+13*s)});
  ticks.y.forEach(([y,N])=>{if(y<F.y||y>F.y+F.h)return;[F.x-6*s,F.x+F.w+12*s].forEach(x=>{ctx.save();ctx.translate(x,y);ctx.rotate(-Math.PI/2);ctx.textAlign='center';ctx.fillText(N+'N',0,0);ctx.restore()})});
  const hs=[130,150,95,62].map(h=>h*s);hs.push(PN.h-hs.reduce((a,b)=>a+b,0));let yy=PN.y;ctx.strokeStyle='#222';hs.forEach(h=>{ctx.strokeRect(PN.x,yy,PN.w,h);yy+=h});yy=PN.y;const tx=PN.x+PN.w/2;
  ctx.fillStyle='#000';ctx.textAlign='center';ctx.font=`${16*s}px Arial`;const tl=wrap(ctx,suTitulo(),PN.w-24*s);tl.forEach((l,i)=>ctx.fillText(l,tx,yy+hs[0]/2-(tl.length-1)*10*s+i*20*s+6*s));yy+=hs[0];
  if(logoImg){const r=Math.min((PN.w-40*s)/logoImg.width,(hs[1]-30*s)/logoImg.height);ctx.drawImage(logoImg,tx-logoImg.width*r/2,yy+hs[1]/2-logoImg.height*r/2,logoImg.width*r,logoImg.height*r)}yy+=hs[1];
  ctx.font=`${15*s}px Arial`;wrap(ctx,'Departamento de Investigaciones Agrícolas',PN.w-30*s).forEach((l,i,a)=>ctx.fillText(l,tx,yy+hs[2]/2-(a.length-1)*10*s+i*20*s+6*s));yy+=hs[2];
  ctx.textAlign='left';ctx.font=`${12*s}px Arial`;wrap(ctx,'Realizado por: '+$('#suAutor').value,PN.w-24*s).forEach((l,i,a)=>ctx.fillText(l,PN.x+14*s,yy+hs[3]/2-(a.length-1)*8*s+i*16*s+4*s));yy+=hs[3];
  ctx.textAlign='center';ctx.font=`bold ${18*s}px Arial`;ctx.fillText('Leyenda',tx,yy+28*s);
  let ly=yy+44*s;const lx=PN.x+16*s;ctx.textAlign='left';const n=suBr().length+1;ctx.font=`${11.5*s}px Arial`;
  for(let i=0;i<n;i++){ctx.fillStyle=P.pal[i];ctx.fillRect(lx,ly,22*s,14*s);ctx.fillStyle='#000';const L=wrap(ctx,suLab(i),PN.w-60*s);L.forEach((l,j)=>ctx.fillText(l,lx+30*s,ly+11*s+j*14*s));ly+=Math.max(22*s,L.length*14*s+8*s)}
  ctx.fillStyle='#E6E9ED';ctx.fillRect(lx,ly,22*s,14*s);ctx.fillStyle='#000';ctx.fillText(SU.modo==='interp'?'Sin análisis cercano':'Sin análisis',lx+30*s,ly+11*s);ly+=26*s;
  ctx.font=`${9.5*s}px Arial`;ctx.fillStyle='#444';wrap(ctx,SU.modo==='interp'?`Interpolación IDW (potencia ${SU.pot}, radio ${fmt(SU.R)} m) desde el centroide de ${fmt(SU.pts.length)} piezas con análisis.`:`${fmt(SU.pts.length)} piezas con análisis.`,PN.w-30*s).forEach((l,i)=>ctx.fillText(l,lx,ly+i*12*s));
  if(!T)SU.view={toPx,toE,px,F};
}
function suInit(){if(suInit.ok)return;suInit.ok=true;
  $('#suPar').innerHTML=Object.entries(SU_PAR).filter(([k])=>SU.base.filas.some(f=>f[4+SU.base.campos.indexOf(k)]!=null)).map(([k,P])=>`<option value="${k}">${P.n}${P.u?' ('+P.u+')':''}</option>`).join('');$('#suPar').value=SU.key;
  $('#suDiv').innerHTML='<option value="">Todas</option>'+Object.entries(DIVN).map(([k,n])=>`<option value="${k}">${n}</option>`).join('');
  const anios=[...new Set(SU.base.filas.map(f=>f[3]).filter(Boolean))].sort();$('#suAnio').innerHTML='<option value="0">Todos los años</option>'+anios.map(a=>`<option value="${a}">Desde ${a}</option>`).join('');
  const brTxt=()=>{$('#suBr').value=suBr().join(', ')};brTxt();
  $('#suPar').onchange=()=>{SU.key=$('#suPar').value;SU.br=null;SU.lo=SU.hi=null;$('#suLo').value=$('#suHi').value='';SU.hi_c.clear();brTxt();suDraw()};
  $('#suDiv').onchange=()=>{SU.div=$('#suDiv').value;suDraw()};$('#suAnio').onchange=()=>{SU.anio=+$('#suAnio').value;suDraw()};
  $('#suR').onchange=()=>{SU.R=+$('#suR').value;suDraw()};$('#suPts').onchange=()=>suDraw();
  $$('#suModo button').forEach(b=>b.onclick=()=>{SU.modo=b.dataset.m;$$('#suModo button').forEach(x=>x.classList.toggle('on',x===b));suDraw()});
  const num=v=>{v=String(v).trim().replace(',','.');return v===''?null:(isFinite(+v)?+v:null)};
  $('#suLo').oninput=$('#suHi').oninput=()=>{SU.lo=num($('#suLo').value);SU.hi=num($('#suHi').value);suDraw()};
  $('#suBr').onchange=()=>{const b=$('#suBr').value.split(/[;,\s]+/).map(x=>+x.replace(',','.')).filter(isFinite).sort((a,b)=>a-b);SU.br=b.length===4?b:null;if(!SU.br)brTxt();SU.hi_c.clear();suDraw()};
  $('#suBrR').onclick=()=>{SU.br=null;brTxt();suDraw()};$('#suAutor').oninput=()=>suDraw();
  $('#suPdf').onclick=async()=>{if(!window.jspdf){$('#suSt').textContent='No se pudo cargar el generador de PDF.';return}$('#suSt').textContent='Generando…';await new Promise(r=>setTimeout(r,30));const c=document.createElement('canvas');suLayout(c,{W:2580});await saveFile(`${slug(suTitulo())}.pdf`,pdfFrom([c]),$('#suSt'))};
  $('#suPng').onclick=()=>{const c=document.createElement('canvas');suLayout(c,{W:2580});c.toBlob(b=>saveFile(`${slug(suTitulo())}.png`,b,$('#suSt')),'image/png')};
  $('#suFile').onchange=async e=>{const st=$('#suFSt');st.className='status';try{st.textContent='Leyendo…';const base=await suLeerExcel(e.target.files[0]);SU.base=base;
      if(DB){st.textContent='Guardando para todos…';const txt=JSON.stringify(base),parts=[];for(let i=0;i<txt.length;i+=900000)parts.push(txt.slice(i,i+900000));
        for(let i=0;i<parts.length;i++)await DB.collection('suelo_base').doc('p'+i).set({i,s:parts[i]});await DB.collection('suelo_base').doc('meta').set({partes:parts.length,fuente:base.fuente,filas:base.filas.length,fecha:hoyISO()})}
      suInit.ok=false;suInit();st.textContent=`Base cargada: ${fmt(base.filas.length)} piezas con análisis${DB?' (guardada para todos)':''}.`;suDraw()}catch(err){st.className='status err';st.textContent=err.message}};
  $('#suMap').addEventListener('click',e=>{if(!SU.view)return;const r=e.target.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top,{px,toE}=SU.view;let hit=null;
    for(const p of (SU.div?EMBED_PIECES.filter(q=>q[0]===+SU.div):EMBED_PIECES)){const Pp=p[3].map(q=>px(q[0],q[1]));let a=1e9,b=1e9,c=-1e9,d=-1e9;Pp.forEach(([u,v])=>{a=Math.min(a,u);c=Math.max(c,u);b=Math.min(b,v);d=Math.max(d,v)});if(x<a||x>c||y<b||y>d)continue;if(pip(x,y,[[Pp]])){hit=p;break}}
    const t=$('#suTip');if(!hit){t.style.display='none';return}const k=hit[0]+'|'+hit[1]+'|'+hit[2],m=SU.med.get(k),fr=SU.base.filas.find(f=>f[0]+'|'+f[1]+'|'+f[2]===k),P=SU_PAR[SU.key],[E,N]=toE(x,y),ve=suIdw(E,N);
    const det=fr?SU.base.campos.map((c,i)=>fr[4+i]!=null&&SU_PAR[c]?`${SU_PAR[c].n}: <b>${fmt(fr[4+i],SU_PAR[c].d)}</b>${SU_PAR[c].u?' '+SU_PAR[c].u:''}`:null).filter(Boolean).join('<br>'):'';
    t.innerHTML=`<b>${DIVN[hit[0]]||'—'} · Tablón ${hit[1]} · Pieza ${hit[2]}</b><br>${m?`${P.n} medido: <b>${fmt(m.v,P.d)}</b>${P.u?' '+P.u:''}${fr&&fr[3]?` (análisis ${fr[3]})`:''}`:'Sin análisis en esta pieza'}${SU.modo==='interp'?`<br>Estimado en este punto: <b>${ve==null?'sin análisis cercano':fmt(ve,P.d)+(P.u?' '+P.u:'')}</b>`:''}${det?`<hr style="border:0;border-top:1px solid #ddd;margin:5px 0">${det}`:''}`;
    t.style.left=Math.min(x+12,r.width-260)+'px';t.style.top=(y+12)+'px';t.style.display='block'});
  suCargarDB()}
async function suCargarDB(){if(!DB)return;try{const m=await DB.collection('suelo_base').doc('meta').get();if(!m.exists)return;const M=m.data();let s='';for(let i=0;i<M.partes;i++){const d=await DB.collection('suelo_base').doc('p'+i).get();if(!d.exists)return;s+=d.data().s}
  SU.base=JSON.parse(s);suInit.ok=false;suInit();$('#suFSt').textContent=`Base en uso: ${M.fuente||'—'} · ${fmt(M.filas)} piezas (cargada el ${M.fecha||'—'}).`;suDraw()}catch(e){}}
/* lee una base nueva con la misma estructura (hoja "AREA REVISADA FINAL V2" o la primera con columnas TABLON/PIEZA/PH) */
async function suLeerExcel(file){const sh=await readTable(file);const hoja=sh.find(s=>/v2/i.test(s.name)&&/revisada/i.test(s.name))||sh.find(s=>s.rows.length&&s.rows[0].some(h=>/^PH$/i.test(String(h||'').trim()))&&s.rows[0].some(h=>/^TABLON$/i.test(String(h||'').trim())));
  if(!hoja)throw new Error('No encontré la hoja "AREA REVISADA FINAL V2" ni otra con las columnas DIVISION_CODE, TABLON, PIEZA y PH.');
  const H=hoja.rows[0].map(h=>String(h||'').trim().toUpperCase()),ix=n=>H.indexOf(n),ID=ix('DIVISION_CODE'),IT=ix('TABLON'),IP=ix('PIEZA'),IA=ix('AÑO');
  if(ID<0||IT<0||IP<0)throw new Error('Faltan las columnas DIVISION_CODE, TABLON o PIEZA.');
  const map={ph:'PH',mo:'MO%',n:'N TOTAL %',p:'P PPM',k:'K PPM',ca:'CA PPM',mg:'MG PPM',na:'NA PPM',cic:'CIC',ce:'C.E.µS/CM',arena:'ARENA%',limo:'LIMO%',arcilla:'ARCILLA%',gravas:'GRAVAS%'},campos=Object.keys(map),ci=campos.map(c=>ix(map[c]));
  const vistos=new Set(),filas=[];for(const r of hoja.rows.slice(1)){const d=+r[ID],t=String(Math.round(+r[IT])),p=+r[IP];if(!d||!isFinite(+r[IT])||!p)continue;const k=d+'|'+t+'|'+p;if(vistos.has(k))continue;vistos.add(k);
    const vals=ci.map(i=>{const v=i<0?null:+String(r[i]??'').replace(',','.');return v>0?v:null});if(vals.every(v=>v==null))continue;const a=IA>=0?+r[IA]:0;filas.push([d,t,p,a>0?a:null,...vals])}
  if(!filas.length)throw new Error('La hoja no tiene análisis con valores.');return{campos,filas,fuente:file.name,hoja:hoja.name}}
