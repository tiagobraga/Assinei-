#!/usr/bin/env python3
"""
Gerador oficial de pacote .click para Ubuntu Touch / OpenStore (Click-Version 0.4).
Segue 100% a especificação binária do `click_package.build.ClickBuilder` e `ArFile` da Canonical/UBports:
  1. debian-binary ("2.0\n")
  2. _click-binary ("0.4\n")
  3. control.tar.gz (GNU_FORMAT: ./control, ./manifest, ./md5sums, ./preinst)
  4. data.tar.gz (GNU_FORMAT, root:root, permissões higienizadas 0755/0644)
"""

import contextlib
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RELEASE_DIR = PROJECT_ROOT / "release"

SPEC_VERSION = "0.4"
STATIC_PREINST = """\
#! /bin/sh
echo "Click packages may not be installed directly using dpkg."
echo "Use 'click install' instead."
exit 1
"""

INCLUDE_ITEMS = [
    "manifest.json",
    "assinei.apparmor",
    "assinei.content-hub",
    "assinei.desktop",
    "assets",
    "qml",
    "src/ubuntu_touch",
    "dist",
]


class ArFile:
    """Implementação idêntica a click_package.arfile.ArFile (formato dpkg/ar Debian)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.fileobj = path.open("wb")

    def __enter__(self) -> "ArFile":
        return self

    def __exit__(self, *args: object) -> None:
        self.fileobj.close()

    def add_magic(self) -> None:
        self.fileobj.write(b"!<arch>\n")

    def add_header(self, name: str, size: int) -> None:
        if len(name) > 15:
            raise ValueError(f"ar member name '{name}' length too long")
        header = ("%-16s%-12u0     0     100644  %-10d`\n" % (name, int(time.time()), size)).encode("ascii")
        assert len(header) == 60
        self.fileobj.write(header)

    def add_data(self, name: str, data: bytes) -> None:
        size = len(data)
        self.add_header(name, size)
        self.fileobj.write(data)
        if size & 1:
            self.fileobj.write(b"\n")

    def add_file(self, name: str, file_path: Path) -> None:
        with file_path.open("rb") as fobj:
            size = os.fstat(fobj.fileno()).st_size
            self.add_header(name, size)
            shutil.copyfileobj(fobj, self.fileobj)
        if size & 1:
            self.fileobj.write(b"\n")


class FakerootTarFile(tarfile.TarFile):
    """Garante uid=0, gid=0, uname='root', gname='root' e permissões seguras (sem world-writable)."""

    def gettarinfo(self, *args: object, **kwargs: object) -> tarfile.TarInfo:
        tarinfo = super().gettarinfo(*args, **kwargs)  # type: ignore[arg-type]
        tarinfo.uid = 0
        tarinfo.gid = 0
        tarinfo.uname = "root"
        tarinfo.gname = "root"
        if tarinfo.isdir():
            tarinfo.mode = 0o755
        else:
            tarinfo.mode = 0o755 if (tarinfo.mode & 0o111) else 0o644
        return tarinfo


def compute_md5(file_path: Path) -> str:
    h = hashlib.md5()
    with file_path.open("rb") as f:
        for chunk in iter(lambda: f.read(16384), b""):
            h.update(chunk)
    return h.hexdigest()


def build_click_package() -> Path:
    manifest_path = PROJECT_ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    for key in list(manifest.keys()):
        if key.startswith("_"):
            del manifest[key]

    pkg_name = manifest["name"]
    pkg_version = manifest["version"]
    epochless_version = re.sub(r"^\d+:", "", pkg_version)
    pkg_arch = manifest.get("architecture", "all")
    if isinstance(pkg_arch, list):
        pkg_arch = "multi"
    pkg_maintainer = manifest["maintainer"]
    pkg_title = manifest["title"]

    dist_dir = PROJECT_ROOT / "dist"
    if not dist_dir.exists() or not (dist_dir / "index.html").exists():
        raise RuntimeError("O diretório dist/ ainda não foi gerado.")

    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    click_filename = f"{pkg_name}_{epochless_version}_{pkg_arch}.click"
    output_click = RELEASE_DIR / click_filename

    with tempfile.TemporaryDirectory(prefix="click_") as tmp_str:
        os.chmod(tmp_str, 0o755)
        tmp_path = Path(tmp_str)
        data_dir = tmp_path / "data"
        control_dir = tmp_path / "DEBIAN"
        data_dir.mkdir(mode=0o755)
        control_dir.mkdir(mode=0o755)

        # 1. Copia todos os arquivos do app para data/
        for rel_item in INCLUDE_ITEMS:
            src = PROJECT_ROOT / rel_item
            if not src.exists():
                raise FileNotFoundError(f"Item obrigatório ausente para o pacote .click: {src}")
            dest = data_dir / rel_item
            dest.parent.mkdir(parents=True, exist_ok=True)
            if src.is_dir():
                shutil.copytree(
                    src,
                    dest,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.click", ".DS_Store"),
                )
            else:
                shutil.copy2(src, dest)

        # Normaliza permissões em data_dir (0755 diretórios, 0644 arquivos)
        for root_d, dirs, files in os.walk(data_dir):
            os.chmod(root_d, 0o755)
            for d_name in dirs:
                os.chmod(os.path.join(root_d, d_name), 0o755)
            for f_name in files:
                os.chmod(os.path.join(root_d, f_name), 0o644)

        # 2. Calcula Installed-Size idêntico ao ClickBuilder (`du -k -s --apparent-size .`)
        du_out = subprocess.check_output(
            ["du", "-k", "-s", "--apparent-size", "."],
            cwd=str(tmp_path),
            text=True,
        ).strip()
        m_du = re.match(r"^(\d+)\s+\.$", du_out)
        installed_size_kb = m_du.group(1) if m_du else "3600"

        manifest["installed-size"] = installed_size_kb

        # 3. Grava ./control em DEBIAN/
        control_content = (
            f"Package: {pkg_name}\n"
            f"Version: {pkg_version}\n"
            f"Click-Version: {SPEC_VERSION}\n"
            f"Architecture: {pkg_arch}\n"
            f"Maintainer: {pkg_maintainer}\n"
            f"Installed-Size: {installed_size_kb}\n"
            f"Description: {pkg_title}\n"
        )
        control_file = control_dir / "control"
        control_file.write_text(control_content, encoding="utf-8")
        os.chmod(control_file, 0o644)

        # 4. Grava ./manifest em DEBIAN/ e remove manifest.json de data/ (exigência do ClickBuilder)
        real_manifest_path = control_dir / "manifest"
        real_manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=4, separators=(",", ": ")) + "\n",
            encoding="utf-8",
        )
        os.chmod(real_manifest_path, 0o644)
        (data_dir / "manifest.json").unlink(missing_ok=True)

        # 5. Gera ./md5sums (após remover manifest.json de data/)
        md5_lines = []
        for file_p in sorted(data_dir.rglob("*")):
            if file_p.is_file():
                rel_p = file_p.relative_to(data_dir).as_posix()
                md5_lines.append(f"{compute_md5(file_p)}  {rel_p}")
        md5sums_file = control_dir / "md5sums"
        md5sums_file.write_text("\n".join(md5_lines) + "\n", encoding="utf-8")
        os.chmod(md5sums_file, 0o644)

        # 6. Gera ./preinst em DEBIAN/
        preinst_file = control_dir / "preinst"
        preinst_file.write_text(STATIC_PREINST, encoding="utf-8")
        os.chmod(preinst_file, 0o644)

        # 7. Empacota data.tar.gz e control.tar.gz em tarfile.GNU_FORMAT com FakerootTarFile
        data_tar_path = tmp_path / "data.tar.gz"
        with contextlib.closing(
            FakerootTarFile.open(name=str(data_tar_path), mode="w:gz", format=tarfile.GNU_FORMAT)
        ) as data_tar:
            data_tar.add(str(data_dir), arcname="./")

        control_tar_path = tmp_path / "control.tar.gz"
        with contextlib.closing(
            FakerootTarFile.open(name=str(control_tar_path), mode="w:gz", format=tarfile.GNU_FORMAT)
        ) as control_tar:
            control_tar.add(str(control_dir), arcname="./")

        # 8. Monta o arquivo .click usando ArFile na ordem exata:
        #    debian-binary, _click-binary, control.tar.gz, data.tar.gz
        if output_click.exists():
            output_click.unlink()

        with ArFile(output_click) as pkg:
            pkg.add_magic()
            pkg.add_data("debian-binary", b"2.0\n")
            pkg.add_data("_click-binary", f"{SPEC_VERSION}\n".encode("utf-8"))
            pkg.add_file("control.tar.gz", control_tar_path)
            pkg.add_file("data.tar.gz", data_tar_path)

    print(f"[OK] Pacote OpenStore .click gerado com sucesso em: {output_click}")
    return output_click


if __name__ == "__main__":
    build_click_package()
