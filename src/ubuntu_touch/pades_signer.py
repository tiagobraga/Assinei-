"""
Motor PAdES (PDF Advanced Electronic Signatures) + Estampa Visual ICP-Brasil em Python.
100% compatível com o padrão ICP-Brasil / SerproID e independente de arquitetura (roda em ARM64/all no Ubuntu Touch).
"""

import base64
import datetime
import hashlib
import json
import re
import struct
import zlib
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from asn1_x509 import iter_asn1_children, parse_x509_der, read_asn1_element

try:
    from PIL import Image  # type: ignore
except ImportError:
    Image = None


SIGNATURE_HEX_CAPACITY = 66000  # 33000 bytes em hex


# ============================================================================
# 1. Codificador ASN.1 DER para PKCS#7 / CMS SignedData (PAdES)
# ============================================================================

def der_encode_length(length: int) -> bytes:
    if length < 0x80:
        return bytes([length])
    length_bytes = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(length_bytes)]) + length_bytes


def der_tlv(tag: int, value: bytes) -> bytes:
    return bytes([tag]) + der_encode_length(len(value)) + value


def der_seq(items: List[bytes]) -> bytes:
    return der_tlv(0x30, b"".join(items))


def der_set(items: List[bytes]) -> bytes:
    # X.690 11.6: elementos de um SET OF em DER devem ser ordenados lexicograficamente
    sorted_items = sorted(items)
    return der_tlv(0x31, b"".join(sorted_items))


def der_oid(oid_str: str) -> bytes:
    parts = [int(p) for p in oid_str.split(".")]
    out = bytearray([parts[0] * 40 + parts[1]])
    for val in parts[2:]:
        if val == 0:
            out.append(0)
        else:
            buf = bytearray()
            while val > 0:
                buf.append(val & 0x7F)
                val >>= 7
            for i in range(len(buf) - 1, 0, -1):
                out.append(buf[i] | 0x80)
            out.append(buf[0])
    return der_tlv(0x06, bytes(out))


def der_integer(val: int) -> bytes:
    if val == 0:
        return der_tlv(0x02, b"\x00")
    byte_len = (val.bit_length() + 8) // 8
    return der_tlv(0x02, val.to_bytes(byte_len, "big", signed=True))


def der_octet_string(data: bytes) -> bytes:
    return der_tlv(0x04, data)


def der_null() -> bytes:
    return b"\x05\x00"


def der_utctime(dt: datetime.datetime) -> bytes:
    utc_dt = dt.astimezone(datetime.timezone.utc)
    s = utc_dt.strftime("%y%m%d%H%M%SZ").encode("ascii")
    return der_tlv(0x17, s)


def extract_issuer_and_serial_raw_der(cert_der: bytes) -> Tuple[bytes, bytes]:
    """
    Extrai os bytes ASN.1 DER exatos do campo Issuer (Name SEQUENCE) e SerialNumber (INTEGER)
    diretamente do TBSCertificate do certificado X.509 do titular.
    """
    _, _, cert_seq_val, _ = read_asn1_element(cert_der, 0)
    cert_children = iter_asn1_children(cert_seq_val)
    tbs_val = cert_children[0][1]
    tbs_children = iter_asn1_children(tbs_val)
    idx = 1 if tbs_children[0][0] == 0xA0 else 0
    serial_raw_der = tbs_children[idx][2]
    issuer_raw_der = tbs_children[idx + 2][2]
    return issuer_raw_der, serial_raw_der


def build_pkcs7_pades(
    pdf_signed_bytes: bytes,
    cert_der_b64: str,
    chain_b64_list: List[str],
    sign_digest_fn: Callable[[str], Dict[str, Any]],
) -> bytes:
    """
    Constrói a estrutura PKCS#7 / CMS SignedData destacada (adbe.pkcs7.detached),
    calcula o DigestInfo SHA-256 dos authenticatedAttributes, delega a assinatura RSA
    ao SerproID e retorna o CMS DER completo.
    """
    leaf_der = base64.b64decode(cert_der_b64)
    issuer_raw_der, serial_raw_der = extract_issuer_and_serial_raw_der(leaf_der)

    # 1. Calcula o SHA-256 dos bytes assinados do PDF (ByteRange[0..1] + ByteRange[2..3])
    pdf_sha256 = hashlib.sha256(pdf_signed_bytes).digest()

    # 2. Monta os authenticatedAttributes (contentType, signingTime, messageDigest)
    attr_content_type = der_seq(
        [
            der_oid("1.2.840.113549.1.9.3"),  # contentType
            der_set([der_oid("1.2.840.113549.1.7.1")]),  # id-data
        ]
    )
    attr_signing_time = der_seq(
        [
            der_oid("1.2.840.113549.1.9.5"),  # signingTime
            der_set([der_utctime(datetime.datetime.now(datetime.timezone.utc))]),
        ]
    )
    attr_message_digest = der_seq(
        [
            der_oid("1.2.840.113549.1.9.4"),  # messageDigest
            der_set([der_octet_string(pdf_sha256)]),
        ]
    )

    attrs_items = [attr_content_type, attr_signing_time, attr_message_digest]
    # Para o cálculo do hash dos atributos autenticados (RFC 5652), usa-se tag SET (0x31)
    attrs_for_hash_der = der_set(attrs_items)
    attrs_sha256 = hashlib.sha256(attrs_for_hash_der).digest()

    # No SignerInfo, signedAttrs tem tag [0] IMPLICIT (0xA0) com o mesmo conteúdo ordenado
    signed_attrs_implicit = der_tlv(0xA0, b"".join(sorted(attrs_items)))

    # 3. Empacota o DigestInfo PKCS#1 (SHA-256 OID + 32 bytes do hash dos atributos)
    digest_info_prefix = bytes.fromhex("3031300d060960864801650304020105000420")
    digest_info_bytes = digest_info_prefix + attrs_sha256
    digest_info_b64 = base64.b64encode(digest_info_bytes).decode("ascii")

    # 4. Solicita a assinatura ao SerproID
    sign_res = sign_digest_fn(digest_info_b64)
    if not sign_res.get("success") or not sign_res.get("signatureBase64"):
        raise RuntimeError(
            sign_res.get("error") or "Falha ao obter assinatura criptográfica do SerproID."
        )

    signature_bytes = base64.b64decode(sign_res["signatureBase64"])

    # 5. Monta algoritmos e SignerInfo
    alg_sha256 = der_seq([der_oid("2.16.840.1.101.3.4.2.1"), der_null()])
    alg_sha256_with_rsa = der_seq([der_oid("1.2.840.113549.1.1.11"), der_null()])

    issuer_and_serial = der_seq([issuer_raw_der, serial_raw_der])

    signer_info = der_seq(
        [
            der_integer(1),  # version = 1
            issuer_and_serial,
            alg_sha256,
            signed_attrs_implicit,
            alg_sha256_with_rsa,
            der_octet_string(signature_bytes),
        ]
    )

    # 6. Empacota todos os certificados da cadeia ICP-Brasil
    effective_chain = chain_b64_list if chain_b64_list else [cert_der_b64]
    certs_raw_list: List[bytes] = []
    for c_b64 in effective_chain:
        try:
            c_der = base64.b64decode(c_b64)
            if c_der not in certs_raw_list:
                certs_raw_list.append(c_der)
        except Exception:
            pass
    if leaf_der not in certs_raw_list:
        certs_raw_list.insert(0, leaf_der)

    certificates_implicit = der_tlv(0xA0, b"".join(certs_raw_list))

    # 7. Monta SignedData e ContentInfo (1.2.840.113549.1.7.2)
    encap_content_info = der_seq([der_oid("1.2.840.113549.1.7.1")])
    signed_data = der_seq(
        [
            der_integer(1),  # version = 1
            der_set([alg_sha256]),  # digestAlgorithms
            encap_content_info,
            certificates_implicit,
            der_set([signer_info]),  # signerInfos
        ]
    )

    content_info = der_seq(
        [
            der_oid("1.2.840.113549.1.7.2"),  # id-signedData
            der_tlv(0xA0, signed_data),
        ]
    )
    return content_info


# ============================================================================
# 2. Utilitários de PDF: Parsing de Objetos, Imagem PNG e Estampa Visual
# ============================================================================

def _pdf_escape_text(text: str) -> bytes:
    """Converte string para WinAnsi/Latin-1 escapando parênteses e barras para literais PDF."""
    raw = text.encode("latin-1", errors="replace")
    raw = raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    return raw


def _decode_png_pure_python(png_bytes: bytes) -> Optional[Tuple[int, int, bytes, Optional[bytes]]]:
    """
    Decodificador PNG 100% Python puro (stdlib struct + zlib) para Ubuntu Touch,
    onde python3-pil não está instalado na imagem do sistema.
    """
    if not png_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    pos = 8
    width = height = bit_depth = color_type = interlace = 0
    plte: bytes = b""
    trns: bytes = b""
    idat_chunks: List[bytes] = []

    while pos + 8 <= len(png_bytes):
        length = struct.unpack(">I", png_bytes[pos : pos + 4])[0]
        chunk_type = png_bytes[pos + 4 : pos + 8]
        chunk_data = png_bytes[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if chunk_type == b"IHDR" and len(chunk_data) >= 13:
            width, height, bit_depth, color_type, _, _, interlace = struct.unpack(">IIBBBBB", chunk_data[:13])
        elif chunk_type == b"PLTE":
            plte = chunk_data
        elif chunk_type == b"tRNS":
            trns = chunk_data
        elif chunk_type == b"IDAT":
            idat_chunks.append(chunk_data)
        elif chunk_type == b"IEND":
            break

    if width <= 0 or height <= 0 or bit_depth != 8 or interlace != 0 or not idat_chunks:
        return None

    channels_map = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
    if color_type not in channels_map:
        return None
    bpp = channels_map[color_type]
    stride = width * bpp

    raw = zlib.decompress(b"".join(idat_chunks))
    if len(raw) < height * (1 + stride):
        return None

    recon = bytearray(height * stride)
    in_pos = 0
    for y in range(height):
        f_type = raw[in_pos]
        in_pos += 1
        row_out = y * stride
        prev_out = (y - 1) * stride
        for x in range(stride):
            val = raw[in_pos + x]
            a = recon[row_out + x - bpp] if x >= bpp else 0
            b = recon[prev_out + x] if y > 0 else 0
            c = recon[prev_out + x - bpp] if (y > 0 and x >= bpp) else 0
            if f_type == 1:
                val = (val + a) & 0xFF
            elif f_type == 2:
                val = (val + b) & 0xFF
            elif f_type == 3:
                val = (val + ((a + b) >> 1)) & 0xFF
            elif f_type == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                val = (val + pr) & 0xFF
            recon[row_out + x] = val
        in_pos += stride

    rgb_bytes = bytearray()
    alpha_bytes = bytearray()
    has_alpha = color_type in (4, 6) or (color_type == 3 and len(trns) > 0)

    for idx_px in range(width * height):
        off = idx_px * bpp
        if color_type == 6:
            rgb_bytes.extend(recon[off : off + 3])
            alpha_bytes.append(recon[off + 3])
        elif color_type == 2:
            rgb_bytes.extend(recon[off : off + 3])
        elif color_type == 4:
            g = recon[off]
            rgb_bytes.extend((g, g, g))
            alpha_bytes.append(recon[off + 1])
        elif color_type == 0:
            g = recon[off]
            rgb_bytes.extend((g, g, g))
        elif color_type == 3:
            p_idx = recon[off]
            if p_idx * 3 + 3 <= len(plte):
                rgb_bytes.extend(plte[p_idx * 3 : p_idx * 3 + 3])
            else:
                rgb_bytes.extend((0, 0, 0))
            if has_alpha:
                alpha_bytes.append(trns[p_idx] if p_idx < len(trns) else 255)

    return (
        width,
        height,
        zlib.compress(bytes(rgb_bytes)),
        zlib.compress(bytes(alpha_bytes)) if has_alpha else None,
    )


def _load_png_for_pdf(png_path: Path, max_dim: int = 128) -> Optional[Tuple[int, int, bytes, Optional[bytes]]]:
    """
    Carrega um arquivo PNG e retorna (width, height, compressed_rgb, compressed_alpha)
    prontos para inserção como Image XObject (/FlateDecode) no PDF.
    Prioriza o cache pré-compilado (logos_pdf_cache.json) para funcionar sem python3-pil no Ubuntu Touch.
    """
    cache_file = Path(__file__).resolve().parent / "logos_pdf_cache.json"
    if cache_file.exists():
        try:
            cache_data = json.loads(cache_file.read_text(encoding="utf-8"))
            entry = cache_data.get(png_path.name)
            if entry:
                return (
                    int(entry["w"]),
                    int(entry["h"]),
                    base64.b64decode(entry["rgb_z_b64"]),
                    base64.b64decode(entry["alpha_z_b64"]) if entry.get("alpha_z_b64") else None,
                )
        except Exception:
            pass

    if not png_path.exists():
        return None

    if Image is not None:
        try:
            with Image.open(png_path) as img:
                img = img.convert("RGBA")
                if img.width > max_dim or img.height > max_dim:
                    img.thumbnail((max_dim, max_dim))
                w, h = img.size
                raw_rgba = img.tobytes()
                rgb_bytes = bytearray()
                alpha_bytes = bytearray()
                for idx in range(0, len(raw_rgba), 4):
                    rgb_bytes.extend(raw_rgba[idx : idx + 3])
                    alpha_bytes.append(raw_rgba[idx + 3])
                return (
                    w,
                    h,
                    zlib.compress(bytes(rgb_bytes)),
                    zlib.compress(bytes(alpha_bytes)),
                )
        except Exception:
            pass

    try:
        return _decode_png_pure_python(png_path.read_bytes())
    except Exception:
        return None


def _find_pdf_pages_and_root(pdf_bytes: bytes) -> Tuple[int, List[Tuple[int, float, float, bytes]]]:
    """
    Localiza os objetos do PDF (suportando tanto tabelas xref clássicas quanto objetos diretos):
    Retorna:
      (root_obj_num, [(page_obj_num, width, height, page_dict_bytes), ...])
    """
    obj_pattern = re.compile(rb"(\d+)\s+0\s+obj\b(.*?)endobj", re.DOTALL)
    objects: Dict[int, bytes] = {}
    for m in obj_pattern.finditer(pdf_bytes):
        obj_num = int(m.group(1))
        objects[obj_num] = m.group(2).strip()

    # Caso o PDF possua Object Streams (/Type /ObjStm), descompacta os objetos internos
    for obj_num, body in list(objects.items()):
        if re.search(rb"/Type\s*/ObjStm\b", body):
            sm = re.search(rb"stream\r?\n(.*?)\r?\nendstream", body, re.DOTALL)
            nm = re.search(rb"/N\s+(\d+)", body)
            fm = re.search(rb"/First\s+(\d+)", body)
            if sm and nm and fm:
                try:
                    decompressed = zlib.decompress(sm.group(1))
                    n_objs = int(nm.group(1))
                    first_off = int(fm.group(1))
                    header_tokens = decompressed[:first_off].decode("ascii", errors="ignore").split()
                    pairs = [
                        (int(header_tokens[2 * i]), int(header_tokens[2 * i + 1]))
                        for i in range(min(n_objs, len(header_tokens) // 2))
                    ]
                    for idx_p, (inner_num, rel_off) in enumerate(pairs):
                        start_p = first_off + rel_off
                        end_p = (
                            first_off + pairs[idx_p + 1][1]
                            if idx_p + 1 < len(pairs)
                            else len(decompressed)
                        )
                        objects[inner_num] = decompressed[start_p:end_p].strip()
                except Exception:
                    pass

    root_obj_num = 0
    for num, body in objects.items():
        if re.search(rb"/Type\s*/Catalog\b", body):
            root_obj_num = num
            break

    if not root_obj_num:
        rm = re.search(rb"/Root\s+(\d+)\s+0\s+R", pdf_bytes)
        if rm:
            root_obj_num = int(rm.group(1))

    # Descobre MediaBox herdado (caso definido no /Pages pai)
    default_w, default_h = 595.28, 841.89
    for num, body in objects.items():
        if re.search(rb"/Type\s*/Pages\b", body):
            mb = re.search(
                rb"/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]",
                body,
            )
            if mb:
                default_w = float(mb.group(3)) - float(mb.group(1))
                default_h = float(mb.group(4)) - float(mb.group(2))

    # Ordena as páginas na ordem listada em /Kids se possível
    pages_list: List[Tuple[int, float, float, bytes]] = []
    page_objs: Dict[int, Tuple[float, float, bytes]] = {}
    for num, body in objects.items():
        if re.search(rb"/Type\s*/Page\b(?!s)", body):
            w, h = default_w, default_h
            mb = re.search(
                rb"/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]",
                body,
            )
            if mb:
                w = float(mb.group(3)) - float(mb.group(1))
                h = float(mb.group(4)) - float(mb.group(2))
            page_objs[num] = (w, h, body)

    # Tenta preservar a ordem de /Kids no objeto /Pages
    ordered_nums: List[int] = []
    for num, body in objects.items():
        if re.search(rb"/Type\s*/Pages\b", body):
            km = re.search(rb"/Kids\s*\[(.*?)\]", body, re.DOTALL)
            if km:
                for ref_m in re.finditer(rb"(\d+)\s+0\s+R", km.group(1)):
                    r_num = int(ref_m.group(1))
                    if r_num in page_objs and r_num not in ordered_nums:
                        ordered_nums.append(r_num)

    for num in sorted(page_objs.keys()):
        if num not in ordered_nums:
            ordered_nums.append(num)

    for num in ordered_nums:
        w, h, body = page_objs[num]
        pages_list.append((num, w, h, body))

    return root_obj_num, pages_list


def sign_pdf_pades(
    pdf_bytes: bytes,
    cert_der_b64: str,
    chain_b64_list: List[str],
    sign_digest_fn: Callable[[str], Dict[str, Any]],
    signature_box: Optional[Dict[str, float]] = None,
    icon_path: Optional[Path] = None,
) -> bytes:
    """
    Assina um documento PDF aplicando a estampa visual ICP-Brasil / SerproID e a estrutura
    criptográfica PAdES (adbe.pkcs7.detached) sem depender de Node.js.
    """
    cert_info = parse_x509_der(base64.b64decode(cert_der_b64))
    subject_name = cert_info["subject"].split(":")[0].strip() or "Assinante"

    root_num, pages = _find_pdf_pages_and_root(pdf_bytes)
    if not root_num or not pages:
        raise ValueError("Estrutura interna do PDF não pôde ser identificada (/Catalog ou /Page ausentes).")

    # Determina página e coordenadas cartesianas PDF (Y=0 na base)
    sig_w = 240.0
    sig_h = 65.0
    if (
        signature_box
        and float(signature_box.get("w", 0)) > 0
        and float(signature_box.get("h", 0)) > 0
    ):
        page_idx = max(0, min(len(pages) - 1, int(signature_box.get("page", 1)) - 1))
        page_obj_num, page_w, page_h, page_body = pages[page_idx]
        sig_w = max(float(signature_box["w"]) * page_w, 200.0)
        sig_h = max(float(signature_box["h"]) * page_h, 45.0)
        final_x = min(float(signature_box["x"]) * page_w, max(0.0, page_w - sig_w))
        final_y = max(0.0, page_h - (float(signature_box["y"]) * page_h) - sig_h)
    else:
        page_idx = len(pages) - 1
        page_obj_num, page_w, page_h, page_body = pages[page_idx]
        final_x = max(10.0, page_w - sig_w - 40.0)
        final_y = 40.0

    # Descobre o maior número de objeto existente no PDF para alocar novos objetos
    all_nums = [int(m.group(1)) for m in re.finditer(rb"(\d+)\s+0\s+obj\b", pdf_bytes)]
    max_obj_num = max(all_nums + [root_num, page_obj_num, 10])

    next_id = max_obj_num + 1
    font_regular_id = next_id
    font_bold_id = next_id + 1
    ap_form_id = next_id + 2
    sig_dict_id = next_id + 3
    widget_id = next_id + 4
    next_free_id = next_id + 5

    img_obj_id: Optional[int] = None
    smask_obj_id: Optional[int] = None
    png_data = _load_png_for_pdf(icon_path) if icon_path else None
    if png_data is not None:
        img_obj_id = next_free_id
        next_free_id += 1
        if png_data[3] is not None:
            smask_obj_id = next_free_id
            next_free_id += 1

    # Constrói o Appearance Stream (/BBox [0 0 sig_w sig_h]) da estampa visual ICP-Brasil
    img_pad = min(8.0, sig_h * 0.1)
    img_h = (sig_h - img_pad * 2.0) if (img_obj_id and png_data and sig_h > 20) else 0.0
    img_w = (
        img_h * (float(png_data[0]) / max(1.0, float(png_data[1])))
        if (img_h > 0 and png_data)
        else 0.0
    )
    text_x = (img_w + img_pad * 2.0) if img_w > 0 else (img_pad * 1.5)
    line_top = sig_h - (img_pad * 2.0) - 4.0
    dyn_font = max(6.0, min(8.0, sig_h * 0.15))
    line_h = dyn_font * 1.45

    short_name = subject_name[:25] + "..." if len(subject_name) > 28 else subject_name
    date_str = datetime.datetime.now().strftime("%d/%m/%Y %H:%M:%S")

    ap_cmds: List[bytes] = [
        b"q",
        b"0.96 0.96 0.98 rg",
        b"0.5 0.5 0.5 RG",
        b"1.5 w",
        f"0.75 0.75 {sig_w - 1.5:.2f} {sig_h - 1.5:.2f} re B".encode("ascii"),
    ]

    if img_obj_id and img_w > 8 and img_h > 8:
        ap_cmds.extend(
            [
                b"q",
                f"{img_w:.2f} 0 0 {img_h:.2f} {img_pad:.2f} {img_pad:.2f} cm".encode("ascii"),
                b"/ImLogo Do",
                b"Q",
            ]
        )

    ap_cmds.extend(
        [
            b"BT",
            b"0.2 0.2 0.2 rg",
            f"/F2 {dyn_font:.2f} Tf".encode("ascii"),
            f"{text_x:.2f} {line_top:.2f} Td".encode("ascii"),
            b"(" + _pdf_escape_text("ASSINATURA DIGITAL") + b") Tj",
            b"0.1 0.1 0.1 rg",
            f"/F1 {max(5.5, dyn_font - 1.0):.2f} Tf".encode("ascii"),
            f"0 -{line_h:.2f} Td".encode("ascii"),
            b"(" + _pdf_escape_text(short_name) + b") Tj",
            b"0.4 0.4 0.4 rg",
            f"/F1 {max(5.0, dyn_font - 2.0):.2f} Tf".encode("ascii"),
            f"0 -{line_h:.2f} Td".encode("ascii"),
            b"(" + _pdf_escape_text(f"Assinado em {date_str}") + b") Tj",
            b"0.5 0.5 0.5 rg",
            b"/F1 6.5 Tf",
            f"0 -{line_h:.2f} Td".encode("ascii"),
            b"(Fornecido por SERPRO-ID / ICP-Brasil) Tj",
            b"ET",
            b"Q",
        ]
    )
    ap_stream_bytes = b"\n".join(ap_cmds)

    # Atualiza o dicionário da página alvo para incluir o widget em /Annots
    if re.search(rb"/Annots\s*\[", page_body):
        updated_page_body = re.sub(
            rb"/Annots\s*\[",
            f"/Annots [ {widget_id} 0 R ".encode("ascii"),
            page_body,
            count=1,
        )
    else:
        # Insere /Annots antes do >> final do dicionário da página
        last_close = page_body.rfind(b">>")
        updated_page_body = (
            page_body[:last_close]
            + f"\n/Annots [ {widget_id} 0 R ]\n>>".encode("ascii")
        )

    # Localiza o corpo do Catalog (/Root) e adiciona /AcroForm
    catalog_match = re.search(
        rf"\b{root_num}\s+0\s+obj\b(.*?)endobj".encode("ascii"),
        pdf_bytes,
        re.DOTALL,
    )
    if catalog_match:
        cat_body = catalog_match.group(1).strip()
        if re.search(rb"/AcroForm\b", cat_body):
            # Se já tem AcroForm inline com /Fields [
            if re.search(rb"/Fields\s*\[", cat_body):
                updated_cat_body = re.sub(
                    rb"/Fields\s*\[",
                    f"/Fields [ {widget_id} 0 R ".encode("ascii"),
                    cat_body,
                    count=1,
                )
            else:
                last_c = cat_body.rfind(b">>")
                updated_cat_body = (
                    cat_body[:last_c]
                    + f"\n/AcroForm << /Fields [ {widget_id} 0 R ] /SigFlags 3 >>\n>>".encode("ascii")
                )
        else:
            last_c = cat_body.rfind(b">>")
            updated_cat_body = (
                cat_body[:last_c]
                + f"\n/AcroForm << /Fields [ {widget_id} 0 R ] /SigFlags 3 >>\n>>".encode("ascii")
            )
    else:
        updated_cat_body = (
            f"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [ {widget_id} 0 R ] /SigFlags 3 >> >>".encode(
                "ascii"
            )
        )

    # Prepara os objetos novos / atualizados
    new_objects: List[Tuple[int, bytes]] = [
        (page_obj_num, updated_page_body),
        (root_num, updated_cat_body),
        (
            font_regular_id,
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        ),
        (
            font_bold_id,
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        ),
    ]

    if png_data is not None and img_obj_id is not None:
        pw, ph, rgb_z, alpha_z = png_data
        smask_ref = f"/SMask {smask_obj_id} 0 R " if smask_obj_id else ""
        img_header = (
            f"<< /Type /XObject /Subtype /Image /Width {pw} /Height {ph} "
            f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
            f"{smask_ref}/Length {len(rgb_z)} >>\nstream\n"
        ).encode("ascii")
        new_objects.append((img_obj_id, img_header + rgb_z + b"\nendstream"))

        if smask_obj_id is not None and alpha_z is not None:
            smask_header = (
                f"<< /Type /XObject /Subtype /Image /Width {pw} /Height {ph} "
                f"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode "
                f"/Length {len(alpha_z)} >>\nstream\n"
            ).encode("ascii")
            new_objects.append((smask_obj_id, smask_header + alpha_z + b"\nendstream"))

    xobj_res = f"/XObject << /ImLogo {img_obj_id} 0 R >> " if img_obj_id else ""
    ap_header = (
        f"<< /Type /XObject /Subtype /Form /FormType 1 "
        f"/BBox [ 0 0 {sig_w:.2f} {sig_h:.2f} ] "
        f"/Resources << /Font << /F1 {font_regular_id} 0 R /F2 {font_bold_id} 0 R >> {xobj_res}>> "
        f"/Length {len(ap_stream_bytes)} >>\nstream\n"
    ).encode("ascii")
    new_objects.append((ap_form_id, ap_header + ap_stream_bytes + b"\nendstream"))

    pdf_date = datetime.datetime.now(datetime.timezone.utc).strftime("D:%Y%m%d%H%M%SZ")
    br_placeholder = b"/ByteRange [0 ********** ********** **********]"
    contents_placeholder = b"<" + (b"0" * SIGNATURE_HEX_CAPACITY) + b">"

    sig_dict_body = (
        b"<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached "
        + br_placeholder
        + b" /Contents "
        + contents_placeholder
        + b" /Reason (Assinatura Digital SERPRO-ID)"
        + b" /Name ("
        + _pdf_escape_text(subject_name)
        + b") /Location (BR) /ContactInfo (SERPRO-ID / ICP-Brasil) /M ("
        + pdf_date.encode("ascii")
        + b") >>"
    )
    new_objects.append((sig_dict_id, sig_dict_body))

    rect_str = f"[ {final_x:.2f} {final_y:.2f} {final_x + sig_w:.2f} {final_y + sig_h:.2f} ]"
    widget_body = (
        f"<< /Type /Annot /Subtype /Widget /FT /Sig "
        f"/Rect {rect_str} "
        f"/V {sig_dict_id} 0 R "
        f"/T (Signature_{int(datetime.datetime.now().timestamp())}) "
        f"/F 132 "
        f"/P {page_obj_num} 0 R "
        f"/AP << /N {ap_form_id} 0 R >> >>"
    ).encode("ascii")
    new_objects.append((widget_id, widget_body))

    # Localiza o startxref anterior do PDF original
    prev_xref_matches = list(re.finditer(rb"startxref\s+(\d+)", pdf_bytes))
    prev_xref_offset = int(prev_xref_matches[-1].group(1)) if prev_xref_matches else 0

    buf = bytearray(pdf_bytes)
    if not buf.endswith(b"\n"):
        buf.extend(b"\n")

    # Grava os objetos incrementais registrando seus offsets exatos
    offsets: Dict[int, int] = {}
    for obj_id, obj_content in new_objects:
        offsets[obj_id] = len(buf)
        buf.extend(f"{obj_id} 0 obj\n".encode("ascii"))
        buf.extend(obj_content)
        buf.extend(b"\nendobj\n")

    # Constrói sub-seções xref para os objetos adicionados/modificados
    xref_offset = len(buf)
    buf.extend(b"xref\n")
    for obj_id in sorted(offsets.keys()):
        buf.extend(f"{obj_id} 1\n".encode("ascii"))
        buf.extend(f"{offsets[obj_id]:010d} 00000 n \n".encode("ascii"))

    prev_clause = f"/Prev {prev_xref_offset} " if prev_xref_offset > 0 else ""
    trailer_str = (
        f"trailer\n<< /Size {next_free_id} /Root {root_num} 0 R {prev_clause}>>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    )
    buf.extend(trailer_str.encode("ascii"))

    # Localiza a posição exata do placeholder /ByteRange e de /Contents <000...>
    br_pos = buf.rfind(br_placeholder)
    if br_pos == -1:
        raise RuntimeError("Falha interna: /ByteRange placeholder não encontrado.")

    contents_tag_pos = buf.find(b"/Contents <", br_pos)
    hex_start = buf.find(b"<", contents_tag_pos)
    hex_end = buf.find(b">", hex_start) + 1

    byte_range_vals = [0, hex_start, hex_end, len(buf) - hex_end]
    actual_br = f"/ByteRange [{byte_range_vals[0]} {byte_range_vals[1]} {byte_range_vals[2]} {byte_range_vals[3]}]".encode(
        "ascii"
    )
    padded_br = actual_br + b" " * (len(br_placeholder) - len(actual_br))
    buf[br_pos : br_pos + len(br_placeholder)] = padded_br

    # Extrai os dois intervalos assinados do documento
    signed_data_bytes = bytes(buf[0:hex_start]) + bytes(buf[hex_end:])

    # Constrói o PKCS#7 / CMS assinando via SerproID
    cms_der = build_pkcs7_pades(
        signed_data_bytes,
        cert_der_b64,
        chain_b64_list,
        sign_digest_fn,
    )
    cms_hex = cms_der.hex().encode("ascii")
    if len(cms_hex) > SIGNATURE_HEX_CAPACITY:
        raise RuntimeError(
            f"Tamanho do CMS ({len(cms_hex)}) excede a capacidade ({SIGNATURE_HEX_CAPACITY})."
        )

    padded_cms_hex = cms_hex + b"0" * (SIGNATURE_HEX_CAPACITY - len(cms_hex))
    buf[hex_start + 1 : hex_end - 1] = padded_cms_hex

    return bytes(buf)
