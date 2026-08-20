# Advanced Home Network Platform: Terrestrial, Multi-WAN, AI, and Satellite Integration

**Author:** Manus AI  
**Date:** 20 August 2026  
**Repository:** `M1rw/MindPal`  
**Prototype commit:** `3cd1c1f` plus the current WAN-routing extension

## Executive summary

The most advanced practical system is not a “free internet” box. It is a **local intelligent gateway** that measures every WAN, protects the household from background waste, keeps gaming responsive, detects quota/accounting inconsistencies, and fails over to an independently subscribed 4G/5G or satellite connection when policy allows. A satellite link can be integrated as a normal WAN after an authorized terminal and service are installed; it cannot be activated, borrowed, or made unlimited by software.

Egypt’s NTRA states that it is the authority for telecom licensing, permits, and spectrum, and describes permits for satellite operators whose networks provide capacity to licensed satellite communications companies using VSAT in Egypt.[1] Eutelsat describes GEO and OneWeb LEO as complementary connectivity options: GEO offers wide-area/high-throughput coverage, while LEO is intended to reduce latency for real-time applications.[2] Starlink’s official support material describes third-party-router integration through its supported Ethernet/bypass workflow, but availability is address-specific and must be verified with the provider and local authorities.[3]

## 1. Complete capability map

| Capability | What the finished platform can do | What it cannot do |
|---|---|---|
| Router administration | Read status, leases, WAN counters, firewall state, DHCP reservations, SQM state, and approved configuration; apply reversible changes after approval | Access a router without authorization, expose router management publicly, or defeat ISP credentials |
| Quota evidence | Compare router WAN bytes, device bytes, application estimates, reset times, and provider-displayed balance | Change the ISP’s meter or prove fraud from one unexplained screenshot |
| AI optimization | Explain anomalies, classify likely causes, propose a ranked policy, estimate trade-offs, and generate a rollback plan | Have unrestricted write authority or invent certainty when counters disagree |
| QoS and gaming | Use wired PS5 preference, SQM/CAKE, device priority, congestion tests, NAT diagnostics, and download scheduling | Make a high-latency link behave like fiber or make PSN traffic universally quota-free |
| Multi-WAN | Use WE, 4G/5G, and an authorized satellite WAN with health checks, policy routing, and failover | Combine providers to evade billing or guarantee bandwidth aggregation for every flow |
| Satellite | Accept Ethernet handoff from an authorized GEO/LEO/VSAT terminal, monitor it, and route selected traffic over it | Turn a dish, GPS receiver, or satellite signal into internet without provider service, authorization, and terminal hardware |
| Privacy and security | Keep telemetry local, segment IoT/guest/PS5/work networks, log changes, and use least privilege | Hide malicious traffic or provide anonymous access to other people’s networks |

## 2. Physical architecture

```text
                    ┌──────────────────────────────┐
WE DSL/fiber/GPON ──┤ WAN1                         │
4G/5G CPE ──────────┤ WAN2   Hardened AI Gateway   ├── Managed switch ── APs
Authorized satellite┤ WAN3   OpenWrt/Linux         │                    ├─ PS5 VLAN
terminal ───────────┤        SQM + firewall + PBR   │                    ├─ Work VLAN
                    └──────────────────────────────┘                    ├─ IoT VLAN
                                                                         └─ Guest VLAN
```

The gateway should be a small x86 appliance or capable router with at least two Ethernet WAN inputs and enough CPU for SQM, firewalling, metrics, and optional encrypted tunnels. A managed switch and separate access points make VLAN segmentation easier than relying on an ISP router’s limited firmware. A UPS is important because a satellite terminal, ONT, modem, and gateway must restart coherently after a power event. Roof hardware also needs proper mounting, grounding, surge protection, and an unobstructed view appropriate to the chosen provider.

The satellite terminal should enter through Ethernet or the provider’s documented handoff. The gateway then treats satellite as WAN3. If the provider’s router supports an official third-party-router or bypass mode, that mode may be used only as documented by the provider; it is not the same as bypassing billing or access controls.[3]

## 3. WAN options for an Egyptian home

| Link | Best role | Latency and quality expectation | Quota/cost behavior | Readiness |
|---|---|---|---|---|
| WE fixed broadband | Primary gaming and ordinary traffic | Usually preferred when line quality is good | Subject to plan quota and throttling/FUP | Existing primary if available |
| 4G/5G CPE | Fast backup and emergency browsing | Variable by radio load and signal | Separate mobile plan and possible CGNAT | Hardware and SIM required |
| Licensed GEO VSAT | Remote-site resilience and bulk/essential access | Higher propagation delay; weather sensitivity | Provider-specific allowance, contract, and installation | Must use authorized Egyptian service/reseller |
| Licensed LEO | Lower-latency independent path where available | Better latency than GEO but obstruction/power dependent | Provider and country availability; plan-specific rules | Verify address, licensing, and terminal |
| Dual-WAN without bonding | High availability | Preserves session stability | Does not combine allowances | Recommended first step |
| Packet-level bonding | Specialized use with multiple endpoints | Complex, may add overhead and failure modes | Needs a lawful bonding service and multiple paid links | Optional advanced phase, not required |

The correct default is **failover**, not packet-level bonding. Existing TCP/UDP sessions should remain pinned to a single WAN; otherwise source-address changes, reordering, and NAT state changes can break PS5 sessions, calls, and logins. Bonding can be considered later only if the household has a lawful provider that supports it and the cost/latency trade-off is acceptable.

The NTRA framework is the decisive constraint in Egypt: satellite service must be delivered through the licensing and permit structure, not through a software configuration.[1] Eutelsat’s public description confirms that GEO and LEO are service architectures rather than generic open networks; the terminal, provider, and support arrangement remain part of the product.[2]

## 4. Routing policy engine

The gateway should classify traffic into real-time, bulk, general, management, and restricted categories. The policy engine then scores healthy WANs using measured latency, loss, cost per GB, remaining paid allowance, and user preferences.

| Class | Default policy | Satellite behavior |
|---|---|---|
| PS5 gameplay and party chat | Lowest latency/loss path, normally WE; SQM reserves upload capacity | Use only after terrestrial quality fails or the user explicitly allows it |
| Downloads, patches, and backups | Cost-aware path with a schedule and rate limit | Suitable if the satellite plan allows the volume and delay is acceptable |
| Browsing and education | Primary WE; fail over when unavailable | Allowed under budget and provider policy |
| Work calls and remote access | Lowest loss/jitter path; pin sessions | Satellite only if the measured link is stable enough |
| IoT | Restricted egress and low priority | Failover only for essential telemetry |
| Guest traffic | Separate VLAN and lower priority | Never allow it to consume the emergency/failover budget without a rule |

The prototype now includes a deterministic route simulator. It models WE, 4G/5G, and SATELLITE as separate WANs, accounts for latency/loss/cost/remaining allowance, penalizes satellite for real-time traffic, and can block satellite for bulk traffic. This is a simulation, not a claim about actual provider performance.

## 5. AI control model

The reliable design is hybrid. Deterministic code performs health checks, hysteresis, counter deltas, rate limiting, state pinning, backup, rollback, and threshold decisions. AI is used for explanations and planning: it can say that a 21-GB spike coincides with a console update, compare alternative policies, summarize a week of measurements, and prepare an evidence report.

Every AI recommendation should be a structured object containing the observation, confidence, proposed change, expected benefit, risk, required approval, backup identifier, and rollback action. The AI must never receive the router’s master password and must not directly execute changes. The implementation can use a local rules-only mode or an optional remote model. If remote analysis is enabled, the current model catalog must be checked at deployment time; the built-in guidance identifies `gpt-5-mini` as a cost-efficient option for routine classification and summarization, but model IDs and prices can change.[4]

## 6. Quota and provider-classification subsystem

The platform must keep four ledgers: the gateway’s WAN counter, per-device counters, application-class estimates, and the provider’s displayed balance. Each record must include a timestamp, reset-boundary information, counter source, and confidence. A provider “unlimited” or dedicated bundle must be treated as **classification-dependent**, not as a universal route.

The controlled test protocol is simple. Freeze other household activity, record My WE and router counters, run one activity for a short fixed interval, record the counters again, and repeat separately for PS5 gameplay, a PS5 update, a listed streaming service, a listed music or conference service, an educational/government website, and ordinary browsing. Results should be labelled `dedicated`, `main`, `mixed`, or `unresolved`. The system must not test by redirecting traffic through unowned sources, changing identity, tunnelling around accounting, or exploiting an apparent billing exception.

## 7. Security and trust boundaries

The gateway must be LAN-only by default. The dashboard may be reached remotely only through a private authenticated tunnel under the owner’s control. Router management, satellite management, modem management, and switch management should be isolated from guest and IoT VLANs. The production system should have read-only credentials for monitoring and a separate approval path for changes. Before modifying routing or SQM, it should take a configuration backup, show a diff, apply one change, run health tests, and automatically roll back if the gateway loses reachability or the measured result degrades.

The platform should also support signed configuration bundles, encrypted local backups, log rotation, two-person approval for disruptive changes, and a “safe mode” that restores primary WAN access when policy logic fails. These controls matter more than adding another AI model.

## 8. Deployment choices

| Approach | Trade-offs | Cost | Setup complexity |
|---|---|---:|---:|
| Local gateway appliance | Best privacy and direct router/satellite control; requires hardware, power, and maintenance | Existing hardware or one-time appliance cost | Medium–high |
| Existing router plus read-only monitor | Lowest risk and fastest proof of quota discrepancies; cannot enforce policies if the router lacks APIs | Usually free | Low |
| Local gateway plus optional remote dashboard | Strong local control with convenient reporting; requires secure connector design and optional hosting | Variable; hosting/integration may add recurring cost | High |
| Remote persistent server only | Good for dashboards, not ideal for LAN-level WAN control; requires a secure local connector and can add latency/privacy exposure | Paid if using a persistent server; WebDev is a managed alternative for a dashboard | High |

The recommended route is a local gateway appliance with an optional dashboard. A remote dashboard should receive aggregate metrics and recommendations, not raw browsing history or router credentials.

## 9. Prototype delivered and tests

The existing `M1rw/MindPal/network_assistant` prototype now contains provider-neutral WAN structures, deterministic traffic classes, satellite-policy gating, cost-aware route selection, and failover hysteresis. The CLI includes:

```text
netassist usage <before.csv> <after.csv>
netassist sqm <down_mbps> <up_mbps> <idle_latency_ms> <loaded_latency_ms>
netassist plan-cost <price_ex_vat_egp> <quota_gb>
netassist route <realtime|bulk|general|management> <allow_satellite_bulk:0|1>
```

The project compiled with GCC 13.3 and CMake 3.28.3. The unit suite passed **1/1 tests**. The tests cover byte-counter deltas, counter resets, SQM logic, VAT arithmetic, real-time route preference, cost-aware bulk selection, satellite-policy blocking, and failover hysteresis. The route simulator selected WE for the example real-time and bulk policies while it was healthy; the unit tests verified fallback to 4G/5G when WE was marked unhealthy and verified that satellite could be blocked for bulk traffic.

This remains a safe prototype. It does not discover the user’s router, create a satellite subscription, control a dish, or apply firewall/routing changes. Those steps require the exact hardware and authorized credentials.

## 10. Implementation roadmap

**Stage 1 — Evidence mode.** Add router adapters for the exact model, collect counters, reserve the PS5 address, and run the controlled reconciliation tests. No write access is enabled.

**Stage 2 — Local optimization.** Add SQM, device priorities, DNS caching/blocking, background-update schedules, VLANs, and automatic configuration backups. Each change is approved and reversible.

**Stage 3 — Multi-WAN.** Add WE plus 4G/5G health checks and stateful failover. Measure recovery time, route stability, NAT behavior, and PS5 session impact.

**Stage 4 — Satellite integration.** After confirming an authorized local service, connect the terminal’s documented Ethernet handoff as WAN3. Measure obstruction, latency, jitter, weather impact, power consumption, provider caps, and fair-use rules. Start with emergency or bulk traffic rather than PS5 gameplay.

**Stage 5 — AI operations.** Add local summaries, anomaly explanations, approval workflows, and weekly evidence reports. Keep the deterministic safety controller authoritative.

**Stage 6 — Optional bonding.** Consider lawful multi-link bonding only if the user has two or more independent paid links, a provider-supported bonding endpoint, and a clear budget. Test whether the improvement justifies added overhead and complexity.

## Final boundary

The finished system can be extremely capable: it can control an owner-authorized router, coordinate multiple paid WANs, optimize PS5 and work traffic, use a licensed satellite connection as a failover path, and explain exactly where the household’s bytes went. It cannot lawfully turn another party’s unlimited source into the household’s internet, evade WE billing/FUP, or make satellite connectivity appear without an authorized terminal and service.

## References

[1]: https://www.tra.gov.eg/en/the-satellite-operator-regulatory-framework/ "NTRA — The Satellite Operator Regulatory Framework"
[2]: https://www.eutelsat.com/satellite-services/tv-internet-home/satellite-internet-home-business-konnect "Eutelsat — High-Speed Satellite Internet for Home & Business"
[3]: https://starlink.com/support/article/a206a55c-0597-2d06-1408-dea7dcf24221 "Starlink — Can I add a third-party router or mesh system?"
[4]: https://openai.com/ "Built-in AI integration must use the live model catalog and current deployment configuration."
[5]: https://openwrt.org/docs/guide-user/network/traffic-shaping/sqm "OpenWrt — SQM"
[6]: https://openwrt.org/docs/guide-user/network/wan/multiwan/mwan3 "OpenWrt — mwan3 multi-WAN"
