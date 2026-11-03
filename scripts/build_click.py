#!/usr/bin/env python3
"""
Gerador oficial de pacote .click para Ubuntu Touch / OpenStore (Click-Version 0.4).
Empacota a aplicação Assinei! (assinei.tiagobraga_1.0.0_all.click) pronta para
submissão na OpenStore (https://open-store.io/submit) ou instalação via `pkcon install-local` / `adb`.
"""

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RELEASE_DIR = PROJECT_ROOT / "release"

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


def compute_md5(file_path: Path) -> str:
    h = hashlib.md5()
    with file_path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def build_click_package() -> Path:
    manifest_path = PROJECT_ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    pkg_name = manifest["name"]
    pkg_version = manifest["version"]
    pkg_arch = manifest.get("architecture", "all")
    pkg_maintainer = manifest["maintainer"]
    pkg_description = manifest["description"]

    dist_dir = PROJECT_ROOT / "dist"
    if not dist_dir.exists() or not (dist_dir / "index.html").exists():
        raise RuntimeError(
            "O diretório dist/ ainda não foi gerado. Execute o build do frontend primeiro (npm run build)."
        )

    RELEASE_DIR.mkdir(parents=True, exist_ok=True)
    click_filename = f"{pkg_name}_{pkg_version}_{pkg_arch}.click"
    output_click = RELEASE_DIR / click_filename

    with tempfile.TemporaryDirectory(prefix="assinei_click_") as tmp_str:
        tmp_path = Path(tmp_str)
        data_dir = tmp_path / "data"
        control_dir = tmp_path / "control"
        data_dir.mkdir()
        control_dir.mkdir()

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
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
                )
            else:
                shutil.copy2(src, dest)

        # 2. Calcula Installed-Size (em KB) e gera md5sums
        total_bytes = 0
        md5_lines = []
        for file_p in sorted(data_dir.rglob("*")):
            if file_p.is_file():
                total_bytes += file_p.stat().st_size
                rel_p = file_p.relative_to(data_dir).as_posix()
                md5_lines.append(f"{compute_md5(file_p)}  {rel_p}")

        installed_size_kb = max(1, (total_bytes + 1023) // 1024)
        manifest_with_size = dict(manifest)
        manifest_with_size["installed-size"] = str(installed_size_kb)

        # Atualiza manifest.json em data/ e grava ./manifest em control/
        (data_dir / "manifest.json").write_text(
            json.dumps(manifest_with_size, indent=4, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        (control_dir / "manifest").write_text(
            json.dumps(manifest_with_size, indent=4, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        (control_dir / "md5sums").write_text("\n".join(md5_lines) + "\n", encoding="utf-8")

        control_content = (
            f"Package: {pkg_name}\n"
            f"Version: {pkg_version}\n"
            f"Click-Version: 0.4\n"
            f"Architecture: {pkg_arch}\n"
            f"Maintainer: {pkg_maintainer}\n"
            f"Installed-Size: {installed_size_kb}\n"
            f"Description: {pkg_description}\n"
        )
        (control_dir / "control").write_text(control_content, encoding="utf-8")

        # 3. Empacota control.tar.gz, data.tar.gz e debian-binary
        debian_binary = tmp_path / "debian-binary"
        debian_binary.write_text("2.0\n", encoding="ascii")

        control_tar = tmp_path / "control.tar.gz"
        data_tar = tmp_path / "data.tar.gz"

        subprocess.run(
            [
                "tar",
                "-czf",
                str(control_tar),
                "--owner=0",
                "--group=0",
                "--numeric-owner",
                "-C",
                str(control_dir),
                ".",
            ],
            check=True,
        )
        subprocess.run(
            [
                "tar",
                "-czf",
                str(data_tar),
                "--owner=0",
                "--group=0",
                "--numeric-owner",
                "-C",
                str(data_dir),
                ".",
            ],
            check=True,
        )

        if output_click.exists():
            output_click.unlink()

        subprocess.run(
            [
                "ar",
                "rc",
                str(output_click),
                str(debian_binary),
                str(control_tar),
                str(data_tar),
            ],
            check=True,
        )

    print(f"[OK] Pacote OpenStore .click gerado com sucesso em: {output_click}")
    return output_click


if __name__ == "__main__":
    build_click_package()
