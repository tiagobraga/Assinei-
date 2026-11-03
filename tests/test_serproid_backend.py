import base64
import json
import os
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

import sys

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src" / "ubuntu_touch"))

from asn1_x509 import (
    decode_oid,
    extract_all_pem_certs,
    iter_asn1_children,
    parse_x509_der,
    read_asn1_element,
)
from backend import SerproIdClient, UbuntuTouchBackend, XdgPaths
from pades_signer import der_integer, der_oid, der_seq, der_set, der_tlv, sign_pdf_pades


def _build_synthetic_leaf_cert_b64() -> str:
    """Gera um certificado X.509 v3 DER sintético de teste (sem dados pessoais reais)."""
    cn_oid = der_oid("2.5.4.3")
    issuer_dn = der_seq([der_set([der_seq([cn_oid, der_tlv(0x0C, b"Autoridade Certificadora SERPRORFBv5")])])])
    subject_dn = der_seq([der_set([der_seq([cn_oid, der_tlv(0x0C, b"USUARIO TESTE ICP-BRASIL:00000000000")])])])
    validity = der_seq([der_tlv(0x17, b"250101000000Z"), der_tlv(0x17, b"300101000000Z")])
    spki = der_seq([der_seq([der_oid("1.2.840.113549.1.1.1"), b"\x05\x00"]), der_tlv(0x03, b"\x00" + b"\x01" * 64)])
    aia_url = b"http://repositorio.serpro.gov.br/cadeias/acserprorfbv5.p7b"
    aia_ext_val = der_seq([der_seq([der_oid("1.3.6.1.5.5.7.48.2"), der_tlv(0x86, aia_url)])])
    aia_ext = der_seq([der_oid("1.3.6.1.5.5.7.1.1"), der_tlv(0x04, aia_ext_val)])
    bc_ext = der_seq([der_oid("2.5.29.19"), der_tlv(0x04, der_seq([]))])
    extensions = der_tlv(0xA3, der_seq([bc_ext, aia_ext]))
    tbs = der_seq(
        [
            der_tlv(0xA0, der_integer(2)),
            der_integer(123456789),
            der_seq([der_oid("1.2.840.113549.1.1.11"), b"\x05\x00"]),
            issuer_dn,
            validity,
            subject_dn,
            spki,
            extensions,
        ]
    )
    cert_der = der_seq(
        [
            tbs,
            der_seq([der_oid("1.2.840.113549.1.1.11"), b"\x05\x00"]),
            der_tlv(0x03, b"\x00" + b"\xaa" * 64),
        ]
    )
    return base64.b64encode(cert_der).decode("ascii")


class TestSerproIdUbuntuTouchBackend(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp_dir = tempfile.TemporaryDirectory()
        base = Path(self.tmp_dir.name)
        os.environ["XDG_DATA_HOME"] = str(base / "data")
        os.environ["XDG_CONFIG_HOME"] = str(base / "config")
        os.environ["XDG_CACHE_HOME"] = str(base / "cache")
        self.paths = XdgPaths("assinei.tiagobraga")

        self.client = SerproIdClient(self.paths, import_legacy=False)

        self.sample_pem_path = PROJECT_ROOT / "src" / "ubuntu_touch" / "cadeia_icp_brasil.pem"
        ca_chain_b64 = extract_all_pem_certs(self.sample_pem_path.read_bytes())
        self.all_chain_b64 = [_build_synthetic_leaf_cert_b64()] + ca_chain_b64

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def test_parse_icp_brasil_certificate_and_aia(self) -> None:
        self.assertGreaterEqual(len(self.all_chain_b64), 2)
        leaf_der = base64.b64decode(self.all_chain_b64[0])
        info = parse_x509_der(leaf_der)
        self.assertIn("USUARIO TESTE ICP-BRASIL", info["subject"])
        self.assertIn("SERPRO", info["issuer"])
        self.assertFalse(info["isCa"])
        self.assertEqual(
            info["aiaUrl"],
            "http://repositorio.serpro.gov.br/cadeias/acserprorfbv5.p7b",
        )

    def test_register_device_and_qr_payload(self) -> None:
        with patch.object(
            self.client,
            "_request_json",
            return_value={"identificador": "uuid-teste-ut-1234"},
        ) as mock_req:
            res = self.client.register_device(custom_hostname="ubuntu-touch-phone")
            self.assertTrue(res["success"])
            self.assertEqual(res["maquinaId"], "uuid-teste-ut-1234")
            qr_obj = json.loads(res["qrPayload"])
            self.assertEqual(qr_obj["identificador"], "uuid-teste-ut-1234")
            self.assertEqual(qr_obj["nome"], "LINUX_64")
            self.assertEqual(qr_obj["hostname"], "ubuntu-touch-phone")
            self.assertTrue(res["qrSvgDataUri"].startswith("data:image/svg+xml;base64,"))
            mock_req.assert_called_once_with("POST", "drivers/maquina", payload={})

    def test_sync_and_list_certificates(self) -> None:
        self.client.set_maquina_id("uuid-teste-ut-1234")
        leaf_b64 = self.all_chain_b64[0]

        mock_api_response = [
            {
                "id": 98765,
                "certificadoB64": f"-----BEGIN CERTIFICATE-----\n{leaf_b64}\n-----END CERTIFICATE-----",
                "certificadoP7b": "",
            }
        ]

        with patch.object(self.client, "_request_json", return_value=mock_api_response):
            sync_res = self.client.sync_certificates()
            self.assertTrue(sync_res["success"])
            self.assertEqual(sync_res["installedCount"], 1)
            self.assertEqual(len(sync_res["certs"]), 1)

            cert = sync_res["certs"][0]
            self.assertEqual(cert["slotId"], "98765")
            self.assertIn("USUARIO TESTE ICP-BRASIL", cert["subject"])
            # Verifica que a cadeia ICP-Brasil completa foi anexada
            self.assertGreaterEqual(len(cert["chainB64"]), 2)

    def test_sign_digest_polling_flow(self) -> None:
        self.client.set_maquina_id("uuid-teste-ut-1234")
        fake_sig_b64 = base64.b64encode(b"S" * 256).decode("ascii")

        responses = [
            {"id": 555},
            {"status": "AGUARDANDO"},
            {"status": "ACEITO", "desafioAssinado": fake_sig_b64},
        ]

        with patch.object(self.client, "_request_json", side_effect=responses), patch(
            "time.sleep", return_value=None
        ):
            digest_b64 = base64.b64encode(b"D" * 51).decode("ascii")
            res = self.client.sign_digest("98765", digest_b64)
            self.assertTrue(res["success"])
            self.assertEqual(res["signatureBase64"], fake_sig_b64)
            self.assertEqual(res["pedidoId"], 555)

    def test_content_hub_import_and_export(self) -> None:
        backend = UbuntuTouchBackend()
        sample_pdf = Path(self.tmp_dir.name) / "contrato.pdf"
        sample_pdf.write_bytes(b"%PDF-1.4\n%Teste Ubuntu Touch\n%%EOF\n")

        imp_res = backend.enqueue_imported_file(f"file://{sample_pdf}")
        self.assertTrue(imp_res["success"])
        self.assertEqual(imp_res["name"], "contrato.pdf")

        pending = backend.pop_pending_files()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["name"], "contrato.pdf")
        self.assertEqual(
            base64.b64decode(pending[0]["base64"]),
            b"%PDF-1.4\n%Teste Ubuntu Touch\n%%EOF\n",
        )

        # Verifica fila limpa após pop
        self.assertEqual(len(backend.pop_pending_files()), 0)

        # Testa exportação de PDF assinado
        signed_b64 = base64.b64encode(b"%PDF-1.4\n%Assinado\n%%EOF\n").decode("ascii")
        save_res = backend.save_signed_pdf(signed_b64, "contrato.pdf")
        self.assertTrue(save_res["success"])
        self.assertEqual(save_res["fileName"], "contrato_tb.pdf")
        self.assertTrue(Path(save_res["destPath"]).exists())

    def test_local_http_server_endpoints(self) -> None:
        backend = UbuntuTouchBackend()
        port = backend.start_local_server(preferred_port=0)
        self.assertGreater(port, 0)

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data["ok"])
            self.assertEqual(data["platform"], "ubuntu-touch")

    def test_pades_pdf_signing_and_cryptographic_verification(self) -> None:
        """
        Testa a assinatura PAdES completa sobre src/backend/ibict.pdf com estampa visual
        e verifica matematicamente o ByteRange, estrutura PKCS#7 e messageDigest SHA-256.
        """
        import hashlib
        import re

        sample_pdf_path = PROJECT_ROOT / "src" / "backend" / "ibict.pdf"
        raw_pdf = sample_pdf_path.read_bytes()
        leaf_b64 = self.all_chain_b64[0]

        captured_digest_info: list[bytes] = []

        def mock_serpro_sign(digest_info_b64: str) -> dict:
            captured_digest_info.append(base64.b64decode(digest_info_b64))
            return {
                "success": True,
                "signatureBase64": base64.b64encode(b"\xab" * 256).decode("ascii"),
            }

        signed_pdf = sign_pdf_pades(
            pdf_bytes=raw_pdf,
            cert_der_b64=leaf_b64,
            chain_b64_list=self.all_chain_b64,
            sign_digest_fn=mock_serpro_sign,
            signature_box={"page": 1, "x": 0.15, "y": 0.75, "w": 0.4, "h": 0.1},
            icon_path=PROJECT_ROOT / "assets" / "ipe.png",
        )

        # 1. Confirma que o DigestInfo enviado ao SerproID tem 51 bytes (19 prefixo OID SHA-256 + 32 hash)
        self.assertEqual(len(captured_digest_info), 1)
        self.assertEqual(len(captured_digest_info[0]), 51)
        self.assertTrue(
            captured_digest_info[0].startswith(
                bytes.fromhex("3031300d060960864801650304020105000420")
            )
        )

        # 2. Verifica /ByteRange e extrai os dados assinados (mesma lógica do verify.cjs)
        m = re.search(rb"/ByteRange\s*\[(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\]", signed_pdf)
        self.assertIsNotNone(m)
        b0, b1, b2, b3 = (int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)))
        self.assertEqual(b0, 0)
        self.assertEqual(b2 + b3, len(signed_pdf))

        signed_data = signed_pdf[b0 : b0 + b1] + signed_pdf[b2 : b2 + b3]
        actual_pdf_sha256 = hashlib.sha256(signed_data).digest()

        # 3. Extrai o CMS hex entre b1 e b2 e verifica que o messageDigest dentro do PKCS#7 é idêntico
        gap_bytes = signed_pdf[b0 + b1 : b2]
        self.assertTrue(gap_bytes.startswith(b"<") and gap_bytes.endswith(b">"))
        hex_str = gap_bytes[1:-1].decode("ascii").rstrip("0")
        if len(hex_str) % 2 != 0:
            hex_str += "0"
        cms_der = bytes.fromhex(hex_str)

        # Faz o parse da estrutura ContentInfo -> SignedData -> SignerInfos -> signedAttrs
        _, _, ci_val, _ = read_asn1_element(cms_der, 0)
        ci_children = iter_asn1_children(ci_val)
        self.assertEqual(decode_oid(ci_children[0][1]), "1.2.840.113549.1.7.2")  # signedData

        # Procura o OID messageDigest (1.2.840.113549.1.9.4) no DER do CMS
        md_oid_der = bytes.fromhex("06092a864886f70d010904")
        pos = cms_der.find(md_oid_der)
        self.assertNotEqual(pos, -1)
        # Logo após o OID vem SET (0x31, len 0x22) -> OCTET STRING (0x04, len 0x20) -> 32 bytes do hash
        set_tag, _, set_val, _ = read_asn1_element(cms_der, pos + len(md_oid_der))
        self.assertEqual(set_tag, 0x31)
        oct_tag, _, expected_pdf_sha256, _ = read_asn1_element(set_val, 0)
        self.assertEqual(oct_tag, 0x04)
        self.assertEqual(actual_pdf_sha256, expected_pdf_sha256)

    def test_render_pdf_pages(self) -> None:
        backend = UbuntuTouchBackend()
        sample_pdf = PROJECT_ROOT / "src" / "backend" / "ibict.pdf"
        pdf_b64 = base64.b64encode(sample_pdf.read_bytes()).decode("ascii")
        res = backend.render_pdf_pages(pdf_b64)
        self.assertTrue(res["success"])
        self.assertEqual(res["numPages"], 1)
        self.assertEqual(len(res["pages"]), 1)
        self.assertEqual(res["pages"][0]["page"], 1)
        self.assertGreater(res["pages"][0]["width"], 500)
        self.assertGreater(res["pages"][0]["height"], 700)
        self.assertTrue(len(res["pages"][0]["imageBase64"]) > 100)

    def test_logo_embedding_without_pil_on_ubuntu_touch(self) -> None:
        """
        Garante que no Ubuntu Touch (onde python3-pil não está instalado e Image é None),
        as 3 logos (ipe.png, brasao.png, ibict.png) são embutidas como Image XObject (/ImLogo Do)
        na estampa visual da assinatura digital.
        """
        import pades_signer

        sample_pdf = (PROJECT_ROOT / "src" / "backend" / "ibict.pdf").read_bytes()
        leaf_b64 = self.all_chain_b64[0]

        with patch.object(pades_signer, "Image", None):
            for logo_name in ("ipe.png", "brasao.png", "ibict.png"):
                signed = sign_pdf_pades(
                    pdf_bytes=sample_pdf,
                    cert_der_b64=leaf_b64,
                    chain_b64_list=self.all_chain_b64,
                    sign_digest_fn=lambda _: {
                        "success": True,
                        "signatureBase64": base64.b64encode(b"\xab" * 256).decode("ascii"),
                    },
                    signature_box={"page": 1, "x": 0.1, "y": 0.7, "w": 0.45, "h": 0.12},
                    icon_path=PROJECT_ROOT / "assets" / logo_name,
                )
                self.assertIn(b"/ImLogo Do", signed, f"Logo {logo_name} ausente no stream de aparência")
                self.assertIn(b"/Subtype /Image", signed, f"Image XObject ausente para {logo_name}")


if __name__ == "__main__":
    unittest.main()
