import re
import binascii

def ext(pdf_path, out_path):
    with open(pdf_path, 'rb') as f:
        data = f.read()

    # Find /ByteRange
    idx = data.rfind(b'/ByteRange')
    if idx == -1:
        print("No byterange in", pdf_path)
        return
        
    br_match = re.search(rb'/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]', data[idx:idx+100])
    if br_match:
        gap_start = int(br_match.group(1)) + int(br_match.group(2))
        gap_end = int(br_match.group(3))
        
        sig_data = data[gap_start:gap_end]
        sig_hex = sig_data.replace(b'<', b'').replace(b'>', b'').replace(b'\n', b'').replace(b'\r', b'').replace(b' ', b'').replace(b'\x00', b'')
        sig_hex = sig_hex.rstrip(b'0')
        if len(sig_hex) % 2 != 0:
            sig_hex += b'0'
        
        with open(out_path, 'wb') as fout:
            fout.write(binascii.unhexlify(sig_hex))
        print("OK", out_path)

ext('/Users/tiagobraga/Downloads/1. Resposta à Representação - IBICT_tb.pdf', '/Users/tiagobraga/Documents/0306_p_assinador_pdf/govbr.der')
ext('/Users/tiagobraga/Documents/documento_assinado_tb6.pdf', '/Users/tiagobraga/Documents/0306_p_assinador_pdf/meu.der')
