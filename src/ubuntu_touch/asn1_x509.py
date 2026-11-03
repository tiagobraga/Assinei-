"""
Parser ASN.1 DER X.509 e PKCS#7 (.p7b) em Python puro (zero dependências externas).
Garante funcionamento 100% nativo dentro do confinamento AppArmor da OpenStore no Ubuntu Touch.
"""

import base64
import datetime
import re
from typing import Any, Dict, List, Optional, Tuple


OID_MAP = {
    "2.5.4.3": "CN",
    "2.5.4.6": "C",
    "2.5.4.7": "L",
    "2.5.4.8": "ST",
    "2.5.4.10": "O",
    "2.5.4.11": "OU",
    "2.5.4.5": "serialNumber",
    "1.3.6.1.5.5.7.1.1": "authorityInfoAccess",
    "1.3.6.1.5.5.7.48.2": "caIssuers",
    "1.2.840.113549.1.7.2": "signedData",
}


def decode_oid(oid_bytes: bytes) -> str:
    if not oid_bytes:
        return ""
    first = oid_bytes[0]
    parts = [str(first // 40), str(first % 40)]
    val = 0
    for b in oid_bytes[1:]:
        val = (val << 7) | (b & 0x7F)
        if not (b & 0x80):
            parts.append(str(val))
            val = 0
    return ".".join(parts)


def read_asn1_element(data: bytes, offset: int = 0) -> Tuple[int, int, bytes, int]:
    """
    Lê um elemento TLV (Tag, Length, Value) ASN.1 DER.
    Retorna: (tag, hdr_len, value_bytes, next_offset)
    """
    if offset >= len(data):
        raise ValueError("Offset fora dos limites do buffer ASN.1")
    tag = data[offset]
    length_byte = data[offset + 1]
    pos = offset + 2
    if (length_byte & 0x80) == 0:
        length = length_byte
    else:
        num_octets = length_byte & 0x7F
        if num_octets == 0 or pos + num_octets > len(data):
            raise ValueError("Comprimento ASN.1 inválido ou indefinido")
        length = int.from_bytes(data[pos : pos + num_octets], "big")
        pos += num_octets
    hdr_len = pos - offset
    val = data[pos : pos + length]
    return tag, hdr_len, val, pos + length


def iter_asn1_children(data: bytes) -> List[Tuple[int, bytes, bytes]]:
    """
    Itera sobre os filhos imediatos de uma estrutura construída ASN.1.
    Retorna lista de (tag, value_bytes, full_raw_bytes).
    """
    children = []
    offset = 0
    while offset < len(data):
        tag, hdr_len, val, next_offset = read_asn1_element(data, offset)
        raw = data[offset:next_offset]
        children.append((tag, val, raw))
        offset = next_offset
    return children


def _decode_asn1_string(tag: int, val: bytes) -> str:
    if tag == 0x1E:  # BMPString
        return val.decode("utf-16-be", errors="replace")
    return val.decode("utf-8", errors="replace")


def _parse_x509_name(name_der: bytes) -> Dict[str, str]:
    attrs: Dict[str, str] = {}
    for _, rdn_val, _ in iter_asn1_children(name_der):
        for _, atv_val, _ in iter_asn1_children(rdn_val):
            atv_children = iter_asn1_children(atv_val)
            if len(atv_children) >= 2 and atv_children[0][0] == 0x06:
                oid = decode_oid(atv_children[0][1])
                key = OID_MAP.get(oid, oid)
                attrs[key] = _decode_asn1_string(atv_children[1][0], atv_children[1][1])
    return attrs


def _parse_asn1_time(tag: int, val: bytes) -> str:
    s = val.decode("ascii", errors="ignore").rstrip("Z")
    try:
        if tag == 0x17:  # UTCTime (YYMMDDHHMMSS)
            year = int(s[0:2])
            year += 2000 if year < 50 else 1900
            dt = datetime.datetime(
                year,
                int(s[2:4]),
                int(s[4:6]),
                int(s[6:8]),
                int(s[8:10]),
                int(s[10:12]) if len(s) >= 12 else 0,
                tzinfo=datetime.timezone.utc,
            )
            return dt.isoformat()
        elif tag == 0x18:  # GeneralizedTime (YYYYMMDDHHMMSS)
            dt = datetime.datetime(
                int(s[0:4]),
                int(s[4:6]),
                int(s[6:8]),
                int(s[8:10]),
                int(s[10:12]),
                int(s[12:14]) if len(s) >= 14 else 0,
                tzinfo=datetime.timezone.utc,
            )
            return dt.isoformat()
    except Exception:
        pass
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _extract_aia_url_from_tbs(tbs_children: List[Tuple[int, bytes, bytes]]) -> Optional[str]:
    # Em X.509 v3, extensions tem tag [3] EXPLICIT (0xA3)
    for tag, val, _ in tbs_children:
        if tag == 0xA3:
            ext_seq = iter_asn1_children(val)
            if not ext_seq:
                continue
            for _, ext_entry, _ in iter_asn1_children(ext_seq[0][1]):
                ext_parts = iter_asn1_children(ext_entry)
                if len(ext_parts) >= 2 and ext_parts[0][0] == 0x06:
                    oid = decode_oid(ext_parts[0][1])
                    if oid == "1.3.6.1.5.5.7.1.1":  # authorityInfoAccess
                        octet_val = ext_parts[-1][1]
                        m = re.search(rb"https?://[^\s\x00-\x1f\"'<>]+", octet_val)
                        if m:
                            return m.group(0).decode("ascii", errors="ignore")
    return None


def parse_x509_der(der_bytes: bytes) -> Dict[str, Any]:
    """
    Extrai metadados de um certificado X.509 em formato DER (ou PEM convertido).
    """
    if b"-----BEGIN" in der_bytes:
        pem_text = der_bytes.decode("ascii", errors="ignore")
        m = re.search(
            r"-----BEGIN [^-]+-----(.+?)-----END [^-]+-----",
            pem_text,
            re.DOTALL,
        )
        if m:
            b64_clean = re.sub(r"\s+", "", m.group(1))
            der_bytes = base64.b64decode(b64_clean)

    _, _, cert_seq_val, _ = read_asn1_element(der_bytes, 0)
    cert_children = iter_asn1_children(cert_seq_val)
    if not cert_children:
        raise ValueError("Certificado X.509 inválido")

    tbs_val = cert_children[0][1]
    tbs_children = iter_asn1_children(tbs_val)

    idx = 0
    # Se o primeiro elemento for [0] EXPLICIT version (tag 0xA0), avança
    if tbs_children[0][0] == 0xA0:
        idx = 1

    serial_bytes = tbs_children[idx][1]
    serial_hex = serial_bytes.hex()

    # idx + 1 = signature algorithm
    issuer_attrs = _parse_x509_name(tbs_children[idx + 2][1])
    validity_children = iter_asn1_children(tbs_children[idx + 3][1])
    not_before = _parse_asn1_time(validity_children[0][0], validity_children[0][1])
    not_after = _parse_asn1_time(validity_children[1][0], validity_children[1][1])
    subject_attrs = _parse_x509_name(tbs_children[idx + 4][1])

    aia_url = _extract_aia_url_from_tbs(tbs_children)

    subject_cn = subject_attrs.get("CN", "Certificado Digital")
    issuer_cn = issuer_attrs.get("CN", "ICP-Brasil")

    is_ca = (
        (subject_cn == issuer_cn)
        or ("Autoridade Certificadora" in subject_cn)
        or subject_cn.startswith("AC ")
    )

    return {
        "subject": subject_cn,
        "issuer": issuer_cn,
        "serialNumber": serial_hex,
        "validity": {
            "notBefore": not_before,
            "notAfter": not_after,
        },
        "aiaUrl": aia_url,
        "rawDerBase64": base64.b64encode(der_bytes).decode("ascii"),
        "isCa": is_ca,
    }


def extract_certs_from_pkcs7_der(p7b_bytes: bytes) -> List[str]:
    """
    Extrai todos os certificados X.509 (em Base64 DER) de um pacote PKCS#7 / .p7b.
    """
    if b"-----BEGIN" in p7b_bytes:
        pem_text = p7b_bytes.decode("ascii", errors="ignore")
        b64_lines = [
            line.strip()
            for line in pem_text.splitlines()
            if line.strip() and not line.strip().startswith("-----")
        ]
        p7b_bytes = base64.b64decode("".join(b64_lines))

    _, _, content_info_val, _ = read_asn1_element(p7b_bytes, 0)
    ci_children = iter_asn1_children(content_info_val)
    if len(ci_children) < 2:
        return []

    # ci_children[1] é [0] EXPLICIT SignedData
    _, _, signed_data_seq, _ = read_asn1_element(ci_children[1][1], 0)
    sd_children = iter_asn1_children(signed_data_seq)

    certs_b64: List[str] = []
    for tag, val, _ in sd_children:
        # [0] IMPLICIT CertificateSet (tag 0xA0)
        if tag == 0xA0:
            for cert_tag, _, cert_raw in iter_asn1_children(val):
                if cert_tag == 0x30:  # SEQUENCE (X.509 Certificate)
                    certs_b64.append(base64.b64encode(cert_raw).decode("ascii"))
    return certs_b64


def extract_all_pem_certs(pem_bytes: bytes) -> List[str]:
    """
    Extrai todos os blocos CERTIFICATE de um arquivo PEM e retorna lista de DER em Base64.
    """
    pem_text = pem_bytes.decode("ascii", errors="ignore")
    matches = re.findall(
        r"-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----",
        pem_text,
        re.DOTALL,
    )
    result: List[str] = []
    for m in matches:
        b64_clean = re.sub(r"\s+", "", m)
        if b64_clean:
            # Normaliza via decode/encode para garantir Base64 limpo sem quebras
            raw = base64.b64decode(b64_clean)
            result.append(base64.b64encode(raw).decode("ascii"))
    return result

