from pathlib import Path
out=Path(__file__).resolve().parent
pages=[]
def page(label, media, crop, rotation, commands):
    # commands use baseline positions in PDF default user coordinates
    body='BT\n/F1 12 Tf\n'
    for text,x,y in commands:
        safe=text.replace('\\','\\\\').replace('(','\\(').replace(')','\\)')
        body+=f'1 0 0 1 {x} {y} Tm ({safe}) Tj\n'
    body+='ET\n'
    pages.append((label,media,crop,rotation,body.encode('ascii')))
page('p1 single column; two entries; multi-line; ASCII superscript/subscript stand-ins',[0,0,612,792],[36,48,576,744],0,[
 ('ENTRY-ALPHA',72,690),('alpha first line',72,670),('alpha second line marker^2',72,650),
 ('ENTRY-BETA',72,590),('beta line water_H2O',72,570),('beta next line',72,550)])
page('p2 next physical page',[0,0,612,792],[36,48,576,744],0,[('PAGE-TWO ENTRY-GAMMA',72,690),('gamma source phrase',72,670)])
page('p3 two columns',[0,0,612,792],[36,48,576,744],0,[('LEFT-COLUMN ENTRY-DELTA',72,690),('delta line two',72,670),('RIGHT-COLUMN ENTRY-EPSILON',330,690),('epsilon line two',330,670)])
for rot in (0,90,180,270):
    page(f'p{4+rot//90} rotation {rot}; nonzero MediaBox/CropBox',[20,30,632,822],[60,90,572,762],rot,[(f'ROTATION-{rot}-ENTRY-ZETA',100,700),(f'rotation {rot} second line',100,680)])
# PDF 1.4 document, plain Helvetica, uncompressed streams.
objs=[]
def add(s): objs.append(s if isinstance(s,bytes) else s.encode('ascii')); return len(objs)
catalog_id=add(b'')
pages_id=add(b'')
helv_id=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
page_ids=[]
for label,media,crop,rotation,stream in pages:
    content_id=add(b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'endstream')
    m=' '.join(map(str,media)); c=' '.join(map(str,crop))
    page_id=add(f'<< /Type /Page /Parent {pages_id} 0 R /MediaBox [{m}] /CropBox [{c}] /Rotate {rotation} /Resources << /Font << /F1 {helv_id} 0 R >> >> /Contents {content_id} 0 R >>')
    page_ids.append(page_id)
objs[catalog_id-1]=f'<< /Type /Catalog /Pages {pages_id} 0 R >>'.encode()
objs[pages_id-1]=f'<< /Type /Pages /Kids [{" ".join(f"{i} 0 R" for i in page_ids)}] /Count {len(page_ids)} >>'.encode()
pdf=b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; offsets=[0]
for i,obj in enumerate(objs,1):
    offsets.append(len(pdf)); pdf+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
xref=len(pdf); pdf+=f'xref\n0 {len(objs)+1}\n0000000000 65535 f \n'.encode()
for off in offsets[1:]: pdf+=f'{off:010d} 00000 n \n'.encode()
pdf+=f'trailer\n<< /Size {len(objs)+1} /Root {catalog_id} 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
(out/'source-region.pdf').write_bytes(pdf)
