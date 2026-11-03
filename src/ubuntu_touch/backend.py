"""
Backend Python nativo para Ubuntu Touch (OpenStore / Lomiri).
Gerencia:
1. Integração com Lomiri Content Hub (via sinais PyOtherSide com Main.qml).
2. Armazenamento XDG estritamente confinado (compatível com click-review da OpenStore):
   - Dados: ~/.local/share/assinei.tiagobraga/
   - Config: ~/.config/assinei.tiagobraga/
   - Cache/Transferências: ~/.cache/assinei.tiagobraga/
3. Cliente Nativo SerproID (smartcert-api) para arquiteturas ARM64/all:
   - Pareamento de dispositivo (POST /smartcert-api/api/drivers/maquina + QR Code)
   - Sincronização de certificados (GET /smartcert-api/api/drivers/certificados)
   - Assinatura remota com Push PIN (POST/GET /smartcert-api/api/drivers/assinatura)
4. Servidor HTTP Loopback (127.0.0.1) para servir a UI empacotada (evitando restrições CORS
   de file:// no WebWorker do PDF.js) e expor a API local para o WebEngineView.
"""

import base64
import getpass
import http.server
import json
import os
import shutil
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

# Garante que o diretório atual esteja no sys.path quando carregado pelo PyOtherSide
CURRENT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = CURRENT_DIR.parent.parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from asn1_x509 import (
    extract_all_pem_certs,
    extract_certs_from_pkcs7_der,
    parse_x509_der,
)
from pades_signer import _find_pdf_pages_and_root, sign_pdf_pades
from qrcode_gen import generate_qr_svg_data_uri

try:
    import pyotherside  # type: ignore
except ImportError:
    pyotherside = None


APP_ID = "assinei-ut.braga"
SERPRO_VERSION = "2.1.6"
SERPRO_SO = "LINUX_64"


def _notify_qml(event_name: str, payload: Any = None) -> None:
    if pyotherside is not None:
        try:
            pyotherside.send(event_name, payload)
        except Exception as exc:
            print(f"[Assinei-UT] Erro ao enviar evento PyOtherSide {event_name}: {exc}")


class XdgPaths:
    """Resolve diretórios XDG confinados permitidos pelo AppArmor na OpenStore."""

    def __init__(self, app_id: str = APP_ID) -> None:
        home = Path.home()
        xdg_data = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
        xdg_config = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
        xdg_cache = Path(os.environ.get("XDG_Cache_HOME") or os.environ.get("XDG_CACHE_HOME", home / ".cache"))

        self.data_dir = xdg_data / app_id
        self.config_dir = xdg_config / app_id
        self.cache_dir = xdg_cache / app_id

        self.serpro_dir = self.data_dir / "serproid"
        self.certs_dir = self.serpro_dir / "certificados"
        self.chains_dir = self.serpro_dir / "cadeias"
        self.incoming_dir = self.cache_dir / "incoming"
        self.signed_dir = self.cache_dir / "signed"

        try:
            for d in (
                self.data_dir,
                self.config_dir,
                self.cache_dir,
                self.serpro_dir,
                self.certs_dir,
                self.chains_dir,
                self.incoming_dir,
                self.signed_dir,
            ):
                d.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Fallback para /tmp caso o ambiente de execução tenha HOME somente-leitura
            tmp_root = Path("/tmp") / app_id
            self.data_dir = tmp_root / "data"
            self.config_dir = tmp_root / "config"
            self.cache_dir = tmp_root / "cache"
            self.serpro_dir = self.data_dir / "serproid"
            self.certs_dir = self.serpro_dir / "certificados"
            self.chains_dir = self.serpro_dir / "cadeias"
            self.incoming_dir = self.cache_dir / "incoming"
            self.signed_dir = self.cache_dir / "signed"
            for d in (
                self.data_dir,
                self.config_dir,
                self.cache_dir,
                self.serpro_dir,
                self.certs_dir,
                self.chains_dir,
                self.incoming_dir,
                self.signed_dir,
            ):
                d.mkdir(parents=True, exist_ok=True)


class SerproIdClient:
    """
    Implementação em Python puro do protocolo SerproID SmartCert API
    (https://serproid.serpro.gov.br:443/smartcert-api/api/).
    Funciona nativamente em ARM64 (Ubuntu Touch) sem depender de libserproidp11.so (x86_64).
    """

    HOSTS = {
        "producao": "serproid.serpro.gov.br",
        "homologacao": "hom.serproid.serpro.gov.br",
    }

    def __init__(self, paths: XdgPaths, import_legacy: bool = True) -> None:
        self.paths = paths
        self.import_legacy = import_legacy
        if self.import_legacy:
            self._ImportDesktopConfigIfAvailable()

    def _ImportDesktopConfigIfAvailable(self) -> None:
        if not self.import_legacy:
            return
        """
        Em ambientes de desenvolvimento ou não-confinados onde ~/.config/serproid já exista,
        importa silenciosamente o maquinaId e certificados se o armazenamento do app estiver vazio.
        """
        try:
            legacy_dir = Path.home() / ".config" / "serproid"
            if not legacy_dir.exists():
                return
            target_maq = self.paths.serpro_dir / "maquinaId"
            legacy_maq = legacy_dir / "maquinaId"
            if not target_maq.exists() and legacy_maq.exists():
                shutil.copy2(legacy_maq, target_maq)

            legacy_certs = legacy_dir / "certificados"
            if legacy_certs.exists():
                for cer_file in legacy_certs.glob("*.cer"):
                    dest = self.paths.certs_dir / cer_file.name
                    if not dest.exists():
                        shutil.copy2(cer_file, dest)
        except PermissionError:
            # No Ubuntu Touch confinado (AppArmor), ~/.config/serproid não é acessível, o que é esperado.
            pass
        except Exception as exc:
            print(f"[Assinei-UT] Aviso ao checar config legada: {exc}")

    def get_ambiente(self) -> str:
        amb_file = self.paths.serpro_dir / "ambiente"
        if amb_file.exists():
            val = amb_file.read_text(encoding="utf-8", errors="ignore").strip().lower()
            if val in ("1", "hom", "homologacao"):
                return "homologacao"
        return "producao"

    def get_base_url(self) -> str:
        host = self.HOSTS.get(self.get_ambiente(), self.HOSTS["producao"])
        return f"https://{host}:443/smartcert-api/api"

    def get_maquina_id(self) -> str:
        key_name = "maquinaIdHom" if self.get_ambiente() == "homologacao" else "maquinaId"
        maq_file = self.paths.serpro_dir / key_name
        if maq_file.exists():
            return maq_file.read_text(encoding="utf-8", errors="ignore").strip()
        return ""

    def set_maquina_id(self, maquina_id: str) -> None:
        key_name = "maquinaIdHom" if self.get_ambiente() == "homologacao" else "maquinaId"
        maq_file = self.paths.serpro_dir / key_name
        maq_file.write_text(maquina_id.strip(), encoding="utf-8")

    def _ssl_context(self) -> ssl.SSLContext:
        ctx = ssl.create_default_context()
        # A API do SerproID utiliza cadeias ICP-Brasil / AC Serpro SSL que podem não constar
        # no ca-certificates padrão do Ubuntu Touch. Carregamos as raízes SSL do SerproID e ICP-Brasil.
        for pem_name in ("serpro_ssl_cas.pem", "cadeia_icp_brasil.pem"):
            fallback_pem = CURRENT_DIR / pem_name
            if fallback_pem.exists():
                try:
                    ctx.load_verify_locations(cafile=str(fallback_pem))
                except Exception:
                    pass
        return ctx

    def _request_json(
        self,
        method: str,
        endpoint: str,
        payload: Optional[Dict[str, Any]] = None,
        maquina_id: Optional[str] = None,
        timeout: int = 15,
    ) -> Any:
        url = f"{self.get_base_url()}/{endpoint.lstrip('/')}"
        headers = {
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "x-app-so": SERPRO_SO,
            "x-app-version": SERPRO_VERSION,
        }
        uuid_val = maquina_id if maquina_id is not None else self.get_maquina_id()
        if uuid_val:
            headers["X-SMARTCERT-UUID"] = uuid_val

        data_bytes = None
        if payload is not None:
            data_bytes = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self._ssl_context()) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                return json.loads(raw) if raw.strip() else {}
        except ssl.SSLError:
            # Fallback para conexões onde a AC Raiz ICP-Brasil v5/SerproSSL não está instalada no ca-bundle do aparelho
            unverified_ctx = ssl._create_unverified_context()
            with urllib.request.urlopen(req, timeout=timeout, context=unverified_ctx) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                return json.loads(raw) if raw.strip() else {}

    def get_status(self) -> Dict[str, Any]:
        maq_id = self.get_maquina_id()
        cert_files = list(self.paths.certs_dir.glob("*.cer"))
        hostname = socket.gethostname() or "ubuntu-phablet"
        try:
            username = getpass.getuser()
        except Exception:
            username = "phablet"

        qr_payload = None
        qr_svg_uri = None
        if maq_id:
            qr_payload = json.dumps(
                {
                    "identificador": maq_id,
                    "nome": SERPRO_SO,
                    "hostname": hostname,
                    "username": username,
                },
                separators=(",", ":"),
            )
            try:
                qr_svg_uri = generate_qr_svg_data_uri(qr_payload)
            except Exception:
                qr_svg_uri = None

        return {
            "success": True,
            "paired": bool(maq_id),
            "maquinaId": maq_id,
            "ambiente": self.get_ambiente(),
            "certificatesCount": len(cert_files),
            "qrPayload": qr_payload,
            "qrSvgDataUri": qr_svg_uri,
            "hostname": hostname,
            "username": username,
        }

    def register_device(
        self,
        custom_hostname: Optional[str] = None,
        force_new: bool = False,
    ) -> Dict[str, Any]:
        """
        Registra uma nova máquina na nuvem SerproID (POST /smartcert-api/api/drivers/maquina)
        ou reutiliza o maquinaId atual, retornando o payload JSON e a imagem QR Code SVG
        para leitura no app móvel SerproID (opção Computadores -> +).
        """
        try:
            maq_id = "" if force_new else self.get_maquina_id()
            if not maq_id:
                resp = self._request_json("POST", "drivers/maquina", payload={})
                maq_id = resp.get("identificador", "")
                if not maq_id:
                    raise RuntimeError(f"Resposta inesperada de drivers/maquina: {resp}")
                self.set_maquina_id(maq_id)

            hostname = custom_hostname or socket.gethostname() or "ubuntu-phablet"
            try:
                username = getpass.getuser()
            except Exception:
                username = "phablet"

            qr_payload = json.dumps(
                {
                    "identificador": maq_id,
                    "nome": SERPRO_SO,
                    "hostname": hostname,
                    "username": username,
                },
                separators=(",", ":"),
            )
            qr_svg_uri = generate_qr_svg_data_uri(qr_payload)
            return {
                "success": True,
                "maquinaId": maq_id,
                "qrPayload": qr_payload,
                "qrSvgDataUri": qr_svg_uri,
                "hostname": hostname,
                "username": username,
            }
        except urllib.error.HTTPError as http_err:
            err_body = http_err.read().decode("utf-8", errors="ignore")
            return {
                "success": False,
                "error": f"Erro HTTP {http_err.code} no servidor SerproID: {err_body or http_err.reason}",
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def sync_certificates(self) -> Dict[str, Any]:
        """
        Consulta GET /smartcert-api/api/drivers/certificados usando X-SMARTCERT-UUID
        e instala os certificados (.cer) e cadeias (.p7b) no diretório XDG confinado.
        """
        maq_id = self.get_maquina_id()
        if not maq_id:
            return {
                "success": False,
                "error": "Dispositivo ainda não possui identificador SerproID. Gere o QR Code primeiro e autorize em 'Computadores' no app SerproID.",
            }

        try:
            cert_list = self._request_json("GET", "drivers/certificados", maquina_id=maq_id)
            if not isinstance(cert_list, list):
                return {
                    "success": False,
                    "error": f"Formato inválido recebido de drivers/certificados: {cert_list}",
                }

            if len(cert_list) == 0:
                return {
                    "success": False,
                    "error": "Este computador não possui certificados ativos associados. No aplicativo SerproID, acesse 'Computadores', selecione este dispositivo e associe seus certificados.",
                }

            # Limpa certificados antigos antes de gravar os novos sincronizados
            for old_cer in self.paths.certs_dir.glob("*.cer"):
                old_cer.unlink(missing_ok=True)

            installed_count = 0
            for item in cert_list:
                cert_id = item.get("id")
                cert_b64 = item.get("certificadoB64", "")
                cert_p7b = item.get("certificadoP7b", "")
                if cert_id is None or not cert_b64:
                    continue

                # Limpa cabeçalhos PEM caso venham junto do base64
                clean_b64 = (
                    cert_b64.replace("-----BEGIN CERTIFICATE-----", "")
                    .replace("-----END CERTIFICATE-----", "")
                    .strip()
                )
                der_bytes = base64.b64decode("".join(clean_b64.split()))
                cer_path = self.paths.certs_dir / f"{cert_id}.cer"
                cer_path.write_bytes(der_bytes)

                if cert_p7b:
                    clean_p7b = (
                        cert_p7b.replace("-----BEGIN PKCS7-----", "")
                        .replace("-----END PKCS7-----", "")
                        .replace("-----BEGIN CERTIFICATE-----", "")
                        .replace("-----END CERTIFICATE-----", "")
                        .strip()
                    )
                    try:
                        p7b_bytes = base64.b64decode("".join(clean_p7b.split()))
                        chain_certs = extract_certs_from_pkcs7_der(p7b_bytes)
                        if chain_certs:
                            chain_file = self.paths.chains_dir / f"{cert_id}.json"
                            chain_file.write_text(json.dumps(chain_certs), encoding="utf-8")
                    except Exception as exc:
                        print(f"[Assinei-UT] Aviso ao extrair cadeia P7B do cert {cert_id}: {exc}")

                installed_count += 1

            certs_result = self.get_certificates()
            return {
                "success": True,
                "installedCount": installed_count,
                "certs": certs_result.get("certs", []),
            }
        except urllib.error.HTTPError as http_err:
            err_body = http_err.read().decode("utf-8", errors="ignore")
            if http_err.code == 412 or "MAQ-NAO-AUT" in err_body:
                return {
                    "success": False,
                    "error": "Computador ainda não autorizado (MAQ-NAO-AUT). No app SerproID, acesse 'Computadores', toque em '+' (Adicionar), leia o QR Code exibido acima e associe seus certificados.",
                }
            return {
                "success": False,
                "error": f"Erro HTTP {http_err.code} ao ler certificados: {err_body or http_err.reason}",
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def import_manual_credentials(
        self,
        maquina_id: Optional[str] = None,
        cert_id: Optional[str] = None,
        cert_data_b64_or_pem: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Permite configurar manualmente o maquinaId (UUID) e/ou importar um arquivo .cer/.pem
        caso o usuário já tenha pareado em outro ambiente ou queira importar diretamente.
        """
        try:
            if maquina_id and maquina_id.strip():
                self.set_maquina_id(maquina_id.strip())

            if cert_data_b64_or_pem and cert_data_b64_or_pem.strip():
                raw_input = cert_data_b64_or_pem.strip().encode("ascii", errors="ignore")
                parsed = parse_x509_der(raw_input)
                der_bytes = base64.b64decode(parsed["rawDerBase64"])
                effective_id = (cert_id or "").strip()
                if not effective_id or not effective_id.isdigit():
                    # Usa os últimos dígitos decimais do serial ou 1 se não informado
                    effective_id = str(int(parsed["serialNumber"][-6:], 16) % 1000000 or 1)
                cer_path = self.paths.certs_dir / f"{effective_id}.cer"
                cer_path.write_bytes(der_bytes)

            return self.get_certificates()
        except Exception as exc:
            return {"success": False, "error": f"Erro ao importar credenciais: {exc}"}

    def _resolve_chain(self, cert_id: str, cert_info: Dict[str, Any]) -> List[str]:
        """
        Monta a cadeia completa [cert_usuario_b64, ...intermediarias_e_raiz_b64].
        Prioriza:
        1. Cadeia já salva em cache (<chains_dir>/<cert_id>.json)
        2. Download via URL AIA (http://repositorio.serpro.gov.br/cadeias/...)
        3. Cadeia ICP-Brasil embarcada (cadeia_icp_brasil.pem)
        """
        full_chain = [cert_info["rawDerBase64"]]

        cached_chain_file = self.paths.chains_dir / f"{cert_id}.json"
        if cached_chain_file.exists():
            try:
                cached_list = json.loads(cached_chain_file.read_text(encoding="utf-8"))
                for c_b64 in cached_list:
                    if c_b64 not in full_chain:
                        full_chain.append(c_b64)
                if len(full_chain) > 1:
                    return full_chain
            except Exception:
                pass

        aia_url = cert_info.get("aiaUrl")
        if aia_url:
            try:
                req = urllib.request.Request(aia_url, headers={"User-Agent": "Assinei-UT/1.0"})
                with urllib.request.urlopen(req, timeout=6) as resp:
                    p7b_data = resp.read()
                    downloaded_certs = extract_certs_from_pkcs7_der(p7b_data)
                    if downloaded_certs:
                        cached_chain_file.write_text(json.dumps(downloaded_certs), encoding="utf-8")
                        for c_b64 in downloaded_certs:
                            if c_b64 not in full_chain:
                                full_chain.append(c_b64)
                        return full_chain
            except Exception as exc:
                print(f"[Assinei-UT] Aviso ao baixar AIA ({aia_url}), usando cadeia ICP-Brasil local: {exc}")

        # Fallback offline usando a cadeia ICP-Brasil embarcada
        fallback_pem = CURRENT_DIR / "cadeia_icp_brasil.pem"
        if fallback_pem.exists():
            try:
                pem_certs = extract_all_pem_certs(fallback_pem.read_bytes())
                for c_b64 in pem_certs:
                    info = parse_x509_der(base64.b64decode(c_b64))
                    if info.get("isCa") and c_b64 not in full_chain:
                        full_chain.append(c_b64)
            except Exception as exc:
                print(f"[Assinei-UT] Erro ao ler cadeia fallback: {exc}")

        return full_chain

    def get_certificates(self) -> Dict[str, Any]:
        """
        Lista os certificados SerproID disponíveis no dispositivo.
        """
        try:
            self._ImportDesktopConfigIfAvailable()
            certs: List[Dict[str, Any]] = []

            for cer_file in sorted(self.paths.certs_dir.glob("*.cer")):
                cert_id = cer_file.stem
                try:
                    der_bytes = cer_file.read_bytes()
                    info = parse_x509_der(der_bytes)
                    if info.get("isCa"):
                        continue

                    chain_b64 = self._resolve_chain(cert_id, info)
                    certs.append(
                        {
                            "slotId": str(cert_id),
                            "keyId": str(cert_id),
                            "label": f"SerproID #{cert_id}",
                            "subject": info["subject"],
                            "issuer": info["issuer"],
                            "validity": info["validity"],
                            "serialNumber": info["serialNumber"],
                            "rawDerBase64": info["rawDerBase64"],
                            "chainB64": chain_b64,
                        }
                    )
                except Exception as exc:
                    print(f"[Assinei-UT] Erro ao processar certificado {cer_file}: {exc}")

            return {
                "success": True,
                "certs": certs,
                "paired": bool(self.get_maquina_id()),
                "maquinaId": self.get_maquina_id(),
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def sign_digest(self, slot_id: str, digest_info_b64: str) -> Dict[str, Any]:
        """
        Executa a assinatura remota na nuvem do SerproID (equivalente ao C_Sign do libserproidp11.so):
        1. POST /smartcert-api/api/drivers/assinatura
           {"certificadoId": <int>, "desafio": "<base64_digest_info>", "pid": "<pid>", "executavel": "assinei-ut"}
        2. Faz polling em GET /smartcert-api/api/drivers/assinatura/<pedido_id> aguardando o PIN no celular.
        3. Retorna signatureBase64 quando status == "ACEITO".
        """
        maq_id = self.get_maquina_id()
        if not maq_id:
            return {
                "success": False,
                "error": "Dispositivo não pareado com o SerproID (maquinaId ausente). Pareie o dispositivo no modal de Certificados.",
            }

        try:
            cert_id_int = int(slot_id)
        except ValueError:
            return {
                "success": False,
                "error": f"Identificador de certificado SerproID inválido: {slot_id}",
            }

        payload = {
            "certificadoId": cert_id_int,
            "desafio": digest_info_b64,
            "pid": str(os.getpid()),
            "executavel": "assinei-ut",
        }

        try:
            _notify_qml("serpro-pin-requested", {"certificadoId": cert_id_int})
            init_resp = self._request_json(
                "POST",
                "drivers/assinatura",
                payload=payload,
                maquina_id=maq_id,
                timeout=20,
            )
            if not isinstance(init_resp, dict) or "id" not in init_resp:
                return {
                    "success": False,
                    "error": f"Falha ao criar pedido de assinatura no SerproID: {init_resp}",
                }

            pedido_id = init_resp["id"]

            # Polling idêntico ao libserproidp11.so (até 25 tentativas aguardando o PIN no app SerproID)
            for attempt in range(25):
                time.sleep(2.0)
                status_resp = self._request_json(
                    "GET",
                    f"drivers/assinatura/{pedido_id}",
                    maquina_id=maq_id,
                    timeout=15,
                )
                status = status_resp.get("status", "")
                if status == "ACEITO":
                    desafio_assinado = status_resp.get("desafioAssinado", "")
                    if not desafio_assinado:
                        return {
                            "success": False,
                            "error": "Assinatura aceita, mas o SerproID não retornou desafioAssinado.",
                        }
                    return {
                        "success": True,
                        "signatureBase64": desafio_assinado,
                        "pedidoId": pedido_id,
                    }
                elif status == "RECUSADO":
                    return {
                        "success": False,
                        "error": "Pedido de assinatura foi RECUSADO pelo usuário no aplicativo SerproID.",
                    }
                elif status != "AGUARDANDO":
                    return {
                        "success": False,
                        "error": f"Status inesperado retornado pelo SerproID: {status}",
                    }

            return {
                "success": False,
                "error": "Tempo limite esgotado aguardando confirmação do PIN no aplicativo SerproID.",
            }
        except urllib.error.HTTPError as http_err:
            err_body = http_err.read().decode("utf-8", errors="ignore")
            return {
                "success": False,
                "error": f"Erro HTTP {http_err.code} no SerproID durante assinatura: {err_body or http_err.reason}",
            }
        except Exception as exc:
            return {"success": False, "error": f"Erro de comunicação com o SerproID: {exc}"}


class UbuntuTouchBackend:
    """Fachada principal do backend para o QML (PyOtherSide) e servidor HTTP local."""

    def __init__(self) -> None:
        self.paths = XdgPaths(APP_ID)
        self.serpro = SerproIdClient(self.paths)
        self.pending_files: List[Dict[str, str]] = []
        self._lock = threading.Lock()
        self._server: Optional[http.server.ThreadingHTTPServer] = None
        self._server_port: int = 0

    def enqueue_imported_file(self, file_url_or_path: str) -> Dict[str, Any]:
        """
        Chamado pelo Main.qml quando o Lomiri Content Hub entrega um arquivo PDF
        (via ContentPeerPicker ou via 'Abrir com...').
        Copia o arquivo para o cache confinado do app e o disponibiliza para a UI React.
        """
        try:
            clean_path = file_url_or_path
            if clean_path.startswith("file://"):
                clean_path = urllib.parse.unquote(clean_path[len("file://") :])

            src = Path(clean_path)
            if not src.exists():
                return {"success": False, "error": f"Arquivo não encontrado: {clean_path}"}

            dest = self.paths.incoming_dir / f"{int(time.time() * 1000)}_{src.name}"
            shutil.copy2(src, dest)

            data_b64 = base64.b64encode(dest.read_bytes()).decode("ascii")
            item = {
                "name": src.name,
                "path": str(dest),
                "base64": data_b64,
            }
            with self._lock:
                self.pending_files.append(item)

            _notify_qml("pdf-imported", {"name": src.name, "path": str(dest)})
            return {"success": True, "name": src.name, "path": str(dest)}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def pop_pending_files(self) -> List[Dict[str, str]]:
        with self._lock:
            items = list(self.pending_files)
            self.pending_files.clear()
            return items

    def read_file(self, file_path: str) -> Dict[str, Any]:
        try:
            clean_path = file_path
            if clean_path.startswith("file://"):
                clean_path = urllib.parse.unquote(clean_path[len("file://") :])
            p = Path(clean_path)
            data = p.read_bytes()
            return {
                "success": True,
                "base64": base64.b64encode(data).decode("ascii"),
                "name": p.name,
                "path": str(p),
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def save_signed_pdf(self, signed_base64: str, original_name: str = "documento.pdf") -> Dict[str, Any]:
        """
        Salva o PDF assinado no diretório de transferência confinado (~/.cache/assinei.tiagobraga/signed/)
        e aciona o Lomiri Content Hub no QML para exportar/compartilhar o arquivo assinado.
        """
        try:
            safe_name = Path(original_name).name
            if safe_name.lower().endswith(".pdf"):
                out_name = safe_name[:-4] + "_tb.pdf"
            else:
                out_name = safe_name + "_tb.pdf"

            dest_path = self.paths.signed_dir / out_name
            raw_bytes = base64.b64decode(signed_base64)
            dest_path.write_bytes(raw_bytes)

            # Notifica o Main.qml para abrir o ContentPeerPicker de exportação do Ubuntu Touch
            _notify_qml("request-export-pdf", str(dest_path))

            return {
                "success": True,
                "destPath": str(dest_path),
                "fileName": out_name,
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def request_open_file_dialog(self) -> Dict[str, Any]:
        """Solicita ao Main.qml que abra o seletor de arquivos do Lomiri Content Hub."""
        _notify_qml("request-import-pdf", {})
        return {"success": True, "contentHubRequested": True}

    def render_pdf_pages(self, pdf_base64: str) -> Dict[str, Any]:
        """
        Renderiza as páginas do PDF como imagens PNG (via pdftoppm se disponível)
        ou retorna os metadados de dimensão de cada página para renderização em canvas.
        """
        import subprocess
        import tempfile

        try:
            pdf_bytes = base64.b64decode(pdf_base64)
            _, page_tuples = _find_pdf_pages_and_root(pdf_bytes)
            pages_out: List[Dict[str, Any]] = []

            pdftoppm_bin = shutil.which("pdftoppm")
            if pdftoppm_bin:
                with tempfile.TemporaryDirectory(dir=str(self.paths.cache_dir)) as tmp_d:
                    tmp_path = Path(tmp_d)
                    in_pdf = tmp_path / "doc.pdf"
                    in_pdf.write_bytes(pdf_bytes)
                    out_prefix = tmp_path / "page"
                    subprocess.run(
                        [pdftoppm_bin, "-png", "-r", "130", str(in_pdf), str(out_prefix)],
                        check=False,
                        timeout=30,
                    )
                    png_files = sorted(tmp_path.glob("page-*.png"))
                    for idx, png_f in enumerate(png_files):
                        pw = page_tuples[idx][1] if idx < len(page_tuples) else 595.28
                        ph = page_tuples[idx][2] if idx < len(page_tuples) else 841.89
                        pages_out.append(
                            {
                                "page": idx + 1,
                                "width": pw,
                                "height": ph,
                                "imageBase64": base64.b64encode(png_f.read_bytes()).decode("ascii"),
                            }
                        )

            if not pages_out:
                for idx, (_, pw, ph, _) in enumerate(page_tuples):
                    pages_out.append(
                        {
                            "page": idx + 1,
                            "width": pw,
                            "height": ph,
                            "imageBase64": None,
                        }
                    )

            return {"success": True, "numPages": len(pages_out), "pages": pages_out}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def sign_pdf_complete(
        self,
        pdf_base64: str,
        slot_id: str,
        cert_der_b64: str,
        chain_b64_list: List[str],
        original_name: str = "documento.pdf",
        signature_box: Optional[Dict[str, float]] = None,
        icon_name: str = "ipe.png",
    ) -> Dict[str, Any]:
        """
        Executa todo o pipeline de assinatura PAdES ICP-Brasil no backend Python:
        1. Desenha a estampa visual na página selecionada;
        2. Injeta o dicionário /Sig e calcula o ByteRange;
        3. Envia o DigestInfo SHA-256 para o SerproID (disparando o Push PIN no celular);
        4. Empacota o PKCS#7 / CMS SignedData com a cadeia ICP-Brasil;
        5. Salva o PDF assinado (_tb.pdf) e aciona o Lomiri Content Hub para exportação.
        """
        try:
            pdf_bytes = base64.b64decode(pdf_base64)
            safe_icon = Path(icon_name or "ipe.png").name
            icon_path = PROJECT_ROOT / "assets" / safe_icon
            if not icon_path.exists():
                icon_path = PROJECT_ROOT / "dist" / safe_icon
            if not icon_path.exists():
                icon_path = PROJECT_ROOT / "public" / safe_icon

            signed_pdf_bytes = sign_pdf_pades(
                pdf_bytes=pdf_bytes,
                cert_der_b64=cert_der_b64,
                chain_b64_list=chain_b64_list,
                sign_digest_fn=lambda digest_b64: self.serpro.sign_digest(slot_id, digest_b64),
                signature_box=signature_box,
                icon_path=icon_path,
            )

            signed_b64 = base64.b64encode(signed_pdf_bytes).decode("ascii")
            save_res = self.save_signed_pdf(signed_b64, original_name)
            if not save_res.get("success"):
                return save_res

            return {
                "success": True,
                "destPath": save_res["destPath"],
                "fileName": save_res["fileName"],
                "signedBase64": signed_b64,
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    def start_local_server(self, preferred_port: int = 18452) -> int:
        """
        Inicia o servidor HTTP em 127.0.0.1 para servir a pasta dist/ e os endpoints /api/*.
        """
        if self._server is not None:
            return self._server_port

        backend_ref = self
        dist_dir = PROJECT_ROOT / "dist"
        if not dist_dir.exists():
            dist_dir = PROJECT_ROOT

        class Handler(http.server.SimpleHTTPRequestHandler):
            _MIME_MAP = {
                ".html": "text/html; charset=utf-8",
                ".htm": "text/html; charset=utf-8",
                ".js": "application/javascript; charset=utf-8",
                ".mjs": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".json": "application/json; charset=utf-8",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".svg": "image/svg+xml",
                ".ico": "image/x-icon",
                ".pdf": "application/pdf",
                ".woff": "font/woff",
                ".woff2": "font/woff2",
                ".ttf": "font/ttf",
            }

            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, directory=str(dist_dir), **kwargs)

            def guess_type(self, path: Any) -> str:
                # Evita que mimetypes.init() tente ler /etc/mime.types bloqueado pelo AppArmor no Ubuntu Touch
                ext = Path(str(path)).suffix.lower()
                return self._MIME_MAP.get(ext, "application/octet-stream")

            def end_headers(self) -> None:
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
                self.send_header("Pragma", "no-cache")
                self.send_header("Expires", "0")
                super().end_headers()

            def log_message(self, format: str, *args: Any) -> None:
                pass  # Silencia logs verbosos a cada request de polling

            def _send_json(self, data: Any, status: int = 200) -> None:
                body = json.dumps(data).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_OPTIONS(self) -> None:
                self._send_json({"ok": True})

            def do_GET(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                route = parsed.path

                if route == "/api/health":
                    self._send_json({"ok": True, "platform": "ubuntu-touch", "appId": APP_ID})
                elif route == "/api/pending-files":
                    self._send_json({"success": True, "files": backend_ref.pop_pending_files()})
                elif route == "/api/certificates":
                    self._send_json(backend_ref.serpro.get_certificates())
                elif route == "/api/serproid/status":
                    self._send_json(backend_ref.serpro.get_status())
                else:
                    super().do_GET()

            def do_POST(self) -> None:
                parsed = urllib.parse.urlparse(self.path)
                route = parsed.path
                length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
                try:
                    body = json.loads(raw_body) if raw_body else {}
                except Exception:
                    body = {}

                if route == "/api/request-open-dialog":
                    self._send_json(backend_ref.request_open_file_dialog())
                elif route == "/api/render-pdf":
                    self._send_json(backend_ref.render_pdf_pages(body.get("pdfBase64", "")))
                elif route == "/api/read-file":
                    self._send_json(backend_ref.read_file(body.get("path", "")))
                elif route == "/api/save-signed-pdf":
                    self._send_json(
                        backend_ref.save_signed_pdf(
                            body.get("signedBase64", ""),
                            body.get("originalName", "documento.pdf"),
                        )
                    )
                elif route == "/api/serproid/pair":
                    self._send_json(
                        backend_ref.serpro.register_device(
                            custom_hostname=body.get("hostname"),
                            force_new=bool(body.get("forceNew", False)),
                        )
                    )
                elif route == "/api/serproid/sync":
                    self._send_json(backend_ref.serpro.sync_certificates())
                elif route == "/api/serproid/import":
                    self._send_json(
                        backend_ref.serpro.import_manual_credentials(
                            maquina_id=body.get("maquinaId"),
                            cert_id=body.get("certId"),
                            cert_data_b64_or_pem=body.get("certData"),
                        )
                    )
                elif route == "/api/serproid/sign":
                    self._send_json(
                        backend_ref.serpro.sign_digest(
                            slot_id=str(body.get("slotId", "")),
                            digest_info_b64=str(body.get("digestInfoBase64", "")),
                        )
                    )
                elif route == "/api/sign-pdf":
                    self._send_json(
                        backend_ref.sign_pdf_complete(
                            pdf_base64=str(body.get("pdfBase64", "")),
                            slot_id=str(body.get("slotId", "")),
                            cert_der_b64=str(body.get("certDerBase64", "")),
                            chain_b64_list=body.get("chainB64") or [],
                            original_name=str(body.get("originalName", "documento.pdf")),
                            signature_box=body.get("signatureBox"),
                            icon_name=str(body.get("iconName", "ipe.png")),
                        )
                    )
                else:
                    self._send_json({"success": False, "error": f"Rota desconhecida: {route}"}, status=404)

        for port in (preferred_port, 0):
            try:
                server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
                self._server = server
                self._server_port = server.server_address[1]
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                break
            except OSError:
                continue

        return self._server_port


# Instância singleton preguiçosa acessível pelo QML via PyOtherSide:
_backend_instance: Optional[UbuntuTouchBackend] = None


def get_backend() -> UbuntuTouchBackend:
    global _backend_instance
    if _backend_instance is None:
        _backend_instance = UbuntuTouchBackend()
    return _backend_instance


def start_server() -> str:
    port = get_backend().start_local_server()
    return f"http://127.0.0.1:{port}/index.html"


def import_file(file_url: str) -> Dict[str, Any]:
    return get_backend().enqueue_imported_file(file_url)


def get_certificates() -> Dict[str, Any]:
    return get_backend().serpro.get_certificates()


def sign_digest(slot_id: str, digest_info_b64: str) -> Dict[str, Any]:
    return get_backend().serpro.sign_digest(slot_id, digest_info_b64)
