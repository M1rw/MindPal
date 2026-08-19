#pragma once

#include <algorithm>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace netassist {

struct DeviceSnapshot {
    std::string device;
    std::string category;
    std::uint64_t rx_bytes{};
    std::uint64_t tx_bytes{};
    bool ps5{};
};

struct UsageDelta {
    std::string device;
    std::string category;
    std::uint64_t rx_bytes{};
    std::uint64_t tx_bytes{};
    std::uint64_t total_bytes{};
    bool ps5{};
};

inline std::uint64_t non_wrapping_delta(std::uint64_t before, std::uint64_t after) {
    // A counter reset or wrap is treated as unknown rather than negative usage.
    if (after < before) return 0;
    return after - before;
}

inline UsageDelta delta(const DeviceSnapshot& before, const DeviceSnapshot& after) {
    if (before.device != after.device) throw std::invalid_argument("device mismatch");
    UsageDelta out;
    out.device = after.device;
    out.category = after.category;
    out.rx_bytes = non_wrapping_delta(before.rx_bytes, after.rx_bytes);
    out.tx_bytes = non_wrapping_delta(before.tx_bytes, after.tx_bytes);
    out.total_bytes = out.rx_bytes + out.tx_bytes;
    out.ps5 = after.ps5;
    return out;
}

inline double bytes_to_gib(std::uint64_t bytes) {
    return static_cast<double>(bytes) / (1024.0 * 1024.0 * 1024.0);
}

struct SqmRecommendation {
    double download_mbps{};
    double upload_mbps{};
    double latency_delta_ms{};
    bool enable{};
    std::string reason;
};

inline SqmRecommendation recommend_sqm(double measured_down_mbps,
                                       double measured_up_mbps,
                                       double idle_latency_ms,
                                       double loaded_latency_ms) {
    if (measured_down_mbps <= 0 || measured_up_mbps <= 0 || idle_latency_ms < 0 || loaded_latency_ms < 0) {
        throw std::invalid_argument("measurements must be positive and non-negative where applicable");
    }
    SqmRecommendation out;
    out.latency_delta_ms = std::max(0.0, loaded_latency_ms - idle_latency_ms);
    out.enable = out.latency_delta_ms >= 10.0;
    out.download_mbps = measured_down_mbps * 0.90;
    out.upload_mbps = measured_up_mbps * 0.90;
    if (out.enable) {
        out.reason = "loaded latency is at least 10 ms above idle; propose reversible SQM at 90% of measured rates";
    } else {
        out.reason = "loaded latency delta is below 10 ms; keep SQM in dry-run unless other evidence appears";
    }
    return out;
}

struct PriceResult {
    double price_ex_vat{};
    double price_inc_vat{};
    double egp_per_gb_ex_vat{};
    double egp_per_gb_inc_vat{};
};

inline PriceResult price_per_gb(double price_ex_vat, double quota_gb, double vat = 0.14) {
    if (price_ex_vat < 0 || quota_gb <= 0 || vat < 0) throw std::invalid_argument("invalid plan values");
    PriceResult out;
    out.price_ex_vat = price_ex_vat;
    out.price_inc_vat = price_ex_vat * (1.0 + vat);
    out.egp_per_gb_ex_vat = price_ex_vat / quota_gb;
    out.egp_per_gb_inc_vat = out.price_inc_vat / quota_gb;
    return out;
}

enum class TrafficClass { Realtime, Bulk, General, Management };

struct WanPath {
    std::string name;
    bool healthy{};
    bool satellite{};
    double latency_ms{};
    double loss_percent{};
    double estimated_cost_per_gb{};
    double quota_remaining_gb{};
};

struct RouteDecision {
    std::string wan;
    bool allowed{};
    std::string reason;
};

inline double health_score(const WanPath& path, TrafficClass traffic) {
    double score = path.latency_ms + (path.loss_percent * 20.0);
    if (traffic == TrafficClass::Realtime && path.satellite) score += 25.0;
    if (traffic == TrafficClass::Bulk) score += path.estimated_cost_per_gb * 10.0;
    return score;
}

inline RouteDecision choose_route(const std::vector<WanPath>& paths,
                                  TrafficClass traffic,
                                  bool allow_satellite_bulk = true) {
    const WanPath* best = nullptr;
    for (const auto& path : paths) {
        if (!path.healthy) continue;
        if (path.quota_remaining_gb <= 0.0) continue;
        if (traffic == TrafficClass::Bulk && path.satellite && !allow_satellite_bulk) continue;
        if (!best || health_score(path, traffic) < health_score(*best, traffic)) best = &path;
    }
    if (!best) return {"", false, "no healthy eligible WAN with remaining allowance"};
    std::string reason = "selected by latency/loss";
    if (traffic == TrafficClass::Bulk) reason = "selected by cost-aware bulk-transfer score";
    if (best->satellite) reason += "; satellite allowed by policy";
    return {best->name, true, reason};
}

inline bool should_failover(bool primary_healthy, int consecutive_failures, int threshold = 3) {
    if (threshold < 1) throw std::invalid_argument("failover threshold must be positive");
    return !primary_healthy && consecutive_failures >= threshold;
}

inline std::string safe_policy_summary() {
    return "read-only discovery; dry-run recommendations; owner approval for each change; local-only binding; append-only audit log; no quota or billing evasion";
}

inline std::string format_double(double value) {
    std::ostringstream out;
    out << std::fixed << std::setprecision(3) << value;
    return out.str();
}

} // namespace netassist
