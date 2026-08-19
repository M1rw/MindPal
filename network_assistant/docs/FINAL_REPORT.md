# Home Network AI Assistant: Findings, Tests, and Safe Design

**Author:** Manus AI  
**Date:** 20 August 2026  
**Input:** *Beyond a Quota Scam: A Decade of Systemic Failure in Telecom Egypt’s Internet Services* (28-page PDF supplied with this task)

## Executive conclusion

The supplied report documents a serious and persistent **trust problem** around Telecom Egypt/WE fixed broadband: users describe unexplained quota depletion, mismatches between router counters and the My WE balance, throttling, packet loss, service interruptions, and poor complaint handling. However, the report is a synthesis of official material, news, social-media posts, and anecdotes. It is evidence that people experienced these symptoms, not proof that WE intentionally falsified individual accounts or that a particular router configuration can make metered traffic free.

The strongest technically defensible solution is a **local-first network evidence and optimization assistant**. It should inventory devices, keep its own timestamped byte ledger, identify the PS5, run idle and loaded latency tests, recommend Smart Queue Management (SQM), schedule large downloads and updates, block known waste or malicious domains, and export evidence for an NTRA/ISP complaint. This can make a limited plan feel substantially more usable by preventing avoidable consumption and keeping gaming responsive. It cannot create additional ISP allowance, alter WE’s billing meter, or legitimately turn a capped plan into unlimited service.

I built and tested a safe prototype in the selected `M1rw/MindPal` repository. The prototype is deliberately **read-only and dry-run**: it does not connect to or change a router until the exact router model, firmware, and owner-approved interface are known.

## 1. What the supplied report establishes—and what it does not

The report’s recurring themes are anomalous “data drain,” discrepancies between router and ISP counters, speed reduction after quota/FUP thresholds, packet loss and latency, dissatisfaction with customer support, and a structural concern that Telecom Egypt controls much of the fixed-line and international infrastructure. It also gives historical context, including the abandoned 2007 quota proposal, the 2008 cable-break disruption, and later public campaigns. These themes are useful for designing an evidence tool because they identify exactly what must be measured rather than argued from screenshots.

The report does **not** independently demonstrate the cause of a particular 21-GB overnight loss, establish that the ISP deliberately adds unobserved traffic, or validate social-media “quota extension” configurations. Router counters and ISP accounting can differ for several non-fraud reasons: different measurement points, retransmissions, multicast/broadcast traffic, counter resets, PPP/session accounting, device updates, and different reset times. A controlled, timestamped comparison is therefore more valuable than a single dashboard screenshot.

> The correct engineering question is not “which secret config gives free gigabytes?” but “which bytes crossed the WAN, which device generated them, when did the ISP counter change, and can the difference be reproduced?”

## 2. Current WE plan facts verified from official pages

The official WE Space page currently lists monthly packages from 50 GB at 150 EGP to 1,500 GB at 1,650 EGP for the up-to-30-Mbps tier, with higher-speed tiers and a 3-TB up-to-1-Gbps offering. It explicitly says that after the basic quota is consumed, service continues at a throttled speed, and that the customer can early-renew or purchase add-ons.[1] The WE FAQ states that 14% VAT applies to recharge amounts and that customers can monitor quota usage through My WE, the website, or customer care.[2]

| Offer | Official description | Price basis used in calculation | Important limitation |
|---|---|---:|---|
| WE Space regular | Base quota; after it is consumed, continued use is throttled | 150 GB/260 EGP through 1,500 GB/1,650 EGP examples | These are VAT-exclusive prices on the page; line speed depends on eligibility |
| PS add-on | 150 GB for 120 EGP or 300 GB for 240 EGP for PS3/PS4/PS5 use | 0.80 EGP/GB before VAT | Classification is provider-controlled; non-PS traffic is not included |
| GAME ON | 40 GB for 40 EGP for listed games/platforms | 1.00 EGP/GB before VAT | The included-game list is narrower than “all gaming” |
| WE Sonic Gamerz | 500 GB plan at up to 80 Mbps; basic quota plus a dedicated gaming quota | Advertised gaming quota range modelled as 250 GB basic + 125–250 GB gaming | Dedicated quota is used only if WE classifies the traffic as gaming |
| WE Sonic Plus | 1,500 GB plan at up to 150 Mbps; basic quota plus gaming-and-streaming quota | Advertised range modelled as 500 GB basic + 500–1,000 GB dedicated | Combined classification and traffic eligibility must be tested against the account |

WE’s official page says the PS add-on is intended for PS3/PS4/PS5 use. It also states that after the PS quota is consumed, PlayStation online usage consumes the main quota; if the main quota is consumed while PS quota remains, PlayStation gaming is stated to continue at original speed.[1] This wording should not be generalized to downloads, patches, store browsing, cloud sync, party chat, Remote Play, or third-party game services without testing.

The official WE Sonic page advertises 500 GB at 650 EGP/month up to 80 Mbps and 1,500 GB at 1,400 EGP/month up to 150 Mbps. Its table describes basic quota plus dedicated gaming, streaming, or combined quota and says that dedicated-quota use shifts to the basic quota after exhaustion.[3] The practical issue is classification: the same PS5 may generate different traffic for gameplay, a patch CDN, the PlayStation Store, party chat, and video streaming.

## 3. How the plan economics calculate

The calculator applies the 14% VAT stated in the WE FAQ. The formula is:

`VAT-inclusive price = listed price × 1.14`  
`cost per GB = VAT-inclusive price ÷ advertised quota`

| Item | Listed price | Price with VAT | Advertised quota | Cost per GB with VAT |
|---|---:|---:|---:|---:|
| WE Space Super 150 GB | 260 EGP | 296.40 EGP | 150 GB | 1.976 EGP |
| WE Space Super 500 GB | 660 EGP | 752.40 EGP | 500 GB | 1.505 EGP |
| WE Space Super 1,500 GB | 1,650 EGP | 1,881.00 EGP | 1,500 GB | 1.254 EGP |
| PS add-on 150 GB | 120 EGP | 136.80 EGP | 150 GB | 0.912 EGP |
| PS add-on 300 GB | 240 EGP | 273.60 EGP | 300 GB | 0.912 EGP |
| GAME ON 40 GB | 40 EGP | 45.60 EGP | 40 GB | 1.140 EGP |
| Giga tank 400 GB | 500 EGP | 570.00 EGP | 400 GB | 1.425 EGP |
| Giga tank 2,000 GB | 2,000 EGP | 2,280.00 EGP | 2,000 GB | 1.140 EGP |

For WE Sonic, the effective advertised range must be shown as a range because the page itself describes a basic quota plus a dedicated quota. The 500-GB Gamerz plan is 650 EGP before VAT, or 741 EGP including VAT. If only the lower 125-GB dedicated quota is granted, the advertised total is 375 GB and the arithmetic cost is 1.976 EGP/GB. If the full 250-GB dedicated quota is granted, the advertised total is 500 GB and the arithmetic cost is 1.482 EGP/GB. The 1,500-GB Plus plan is 1,596 EGP including VAT; its advertised combined range is 1,000–1,500 GB, giving 1.596–1.064 EGP/GB. These are not guaranteed prices for arbitrary internet traffic because the dedicated portion depends on classification.

The immediate economic result is clear: the PS add-on is attractive **only when the household’s traffic is genuinely eligible PS traffic**. The add-on does not provide a general-purpose 150 or 300 GB to use for browsers, video, cloud backups, or unrelated downloads.

## 4. “Configs” that claim to extend GBs

The request’s phrase “extend more GPS” appears to mean “extend more GBs,” although it could also mean GPON or another configuration term. I did not reproduce or test quota-bypass instructions. Public claims in this area generally fall into four categories: using a provider’s legitimate gaming classification; reducing local waste; accounting tricks that only change what a dashboard displays; or tunnelling/identity/traffic-classification abuse intended to evade billing or FUP enforcement.

The first two are legitimate. A local assistant can reduce auto-play, unwanted advertising and malware traffic, duplicate cloud synchronization, unplanned console updates, and large downloads during gaming. It can also keep latency low with SQM. A VPN, DNS change, port forwarding, MAC-address change, MTU change, or tunnel does not make ISP-metered bytes disappear. Encryption usually adds overhead, and changing the route may cause provider classification to fail rather than improve. Identity spoofing, exploiting a billing exception, or intentionally hiding usage from the ISP can violate service terms or law and can expose the home network to unsafe third parties.

The assistant should therefore report three separate numbers: **local WAN bytes observed**, **PS5-device bytes observed**, and **ISP balance delta**. It should attach a confidence interval and flag counter resets or different reset boundaries. If the ISP balance falls materially faster than the local ledger over a controlled period, the result is evidence for a formal complaint—not a reason to deploy an exploit.

## 5. PS5 networking facts and router configuration

Sony’s current PS5 troubleshooting guidance recommends wired Ethernet where possible, router firmware updates, and attention to congestion and multiple-router conditions. For a connectivity failure it lists TCP ports 80, 443, 3478, 3479, and 3480, and UDP ports 3478, 3479, and 49152–65535; it directs users to their ISP for router configuration.[4] Sony does not claim that opening ports increases download speed or reduces quota consumption. Port forwarding should be considered only when a real NAT or connectivity problem is observed, and UPnP/DMZ should not be enabled broadly as a substitute for diagnosis.

| PS5 activity | Expected network effect | Quota-control recommendation |
|---|---|---|
| Online gameplay | Usually modest sustained data, but sensitive to latency, jitter, and loss | Prioritize the PS5 flow locally; use wired Ethernet and SQM |
| Game download or patch | Potentially tens of gigabytes or more; high throughput | Schedule it; record before/after counters; do not run it during a quota-reconciliation test |
| Console firmware and cloud sync | Variable background usage | Disable automatic behavior where appropriate and schedule maintenance |
| Party chat | Low-to-moderate continuous traffic, latency-sensitive | Give real-time traffic priority but do not assume PS-bundle classification |
| Remote Play or video streaming | Sustained higher bandwidth | Treat separately from “PS gaming” unless WE confirms eligibility |

The PS add-on and WE Sonic plan should be compared by **observed eligible traffic**, not by the word “gaming.” The tool should run separate sessions for gameplay, a permitted update/download, party chat, and streaming, with the My WE balance recorded before and after each session. This is the only reliable way to learn how the user’s specific line is classified.

## 6. Tool architecture and safety model

The prototype uses a local-first architecture. The router adapter is intentionally not activated because the router model and firmware were not supplied. OpenWrt is the best first target: its documented `ubus`/`rpcd` architecture provides local status and action interfaces, while SQM is documented as a mechanism for per-flow scheduling, traffic shaping, rate limiting, and QoS prioritization.[5] [6]

| Component | Role | Authority |
|---|---|---|
| Router adapter | Read WAN/LAN status, leases, and counters | Read-only by default |
| Quota ledger | Store timestamped device and WAN counters | Read-only |
| Test runner | Measure idle/loaded latency, DNS, loss, and throughput | Read-only |
| Policy engine | Recommend SQM, scheduling, and quota alerts | Dry-run |
| Change executor | Apply approved local settings with backup and rollback | Disabled until explicitly approved |
| AI analyst | Summarize evidence and rank reversible actions | No direct execution authority |
| Audit log | Record every read, recommendation, approval, and change | Append-only |

The future controller must bind only to the LAN, never publish router management to the public internet, use a least-privilege router account, take a configuration backup before changes, show a diff, require explicit approval for writes, and support rollback. “Full access” should mean full **owner-authorized local administration**, not unrestricted remote access or bypass of ISP controls.

## 7. Prototype implementation and tests

The selected repository now contains `network_assistant/`. It includes a C++17 command-line prototype, a pure core library, unit tests, sample snapshots, CMake configuration, and a GitHub Actions workflow. The commands are:

```text
netassist usage <before.csv> <after.csv>
netassist sqm <down_mbps> <up_mbps> <idle_latency_ms> <loaded_latency_ms>
netassist plan-cost <price_ex_vat_egp> <quota_gb>
```

The build completed successfully with GCC 13.3 and CMake 3.28.3. The unit-test suite passed: **1/1 tests passed**. The tests cover byte deltas, counter-reset handling, SQM threshold logic, VAT arithmetic, and the no-evasion safety policy. A sample snapshot comparison measured 2.142 GiB of PS5-device traffic and 0.373 GiB for a laptop in the supplied synthetic test fixture; this fixture is only a deterministic software test and is not evidence about the user’s actual home usage.

A separate bounded sandbox connectivity test resolved `speed.cloudflare.com` in 12.49 ms, `playstation.com` in 3.11 ms, and `te.eg` in 3.04 ms. A 1,000,000-byte HTTPS sample returned HTTP 200 in 6,743.18 ms, approximately 1.186 Mbps from the sandbox. The sandbox did not have the ICMP `ping` utility. These measurements describe the sandbox path, not the user’s WE line, and cannot validate quota discrepancies, PS5 classification, or home-router performance.

## 8. What remains to finish real router control

Before enabling any router write capability, the following information is required: the exact router make/model and firmware; whether the line is DSL, fiber/GPON, or another access method; whether the ISP router is locked; whether the router supports OpenWrt, local `ubus`, SNMP, TR-064, or another documented LAN API; the WE plan and renewal date; and the PS5’s DHCP reservation, connection type, and NAT type. The assistant can then add a model-specific adapter and run read-only discovery first.

The first real-world test should last one controlled interval and compare the router’s WAN counter, the PS5’s device counter, and the My WE balance. Only after that baseline is stable should SQM be enabled at a reversible starting point near 90% of measured upload/download throughput, as recommended by OpenWrt’s documentation.[5] The result should be verified with idle and loaded latency tests before any further tuning.

## Bottom line

There is a credible, useful tool to build: a private network observability and optimization assistant that helps the household spend fewer bytes, preserve gaming responsiveness, detect background drains, and produce strong evidence when the ISP’s balance does not reconcile. There is no technically honest configuration that makes a metered ISP quota become unlimited without either consuming another paid allowance or attempting an unauthorized billing/FUP bypass. The best value currently visible in WE’s official offers is the PS add-on for traffic that truly qualifies as PS usage; the best local-network improvements are wired PS5 connectivity, scheduled downloads, careful background-update control, and SQM-based latency management.

## References

[1]: https://te.eg/en/personal/home/we-internet/we-space "Telecom Egypt — WE Space"
[2]: https://te.eg/en/about-te/faq/fixed-broadband "Telecom Egypt — Fixed Broadband FAQ"
[3]: https://te.eg/en/personal/home/we-internet/we-sonic "Telecom Egypt — WE Sonic"
[4]: https://www.playstation.com/en-us/support/error-codes/ps5/nw-102417-5/ "Sony PlayStation — PS5 Error Code NW-102417-5"
[5]: https://openwrt.org/docs/guide-user/network/traffic-shaping/sqm "OpenWrt — SQM (Smart Queue Management)"
[6]: https://openwrt.org/docs/techref/rpcd "OpenWrt — rpcd / ubus RPC daemon"
[7]: https://www.tra.gov.eg/en/%D8%A7%D9%84%D8%AC%D9%87%D8%A7%D8%B2-%D8%A7%D9%84%D9%82%D9%88%D9%85%D9%8A-%D9%84%D8%AA%D9%86%D8%B8%D9%8A%D9%85-%D8%A7%D9%84%D8%A7%D8%AA%D8%B5%D8%A7%D9%84%D8%A7%D8%AA-%D9%8A%D8%B5%D8%AF%D8%B1-%D8%AA/ "NTRA — 2024 Telecom Users Complaints Report"
[8]: Supplied PDF, *Beyond a Quota Scam: A Decade of Systemic Failure in Telecom Egypt’s Internet Services*, 28 pages, attached to this task.
