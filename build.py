"""Arma public/index.html (la página que publica Cloudflare) a partir de src/.
Uso:  python build.py"""
import json, os
R = os.path.dirname(os.path.abspath(__file__)); s = lambda f: os.path.join(R, 'src', f)
enc = lambda t: json.dumps(t).replace('</', '<\\/')
h = open(s('app.html'), encoding='utf-8').read()
rep = {'__NAXENGINE__': open(s('nax_engine.js'), encoding='utf-8').read(), '__SHEETS__': open(s('sheets.json')).read(),
       '__LAYERS__': open(s('layers.json')).read(), '__PIECES__': open(s('pieces.json')).read(), '__ATTRS__': open(s('attrs.json')).read(),
       '__CASCRIPT__': enc(open(s('calidad_aplicacion_dji.py'), encoding='utf-8').read()), '__GLUE__': enc(open(s('glue.py'), encoding='utf-8').read()),
       '__ROSA__': open(s('rosa.b64')).read().strip(),
       '__CAMPO__': open(s('campo.json'), encoding='utf-8').read().replace('</', '<\\/')}
for k, v in rep.items():
    assert k in h, k
    h = h.replace(k, v)
os.makedirs(os.path.join(R, 'public'), exist_ok=True)
open(os.path.join(R, 'public', 'index.html'), 'w', encoding='utf-8').write(h)
print('public/index.html', len(h) // 1024, 'KB')
