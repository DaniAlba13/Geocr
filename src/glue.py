import struct, json, os
def escribir_shp(ruta, feats):
    """feats: lista de dict(rings=[[[lon,lat],...]], attrs=dict). Escribe .shp/.shx/.dbf/.cpg (lon/lat, sin .prj)."""
    recs=[];bb=[1e9,1e9,-1e9,-1e9]
    for f in feats:
        rings=[r if r[0]==r[-1] else r+[r[0]] for r in f['rings']]
        pts=[p for r in rings for p in r]
        xs=[p[0] for p in pts];ys=[p[1] for p in pts]
        b=(min(xs),min(ys),max(xs),max(ys));bb=[min(bb[0],b[0]),min(bb[1],b[1]),max(bb[2],b[2]),max(bb[3],b[3])]
        parts=[];k=0
        for r in rings: parts.append(k);k+=len(r)
        c=struct.pack('<i4d2i',5,*b,len(rings),len(pts))+struct.pack('<%di'%len(parts),*parts)+b''.join(struct.pack('<2d',*p) for p in pts)
        recs.append(c)
    def header(total_words):
        return struct.pack('>7i',9994,0,0,0,0,0,total_words)+struct.pack('<2i',1000,5)+struct.pack('<8d',*bb,0,0,0,0)
    shp=b'';shx=b'';off=50
    for i,c in enumerate(recs):
        shp+=struct.pack('>2i',i+1,len(c)//2)+c;shx+=struct.pack('>2i',off,len(c)//2);off+=4+len(c)//2
    open(ruta+'.shp','wb').write(header(50+len(shp)//2)+shp)
    open(ruta+'.shx','wb').write(header(50+len(shx)//2)+shx)
    campos=[('TAB','C',10),('PIEZA','N',5),('PIEZ','C',3),('DIVISION_C','N',3),('VARIEDAD_N','C',20)]
    hl=32+32*len(campos)+1;rl=1+sum(c[2] for c in campos)
    h=struct.pack('<B3BIHH20x',3,126,1,1,len(feats),hl,rl)
    for n,t,l in campos: h+=n.encode().ljust(11,b'\0')+t.encode()+b'\0'*4+bytes([l,0])+b'\0'*14
    h+=b'\r'
    body=b''
    for f in feats:
        a=f['attrs'];body+=b' '
        for n,t,l in campos:
            v=str(a.get(n,''));body+=(v.rjust(l) if t=='N' else v.ljust(l)).encode('utf-8')[:l]
    open(ruta+'.dbf','wb').write(h+body+b'\x1a');open(ruta+'.cpg','w').write('UTF-8')
