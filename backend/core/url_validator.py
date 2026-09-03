# backend/core/url_validator.py

"""
SSRF-safe URL validation and host normalization.

Guards external HTTP clients against SSRF attacks including:
- Private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8)
- Link-local and cloud metadata endpoints (169.254.169.254, etc.)
- Decimal integer, hex, octal, and shorthand IPv4 representations (127.1, 0177.0.0.1, 0x7f000001)
- IPv6 loopback (::1), site-local, unique-local (fc00::/7), link-local (fe80::/10)
- IPv4-mapped (::ffff:127.0.0.1), NAT64 (64:ff9b::/96), SIIT (::ffff:0:0/96), and IPv4-compatible (::/96)
"""

from __future__ import annotations

import ipaddress
from typing import Final
from urllib.parse import urlparse

_SAFE_URL_SCHEMES: Final[frozenset[str]] = frozenset({"http", "https"})


def parse_ip_literal(hostname: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """
    Parse a hostname string into an IPv4 or IPv6 address object if it represents an IP literal.
    Supports standard, decimal integer, hex, octal, shorthand dotted IPv4, and IPv6 encodings.
    """
    host = hostname.strip("[]").strip()
    if not host:
        return None

    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass

    parts = host.split(".")
    if 1 <= len(parts) <= 4:
        parsed_parts: list[int] = []
        valid = True
        for part in parts:
            val = _parse_int_part(part)
            if val is None:
                valid = False
                break
            parsed_parts.append(val)

        if valid:
            ipv4_int = _assemble_ipv4_int(parsed_parts)
            if ipv4_int is not None and 0 <= ipv4_int <= 0xFFFFFFFF:
                return ipaddress.IPv4Address(ipv4_int)

    return None


def is_globally_routable_ip(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """
    Check if an IP address is globally routable.
    Correctly unwraps IPv4-mapped, IPv4-compatible, NAT64, and SIIT IPv6 addresses,
    and rejects site-local, multicast, and reserved IP addresses.
    """
    if (
        not address.is_global
        or getattr(address, "is_site_local", False)
        or getattr(address, "is_multicast", False)
        or getattr(address, "is_reserved", False)
    ):
        return False

    if getattr(address, "ipv4_mapped", None) is not None:
        mapped_v4 = address.ipv4_mapped
        return bool(
            mapped_v4
            and mapped_v4.is_global
            and not mapped_v4.is_multicast
            and not mapped_v4.is_reserved
        )

    if isinstance(address, ipaddress.IPv6Address):
        addr_int = int(address)
        prefix_96 = addr_int >> 32
        if (
            (addr_int != 0 and prefix_96 == 0)
            or prefix_96 == 0x0064FF9B0000000000000000
            or prefix_96 == 0x0000000000000000FFFF0000
        ):
            embedded_v4 = ipaddress.IPv4Address(addr_int & 0xFFFFFFFF)
            return bool(
                embedded_v4.is_global
                and not embedded_v4.is_multicast
                and not embedded_v4.is_reserved
            )

    return True


def validate_url(
    url: str,
    *,
    allowed_schemes: frozenset[str] | None = None,
    block_private_ips: bool = True,
    max_length: int = 2048,
) -> str:
    """
    Validate and sanitize a URL for safe use in provider HTTP calls.
    Raises ValueError if the URL is unsafe.
    """
    schemes = allowed_schemes or _SAFE_URL_SCHEMES
    cleaned = str(url or "").strip()
    if not cleaned or len(cleaned) > max_length:
        raise ValueError("URL is empty or exceeds maximum allowed length")

    try:
        parsed = urlparse(cleaned)
    except Exception as exc:
        raise ValueError(f"URL parse error: {exc}") from exc

    if not parsed.scheme or parsed.scheme.lower() not in schemes:
        raise ValueError(
            f"URL scheme '{parsed.scheme}' not in allowed schemes: {sorted(schemes)}"
        )

    hostname = (parsed.hostname or "").strip().lower()
    if not hostname:
        raise ValueError("URL has no hostname")

    if block_private_ips:
        if hostname == "localhost" or hostname.endswith(".localhost"):
            raise ValueError(f"URL hostname '{hostname}' is a loopback address")

        address = parse_ip_literal(hostname)
        if address is not None and not is_globally_routable_ip(address):
            raise ValueError(f"URL hostname '{hostname}' is not globally routable")

    return cleaned


def is_safe_url(url: str) -> bool:
    """Return True if url passes SSRF and safety validation."""
    try:
        validate_url(url)
        return True
    except ValueError:
        return False


def _parse_int_part(part: str) -> int | None:
    if not part:
        return None
    try:
        if part.startswith(("0x", "0X")) and len(part) > 2:
            return int(part, 16)
        if part.startswith("0") and len(part) > 1 and all(c in "01234567" for c in part[1:]):
            return int(part, 8)
        if part.isdigit():
            return int(part, 10)
    except (ValueError, OverflowError):
        return None
    return None


def _assemble_ipv4_int(parts: list[int]) -> int | None:
    n = len(parts)
    if n == 1:
        return parts[0] if parts[0] <= 0xFFFFFFFF else None
    if n == 2:
        return (parts[0] << 24) | parts[1] if (parts[0] <= 0xFF and parts[1] <= 0xFFFFFF) else None
    if n == 3:
        return (parts[0] << 24) | (parts[1] << 16) | parts[2] if (parts[0] <= 0xFF and parts[1] <= 0xFF and parts[2] <= 0xFFFF) else None
    if n == 4:
        return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3] if all(p <= 0xFF for p in parts) else None
    return None
