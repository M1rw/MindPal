## 2026-09-02 - SSRF Bypass via Site-Local IPv6 Address Literals
**Vulnerability:** Python's `ipaddress.IPv6Address` evaluates site-local IPv6 address literals (`fec0::/10`, e.g. `fec0::1`) with `is_global = True` and `is_private = False`, enabling SSRF bypasses when validating URL hostnames against `is_global`.
**Learning:** Although RFC 3879 deprecated Site-Local IPv6 unicast addresses (`fec0::/10`), Python's `ipaddress.IPv6Address.is_global` property does not exclude `is_site_local`. Internal/site network routers or legacy dual-stack implementations may route these addresses within local environments.
**Prevention:** When validating IP addresses for SSRF prevention, explicitly check `getattr(address, "is_site_local", False)` in addition to `address.is_global` to ensure site-local IPv6 addresses are rejected.

## 2026-08-29 - SSRF Bypass via NAT64 and SIIT IPv6 Address Literals
**Vulnerability:** Python's `ipaddress.ip_address` evaluates NAT64 (`64:ff9b::/96`) and Stateless IP/ICMP Translation (SIIT, `::ffff:0:0/96`) IPv6 address literals (e.g. `64:ff9b::127.0.0.1` or `::ffff:0:10.0.0.1`) as `IPv6Address` instances with `is_global = True` and `ipv4_mapped = None`, enabling SSRF bypasses when validating hostnames against `is_global`.
**Learning:** NAT64 and SIIT IPv6 prefixes embed a 32-bit IPv4 address in the last 32 bits without setting `.ipv4_mapped` (which is only set for `::ffff:0:0/96` IPv4-mapped IPv6 literals without explicit zero word). Dual-stack sockets and transition gateways translate these embedded IPv4 addresses, routing traffic to private IPv4 hosts.
**Prevention:** When inspecting `IPv6Address` objects for SSRF prevention, check for NAT64 (`prefix_96 == 0x0064FF9B0000000000000000`) and SIIT (`prefix_96 == 0x0000000000000000FFFF0000`) prefixes, extract the embedded `IPv4Address(int(address) & 0xFFFFFFFF)`, and validate its `is_global` property.

## 2026-08-28 - SSRF Bypass via IPv4-Compatible IPv6 Address Literals
**Vulnerability:** Python's `ipaddress.ip_address` evaluates IPv4-compatible IPv6 literals (`::/96` range, e.g. `::127.0.0.1` or `::10.0.0.1`) as `IPv6Address` instances with `is_global = True` and `ipv4_mapped = None`, allowing SSRF bypasses when validating URL hostnames against `is_global`.
**Learning:** Unlike IPv4-mapped IPv6 (`::ffff:0:0/96`), `IPv6Address` objects for deprecated IPv4-compatible IPv6 addresses (`::/96`) do not expose an `.ipv4_mapped` property, yet dual-stack sockets and system HTTP clients may unpack the embedded 32-bit IPv4 address and connect to local/private IPv4 hosts.
**Prevention:** When inspecting `IPv6Address` objects for SSRF prevention, check if `address` is in `::/96` (`(int(address) >> 32) == 0`) and validate `IPv4Address(int(address) & 0xFFFFFFFF).is_global` in addition to `address.is_global`.

## 2026-07-20 - SSRF Bypass via IPv4-Mapped IPv6 Address Literals
**Vulnerability:** Python's `ipaddress.ip_address` evaluates IPv4-mapped IPv6 literals (such as `::ffff:127.0.0.1` or `::ffff:10.0.0.1`) as IPv6Address instances with `is_global = True`, allowing SSRF bypasses when validating URL hostnames against `is_global`.
**Learning:** `IPv6Address.is_global` returns `True` for IPv4-mapped IPv6 addresses wrapping non-global IPv4 addresses because `::ffff:0:0/96` is technically globally routable as IPv6 range, even though dual-stack network stacks resolve and route the underlying IPv4 address locally.
**Prevention:** When validating IP addresses for SSRF prevention, check if `address.ipv4_mapped` exists on IPv6 objects and enforce `address.ipv4_mapped.is_global` in addition to `address.is_global`.

## 2026-07-18 - SSRF Bypass via Non-Standard IP Address Notations
**Vulnerability:** Python's standard `ipaddress.ip_address` function throws `ValueError` when given non-standard IPv4 representations like single integer (`2130706433`), hex (`0x7f000001`), octal (`017700000001`), shorthand (`127.1`), or dotted octal (`0177.0.0.1`), allowing attackers to bypass `validate_url` non-global IP checks.
**Learning:** `ipaddress.ip_address` does not automatically recognize non-standard integer/hex/octal/shorthand IPv4 literal formats. Host resolution and explicit base parsing are needed to resolve alternative IP notations before checking `ip.is_global`.
**Prevention:** When validating URLs against SSRF, use a custom parser (`_parse_ip_address`) that checks integer/hex/octal representations as well as host resolution to convert IP literals to `IPv4Address` objects prior to performing global routability validation.
