#include "../src/core.hpp"

#include <cassert>
#include <cmath>
#include <iostream>

int main() {
    using namespace netassist;

    DeviceSnapshot before{"ps5", "console", 1000, 2000, true};
    DeviceSnapshot after{"ps5", "console", 5000, 7000, true};
    auto d = delta(before, after);
    assert(d.rx_bytes == 4000);
    assert(d.tx_bytes == 5000);
    assert(d.total_bytes == 9000);
    assert(d.ps5);

    DeviceSnapshot reset{"ps5", "console", 100, 100, true};
    auto r = delta(after, reset);
    assert(r.total_bytes == 0);

    auto sqm = recommend_sqm(100.0, 20.0, 10.0, 40.0);
    assert(sqm.enable);
    assert(std::abs(sqm.download_mbps - 90.0) < 1e-9);
    assert(std::abs(sqm.upload_mbps - 18.0) < 1e-9);

    auto no_sqm = recommend_sqm(100.0, 20.0, 10.0, 15.0);
    assert(!no_sqm.enable);

    auto price = price_per_gb(120.0, 150.0);
    assert(std::abs(price.price_inc_vat - 136.8) < 1e-9);
    assert(std::abs(price.egp_per_gb_inc_vat - 0.912) < 1e-9);

    assert(safe_policy_summary().find("no quota or billing evasion") != std::string::npos);
    std::cout << "all core tests passed\n";
    return 0;
}
