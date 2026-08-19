# MindPal Network Assistant (safe prototype)

This is a local-first, router-agnostic prototype for measuring home-network usage, comparing before/after snapshots, recommending reversible Smart Queue Management settings, and calculating plan unit costs. It is intentionally **read-only and dry-run**. It does not connect to a router, alter firmware, change ISP profiles, bypass quotas, falsify counters, or evade billing.

## What it can prove

The `usage` command calculates byte deltas between two owner-supplied snapshots. It treats a counter reset or wrap as zero/unknown rather than inventing negative usage. The `sqm` command recommends a starting shaper near 90% of measured rates when loaded latency is at least 10 ms above idle latency. The `plan-cost` command applies 14% VAT and reports EGP per GB.

## Build on Linux

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
```

The same commands work on Windows with a CMake generator such as Visual Studio or Ninja. No third-party library is required beyond a C++17 compiler and CMake.

## Usage

```bash
./build/netassist usage data/before.csv data/after.csv
./build/netassist sqm 100 20 10 40
./build/netassist plan-cost 120 150
```

Snapshot CSV format:

```csv
device,category,rx_bytes,tx_bytes,ps5
ps5,console,1000000,400000,true
laptop,computer,2000000,800000,false
```

## Planned adapter work

After the router model and firmware are known, add an adapter under `src/adapters/` that is limited to the LAN and uses the router's documented local interface. OpenWrt is the preferred first target because its local `ubus`/`rpcd` architecture exposes status and configuration methods. The production adapter should use a least-privilege account, read-only credentials for monitoring, a separate approval token for writes, configuration backups before changes, and a rollback path. The assistant must never publish a router-management endpoint to the internet.

## Safe quota-saving actions

The future policy layer may recommend local DNS caching and malware/ad blocking, disabling automatic video autoplay, scheduling PS5 downloads and system updates, using wired Ethernet, identifying duplicate cloud backups, and applying SQM to reduce latency under load. These actions can reduce waste or improve responsiveness; none can increase the ISP allowance.

## Explicitly excluded

The project excludes VPN or tunnel tricks intended to avoid ISP metering, MAC/identity spoofing, exploitation of billing exceptions, unauthorized router access, credential extraction, port scans, and any attempt to make the ISP's accounting system record less traffic than was transmitted.
