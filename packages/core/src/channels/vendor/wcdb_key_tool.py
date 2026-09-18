#!/usr/bin/env python3
# Vendored from https://github.com/TANGandXUE/wcdb-key-tool with two local
# fixes (kept from the prototype): pass WeChat's Chromium signals through GDB,
# and arm the breakpoint at the PIE load base as well as the r-x segment base.
# Rome uses only capture_passphrase(pid): the hosting VM's root script attaches
# GDB to the WeChat client running in the Rome container and recovers the
# passphrase. Key derivation and every read live in wechat-user-helper.py; the
# decrypt/CLI halves of this tool are unused. Do not edit to fit Rome's style —
# keep it diffable against upstream.
"""wcdb-key-tool — 微信数据库密钥提取工具

Linux 微信数据库密钥提取工具。通过 ELF 静态分析自动适配新版本，无需每次更新手动逆向。
Extract WeChat (WCDB/SQLCipher4) database encryption keys on Linux.
Auto-adapts to new versions via ELF static analysis — no manual reverse engineering needed per update.

Usage:
    sudo python3 wcdb_key_tool.py extract          # 提取密钥（首次需要重新登录微信）
    sudo python3 wcdb_key_tool.py decrypt           # 解密数据库
    sudo python3 wcdb_key_tool.py extract --decrypt  # 提取 + 解密一步完成

Requirements:
    - Python 3.10+
    - GDB (sudo apt install gdb)
    - Root privileges or CAP_SYS_PTRACE
    - WeChat Linux running

https://github.com/TANGandXUE/wcdb-key-tool
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import glob
import hashlib
import hmac as hmac_mod
import json
import logging
import os
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import textwrap

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

_print = lambda *a, **kw: print(*a, flush=True, **kw)  # noqa: E731

# ============================================================
# Constants
# ============================================================
PAGE_SZ = 4096
KEY_SZ = 32
SALT_SZ = 16
IV_SZ = 16
HMAC_SZ = 64
RESERVE_SZ = 80  # IV(16) + HMAC(64)
SQLITE_HDR = b"SQLite format 3\x00"

PASSPHRASE_FILE = os.path.join(os.path.expanduser("~"), ".wcdb-key-tool", "wechat-passphrase.json")


# ============================================================
# AES-CBC via OpenSSL (no third-party deps)
# ============================================================

def _load_openssl() -> ctypes.CDLL:
    """加载 libssl/libcrypto，优先 libcrypto。"""
    for name in ("crypto", "ssl"):
        lib_name = ctypes.util.find_library(name)
        if lib_name:
            try:
                return ctypes.CDLL(lib_name)
            except OSError:
                pass
    # fallback: 直接尝试常见路径
    for path in ("/usr/lib/x86_64-linux-gnu/libcrypto.so.3",
                 "/usr/lib/x86_64-linux-gnu/libcrypto.so.1.1",
                 "/lib/x86_64-linux-gnu/libcrypto.so.3"):
        if os.path.exists(path):
            return ctypes.CDLL(path)
    raise RuntimeError("未找到 libcrypto/libssl，请安装: sudo apt install libssl-dev")


_ssl: ctypes.CDLL | None = None


def _get_ssl() -> ctypes.CDLL:
    global _ssl
    if _ssl is None:
        _ssl = _load_openssl()
    return _ssl


def aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    """AES-256-CBC 解密，使用 OpenSSL EVP via ctypes。"""
    ssl = _get_ssl()

    # EVP_CIPHER_CTX_new
    ctx = ssl.EVP_CIPHER_CTX_new()
    if not ctx:
        raise RuntimeError("EVP_CIPHER_CTX_new 失败")
    try:
        # EVP_aes_256_cbc
        cipher = ssl.EVP_aes_256_cbc()
        if not cipher:
            raise RuntimeError("EVP_aes_256_cbc 失败")

        # EVP_DecryptInit_ex
        ret = ssl.EVP_DecryptInit_ex(ctx, cipher, None,
                                     (ctypes.c_ubyte * 32)(*key),
                                     (ctypes.c_ubyte * 16)(*iv))
        if ret != 1:
            raise RuntimeError("EVP_DecryptInit_ex 失败")

        # 关闭 padding（SQLCipher 自管 padding）
        ssl.EVP_CIPHER_CTX_set_padding(ctx, 0)

        out_buf = ctypes.create_string_buffer(len(data) + 32)
        out_len = ctypes.c_int(0)

        ret = ssl.EVP_DecryptUpdate(ctx, out_buf, ctypes.byref(out_len),
                                    ctypes.c_char_p(data), len(data))
        if ret != 1:
            raise RuntimeError("EVP_DecryptUpdate 失败")

        final_buf = ctypes.create_string_buffer(32)
        final_len = ctypes.c_int(0)
        ssl.EVP_DecryptFinal_ex(ctx, final_buf, ctypes.byref(final_len))

        return out_buf.raw[: out_len.value + final_len.value]
    finally:
        ssl.EVP_CIPHER_CTX_free(ctx)


# ============================================================
# HMAC Verification
# ============================================================

def verify_enc_key(enc_key: bytes, db_page1: bytes) -> bool:
    """通过 HMAC-SHA512 校验 page 1 验证 enc_key 是否正确。

    SQLCipher4 参数：
    - MAC salt = DB salt XOR 0x3A
    - MAC key = PBKDF2(enc_key, mac_salt, iterations=2, sha512, 32B)
    - HMAC 范围: page1[16:4032]
    - 存储的 HMAC: page1[4032:4096] (64B SHA512)
    """
    salt = db_page1[:SALT_SZ]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SZ)
    hmac_data = db_page1[SALT_SZ: PAGE_SZ - 80 + 16]
    stored_hmac = db_page1[PAGE_SZ - 64: PAGE_SZ]
    hm = hmac_mod.new(mac_key, hmac_data, hashlib.sha512)
    hm.update(struct.pack("<I", 1))
    return hm.digest() == stored_hmac


# ============================================================
# DB File Collection
# ============================================================

def collect_db_files(db_dir: str) -> tuple[list, dict]:
    """遍历 db_dir 收集所有 .db 文件及其 salt。

    Returns:
        db_files: [(rel_path, abs_path, size, salt_hex, page1_bytes), ...]
        salt_to_dbs: {salt_hex: [rel_path, ...]}
    """
    db_files: list = []
    salt_to_dbs: dict[str, list[str]] = {}
    for root, _dirs, files in os.walk(db_dir):
        for name in files:
            if not name.endswith(".db") or name.endswith("-wal") or name.endswith("-shm"):
                continue
            path = os.path.join(root, name)
            size = os.path.getsize(path)
            if size < PAGE_SZ:
                continue
            with open(path, "rb") as f:
                page1 = f.read(PAGE_SZ)
            rel = os.path.relpath(path, db_dir)
            salt = page1[:SALT_SZ].hex()
            db_files.append((rel, path, size, salt, page1))
            salt_to_dbs.setdefault(salt, []).append(rel)
    return db_files, salt_to_dbs


# ============================================================
# ELF Analysis
# ============================================================

ANCHOR_STRING = b"com.Tencent.WCDB.Config.Cipher"
LEA_RSI = b"\x48\x8D\x35"
LEA_RDI = b"\x48\x8D\x3D"
FUNC_HEAD = b"\x55\x41\x57"
ELF_MAGIC = b"\x7fELF"
EM_X86_64 = 62


class _ELFSection:
    __slots__ = ("name", "addr", "offset", "size", "data")

    def __init__(self, name: str, addr: int, offset: int, size: int, data: bytes) -> None:
        self.name = name
        self.addr = addr
        self.offset = offset
        self.size = size
        self.data = data


def _load_elf_sections(binary_path: pathlib.Path) -> dict[str, _ELFSection]:
    data = binary_path.read_bytes()
    if data[:4] != ELF_MAGIC:
        raise RuntimeError(f"不是 ELF 文件: {binary_path}")
    if data[4] != 2 or data[5] != 1:
        raise RuntimeError(f"仅支持 ELF64 小端序: {binary_path}")

    (
        _etype, machine, _version, _entry, _phoff, shoff,
        _flags, _ehsize, _phentsize, _phnum,
        shentsize, shnum, shstrndx,
    ) = struct.unpack_from("<HHIQQQIHHHHHH", data, 16)

    if machine != EM_X86_64:
        raise RuntimeError(f"仅支持 x86_64 架构: {binary_path}")

    sections_raw: list[tuple[int, int, int, int]] = []
    for index in range(shnum):
        offset = shoff + (index * shentsize)
        sh_name, _sh_type, _flags2, sh_addr, sh_offset, sh_size = (
            struct.unpack_from("<IIQQQQIIQQ", data, offset)[:6]
        )
        sections_raw.append((sh_name, sh_addr, sh_offset, sh_size))

    if shstrndx >= len(sections_raw):
        raise RuntimeError("无效的节字符串表索引")
    _, _, shstr_offset, shstr_size = sections_raw[shstrndx]
    shstr_data = data[shstr_offset: shstr_offset + shstr_size]

    sections: dict[str, _ELFSection] = {}
    for sh_name, sh_addr, sh_offset, sh_size in sections_raw:
        end = shstr_data.find(b"\0", sh_name)
        if end == -1:
            end = len(shstr_data)
        name = shstr_data[sh_name:end].decode("utf-8", errors="replace")
        if not name:
            continue
        section_bytes = data[sh_offset: sh_offset + sh_size]
        sections[name] = _ELFSection(
            name=name, addr=sh_addr, offset=sh_offset, size=sh_size, data=section_bytes,
        )
    return sections


def _find_rip_relative_refs(text: _ELFSection, opcode: bytes, target_va: int) -> list[int]:
    hits = []
    limit = max(0, len(text.data) - 7)
    for offset in range(limit + 1):
        if text.data[offset: offset + 3] != opcode:
            continue
        disp = struct.unpack_from("<i", text.data, offset + 3)[0]
        resolved = text.addr + offset + 7 + disp
        if resolved == target_va:
            hits.append(offset)
    return hits


def find_hook_offset(binary_path: str | pathlib.Path) -> int:
    """分析 ELF 二进制，定位密钥捕获断点的虚拟地址。"""
    binary_path = pathlib.Path(binary_path)
    sections = _load_elf_sections(binary_path)
    try:
        rodata = sections[".rodata"]
        text = sections[".text"]
    except KeyError as exc:
        raise RuntimeError(f"ELF 缺少必要的节: {exc.args[0]}") from exc

    candidates: list[int] = []
    search_from = 0
    while True:
        anchor_offset = rodata.data.find(ANCHOR_STRING, search_from)
        if anchor_offset == -1:
            break
        search_from = anchor_offset + 1
        anchor_va = rodata.addr + anchor_offset

        for first_ref_offset in _find_rip_relative_refs(text, LEA_RSI, anchor_va):
            if first_ref_offset < 7:
                continue
            if text.data[first_ref_offset - 7: first_ref_offset - 4] != LEA_RDI:
                continue

            unk_disp = struct.unpack_from("<i", text.data, first_ref_offset - 4)[0]
            unk_va = text.addr + first_ref_offset + unk_disp

            for second_ref_offset in _find_rip_relative_refs(text, LEA_RSI, unk_va):
                scan_start = max(0, second_ref_offset - 0x500)
                for candidate_offset in range(second_ref_offset, scan_start - 1, -1):
                    if text.data[candidate_offset: candidate_offset + len(FUNC_HEAD)] == FUNC_HEAD:
                        va = text.addr + candidate_offset
                        if va not in candidates:
                            candidates.append(va)
                        break

    if not candidates:
        raise RuntimeError(
            f"未能在 {binary_path} 中定位密钥捕获断点。\n"
            "可能是不支持的微信版本。"
        )
    va = sorted(candidates)[0]
    logger.info(f"找到断点虚拟地址: 0x{va:X}")
    return va


def find_runtime_base(pid: int, binary_path: str | pathlib.Path) -> int:
    """从 /proc/{pid}/maps 找到微信二进制的运行时基址。"""
    binary_path = pathlib.Path(binary_path)
    binary_name = binary_path.name
    maps_path = pathlib.Path(f"/proc/{pid}/maps")
    try:
        maps_text = maps_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"无法读取 /proc/{pid}/maps: {exc}") from exc

    for line in maps_text.splitlines():
        parts = line.split()
        if len(parts) < 6:
            continue
        if not parts[5].endswith("/" + binary_name):
            continue
        if "r" in parts[1] and "x" in parts[1]:
            return int(parts[0].split("-")[0], 16)

    for line in maps_text.splitlines():
        parts = line.split()
        if len(parts) >= 6 and parts[5].endswith("/" + binary_name):
            return int(parts[0].split("-")[0], 16)

    raise RuntimeError(f"未找到 {binary_name} 的内存映射基址 (PID={pid})")


# ============================================================
# GDB Capture
# ============================================================

_GDB_SCRIPT_TEMPLATE = textwrap.dedent("""\
    set pagination off
    set non-stop off
    attach {pid}
    handle SIGPWR SIG32 SIG33 SIG34 SIG35 SIG36 SIG37 SIG38 SIG39 SIG40 nostop noprint pass
    handle SIG41 SIG42 SIG43 SIG44 SIG45 SIG46 SIG47 SIG48 nostop noprint pass
    handle SIGXCPU SIGXFSZ SIGWINCH nostop noprint pass
    handle SIGSEGV SIGBUS SIGILL SIGFPE nostop noprint pass
    python
    import gdb

    class CaptureBreakpoint(gdb.Breakpoint):
        def stop(self):
            try:
                rsi = int(gdb.parse_and_eval("$rsi"))
                rdx = int(gdb.parse_and_eval("$rdx"))
                # 方法 1: wxchat-export 方式（rsi=key_ptr, rdx=key_len=32）
                if rsi and rdx == 32:
                    raw = gdb.selected_inferior().read_memory(rsi, 32).tobytes()
                    print("WECHAT_PASSPHRASE=" + raw.hex())
                    gdb.execute("detach")
                    gdb.execute("quit")
                    return True
                # 方法 2: kkocdko 方式（rsi 指向结构体，key 在 *(rsi+8)，size 在 rsi+16）
                if rsi:
                    import struct as _struct
                    try:
                        size_val = int(gdb.parse_and_eval("*(unsigned long long*)($rsi+16)"))
                        if size_val == 32:
                            key_ptr = int(gdb.parse_and_eval("*(unsigned long long*)($rsi+8)"))
                            if key_ptr:
                                raw = gdb.selected_inferior().read_memory(key_ptr, 32).tobytes()
                                print("WECHAT_PASSPHRASE=" + raw.hex())
                                gdb.execute("detach")
                                gdb.execute("quit")
                                return True
                    except:
                        pass
            except Exception as e:
                print("CAPTURE_ERROR=" + str(e))
            return False

    for _a in [{addr_list}]:
        try:
            gdb.selected_inferior().read_memory(_a, 4)   # probe: must be mapped
        except Exception as _e:
            print("BP_SKIP=0x%X unmapped" % _a)
            continue
        try:
            CaptureBreakpoint("*%d" % _a)
            print("BP_SET=0x%X" % _a)
        except Exception as _e:
            print("BP_FAIL=0x%X %s" % (_a, _e))
    gdb.execute("info breakpoints")
    end
    continue
    quit
""")


class CaptureError(RuntimeError):
    pass


def check_prerequisites() -> list[str]:
    """预检查环境，返回问题列表（空列表表示一切正常）。"""
    issues = []

    if not shutil.which("gdb"):
        issues.append("未安装 GDB，请运行: sudo apt install gdb")

    try:
        scope = int(pathlib.Path("/proc/sys/kernel/yama/ptrace_scope").read_text().strip())
        if scope > 0 and os.geteuid() != 0:
            issues.append(
                f"ptrace_scope={scope}，需要 root 权限。"
                "请使用 sudo 运行，或执行: echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope"
            )
    except (OSError, ValueError):
        pass

    return issues


def _find_wechat_pid() -> int:
    """查找微信主进程 PID。"""
    for pid_str in os.listdir("/proc"):
        if not pid_str.isdigit():
            continue
        pid = int(pid_str)
        try:
            exe = os.readlink(f"/proc/{pid}/exe")
            if exe.endswith("/wechat"):
                return pid
        except (OSError, PermissionError):
            continue
    raise CaptureError("微信未运行，请先启动微信")


def _find_wechat_binary(pid: int) -> pathlib.Path:
    """从 /proc/pid/exe 获取微信二进制路径。"""
    try:
        return pathlib.Path(os.readlink(f"/proc/{pid}/exe"))
    except OSError:
        for candidate in [pathlib.Path("/opt/wechat/wechat"), pathlib.Path("/usr/bin/wechat")]:
            if candidate.exists():
                return candidate
        raise CaptureError("未找到微信二进制文件")


def _check_tracer(pid: int) -> None:
    """检查进程是否已被其他调试器附加。"""
    try:
        status = pathlib.Path(f"/proc/{pid}/status").read_text()
        for line in status.splitlines():
            if line.startswith("TracerPid:"):
                tracer = int(line.split(":")[1].strip())
                if tracer != 0:
                    raise CaptureError(
                        f"微信进程已被 PID={tracer} 调试，请先关闭其他调试器"
                    )
    except OSError:
        pass


def _cleanup_tracer(pid: int) -> None:
    """清理残留的 GDB tracer。"""
    try:
        subprocess.run(["killall", "-9", "gdb"], capture_output=True, timeout=5)
    except Exception:
        pass


def capture_passphrase(pid: int | None = None, timeout: int = 120) -> str:
    """通过 GDB 断点捕获微信数据库 passphrase。

    需要用户在微信中退出登录并重新登录来触发断点。

    Args:
        pid: 微信主进程 PID（None 则自动检测）
        timeout: 等待登录的超时秒数

    Returns:
        64 字符的 hex 字符串（32 字节 passphrase）

    Raises:
        CaptureError: 捕获失败
    """
    if pid is None:
        pid = _find_wechat_pid()

    binary_path = _find_wechat_binary(pid)
    _check_tracer(pid)

    # ELF 分析：找断点虚拟地址
    hook_va = find_hook_offset(binary_path)
    base_addr = find_runtime_base(pid, binary_path)

    # Arm at BOTH plausible load bases: the r-x segment start (what
    # find_runtime_base returns) and the lowest mapping of the binary (true
    # PIE load bias). For a PIE these usually coincide, but list both so a
    # wrong pick doesn't silently mean "breakpoint never fires".
    binary_name = pathlib.Path(binary_path).name
    lowest = None
    for line in pathlib.Path(f"/proc/{pid}/maps").read_text().splitlines():
        parts = line.split()
        if len(parts) >= 6 and parts[5].endswith("/" + binary_name):
            lowest = int(parts[0].split("-")[0], 16)
            break
    addrs = []
    for b in (base_addr, lowest):
        if b is not None and (b + hook_va) not in addrs:
            addrs.append(b + hook_va)
    addr_list = ", ".join(str(a) for a in addrs)

    logger.info(f"微信 PID={pid}, binary={binary_path}")
    logger.info(f"断点候选地址: {[hex(a) for a in addrs]} (hook_va=0x{hook_va:X})")

    # 生成 GDB 脚本
    with tempfile.TemporaryDirectory(prefix="wechat-key-") as tmpdir:
        script_path = pathlib.Path(tmpdir) / "capture.gdb"
        script_content = _GDB_SCRIPT_TEMPLATE.format(
            pid=pid,
            addr_list=addr_list,
        )
        script_path.write_text(script_content)

        gdb_binary = shutil.which("gdb")
        try:
            proc = subprocess.run(
                [gdb_binary, "-q", "--nx", "-batch", "-x", str(script_path)],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            _cleanup_tracer(pid)
            raise CaptureError(
                f"等待 {timeout} 秒后超时。请确保在微信中退出登录并重新登录。"
            )

    combined = proc.stdout + "\n" + proc.stderr

    try:
        with open(os.path.join(os.path.expanduser("~"), "gdb-capture.log"), "w") as _f:
            _f.write(combined)
    except Exception:
        pass

    if "Operation not permitted" in combined or "ptrace" in combined.lower():
        raise CaptureError(
            "GDB 无法附加到微信进程。请使用 sudo 运行，"
            "或执行: echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope"
        )

    match = re.search(r"WECHAT_PASSPHRASE=([0-9a-fA-F]{64})", combined)
    if match:
        passphrase = match.group(1).lower()
        logger.info("passphrase 捕获成功")
        return passphrase

    error_match = re.search(r"CAPTURE_ERROR=(.*)", combined)
    if error_match:
        raise CaptureError(f"捕获时出错: {error_match.group(1)}")

    raise CaptureError("未能捕获 passphrase，断点可能未触发。请确保重新登录了微信。")


def load_passphrase() -> str | None:
    """从磁盘加载已保存的 passphrase。"""
    try:
        with open(PASSPHRASE_FILE, "r") as f:
            data = json.load(f)
        return data.get("passphrase")
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def save_passphrase(passphrase: str) -> None:
    """保存 passphrase 到磁盘。"""
    os.makedirs(os.path.dirname(PASSPHRASE_FILE), exist_ok=True)
    data = {"passphrase": passphrase}
    with open(PASSPHRASE_FILE, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(PASSPHRASE_FILE, 0o600)
    logger.info(f"passphrase 已保存到 {PASSPHRASE_FILE}")


# ============================================================
# PBKDF2 Key Derivation
# ============================================================

def _derive_keys_from_passphrase(
    passphrase: bytes,
    db_files: list,
    salt_to_dbs: dict,
) -> dict:
    """用 passphrase 通过 PBKDF2 派生所有数据库的 enc_key。

    Args:
        passphrase: 32 字节 passphrase（从 GDB 捕获）
        db_files: collect_db_files() 返回的数据库列表
        salt_to_dbs: salt -> db_names 映射

    Returns:
        key_map: {salt_hex: enc_key_hex, ...}，验证通过的密钥
    """
    key_map: dict[str, str] = {}
    total = len(salt_to_dbs)
    for i, salt_hex in enumerate(salt_to_dbs):
        salt = bytes.fromhex(salt_hex)
        enc_key = hashlib.pbkdf2_hmac("sha512", passphrase, salt, 256000, dklen=KEY_SZ)
        for _rel, _path, _sz, s, page1 in db_files:
            if s == salt_hex and verify_enc_key(enc_key, page1):
                key_map[salt_hex] = enc_key.hex()
                break
        if (i + 1) % 5 == 0 or i == total - 1:
            _print(f"  PBKDF2 派生: {i + 1}/{total} ({len(key_map)} 验证通过)")
    return key_map


# ============================================================
# Key helpers
# ============================================================

def _strip_key_metadata(keys: dict) -> dict:
    """移除以下划线开头的元数据字段。"""
    return {k: v for k, v in keys.items() if not k.startswith("_")}


def _key_path_variants(rel_path: str) -> list[str]:
    """生成同一路径的多种分隔符表示，兼容 Windows/Linux JSON key。"""
    normalized = rel_path.replace("\\", "/")
    variants: list[str] = []
    for candidate in (
        rel_path,
        normalized,
        normalized.replace("/", "\\"),
        normalized.replace("/", os.sep),
    ):
        if candidate not in variants:
            variants.append(candidate)
    return variants


def _get_key_info(keys: dict, rel_path: str) -> dict | None:
    """按相对路径查找数据库密钥，自动兼容不同平台分隔符。"""
    if ".." in rel_path.replace("\\", "/").split("/"):
        return None
    for candidate in _key_path_variants(rel_path):
        if candidate in keys and not candidate.startswith("_"):
            return keys[candidate]
    return None


def _save_results(
    db_files: list,
    salt_to_dbs: dict,
    key_map: dict,
    db_dir: str,
    out_file: str,
) -> None:
    """输出扫描结果并保存 JSON。"""
    _print(f"\n{'=' * 60}")
    _print(f"结果: {len(key_map)}/{len(salt_to_dbs)} salts 找到密钥")

    result: dict = {}
    for rel, _path, sz, salt_hex, _page1 in db_files:
        if salt_hex in key_map:
            result[rel] = {
                "enc_key": key_map[salt_hex],
                "salt": salt_hex,
                "size_mb": round(sz / 1024 / 1024, 1),
            }
            _print(f"  OK: {rel} ({sz / 1024 / 1024:.1f}MB)")
        else:
            _print(f"  MISSING: {rel} (salt={salt_hex})")

    if not result:
        raise RuntimeError("未能提取到任何密钥")

    result["_db_dir"] = db_dir
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    _print(f"\n密钥保存到: {out_file}")


# ============================================================
# Config Detection (auto-detect WeChat db dir)
# ============================================================

def auto_detect_db_dir() -> str | None:
    """自动检测微信数据库目录（db_storage）。"""
    home = pathlib.Path.home()

    # 常见位置
    candidates = [
        home / ".local/share/com.tencent.wechat" / "xwechat_files",
        home / ".xwechat",
        home / ".local/share/wechat",
    ]

    # 也扫描 xwechat_files 的子目录
    xwechat = home / ".local/share/com.tencent.wechat" / "xwechat_files"
    if xwechat.exists():
        # 子目录可能是 wxid_xxx/db_storage
        for sub in xwechat.iterdir():
            if sub.is_dir():
                db_cand = sub / "db_storage"
                if db_cand.exists():
                    candidates.insert(0, db_cand)

    # 用 glob 搜索常见模式
    for pattern in [
        str(home / ".local/share/com.tencent.wechat/xwechat_files/*/db_storage"),
        str(home / ".xwechat/*/db_storage"),
        str(home / "xwechat_files/*/db_storage"),
    ]:
        for match in glob.glob(pattern):
            p = pathlib.Path(match)
            if p.is_dir() and p not in candidates:
                candidates.insert(0, p)

    for candidate in candidates:
        p = pathlib.Path(candidate)
        if p.is_dir():
            # 检查是否包含 .db 文件
            for _ in p.rglob("*.db"):
                return str(p)

    return None


# ============================================================
# Database Decryption
# ============================================================

def _decrypt_page(enc_key: bytes, page_data: bytes, pgno: int) -> bytes:
    """解密单个 SQLCipher4 页面，输出 4096 字节标准 SQLite 页面。"""
    iv = page_data[PAGE_SZ - RESERVE_SZ: PAGE_SZ - RESERVE_SZ + IV_SZ]

    if pgno == 1:
        # Page 1: salt(16B) + encrypted(4000B) + reserve(80B)
        encrypted = page_data[SALT_SZ: PAGE_SZ - RESERVE_SZ]
        decrypted = aes_cbc_decrypt(enc_key, iv, encrypted)
        page = bytearray(SQLITE_HDR + decrypted + b"\x00" * RESERVE_SZ)
        return bytes(page)
    else:
        # 普通页: encrypted(4016B) + reserve(80B)
        encrypted = page_data[: PAGE_SZ - RESERVE_SZ]
        decrypted = aes_cbc_decrypt(enc_key, iv, encrypted)
        return decrypted + b"\x00" * RESERVE_SZ


def _decrypt_database(db_path: str, out_path: str, enc_key: bytes) -> bool:
    """解密整个数据库文件。

    Returns:
        True 解密成功，False 解密失败
    """
    file_size = os.path.getsize(db_path)
    total_pages = file_size // PAGE_SZ
    if file_size % PAGE_SZ != 0:
        _print(f"  [WARN] 文件大小 {file_size} 不是 {PAGE_SZ} 的倍数")
        total_pages += 1

    with open(db_path, "rb") as fin:
        page1 = fin.read(PAGE_SZ)

    if len(page1) < PAGE_SZ:
        _print("  [ERROR] 文件太小")
        return False

    # 验证密钥
    salt = page1[:SALT_SZ]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SZ)
    p1_hmac_data = page1[SALT_SZ: PAGE_SZ - RESERVE_SZ + IV_SZ]
    p1_stored_hmac = page1[PAGE_SZ - HMAC_SZ: PAGE_SZ]
    hm = hmac_mod.new(mac_key, p1_hmac_data, hashlib.sha512)
    hm.update(struct.pack("<I", 1))
    if hm.digest() != p1_stored_hmac:
        _print(f"  [ERROR] Page 1 HMAC 验证失败! salt: {salt.hex()}")
        return False

    _print(f"  HMAC OK, {total_pages} pages")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    with open(db_path, "rb") as fin, open(out_path, "wb") as fout:
        for pgno in range(1, total_pages + 1):
            page = fin.read(PAGE_SZ)
            if len(page) < PAGE_SZ:
                if len(page) > 0:
                    page = page + b"\x00" * (PAGE_SZ - len(page))
                else:
                    break
            decrypted = _decrypt_page(enc_key, page, pgno)
            fout.write(decrypted)
            if pgno % 10000 == 0:
                _print(f"  进度: {pgno}/{total_pages} ({100 * pgno / total_pages:.1f}%)")

    return True


def decrypt_all(db_dir: str, out_dir: str, keys_file: str) -> dict:
    """解密 db_dir 下所有有密钥的数据库。

    Args:
        db_dir: 微信 db_storage 目录
        out_dir: 解密输出目录
        keys_file: 密钥 JSON 文件路径

    Returns:
        {"success": int, "failed": int, "total": int, "total_bytes": int}
    """
    _print("=" * 60)
    _print("  WeChat 数据库解密器")
    _print("=" * 60)

    if not os.path.exists(keys_file):
        _print(f"[ERROR] 密钥文件不存在: {keys_file}")
        _print("请先运行: sudo python3 wcdb_key_tool.py extract")
        sys.exit(1)

    with open(keys_file, encoding="utf-8") as f:
        keys = json.load(f)
    keys = _strip_key_metadata(keys)
    _print(f"\n加载 {len(keys)} 个数据库密钥")
    _print(f"输出目录: {out_dir}")
    os.makedirs(out_dir, exist_ok=True)

    db_files: list[tuple[str, str, int]] = []
    for root, _dirs, files in os.walk(db_dir):
        for fname in files:
            if fname.endswith(".db") and not fname.endswith("-wal") and not fname.endswith("-shm"):
                path = os.path.join(root, fname)
                rel = os.path.relpath(path, db_dir)
                sz = os.path.getsize(path)
                db_files.append((rel, path, sz))

    db_files.sort(key=lambda x: x[2])
    _print(f"找到 {len(db_files)} 个数据库文件\n")

    success = 0
    failed = 0
    total_bytes = 0

    for rel, path, sz in db_files:
        key_info = _get_key_info(keys, rel)
        if not key_info:
            _print(f"SKIP: {rel} (无密钥)")
            failed += 1
            continue

        enc_key = bytes.fromhex(key_info["enc_key"])
        out_path = os.path.join(out_dir, rel)

        _print(f"解密: {rel} ({sz / 1024 / 1024:.1f}MB) ...", end=" ")

        ok = _decrypt_database(path, out_path, enc_key)
        if ok:
            try:
                import sqlite3
                conn = sqlite3.connect(out_path)
                tables = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
                conn.close()
                table_names = [t[0] for t in tables]
                _print(f"  OK! 表: {', '.join(table_names[:5])}", end="")
                if len(table_names) > 5:
                    _print(f" ...共{len(table_names)}个", end="")
                _print()
                success += 1
                total_bytes += sz
            except Exception as e:
                _print(f"  [WARN] SQLite 验证失败: {e}")
                failed += 1
        else:
            failed += 1

    _print(f"\n{'=' * 60}")
    _print(f"结果: {success} 成功, {failed} 失败, 共 {len(db_files)} 个")
    _print(f"解密数据量: {total_bytes / 1024 / 1024 / 1024:.1f}GB")
    _print(f"解密文件在: {out_dir}")

    return {
        "success": success,
        "failed": failed,
        "total": len(db_files),
        "total_bytes": total_bytes,
    }


# ============================================================
# CLI
# ============================================================

def cmd_extract(args: argparse.Namespace) -> None:
    """提取密钥主流程。"""
    # 检查环境
    issues = check_prerequisites()
    if issues:
        _print("[ERROR] 环境检查失败:")
        for issue in issues:
            _print(f"  - {issue}")
        sys.exit(1)

    # 确定 DB 目录
    db_dir = args.db_dir
    if not db_dir:
        db_dir = auto_detect_db_dir()
        if not db_dir:
            _print("[ERROR] 未能自动检测微信数据库目录，请使用 --db-dir 手动指定")
            sys.exit(1)
        _print(f"[*] 自动检测到数据库目录: {db_dir}")

    db_files, salt_to_dbs = collect_db_files(db_dir)
    if not db_files:
        _print(f"[ERROR] 在 {db_dir} 未找到可解密的 .db 文件")
        sys.exit(1)

    _print(f"找到 {len(db_files)} 个数据库, {len(salt_to_dbs)} 个不同的 salt")

    out_file = args.output

    # === 第 1 级：已缓存的 keys ===
    key_map: dict[str, str] = {}
    if os.path.exists(out_file):
        try:
            with open(out_file, encoding="utf-8") as f:
                existing = json.load(f)
            existing = _strip_key_metadata(existing)
            all_valid = True
            for rel, _path, _sz, salt_hex, page1 in db_files:
                entry = _get_key_info(existing, rel)
                if not entry or "enc_key" not in entry:
                    all_valid = False
                    break
                enc_key = bytes.fromhex(entry["enc_key"])
                if not verify_enc_key(enc_key, page1):
                    all_valid = False
                    break
            if all_valid:
                _print("[+] 已缓存的密钥全部验证通过，无需重新提取")
                if args.decrypt:
                    cmd_decrypt_inner(db_dir, out_file, "decrypted")
                return
        except (json.JSONDecodeError, KeyError, ValueError):
            pass

    # === 第 2 级：已保存的 passphrase + PBKDF2 派生 ===
    passphrase_hex = load_passphrase()
    if passphrase_hex:
        _print("[*] 使用已保存的 passphrase 派生密钥（PBKDF2，约需 30-60 秒）...")
        passphrase = bytes.fromhex(passphrase_hex)
        key_map = _derive_keys_from_passphrase(passphrase, db_files, salt_to_dbs)
        if key_map:
            _print(f"[+] passphrase 派生成功: {len(key_map)}/{len(salt_to_dbs)} 密钥")
            _save_results(db_files, salt_to_dbs, key_map, db_dir, out_file)
            if args.decrypt:
                cmd_decrypt_inner(db_dir, out_file, "decrypted")
            return
        _print("[!] 已保存的 passphrase 无效（微信可能已更新），将重新捕获")

    # === 第 3 级：GDB 捕获 ===
    _print()
    _print("=" * 60)
    _print("  需要捕获新的 passphrase")
    _print("=" * 60)
    _print()
    _print("请在微信中执行以下操作：")
    _print("  1. 打开微信设置")
    _print("  2. 退出登录（不是退出微信，是账号退出登录）")
    _print("  3. 重新扫码/输入密码登录")
    _print()
    _print(f"工具将等待最多 {args.timeout} 秒...")
    _print()

    try:
        passphrase_hex = capture_passphrase(timeout=args.timeout)
    except CaptureError as e:
        _print(f"[ERROR] 捕获失败: {e}")
        sys.exit(1)

    _print(f"[+] passphrase 捕获成功: {passphrase_hex[:8]}...（已截断）")
    save_passphrase(passphrase_hex)

    _print("\n[*] 开始 PBKDF2 派生密钥（约需 30-60 秒）...")
    passphrase = bytes.fromhex(passphrase_hex)
    key_map = _derive_keys_from_passphrase(passphrase, db_files, salt_to_dbs)

    if not key_map:
        _print("[ERROR] PBKDF2 派生后未能验证任何密钥，请检查数据库目录")
        sys.exit(1)

    _save_results(db_files, salt_to_dbs, key_map, db_dir, out_file)

    if args.decrypt:
        cmd_decrypt_inner(db_dir, out_file, "decrypted")


def cmd_decrypt_inner(db_dir: str, keys_file: str, out_dir: str) -> None:
    """内部解密调用。"""
    decrypt_all(db_dir, out_dir, keys_file)


def cmd_decrypt(args: argparse.Namespace) -> None:
    """解密命令。"""
    # 确定 DB 目录
    db_dir = args.db_dir
    if not db_dir:
        # 尝试从 keys 文件读取
        if os.path.exists(args.keys):
            try:
                with open(args.keys, encoding="utf-8") as f:
                    keys_data = json.load(f)
                db_dir = keys_data.get("_db_dir")
            except Exception:
                pass
    if not db_dir:
        db_dir = auto_detect_db_dir()
    if not db_dir:
        _print("[ERROR] 未能确定数据库目录，请使用 --db-dir 手动指定")
        sys.exit(1)

    decrypt_all(db_dir, args.output, args.keys)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="wcdb-key-tool — 微信数据库密钥提取工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            示例:
              sudo python3 wcdb_key_tool.py extract
              sudo python3 wcdb_key_tool.py extract --decrypt
              sudo python3 wcdb_key_tool.py decrypt --keys all_keys.json

            项目地址: https://github.com/TANGandXUE/wcdb-key-tool
        """),
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="显示详细日志")
    sub = parser.add_subparsers(dest="command", metavar="command")
    sub.required = True

    extract_cmd = sub.add_parser("extract", help="提取数据库密钥（首次需要重新登录微信）")
    extract_cmd.add_argument("--db-dir", help="微信 db_storage 目录（默认自动检测）")
    extract_cmd.add_argument("--output", default="all_keys.json", help="密钥输出文件（默认 all_keys.json）")
    extract_cmd.add_argument("--decrypt", action="store_true", help="提取后自动解密数据库")
    extract_cmd.add_argument("--timeout", type=int, default=120, help="GDB 等待超时秒数（默认 120）")

    decrypt_cmd = sub.add_parser("decrypt", help="解密数据库（需要已有密钥文件）")
    decrypt_cmd.add_argument("--db-dir", help="微信 db_storage 目录（默认从密钥文件读取）")
    decrypt_cmd.add_argument("--keys", default="all_keys.json", help="密钥文件（默认 all_keys.json）")
    decrypt_cmd.add_argument("--output", default="decrypted", help="解密输出目录（默认 ./decrypted）")

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    if args.command == "extract":
        cmd_extract(args)
    elif args.command == "decrypt":
        cmd_decrypt(args)


if __name__ == "__main__":
    main()
