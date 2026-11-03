"""
Gerador de QR Code ISO/IEC 18004 puro em Python (Zero dependências externas).
Gera QR Codes em formato SVG (data:image/svg+xml;base64,...) para leitura
imediata pelo aplicativo móvel SerproID (opção Computadores -> +).
"""

import base64
from typing import List, Tuple

# Tabelas ISO/IEC 18004 para Nível de Correção L (Low - 7%, padrão ZXing)
# (version): (total_data_codewords, ec_codewords_per_block, [(num_blocks, data_codewords_per_block), ...], alignment_centers)
_VERSION_SPECS_L = {
    1: (19, 7, [(1, 19)], []),
    2: (34, 10, [(1, 34)], [6, 18]),
    3: (55, 15, [(1, 55)], [6, 22]),
    4: (80, 20, [(1, 80)], [6, 26]),
    5: (108, 26, [(1, 108)], [6, 30]),
    6: (136, 18, [(2, 68)], [6, 34]),
    7: (156, 20, [(2, 78)], [6, 22, 38]),
    8: (194, 24, [(2, 97)], [6, 24, 42]),
    9: (232, 30, [(2, 116)], [6, 26, 46]),
    10: (274, 18, [(2, 68), (2, 69)], [6, 28, 50]),
}

# Polinômio primitivo GF(256): x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
_GF_EXP = [0] * 512
_GF_LOG = [0] * 256


def _init_gf() -> None:
    x = 1
    for i in range(255):
        _GF_EXP[i] = x
        _GF_LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        _GF_EXP[i] = _GF_EXP[i - 255]


_init_gf()


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


def _rs_generator_poly(degree: int) -> List[int]:
    poly = [1]
    for i in range(degree):
        next_poly = [0] * (len(poly) + 1)
        root = _GF_EXP[i]
        for j, coeff in enumerate(poly):
            next_poly[j] ^= coeff
            next_poly[j + 1] ^= _gf_mul(coeff, root)
        poly = next_poly
    return poly


def _rs_encode(data: List[int], ec_len: int) -> List[int]:
    gen = _rs_generator_poly(ec_len)
    rem = [0] * ec_len
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        if factor != 0:
            for j in range(ec_len):
                rem[j] ^= _gf_mul(gen[j + 1], factor)
    return rem


def _encode_data_codewords(payload: bytes) -> Tuple[int, List[int]]:
    length = len(payload)
    selected_ver = 0
    for ver in sorted(_VERSION_SPECS_L.keys()):
        total_dc, _, _, _ = _VERSION_SPECS_L[ver]
        # Modo Byte (4 bits) + Tamanho (8 bits para v1..9, 16 bits para v10)
        header_bits = 4 + (8 if ver <= 9 else 16)
        max_bytes = (total_dc * 8 - header_bits) // 8
        if length <= max_bytes:
            selected_ver = ver
            break
    if selected_ver == 0:
        raise ValueError(f"Payload muito longo para QR Code v1-v10: {length} bytes")

    total_dc, _, _, _ = _VERSION_SPECS_L[selected_ver]
    bits: List[int] = []

    def append_bits(val: int, num_bits: int) -> None:
        for i in range(num_bits - 1, -1, -1):
            bits.append((val >> i) & 1)

    # Mode indicator: Byte mode = 0100
    append_bits(0b0100, 4)
    append_bits(length, 8 if selected_ver <= 9 else 16)
    for b in payload:
        append_bits(b, 8)

    # Terminator (até 4 zeros)
    capacity_bits = total_dc * 8
    term_len = min(4, capacity_bits - len(bits))
    append_bits(0, term_len)

    # Alinha ao próximo byte
    while len(bits) % 8 != 0:
        bits.append(0)

    codewords: List[int] = []
    for i in range(0, len(bits), 8):
        byte_val = 0
        for bit in bits[i : i + 8]:
            byte_val = (byte_val << 1) | bit
        codewords.append(byte_val)

    # Pad bytes alternados 0xEC, 0x11
    pad_Index = 0
    pads = [0xEC, 0x11]
    while len(codewords) < total_dc:
        codewords.append(pads[pad_Index % 2])
        pad_Index += 1

    return selected_ver, codewords


def _interleave_blocks(version: int, data_codewords: List[int]) -> List[int]:
    _, ec_len, block_groups, _ = _VERSION_SPECS_L[version]
    data_blocks: List[List[int]] = []
    ec_blocks: List[List[int]] = []
    offset = 0
    for count, dc_per_block in block_groups:
        for _ in range(count):
            block = data_codewords[offset : offset + dc_per_block]
            offset += dc_per_block
            data_blocks.append(block)
            ec_blocks.append(_rs_encode(block, ec_len))

    result: List[int] = []
    max_dc = max(len(b) for b in data_blocks)
    for i in range(max_dc):
        for b in data_blocks:
            if i < len(b):
                result.append(b[i])
    for i in range(ec_len):
        for eb in ec_blocks:
            result.append(eb[i])
    return result


def _compute_format_bits(ecl_bits: int, mask_pattern: int) -> int:
    data = (ecl_bits << 3) | mask_pattern
    rem = data << 10
    for i in range(14, 9, -1):
        if (rem >> i) & 1:
            rem ^= 0x537 << (i - 10)
    return ((data << 10) | rem) ^ 0x5412


def _compute_version_bits(version: int) -> int:
    rem = version << 12
    for i in range(17, 11, -1):
        if (rem >> i) & 1:
            rem ^= 0x1F25 << (i - 12)
    return (version << 12) | rem


def _build_matrix(version: int, codewords: List[int], mask: int) -> List[List[int]]:
    size = 17 + 4 * version
    matrix: List[List[int]] = [[0] * size for _ in range(size)]
    is_func: List[List[bool]] = [[False] * size for _ in range(size)]

    def set_func(r: int, c: int, val: int) -> None:
        if 0 <= r < size and 0 <= c < size:
            matrix[r][c] = val
            is_func[r][c] = True

    # Finder patterns + separators
    for fr, fc in [(0, 0), (0, size - 7), (size - 7, 0)]:
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                rr, cc = fr + dr, fc + dc
                if 0 <= rr < size and 0 <= cc < size:
                    if 0 <= dr <= 6 and 0 <= dc <= 6:
                        if dr in (0, 6) or dc in (0, 6) or (2 <= dr <= 4 and 2 <= dc <= 4):
                            set_func(rr, cc, 1)
                        else:
                            set_func(rr, cc, 0)
                    else:
                        set_func(rr, cc, 0)

    # Timing patterns
    for i in range(8, size - 8):
        val = 1 if i % 2 == 0 else 0
        set_func(6, i, val)
        set_func(i, 6, val)

    # Alignment patterns
    _, _, _, centers = _VERSION_SPECS_L[version]
    for ar in centers:
        for ac in centers:
            if (ar == 6 and ac == 6) or (ar == 6 and ac == size - 7) or (ar == size - 7 and ac == 6):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    val = 1 if (abs(dr) == 2 or abs(dc) == 2 or (dr == 0 and dc == 0)) else 0
                    set_func(ar + dr, ac + dc, val)

    # Dark module + reserva de áreas de formato
    set_func(4 * version + 9, 8, 1)
    for i in range(9):
        if not is_func[8][i]:
            set_func(8, i, 0)
        if not is_func[i][8]:
            set_func(i, 8, 0)
    for i in range(8):
        if not is_func[8][size - 1 - i]:
            set_func(8, size - 1 - i, 0)
        if not is_func[size - 1 - i][8]:
            set_func(size - 1 - i, 8, 0)

    # Version info (v7+)
    if version >= 7:
        vbits = _compute_version_bits(version)
        for i in range(18):
            bit = (vbits >> i) & 1
            r = i // 3
            c = size - 11 + (i % 3)
            set_func(r, c, bit)
            set_func(c, r, bit)

    # Bit stream de todos os codewords
    all_bits: List[int] = []
    for cw in codewords:
        for i in range(7, -1, -1):
            all_bits.append((cw >> i) & 1)

    # Posicionamento em zig-zag de 2 colunas da direita para a esquerda
    bit_idx = 0
    upward = True
    col = size - 1
    while col > 0:
        if col == 6:
            col -= 1
        row_iter = range(size - 1, -1, -1) if upward else range(size)
        for r in row_iter:
            for dc in (0, 1):
                c = col - dc
                if not is_func[r][c]:
                    bit = all_bits[bit_idx] if bit_idx < len(all_bits) else 0
                    bit_idx += 1
                    # Aplica máscara
                    invert = False
                    if mask == 0:
                        invert = (r + c) % 2 == 0
                    elif mask == 1:
                        invert = r % 2 == 0
                    elif mask == 2:
                        invert = c % 3 == 0
                    elif mask == 3:
                        invert = (r + c) % 3 == 0
                    elif mask == 4:
                        invert = (r // 2 + c // 3) % 2 == 0
                    elif mask == 5:
                        invert = (r * c) % 2 + (r * c) % 3 == 0
                    elif mask == 6:
                        invert = ((r * c) % 2 + (r * c) % 3) % 2 == 0
                    elif mask == 7:
                        invert = ((r + c) % 2 + (r * c) % 3) % 2 == 0
                    matrix[r][c] = bit ^ (1 if invert else 0)
        upward = not upward
        col -= 2

    # Escreve bits de formato (Nível L = 0b01) segundo ISO/IEC 18004 / ZXing MatrixUtil
    fbits = _compute_format_bits(0b01, mask)
    type_info_coords = [
        (8, 0),
        (8, 1),
        (8, 2),
        (8, 3),
        (8, 4),
        (8, 5),
        (8, 7),
        (8, 8),
        (7, 8),
        (5, 8),
        (4, 8),
        (3, 8),
        (2, 8),
        (1, 8),
        (0, 8),
    ]
    for i in range(15):
        bit = (fbits >> i) & 1
        x1, y1 = type_info_coords[i]
        set_func(y1, x1, bit)
        if i < 8:
            x2 = size - i - 1
            y2 = 8
        else:
            x2 = 8
            y2 = size - 7 + (i - 8)
        set_func(y2, x2, bit)

    return matrix


def generate_qr_svg_data_uri(text: str, border: int = 4) -> str:
    """
    Gera um QR Code SVG em formato Data URI (data:image/svg+xml;base64,...)
    pronto para ser atribuído ao atributo src de uma tag <img>.
    """
    payload = text.encode("utf-8")
    version, data_cws = _encode_data_codewords(payload)
    full_cws = _interleave_blocks(version, data_cws)
    matrix = _build_matrix(version, full_cws, mask=0)

    size = len(matrix)
    total = size + border * 2
    rects: List[str] = []
    for r in range(size):
        for c in range(size):
            if matrix[r][c]:
                rects.append(f"M{c + border},{r + border}h1v1h-1z")

    path_d = "".join(rects)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" '
        f'width="260" height="260" shape-rendering="crispEdges">'
        f'<rect width="100%" height="100%" fill="#ffffff"/>'
        f'<path d="{path_d}" fill="#000000"/>'
        f"</svg>"
    )
    b64 = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{b64}"
