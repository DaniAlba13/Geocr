import struct
def dbf(p):
    b=open(p,'rb').read();n,hl,rl=struct.unpack('<IHH',b[4:12]);F=[];o=32
    while b[o]!=0x0D:
        nm=b[o:o+11].split(b'\0')[0].decode('latin1');t=chr(b[o+11]);ln=b[o+16];F.append((nm,t,ln));o+=32
    R=[]
    for i in range(n):
        s=hl+i*rl;q=s+1;r={}
        for nm,t,ln in F:
            v=b[q:q+ln].decode('utf-8','replace').strip();q+=ln
            if t in 'NF':
                try:v=float(v) if v else None
                except:pass
            r[nm]=v
        R.append(r)
    return [f[0] for f in F],R
def shp(p):
    b=open(p,'rb').read();o=100;S=[]
    while o<len(b):
        _,cl=struct.unpack('>II',b[o:o+8]);c=b[o+8:o+8+cl*2];o+=8+cl*2
        st=struct.unpack('<i',c[:4])[0]
        if st==0:S.append([]);continue
        np_,npt=struct.unpack('<ii',c[36:44]);parts=list(struct.unpack('<%di'%np_,c[44:44+4*np_]));pts=struct.unpack('<%dd'%(2*npt),c[44+4*np_:44+4*np_+16*npt])
        P=[(pts[2*i],pts[2*i+1]) for i in range(npt)];parts.append(npt)
        S.append([P[parts[i]:parts[i+1]] for i in range(np_)])
    return S
