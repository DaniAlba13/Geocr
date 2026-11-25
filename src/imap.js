/* ===== Mapa interactivo sobre canvas: acercar/alejar (rueda, botones, doble clic, pellizco),
   mover arrastrando y fondo satelital de referencia (Esri World Imagery) que se pone o quita. ===== */
const IM_SAT_URL=(z,x,y)=>`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
let IM_SAT=(()=>{try{return localStorage.getItem('geocr-sat')==='1'}catch(e){return false}})();
const IM_ALL=new Set(),IM_TILES=new Map();
const imX=lon=>(lon+180)/360,imY=lat=>{const s=Math.sin(Math.max(-85,Math.min(85,lat))*Math.PI/180);return .5-Math.log((1+s)/(1-s))/(4*Math.PI)};
const imLon=x=>x*360-180,imLat=y=>{const n=Math.PI-2*Math.PI*y;return 180/Math.PI*Math.atan(.5*(Math.exp(n)-Math.exp(-n)))};
function imTile(z,x,y,cb){const k=z+'/'+x+'/'+y;let t=IM_TILES.get(k);if(t)return t.ok?t.img:null;
  t={img:new Image(),ok:false};IM_TILES.set(k,t);const ld=(cors)=>{if(cors)t.img.crossOrigin='anonymous';else t.img.removeAttribute('crossorigin');t.img.src=IM_SAT_URL(z,x,y)};
  t.img.onload=()=>{t.ok=true;cb()};t.img.onerror=()=>{if(t.img.crossOrigin){ld(false)}else IM_TILES.set(k,{img:null,ok:false,dead:true})};ld(true);return null}
let IMBB=null;const imBB=()=>IMBB||(IMBB=EMBED_PIECES.map(p=>{let a=1,b=1,c=0,d=0;p[3].forEach(q=>{const x=imX(q[0]),y=imY(q[1]);if(x<a)a=x;if(x>c)c=x;if(y<b)b=y;if(y>d)d=y});return[a,b,c,d]}));
function imap(cv,opt={}){if(cv._im)return cv._im;
  const im={cv,cx:.5,cy:.5,sc:1,W:0,H:0,draw:null,home:null,v:null,raf:0,opt};cv._im=im;IM_ALL.add(im);
  const wrap=cv.parentElement;wrap.classList.add('imw');
  const ctl=document.createElement('div');ctl.className='imctl';
  ctl.innerHTML=`<button data-a="in" title="Acercar">+</button><button data-a="out" title="Alejar">−</button><button data-a="home" title="Ver todo"><svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg></button><button data-a="sat" class="sat" title="Imagen satelital de referencia"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M3 5l5 2-2 5-5-2zM21 19l-5-2 2-5 5 2zM15 9l3-3M9 15l-3 3"/></svg>Satélite</button>`;
  wrap.appendChild(ctl);const att=document.createElement('div');att.className='imatt';att.textContent='Imágenes © Esri, Maxar, Earthstar Geographics';wrap.appendChild(att);
  const satBtn=ctl.querySelector('[data-a=sat]');const syncBtn=()=>{satBtn.classList.toggle('on',IM_SAT);att.style.display=IM_SAT?'':'none'};syncBtn();im.syncBtn=syncBtn;
  ctl.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;e.stopPropagation();const a=b.dataset.a;
    if(a==='in')im.zoomAt(im.W/2,im.H/2,1.6);else if(a==='out')im.zoomAt(im.W/2,im.H/2,1/1.6);else if(a==='home'){if(im.home){Object.assign(im,im.home);im.render()}}
    else if(a==='sat'){IM_SAT=!IM_SAT;try{localStorage.setItem('geocr-sat',IM_SAT?'1':'0')}catch(e){}IM_ALL.forEach(m=>{m.syncBtn();m.render()})}});
  ctl.addEventListener('pointerdown',e=>e.stopPropagation());ctl.addEventListener('dblclick',e=>e.stopPropagation());
  im.view=()=>{const W=im.W,H=im.H,sc=im.sc,ox=im.cx*sc-W/2,oy=im.cy*sc-H/2;
    const vx0=ox/sc,vx1=(ox+W)/sc,vy0=oy/sc,vy1=(oy+H)/sc,BB=imBB();
    return{ctx:cv.getContext('2d'),W,H,sat:IM_SAT,vis:i=>{const b=BB[i];return b[2]>=vx0&&b[0]<=vx1&&b[3]>=vy0&&b[1]<=vy1},px:(lon,lat)=>[imX(lon)*sc-ox,imY(lat)*sc-oy],geo:(x,y)=>[imLon((x+ox)/sc),imLat((y+oy)/sc)],scale:sc}};
  im.fit=(bb,H)=>{const W=wrap.clientWidth;if(!W)return false;const pad=18,x0=imX(bb[0]),x1=imX(bb[2]),y0=imY(bb[3]),y1=imY(bb[1]),dx=Math.max(x1-x0,1e-9),dy=Math.max(y1-y0,1e-9);
    if(!H)H=im.H||Math.round(Math.max(240,Math.min(dy*(W-2*pad)/dx+2*pad,opt.maxH||620)));im.W=W;im.H=H;im.sc=Math.min((W-2*pad)/dx,(H-2*pad)/dy);im.cx=(x0+x1)/2;im.cy=(y0+y1)/2;
    im.home={cx:im.cx,cy:im.cy,sc:im.sc};return true};
  im.render=()=>{if(im.raf)return;im.raf=requestAnimationFrame(()=>{im.raf=0;im.paint()})};
  im.paint=()=>{const W=wrap.clientWidth||im.W;if(!W||!im.home)return;if(W!==im.W){im.W=W}const dpr=window.devicePixelRatio||1;cv.width=W*dpr;cv.height=im.H*dpr;cv.style.height=im.H+'px';
    const v=im.view(),ctx=v.ctx;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,im.H);
    if(IM_SAT){const zf=Math.log2(im.sc/256),z=Math.max(0,Math.min(18,Math.round(zf))),n=2**z,ts=im.sc/n,ox=im.cx*im.sc-W/2,oy=im.cy*im.sc-im.H/2;
      ctx.fillStyle='#1d2a24';ctx.fillRect(0,0,W,im.H);
      for(let ty=Math.floor(oy/ts);ty<=Math.floor((oy+im.H)/ts);ty++)for(let tx=Math.floor(ox/ts);tx<=Math.floor((ox+W)/ts);tx++){if(ty<0||ty>=n)continue;const xx=((tx%n)+n)%n;
        let img=imTile(z,xx,ty,im.render);if(!img){for(let up=1;up<=4&&!img;up++){const zz=z-up;if(zz<0)break;const k=IM_TILES.get(zz+'/'+(xx>>up)+'/'+(ty>>up));if(k&&k.ok){const s=2**up,sx=(xx%s)*256/s,sy=(ty%s)*256/s;ctx.drawImage(k.img,sx,sy,256/s,256/s,tx*ts-ox,ty*ts-oy,ts+.5,ts+.5)}}continue}
        ctx.drawImage(img,tx*ts-ox,ty*ts-oy,ts+.5,ts+.5)}}
    im.v=v;if(im.draw)im.draw(v);if(im.hl)imHl(v,im.hl)};
  /* interacción */
  const ptrs=new Map();let drag=null,moved=false,pinch=null;
  im.zoomAt=(x,y,f)=>{const ns=Math.max(im.home?im.home.sc/3:1,Math.min(im.sc*f,256*2**19));const gx=im.cx+(x-im.W/2)/im.sc,gy=im.cy+(y-im.H/2)/im.sc;im.sc=ns;im.cx=gx-(x-im.W/2)/ns;im.cy=gy-(y-im.H/2)/ns;im.hideTip();im.render()};
  im.hideTip=()=>{const t=wrap.querySelector('.tip');if(t)t.style.display='none'};
  const rel=e=>{const r=cv.getBoundingClientRect();return[e.clientX-r.left,e.clientY-r.top]};
  cv.style.touchAction='none';cv.style.cursor='grab';
  cv.addEventListener('wheel',e=>{if(!e.ctrlKey)return;e.preventDefault();const[x,y]=rel(e);im.zoomAt(x,y,Math.pow(1.0018,-e.deltaY))},{passive:false});
  
  let snap=null;const snapDraw=(dx,dy)=>{const ctx=cv.getContext('2d'),dpr=window.devicePixelRatio||1;ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle=IM_SAT?'#1d2a24':(opt.bg||'#FBFCFE');ctx.fillRect(0,0,cv.width,cv.height);ctx.drawImage(snap,dx*dpr,dy*dpr)};
  cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);ptrs.set(e.pointerId,rel(e));moved=false;if(ptrs.size===1){drag={p:rel(e),cx:im.cx,cy:im.cy}}
    else if(ptrs.size===2){const[a,b]=[...ptrs.values()];pinch={d:Math.hypot(a[0]-b[0],a[1]-b[1]),sc:im.sc,m:[(a[0]+b[0])/2,(a[1]+b[1])/2]};drag=null}});
  cv.addEventListener('pointermove',e=>{if(!ptrs.has(e.pointerId))return;const p=rel(e);ptrs.set(e.pointerId,p);
    if(pinch&&ptrs.size===2){const[a,b]=[...ptrs.values()],d=Math.hypot(a[0]-b[0],a[1]-b[1]);im.zoomAt(pinch.m[0],pinch.m[1],(pinch.sc*d/pinch.d)/im.sc);moved=true;return}
    if(drag){const dx=p[0]-drag.p[0],dy=p[1]-drag.p[1];if(Math.abs(dx)+Math.abs(dy)>4){moved=true;cv.style.cursor='grabbing'}if(moved){im.cx=drag.cx-dx/im.sc;im.cy=drag.cy-dy/im.sc;im.hideTip();if(!snap){snap=document.createElement('canvas');snap.width=cv.width;snap.height=cv.height;snap.getContext('2d').drawImage(cv,0,0)}snapDraw(dx,dy)}}});
  const up=e=>{ptrs.delete(e.pointerId);if(ptrs.size<2)pinch=null;if(!ptrs.size){drag=null;cv.style.cursor='grab';if(snap){snap=null;im.render()}}};
  cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);
  cv.addEventListener('click',e=>{if(moved){e.stopImmediatePropagation();moved=false}},true);
  addEventListener('resize',()=>{if(cv.offsetParent)im.render()});
  return im}
/* piezas: con satélite, los colores quedan semitransparentes y las piezas sin dato casi transparentes */
const imFill=(v,c)=>!v.sat?c:(c==='#E6E9ED'||c==='#E6E9ED55'?'rgba(230,233,237,.12)':c);

/* ===== Buscar un tablón (o tablón-pieza) en un mapa imap: se acerca, lo delimita y rotula su número ===== */
const IM_ALIAS={kalil:[6,'716'],'kalil hache':[6,'716'],'kalil hacha':[6,'716']};
function imIrA(im,L,f=1.8){const b=bboxPts(L.flatMap(p=>p[3])),x0=imX(b[0]),x1=imX(b[2]),y0=imY(b[3]),y1=imY(b[1]),pad=30;
  im.sc=Math.max(im.home?im.home.sc:1,Math.min(256*2**18,Math.min((im.W-2*pad)/Math.max(x1-x0,1e-9),(im.H-2*pad)/Math.max(y1-y0,1e-9))/f));im.cx=(x0+x1)/2;im.cy=(y0+y1)/2;im.hideTip();im.render()}
function imHl(v,h){const ctx=v.ctx,ring=r=>{r.forEach((q,i)=>{const[x,y]=v.px(q[0],q[1]);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.closePath()};
  const uno=h.L.length===1||new Set(h.L.map(p=>p[2])).size===1;ctx.save();ctx.lineJoin='round';
  if(!uno){ctx.beginPath();h.L.forEach(p=>ring(p[3]));ctx.fillStyle='rgba(255,225,77,.10)';ctx.fill();ctx.strokeStyle='rgba(255,225,77,.75)';ctx.lineWidth=1;ctx.stroke();
    /* contorno exterior del tablón: trazo grueso al que se le quita lo que cae dentro de las piezas */
    const cv=v.ctx.canvas,o=imHl.c||(imHl.c=document.createElement('canvas'));o.width=cv.width;o.height=cv.height;const c2=o.getContext('2d'),T=ctx.getTransform();c2.setTransform(T);
    const rg=r=>{r.forEach((q,i)=>{const[x,y]=v.px(q[0],q[1]);i?c2.lineTo(x,y):c2.moveTo(x,y)});c2.closePath()};c2.beginPath();h.L.forEach(p=>rg(p[3]));c2.lineJoin='round';
    c2.strokeStyle='rgba(0,0,0,.6)';c2.lineWidth=9;c2.stroke();c2.strokeStyle='#FFE14D';c2.lineWidth=5.5;c2.stroke();c2.globalCompositeOperation='destination-out';c2.fill();c2.globalCompositeOperation='source-over';
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(o,0,0);ctx.restore()}
  else{ctx.beginPath();h.L.forEach(p=>ring(p[3]));ctx.strokeStyle='rgba(0,0,0,.55)';ctx.lineWidth=6;ctx.stroke();ctx.strokeStyle='#FFE14D';ctx.lineWidth=2.8;ctx.stroke()}
  ctx.textAlign='center';ctx.textBaseline='middle';
  if(!uno){ctx.font='700 11px Inter,Arial';h.L.forEach(p=>{const b=bboxPts(p[3]),q=v.px(b[0],b[1]),r=v.px(b[2],b[3]);if(Math.min(Math.abs(r[0]-q[0]),Math.abs(r[1]-q[1]))<16)return;const c=pzCentro(p),[x,y]=v.px(c[0],c[1]);ctx.lineWidth=3;ctx.strokeStyle='rgba(0,0,0,.75)';ctx.strokeText(p[2],x,y);ctx.fillStyle='#fff';ctx.fillText(p[2],x,y)})}
  const b=bboxPts(h.L.flatMap(p=>p[3])),[x,y]=v.px((b[0]+b[2])/2,b[3]),t=h.txt;ctx.font='800 13px Inter,Arial';const w=ctx.measureText(t).width+16,yy=Math.max(14,y-16);
  ctx.fillStyle='#0E2A47';ctx.beginPath();ctx.roundRect?ctx.roundRect(x-w/2,yy-11,w,22,11):ctx.rect(x-w/2,yy-11,w,22);ctx.fill();ctx.strokeStyle='#FFE14D';ctx.lineWidth=1.5;ctx.stroke();ctx.fillStyle='#fff';ctx.fillText(t,x,yy+.5);ctx.restore()}
const pzCentro=p=>{if(p._c)return p._c;let a=0,cx=0,cy=0;const r=p[3];for(let i=0;i<r.length-1;i++){const f=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1];a+=f;cx+=(r[i][0]+r[i+1][0])*f;cy+=(r[i][1]+r[i+1][1])*f}
  return p._c=Math.abs(a)>1e-14?[cx/(3*a),cy/(3*a)]:[(r[0][0]+r[2%r.length][0])/2,(r[0][1]+r[2%r.length][1])/2]};
function imBuscar(im,piezas){const wrap=im.cv.parentElement,box=document.createElement('div');box.className='imq';
  box.innerHTML='<input type="search" placeholder="Buscar tablón (ej. 716 o 716-12)" aria-label="Buscar tablón"><div class="imq-op"></div>';wrap.appendChild(box);
  const inp=box.querySelector('input'),op=box.querySelector('.imq-op');['pointerdown','dblclick','wheel','click'].forEach(ev=>box.addEventListener(ev,e=>e.stopPropagation()));
  const marca=(L,txt)=>{op.innerHTML='';im.hl={L,txt,sc0:null};imIrA(im,L,L.length>1?1.25:3);im.hl.sc0=im.sc;im.render()};
  inp.addEventListener('input',()=>{if(!inp.value.trim()&&im.hl){im.hl=null;op.innerHTML='';im.render()}});
  inp.onkeydown=e=>{if(e.key==='Escape'){inp.value='';im.hl=null;op.innerHTML='';im.render();return}if(e.key!=='Enter')return;op.innerHTML='';
    const q=inp.value.trim().toLowerCase(),al=IM_ALIAS[q];let m=al?[null,al[1],null]:q.match(/^0*(\d+)\s*(?:[-_/ ]\s*0*(\d+))?$/);if(!m){inp.classList.add('err');return}
    const L=(piezas?piezas():EMBED_PIECES).filter(p=>(!al||p[0]===al[0])&&String(p[1]).replace(/^0+/,'')===m[1]&&(!m[2]||+p[2]===+m[2]));if(!L.length){inp.classList.add('err');return}inp.classList.remove('err');
    const txt=d=>`${DIVN[d]||'Div. '+d} · Tablón ${m[1]}${m[2]?' · Pieza '+m[2]:''}`;
    const g=new Map();L.forEach(p=>{if(!g.has(p[0]))g.set(p[0],[]);g.get(p[0]).push(p)});if(g.size===1){marca(L,txt(L[0][0]));return}
    g.forEach((Lp,dv)=>{const bt=document.createElement('button');bt.type='button';bt.textContent=txt(dv);bt.onclick=()=>marca(Lp,txt(dv));op.appendChild(bt)})};
  im.buscar=marca;return box}
