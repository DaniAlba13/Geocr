/* Intro de agricultura de precisión (canvas): campo en perspectiva, tractor con guiado RTK,
   estación RTK, satélite, dron que escanea y revela el NDVI, nube con lluvia y pluviómetro, HUD. */
function spIntro(cv,onEnd){const ctx=cv.getContext('2d');let W=0,H=0,DPR=1,t0=performance.now(),raf=0,fin=false,dim=false;
  const resize=()=>{DPR=Math.min(2,window.devicePixelRatio||1);W=cv.clientWidth;H=cv.clientHeight;cv.width=W*DPR;cv.height=H*DPR;ctx.setTransform(DPR,0,0,DPR,0,0)};resize();addEventListener('resize',resize);
  const img=s=>{const i=new Image();i.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s);return i};
  /* tractor verde y amarillo (genérico, sin logotipos), mirando a la derecha */
  const TR=img(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 170"><path d="M8 96h52v10H8z" fill="#2b2b2b"/><path d="M58 70h70l12-52h70l8 52h22l18 28v26H58z" fill="#367C2B"/>
    <path d="M150 26h52l6 42h-62z" fill="#B9E4FF" stroke="#25591E" stroke-width="5"/><path d="M146 18h66" stroke="#25591E" stroke-width="8"/><rect x="186" y="34" width="5" height="34" fill="#25591E"/>
    <rect x="118" y="30" width="9" height="42" fill="#222"/><rect x="58" y="84" width="182" height="8" fill="#FFDE00"/><rect x="236" y="98" width="20" height="24" rx="3" fill="#2b2b2b"/>
    <circle cx="90" cy="120" r="46" fill="#1d1d1d"/><circle cx="90" cy="120" r="27" fill="#FFDE00"/><circle cx="90" cy="120" r="9" fill="#367C2B"/>
    <circle cx="210" cy="136" r="30" fill="#1d1d1d"/><circle cx="210" cy="136" r="17" fill="#FFDE00"/><circle cx="210" cy="136" r="6" fill="#367C2B"/>
    <rect x="172" y="8" width="22" height="9" rx="3" fill="#EE3B33"/></svg>`);
  const DR=img(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 70"><rect x="20" y="22" width="160" height="7" rx="3" fill="#D8E2EE"/><rect x="72" y="18" width="56" height="26" rx="10" fill="#F2F6FA"/>
    <rect x="86" y="44" width="28" height="12" rx="4" fill="#0E2A47"/><circle cx="100" cy="50" r="4" fill="#7FC1FF"/><rect x="22" y="12" width="6" height="12" fill="#D8E2EE"/><rect x="172" y="12" width="6" height="12" fill="#D8E2EE"/></svg>`);
  const RT=img(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 150"><g stroke="#E5EEF8" stroke-width="5" stroke-linecap="round"><line x1="40" y1="70" x2="12" y2="146"/><line x1="40" y1="70" x2="68" y2="146"/><line x1="40" y1="70" x2="40" y2="146"/><line x1="40" y1="70" x2="40" y2="24"/></g>
    <ellipse cx="40" cy="20" rx="24" ry="8" fill="#EE3B33"/><rect x="24" y="52" width="32" height="20" rx="4" fill="#0E2A47" stroke="#7FC1FF" stroke-width="2"/><circle cx="33" cy="62" r="3" fill="#4ADE80"/></svg>`);
  const GA=img(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 90"><path d="M4 4h32l-8 18v64H12V22z" fill="#E5EEF8" opacity=".9"/><rect x="12" y="40" width="16" height="46" fill="#0E2A47"/></svg>`);
  /* NDVI suave por posición */
  const ndvi=(x,z)=>.63+.22*Math.sin(x*3.1+1.3)*Math.cos(z*4.2)+.12*Math.sin(x*7.3+z*5.1)+.06*Math.cos(x*13+z*11);
  const ramp=v=>{const s=[[.3,[215,48,39]],[.45,[252,141,89]],[.55,[254,224,139]],[.65,[166,217,106]],[.8,[26,152,80]]];v=Math.max(.3,Math.min(.8,v));
    for(let i=1;i<s.length;i++)if(v<=s[i][0]){const a=s[i-1],b=s[i],k=(v-a[0])/(b[0]-a[0]);return a[1].map((c,j)=>Math.round(c+(b[1][j]-c)*k))}return s[s.length-1][1]};
  const ease=k=>k<0?0:k>1?1:k*k*(3-2*k),seg=(t,a,b)=>ease((t-a)/(b-a));
  const stars=Array.from({length:90},()=>[Math.random(),Math.random()*.45,Math.random()*1.4+.3]);
  const drops=Array.from({length:120},()=>[Math.random(),Math.random()]);
  const HUD=[[.5,'Conectando con satélites GNSS…'],[1.4,'Estación RTK · corrección FIX ±2 cm'],[2.3,'Tractor en línea de guiado · 6.4 km/h'],[3.0,'Dron multiespectral · escaneando NDVI'],[4.1,'Pluviómetro · 12.4 mm en 24 h'],[5.1,'Integrando cartografía · satélite · lluvia']];
  function frame(now){const t=(now-t0)/1000;ctx.clearRect(0,0,W,H);const hz=H*.48,P=(x,z)=>{const s=1/(1+z*3.2);return[W/2+x*W*.62*s,hz+(H-hz)*s*1.02]},S=z=>1/(1+z*3.2);
    /* cielo y amanecer */
    const sk=ctx.createLinearGradient(0,0,0,hz);sk.addColorStop(0,'#020814');sk.addColorStop(.7,'#0A2240');sk.addColorStop(1,`rgba(${Math.round(40+60*seg(t,0,4))},${Math.round(70+50*seg(t,0,4))},120,1)`);ctx.fillStyle=sk;ctx.fillRect(0,0,W,hz+2);
    const sun=seg(t,0,5);const sg=ctx.createRadialGradient(W*.78,hz,0,W*.78,hz,H*.5);sg.addColorStop(0,`rgba(255,190,110,${.55*sun})`);sg.addColorStop(.35,`rgba(238,59,51,${.18*sun})`);sg.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=sg;ctx.fillRect(0,0,W,hz+2);
    stars.forEach(([x,y,r])=>{ctx.globalAlpha=(1-sun*.8)*(.5+.5*Math.sin(t*3+x*40));ctx.fillStyle='#fff';ctx.fillRect(x*W,y*H,r,r)});ctx.globalAlpha=1;
    /* campo: parches con NDVI que se revela tras el escaneo del dron */
    const gIn=seg(t,0,.9),scanX=-1.35+2.7*seg(t,2.6,5.4),NX=26,NZ=22,ZM=2.6,zz=k=>ZM*Math.pow(k/NZ,1.6);ctx.globalAlpha=gIn;
    {const gg=ctx.createLinearGradient(0,hz,0,H);gg.addColorStop(0,'#0f3d22');gg.addColorStop(1,'#0b2e19');ctx.fillStyle=gg;ctx.fillRect(0,hz,W,H-hz)}
    for(let iz=NZ-1;iz>=0;iz--)for(let ix=0;ix<NX;ix++){const x0=-1.35+2.7*ix/NX,x1=-1.35+2.7*(ix+1)/NX,z0=zz(iz),z1=zz(iz+1),a=P(x0,z0),b=P(x1,z0),c=P(x1,z1),d=P(x0,z1);
      const xc=(x0+x1)/2,rv=Math.max(0,Math.min(1,(scanX-xc)*6));let col=[22,84,46];if(rv>0){const n=ramp(ndvi(xc,(z0+z1)/2));col=col.map((v,j)=>Math.round(v+(n[j]-v)*rv*.9))}
      const sh=.62+.38*Math.max(0,1-z0/ZM);ctx.fillStyle=`rgb(${col.map(v=>Math.round(v*sh)).join(',')})`;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.lineTo(...c);ctx.lineTo(...d);ctx.closePath();ctx.fill()}
    /* surcos de caña que "crecen" */
    const gr=seg(t,.2,1.6);ctx.strokeStyle=`rgba(180,255,190,${.16*gr})`;ctx.lineWidth=1;for(let i=0;i<=54;i++){const x=-1.35+2.7*i/54,a=P(x,0),b=P(x,gr*ZM);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke()}
    ctx.globalAlpha=1;
    /* línea de escaneo */
    if(t>2.6&&t<5.5){const a=P(scanX,0),b=P(scanX,ZM);ctx.strokeStyle='rgba(191,224,255,.9)';ctx.lineWidth=3;ctx.shadowColor='#7FC1FF';ctx.shadowBlur=18;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();ctx.shadowBlur=0}
    /* estación RTK con ondas sobre el suelo */
    const rx=1.02,rz=.62,[rpx,rpy]=P(rx,rz),rs=S(rz),rIn=seg(t,.8,1.4);
    if(rIn>0){for(let k=0;k<3;k++){const ph=((t-1-k*.7)%2.1)/2.1;if(t-1-k*.7<0)continue;ctx.strokeStyle=`rgba(127,193,255,${(1-ph)*.8*rIn})`;ctx.lineWidth=2.5;ctx.beginPath();ctx.ellipse(rpx,rpy,ph*W*.22*rs,ph*W*.22*rs*.32,0,0,7);ctx.stroke()}
      const hh=H*.42*rs,ww=hh*80/150;ctx.globalAlpha=rIn;ctx.drawImage(RT,rpx-ww/2,rpy-hh,ww,hh);ctx.globalAlpha=1}
    /* pluviómetro y nube con lluvia (fondo izquierdo) */
    const cIn=seg(t,3.4,4.0)*(1-seg(t,6.2,6.8)),gx=-1.0,gz=.78,[gpx,gpy]=P(gx,gz),gs=S(gz);
    if(cIn>0){const cx=gpx,cy=hz-H*.16,cw=W*.13;ctx.globalAlpha=cIn;{const cg=ctx.createLinearGradient(0,cy-cw*.5,0,cy+cw*.25);cg.addColorStop(0,'rgba(226,234,244,.95)');cg.addColorStop(1,'rgba(120,138,160,.9)');ctx.fillStyle=cg;ctx.shadowColor='rgba(0,0,0,.35)';ctx.shadowBlur=24;ctx.beginPath();
      [[-.42,.08,.2],[-.2,-.06,.27],[.06,-.16,.31],[.32,-.04,.25],[.5,.08,.18]].forEach(([dx,dy,r])=>{ctx.moveTo(cx+dx*cw+r*cw,cy+dy*cw);ctx.arc(cx+dx*cw,cy+dy*cw,r*cw,0,7)});ctx.rect(cx-.5*cw,cy+.02*cw,cw*1.02,cw*.2);ctx.fill();ctx.shadowBlur=0}
      ctx.strokeStyle='rgba(191,224,255,.8)';ctx.lineWidth=1.6;drops.forEach(([u,v])=>{const x=cx-cw*.45+u*cw*.95,y=cy+cw*.24+((v+t*1.4)%1)*(gpy-cy-cw*.24);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-2,y+10);ctx.stroke()});
      const gh=H*.2*gs,gw=gh*40/90;ctx.drawImage(GA,gpx-gw/2+W*.03,gpy-gh,gw,gh);const lv=seg(t,3.8,6);ctx.fillStyle='#7FC1FF';ctx.fillRect(gpx+W*.03-gw*.2,gpy-gh*.05-gh*.45*lv,gw*.4,gh*.45*lv);ctx.globalAlpha=1}
    /* tractor con su línea de guiado */
    const tz=.16,tx=-1.5+2.15*seg(t,.5,5.6),ts=S(tz),[tpx,tpy]=P(tx,tz),[l0x,l0y]=P(-1.6,tz),[l1x]=P(1.6,tz);
    ctx.setLineDash([16,12]);ctx.lineDashOffset=-t*40;ctx.strokeStyle='rgba(127,193,255,.35)';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(tpx,l0y);ctx.lineTo(l1x,l0y);ctx.stroke();ctx.setLineDash([]);
    ctx.strokeStyle='#7FC1FF';ctx.lineWidth=4;ctx.shadowColor='#7FC1FF';ctx.shadowBlur=12;ctx.beginPath();ctx.moveTo(l0x,l0y);ctx.lineTo(tpx-W*.02,l0y);ctx.stroke();ctx.shadowBlur=0;
    {const th=H*.25*ts,tw=th*260/170,bob=Math.sin(t*14)*1.2;ctx.drawImage(TR,tpx-tw*.55,tpy-th*.93+bob,tw,th)}
    /* satélite y enlaces */
    const sIn=seg(t,1.1,1.6),sx=W*(.12+.7*seg(t,1.1,7)),sy=H*(.13-.05*Math.sin(seg(t,1.1,7)*Math.PI));
    if(sIn>0){ctx.globalAlpha=sIn;ctx.save();ctx.translate(sx,sy);ctx.rotate(-.25);ctx.fillStyle='#E5EEF8';ctx.fillRect(-12,-9,24,18);ctx.fillStyle='#0070C9';ctx.fillRect(-52,-6,34,12);ctx.fillRect(18,-6,34,12);ctx.restore();
      ctx.setLineDash([4,8]);ctx.lineDashOffset=-t*30;ctx.strokeStyle='rgba(191,224,255,.7)';ctx.lineWidth=1.6;ctx.beginPath();ctx.moveTo(sx,sy+10);ctx.lineTo(rpx,rpy-H*.42*rs);ctx.moveTo(sx,sy+10);ctx.lineTo(tpx,tpy-H*.25*ts);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1}
    /* dron que barre el campo con su cono */
    const dIn=seg(t,2.0,2.6);if(dIn>0){const dz=.45,[dpx,dpy]=P(scanX,dz),ds=S(dz),dy=dpy-H*.34*ds-(1-dIn)*H*.3+Math.sin(t*3)*4,dw=W*.16*ds,dh=dw*70/200;
      const [ax,ay]=P(scanX,0),[bx,by]=P(scanX,1.6);const cg=ctx.createLinearGradient(0,dy,0,ay);cg.addColorStop(0,'rgba(127,193,255,.45)');cg.addColorStop(1,'rgba(127,193,255,.04)');
      if(t>2.6&&t<5.5){ctx.fillStyle=cg;ctx.beginPath();ctx.moveTo(dpx,dy+dh*.8);ctx.lineTo(ax,ay);ctx.lineTo(bx,by);ctx.closePath();ctx.fill()}
      ctx.globalAlpha=dIn;ctx.drawImage(DR,dpx-dw/2,dy,dw,dh);ctx.fillStyle='rgba(191,224,255,.85)';const pr=dw*.13*(.4+.6*Math.abs(Math.sin(t*40)));[[.12],[.88]].forEach(([u])=>{ctx.beginPath();ctx.ellipse(dpx-dw/2+u*dw,dy+dh*.17,pr,2.2,0,0,7);ctx.fill()});ctx.globalAlpha=1}
    /* HUD */
    const hx=Math.max(18,W*.03),hy=Math.max(70,H*.08);ctx.font=`600 ${Math.max(12,Math.min(15,W/95))}px Inter, Arial`;ctx.textAlign='left';
    HUD.forEach(([ts0,txt],i)=>{if(t<ts0)return;const n=Math.min(txt.length,Math.floor((t-ts0)*45)),y=hy+i*24;ctx.fillStyle='#4ADE80';ctx.fillRect(hx,y-8,6,6);ctx.fillStyle=`rgba(229,238,248,${dim?.0:.92})`;ctx.fillText(txt.slice(0,n)+(n<txt.length&&Math.floor(t*6)%2?'▌':''),hx+14,y)});
    if(!fin&&t>6.4){fin=true;onEnd&&onEnd()}
    raf=requestAnimationFrame(frame)}
  raf=requestAnimationFrame(frame);
  return{stop(){cancelAnimationFrame(raf);removeEventListener('resize',resize)},dim(){dim=true},skip(){t0=performance.now()-7000}}}
