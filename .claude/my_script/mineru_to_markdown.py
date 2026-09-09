#!/usr/bin/env python3
"""Convert one local document to Markdown through MinerU's precision API.

Contract:
    python3 mineru_to_markdown.py /absolute/path/to/document.pdf

On success stdout contains only the Markdown document. Diagnostics and errors go
to stderr. The MinerU token is read only from the ``MinerU`` environment
variable and is never printed.
"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Protocol
from urllib.parse import urlsplit, urlunsplit


API_ROOT = "https://mineru.net/api/v4"
MAX_INPUT_BYTES = 200 * 1024 * 1024
MAX_MARKDOWN_BYTES = 100 * 1024 * 1024

IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".jp2",
    ".webp",
    ".gif",
    ".bmp",
}
OFFICE_EXTENSIONS = {
    ".doc",
    ".docx",
    ".ppt",
    ".pptx",
    ".xls",
    ".xlsx",
}
HTML_EXTENSIONS = {".html"}
SUPPORTED_EXTENSIONS = {".pdf"} | IMAGE_EXTENSIONS | OFFICE_EXTENSIONS | HTML_EXTENSIONS
PENDING_STATES = {"pending", "running", "converting", "waiting-file", "uploading"}


class MinerUError(RuntimeError):
    """A safe, user-facing MinerU conversion failure."""


class Transport(Protocol):
    def request_json(
        self,
        url: str,
        *,
        method: str,
        headers: dict[str, str],
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...

    def upload_file(self, url: str, path: Path) -> None: ...

    def download(self, url: str, destination: BinaryIO) -> None: ...


class StandardLibraryTransport:
    """HTTP transport implemented without third-party dependencies."""

    def __init__(self, timeout: float = 60.0) -> None:
        self.timeout = timeout

    def request_json(
        self,
        url: str,
        *,
        method: str,
        headers: dict[str, str],
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        request = urllib.request.Request(
            url,
            data=body,
            headers=headers,
            method=method,
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response_body = response.read()
        except urllib.error.HTTPError as error:
            detail = error.read(2048).decode("utf-8", errors="replace").strip()
            raise MinerUError(f"MinerU HTTP {error.code}: {detail or error.reason}") from None
        except urllib.error.URLError as error:
            raise MinerUError(f"无法连接 MinerU：{error.reason}") from None

        try:
            result = json.loads(response_body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise MinerUError("MinerU 返回了无法解析的响应") from None

        if not isinstance(result, dict):
            raise MinerUError("MinerU 返回了非对象 JSON")

        if result.get("code") != 0:
            raise MinerUError(
                f"MinerU API 错误 {result.get('code')}: "
                f"{result.get('msg', 'unknown error')}"
            )

        data = result.get("data")
        if not isinstance(data, dict):
            raise MinerUError("MinerU 响应缺少 data 对象")
        return data

    def upload_file(self, url: str, path: Path) -> None:
        """Stream a file to the signed URL without adding Content-Type."""

        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise MinerUError("MinerU 返回了无效的文件上传地址")

        connection_type = (
            http.client.HTTPSConnection
            if parsed.scheme == "https"
            else http.client.HTTPConnection
        )
        port = parsed.port
        connection = connection_type(parsed.hostname, port=port, timeout=self.timeout)
        target = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))

        try:
            connection.putrequest("PUT", target)
            connection.putheader("Content-Length", str(path.stat().st_size))
            connection.endheaders()

            with path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    connection.send(chunk)

            response = connection.getresponse()
            detail = response.read(2048).decode("utf-8", errors="replace").strip()
            if not 200 <= response.status < 300:
                raise MinerUError(
                    f"文件上传失败，HTTP {response.status}: "
                    f"{detail or response.reason}"
                )
        except OSError as error:
            raise MinerUError(f"上传文件时发生网络错误：{error}") from None
        finally:
            connection.close()

    def download(self, url: str, destination: BinaryIO) -> None:
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as response:
                shutil.copyfileobj(response, destination, length=1024 * 1024)
        except urllib.error.HTTPError as error:
            raise MinerUError(f"下载 MinerU 结果失败，HTTP {error.code}") from None
        except urllib.error.URLError as error:
            raise MinerUError(f"下载 MinerU 结果失败：{error.reason}") from None


def _env_flag(name: str, default: bool = False) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    normalized = raw_value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise MinerUError(f"环境变量 {name} 必须是 true/false 或 1/0")


def _validate_file(file_path: str | os.PathLike[str]) -> Path:
    try:
        path = Path(file_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise MinerUError(f"无法访问输入路径：{error}") from None

    if not path.is_file():
        raise MinerUError(f"输入路径不是普通文件：{path}")

    extension = path.suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise MinerUError(f"不支持 {extension or '无扩展名'} 文件；支持：{supported}")

    size = path.stat().st_size
    if size == 0:
        raise MinerUError("输入文件为空")
    if size > MAX_INPUT_BYTES:
        raise MinerUError("输入文件超过 MinerU 精准解析 API 的 200MB 限制")

    return path


def _build_request(path: Path, data_id: str) -> dict[str, Any]:
    extension = path.suffix.lower()
    if extension in HTML_EXTENSIONS:
        return {
            "files": [{"name": path.name, "data_id": data_id}],
            "model_version": "MinerU-HTML",
        }

    force_pdf_ocr = _env_flag("MINERU_FORCE_OCR", default=False)
    use_ocr = extension in IMAGE_EXTENSIONS or (extension == ".pdf" and force_pdf_ocr)
    return {
        "files": [
            {
                "name": path.name,
                "data_id": data_id,
                "is_ocr": use_ocr,
            }
        ],
        "model_version": "vlm",
        "language": os.environ.get("MINERU_LANGUAGE", "ch"),
        "enable_table": True,
        "enable_formula": True,
    }


def _find_result(results: Any, data_id: str) -> dict[str, Any] | None:
    if not isinstance(results, list):
        raise MinerUError("MinerU 查询结果中的 extract_result 不是列表")

    for result in results:
        if isinstance(result, dict) and result.get("data_id") == data_id:
            return result

    if len(results) == 1 and isinstance(results[0], dict):
        return results[0]
    return None


def _read_markdown(archive_file: BinaryIO) -> str:
    archive_file.seek(0)
    try:
        with zipfile.ZipFile(archive_file) as archive:
            matches = [
                info
                for info in archive.infolist()
                if not info.is_dir() and PurePosixPath(info.filename).name == "full.md"
            ]
            if not matches:
                raise MinerUError("MinerU 结果压缩包中没有 full.md")
            if len(matches) > 1:
                raise MinerUError("MinerU 结果压缩包中存在多个 full.md，无法确定结果")

            markdown_info = matches[0]
            if markdown_info.file_size > MAX_MARKDOWN_BYTES:
                raise MinerUError("MinerU 返回的 Markdown 超过 100MB 安全限制")

            raw_markdown = archive.read(markdown_info)
    except zipfile.BadZipFile:
        raise MinerUError("MinerU 返回的结果不是有效的 ZIP 文件") from None

    try:
        return raw_markdown.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise MinerUError("MinerU 返回的 full.md 不是 UTF-8 编码") from None


def convert_file_to_markdown(
    file_path: str | os.PathLike[str],
    *,
    timeout_seconds: float = 900.0,
    poll_interval_seconds: float = 3.0,
    transport: Transport | None = None,
) -> str:
    """Upload one local file to MinerU and return its Markdown content."""

    path = _validate_file(file_path)
    token = os.environ.get("MinerU")
    if not token:
        raise MinerUError("未设置环境变量 MinerU")
    if timeout_seconds <= 0 or poll_interval_seconds <= 0:
        raise MinerUError("超时和轮询间隔必须大于 0")

    http_transport: Transport = transport or StandardLibraryTransport()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    data_id = uuid.uuid4().hex

    create_data = http_transport.request_json(
        f"{API_ROOT}/file-urls/batch",
        method="POST",
        headers=headers,
        payload=_build_request(path, data_id),
    )

    batch_id = create_data.get("batch_id")
    upload_urls = create_data.get("file_urls")
    if not isinstance(batch_id, str) or not batch_id:
        raise MinerUError("MinerU 响应缺少 batch_id")
    if not isinstance(upload_urls, list) or len(upload_urls) != 1:
        raise MinerUError("MinerU 响应中的 file_urls 数量不正确")
    if not isinstance(upload_urls[0], str):
        raise MinerUError("MinerU 响应包含无效的上传地址")

    http_transport.upload_file(upload_urls[0], path)

    deadline = time.monotonic() + timeout_seconds
    result_url = f"{API_ROOT}/extract-results/batch/{batch_id}"
    while time.monotonic() < deadline:
        query_data = http_transport.request_json(
            result_url,
            method="GET",
            headers=headers,
        )
        result = _find_result(query_data.get("extract_result", []), data_id)
        if result is None:
            time.sleep(poll_interval_seconds)
            continue

        state = result.get("state")
        if state == "failed":
            raise MinerUError(
                f"MinerU 解析失败：{result.get('err_msg') or '未提供失败原因'}"
            )
        if state == "done":
            zip_url = result.get("full_zip_url")
            if not isinstance(zip_url, str) or not zip_url:
                raise MinerUError("完成的 MinerU 任务缺少 full_zip_url")

            with tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024) as archive_file:
                http_transport.download(zip_url, archive_file)
                return _read_markdown(archive_file)

        if state not in PENDING_STATES:
            raise MinerUError(f"MinerU 返回了未知任务状态：{state!r}")

        time.sleep(poll_interval_seconds)

    raise MinerUError(f"MinerU 解析超时，batch_id={batch_id}")


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 1:
        print("用法：python3 mineru_to_markdown.py /absolute/path/to/file", file=sys.stderr)
        return 2

    try:
        timeout = float(os.environ.get("MINERU_TIMEOUT_SECONDS", "900"))
        markdown = convert_file_to_markdown(arguments[0], timeout_seconds=timeout)
    except (MinerUError, ValueError) as error:
        print(f"转换失败：{error}", file=sys.stderr)
        return 1

    sys.stdout.write(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
