import re
import os

with open('/Users/tiagobraga/Downloads/1. Resposta à Representação - IBICT_tb.pdf', 'rb') as f:
    data = f.read()
    
# Find the contents tag
matches = re.finditer(b'/Contents *<([0-9A-Fa-f]+)>', data)
for m in matches:
    hex_data = m.group(1).decode('ascii')
    with open('/Users/tiagobraga/Documents/0306_p_assinador_pdf/cms.der', 'wb') as out:
        import binascii
        out.write(binascii.unhexlify(hex_data))
    print("CMS Extracted")
