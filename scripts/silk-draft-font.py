import math
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen

src, out = sys.argv[1], sys.argv[2]
f = TTFont(src)
glyf = f['glyf']
gs = f.getGlyphSet()
R = 48


def capsule(a, b, r=R, steps=10):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy) or 1
    ux, uy = dx / L, dy / L
    nx, ny = -uy, ux
    base = math.atan2(ny, nx)
    pts = []
    for i in range(steps + 1):
        t = base - math.pi * i / steps
        pts.append((b[0] + r * math.cos(t), b[1] + r * math.sin(t)))
    for i in range(steps + 1):
        t = base + math.pi - math.pi * i / steps
        pts.append((a[0] + r * math.cos(t), a[1] + r * math.sin(t)))
    area = sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(pts, pts[1:] + pts[:1]))
    return pts if area < 0 else pts[::-1]


def draw(pen, pts):
    pen.moveTo(tuple(round(v) for v in pts[0]))
    for p in pts[1:]:
        pen.lineTo(tuple(round(v) for v in p))
    pen.closePath()


pen = TTGlyphPen(gs)
for a, b in [((336, 688), (336, 48)), ((336, 688), (176, 548)), ((176, 48), (496, 48))]:
    draw(pen, capsule(a, b))
glyf['one'] = pen.glyph()
f['hmtx']['one'] = (672, 128)

pen = TTGlyphPen(gs)
gs['zero'].draw(pen)
draw(pen, capsule((196, 150), (476, 586)))
glyf['zero'] = pen.glyph()

for rec in f['name'].names:
    text = rec.toUnicode()
    if 'Routed Gothic' in text or 'RoutedGothic' in text:
        rec.string = text.replace('Routed Gothic', 'Silk Draft').replace('RoutedGothic', 'SilkDraft')
f.save(out)
