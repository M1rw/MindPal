# Advanced Home Network Platform Map

## Objective

Build a local-first gateway that can observe and optimize a household network across WE fixed broadband, 4G/5G backup, and a **lawfully subscribed satellite WAN**. The gateway should make routing decisions based on latency, loss, congestion, remaining paid allowance, service classification, and application importance. It must never alter ISP accounting, use unauthorized satellite terminals, extract provider credentials, or route traffic through another party’s “unlimited” endpoint.

## Connectivity layers

| Link | How it enters the gateway | Strengths | Limits and risks |
|---|---|---|---|
| WE DSL/fiber/GPON | Ethernet WAN or provider modem/ONT | Usually lowest latency and best PS5 experience | Quota/FUP, provider throttling, possible CGNAT, line faults |
| 4G/5G backup | USB modem, tethered phone, or Ethernet CPE | Independent last-mile path and rapid failover | Mobile data cost/cap, radio congestion, CGNAT, indoor signal variation |
| Licensed GEO VSAT | Authorized terminal and licensed local service/reseller | Coverage where terrestrial service is unavailable; wide-area resilience | Higher latency, weather fade, installation/spectrum rules, provider quota and contract |
| Licensed LEO service | Authorized terminal and provider service where available | Lower latency than GEO, mobility options, independent path | Address/service availability, sky view, power, obstruction, provider policy, local authorization |
| Local mesh/Wi-Fi | LAN/AP fabric behind gateway | Coverage and device segmentation | Does not add WAN capacity; poor RF creates “internet” symptoms |

Egypt’s NTRA states that it is the authority for telecom licenses, permits, and spectrum, and describes permits for satellite operators whose networks provide capacity to licensed satellite communication companies using VSAT in Egypt.[1] A satellite terminal is therefore a **service and regulatory integration**, not a software switch.

Eutelsat describes GEO and OneWeb LEO as complementary: GEO provides wide-area/high-throughput coverage, while LEO is designed for lower latency and real-time applications.[2] Starlink’s public support material describes a third-party-router handoff through Ethernet/bypass mode on supported equipment, but address-level availability must be checked with the provider and local authorization must be confirmed.[3]

## Gateway data plane

The recommended physical topology is:

```text
WE modem/ONT ─────── WAN1 ┐
4G/5G CPE ─────────── WAN2 ├─> hardened gateway ──> managed switch/APs ──> home devices
Licensed satellite terminal ─ WAN3 ┘             ├─> PS5 / gaming VLAN
                                                ├─> work/learning VLAN
                                                ├─> IoT VLAN
                                                └─> guest VLAN
```

The gateway should use OpenWrt or another auditable Linux router platform with separate WAN interfaces, firewall zones, DHCP reservations, VLANs, SQM/CAKE, policy-based routing, and an append-only local metrics store. OpenWrt’s SQM model is appropriate for controlling bufferbloat and prioritization; its documented multi-WAN tools are appropriate for link health and failover, subject to hardware capacity and careful session pinning.[4] [5]

## Routing policy engine

The controller should make decisions at flow or connection boundaries, not packet-by-packet across links. A TCP session or UDP flow should remain pinned to one WAN until it ends. Otherwise, reordering and changing source addresses can break games, video calls, logins, and downloads.

| Traffic class | Default route policy | Satellite policy |
|---|---|---|
| PS5 gameplay, voice, work calls | Lowest latency and loss among healthy links; reserve upload capacity with SQM | Use only when terrestrial quality is below threshold or the user explicitly allows the cost |
| Large downloads and updates | Link with sufficient remaining paid allowance and acceptable cost; schedule off-peak | Good failover candidate if the satellite plan permits the volume and latency is irrelevant |
| Browsing and learning | Primary WE while healthy; fallback to 4G/5G or satellite | Allowed if budget and service policy permit |
| IoT telemetry | Restricted egress, low priority, preferably primary WAN | Failover only for essential devices |
| Backups and cloud sync | Scheduled, rate-limited, and optionally routed over the least expensive dedicated allowance | Never allow unbounded backup traffic to consume satellite quota |
| Emergency management | Any healthy link with secure tunnel to the owner | Must be authenticated and provider-compliant |

## AI layer

The AI should be an advisor and planner, not an unrestricted router administrator. Deterministic code should handle health checks, counter deltas, hysteresis, rate limits, and rollback. An optional model can summarize evidence, classify symptoms, explain a proposed change, and rank competing policies. The model must return a strict schema containing: observed evidence, confidence, proposed action, expected benefit, risk, rollback, and approval requirement. It must not receive router passwords or have direct write authority.

For local/private analysis, use rules and small local models first. For optional remote analysis, the current built-in model guidance recommends a cost-efficient workhorse such as `gpt-5-mini` for classification and summarization, but the live model catalog must be checked before production use.[6] A fully offline rule engine remains the fallback if the household does not want telemetry to leave the gateway.

## Quota and accounting evidence

The gateway must maintain separate ledgers for WAN bytes, device bytes, application-class estimates, and provider-displayed balances. It should record reset times and counter confidence. It should never claim that a classified or “unlimited” service is universal: provider classification can vary by app function, CDN, account, destination, and current plan terms.

The strongest test is a controlled interval with only one device active. Record the provider balance, router WAN counter, and device counter before and after one activity. Repeat for PS5 gameplay, a PS5 update, a listed streaming service, a listed education/government destination, and ordinary browsing. Label each outcome as `dedicated`, `main`, `mixed`, or `unresolved`.

## Security model

The gateway should expose its dashboard only on the LAN or through a user-controlled private tunnel. It should use separate read-only and write-capable credentials, require a configuration backup before changes, display a diff, require explicit approval for disruptive changes, and keep a rollback command. Satellite and modem management interfaces must not be reachable from guest or IoT VLANs. Firmware updates should be verified and scheduled.

## Deployment choices

| Approach | Tradeoffs | Cost | Setup complexity |
|---|---|---:|---:|
| Local mini-PC or router appliance running the gateway | Maximum privacy and control; handles custom WAN drivers, VLANs, satellite handoff, and local metrics; requires hardware to stay on | Existing hardware: no recurring software cost | Medium–high |
| Existing router plus read-only monitor | Lowest risk and cost; can prove quota discrepancies and optimize advice; cannot reliably enforce policies if router lacks APIs | Usually free | Low |
| Managed dashboard with local connector | Easier remote reports and UI; requires careful secret handling and an always-on local connector | Variable; hosting/integration costs possible | Medium |

The strongest design is a local gateway with an optional dashboard. A remote dashboard should see aggregates and recommendations, not WAN credentials or raw household browsing history.

## What the platform cannot do

It cannot create ISP allowance, make metered bytes disappear, use another subscriber’s “unlimited” source, bypass FUP/billing classification, turn an unlicensed dish into an internet service, or guarantee satellite service in Egypt where the provider and regulator have not authorized it. It can provide resilience, efficiency, and evidence.

## References

[1]: https://www.tra.gov.eg/en/the-satellite-operator-regulatory-framework/ "NTRA — The Satellite Operator Regulatory Framework"
[2]: https://www.eutelsat.com/satellite-services/tv-internet-home/satellite-internet-home-business-konnect "Eutelsat — High-Speed Satellite Internet for Home & Business"
[3]: https://starlink.com/support/article/a206a55c-0597-2d06-1408-dea7dcf24221 "Starlink — Can I add a third-party router or mesh system?"
[4]: https://openwrt.org/docs/guide-user/network/traffic-shaping/sqm "OpenWrt — SQM"
[5]: https://openwrt.org/docs/guide-user/network/wan/multiwan/mwan3 "OpenWrt — mwan3 multi-WAN"
[6]: https://www.openai.com/ "Model catalog and AI integration must be verified at deployment time; use the current built-in model reference rather than hard-coding a stale model list."
