## 2026-07-20 - SSRF Bypass via IPv4-Mapped IPv6 Address Literals
**Vulnerability:** Python's `ipaddress.ip_address` evaluates IPv4-mapped IPv6 literals (such as `::ffff:127.0.0.1` or `::ffff:10.0.0.1`) as IPv6Address instances with `is_global = True`, allowing SSRF bypasses when validating URL hostnames against `is_global`.
**Learning:** `IPv6Address.is_global` returns `True` for IPv4-mapped IPv6 addresses wrapping non-global IPv4 addresses because `::ffff:0:0/96` is technically globally routable as IPv6 range, even though dual-stack network stacks resolve and route the underlying IPv4 address locally.
**Prevention:** When validating IP addresses for SSRF prevention, check if `address.ipv4_mapped` exists on IPv6 objects and enforce `address.ipv4_mapped.is_global` in addition to `address.is_global`.

## 2026-07-18 - SSRF Bypass via Non-Standard IP Address Notations
**Vulnerability:** Python's standard `ipaddress.ip_address` function throws `ValueError` when given non-standard IPv4 representations like single integer (`2130706433`), hex (`0x7f000001`), octal (`017700000001`), shorthand (`127.1`), or dotted octal (`0177.0.0.1`), allowing attackers to bypass `validate_url` non-global IP checks.
**Learning:** `ipaddress.ip_address` does not automatically recognize non-standard integer/hex/octal/shorthand IPv4 literal formats. Host resolution and explicit base parsing are needed to resolve alternative IP notations before checking `ip.is_global`.
**Prevention:** When validating URLs against SSRF, use a custom parser (`_parse_ip_address`) that checks integer/hex/octal representations as well as host resolution to convert IP literals to `IPv4Address` objects prior to performing global routability validation.
