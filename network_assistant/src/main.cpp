#include "core.hpp"

#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using netassist::DeviceSnapshot;

static std::vector<std::string> split_csv(const std::string& line) {
    std::vector<std::string> fields;
    std::stringstream stream(line);
    std::string field;
    while (std::getline(stream, field, ',')) fields.push_back(field);
    return fields;
}

static bool parse_bool(const std::string& value) {
    return value == "1" || value == "true" || value == "yes" || value == "y";
}

static std::vector<DeviceSnapshot> read_snapshot(const std::string& path) {
    std::ifstream file(path);
    if (!file) throw std::runtime_error("cannot open snapshot: " + path);
    std::string line;
    if (!std::getline(file, line)) throw std::runtime_error("snapshot is empty: " + path);
    std::vector<DeviceSnapshot> rows;
    while (std::getline(file, line)) {
        if (line.empty()) continue;
        auto fields = split_csv(line);
        if (fields.size() < 5) throw std::runtime_error("expected 5 CSV fields: device,category,rx_bytes,tx_bytes,ps5");
        DeviceSnapshot row;
        row.device = fields[0];
        row.category = fields[1];
        row.rx_bytes = std::stoull(fields[2]);
        row.tx_bytes = std::stoull(fields[3]);
        row.ps5 = parse_bool(fields[4]);
        rows.push_back(row);
    }
    return rows;
}

static void usage_report(const std::string& before_path, const std::string& after_path) {
    auto before = read_snapshot(before_path);
    auto after = read_snapshot(after_path);
    std::map<std::string, DeviceSnapshot> prior;
    for (const auto& row : before) prior[row.device] = row;
    std::uint64_t total = 0;
    std::uint64_t ps5_total = 0;
    std::cout << "device,category,rx_delta_bytes,tx_delta_bytes,total_delta_bytes,total_delta_GiB,ps5\n";
    for (const auto& row : after) {
        auto it = prior.find(row.device);
        if (it == prior.end()) continue;
        auto d = netassist::delta(it->second, row);
        total += d.total_bytes;
        if (d.ps5) ps5_total += d.total_bytes;
        std::cout << d.device << ',' << d.category << ',' << d.rx_bytes << ',' << d.tx_bytes << ','
                  << d.total_bytes << ',' << netassist::format_double(netassist::bytes_to_gib(d.total_bytes))
                  << ',' << (d.ps5 ? "true" : "false") << '\n';
    }
    std::cerr << "total_delta_GiB=" << netassist::format_double(netassist::bytes_to_gib(total)) << '\n';
    std::cerr << "ps5_delta_GiB=" << netassist::format_double(netassist::bytes_to_gib(ps5_total)) << '\n';
    std::cerr << "policy=" << netassist::safe_policy_summary() << '\n';
}

static void sqm_report(double down, double up, double idle, double loaded) {
    auto r = netassist::recommend_sqm(down, up, idle, loaded);
    std::cout << "enable_sqm=" << (r.enable ? "true" : "false") << '\n'
              << "proposed_download_mbps=" << netassist::format_double(r.download_mbps) << '\n'
              << "proposed_upload_mbps=" << netassist::format_double(r.upload_mbps) << '\n'
              << "loaded_minus_idle_ms=" << netassist::format_double(r.latency_delta_ms) << '\n'
              << "reason=" << r.reason << '\n'
              << "mode=dry-run\n";
}

static void plan_report(double price, double quota) {
    auto p = netassist::price_per_gb(price, quota);
    std::cout << "price_ex_vat_egp=" << netassist::format_double(p.price_ex_vat) << '\n'
              << "price_inc_vat_egp=" << netassist::format_double(p.price_inc_vat) << '\n'
              << "quota_gb=" << netassist::format_double(quota) << '\n'
              << "egp_per_gb_ex_vat=" << netassist::format_double(p.egp_per_gb_ex_vat) << '\n'
              << "egp_per_gb_inc_vat=" << netassist::format_double(p.egp_per_gb_inc_vat) << '\n';
}

static void help() {
    std::cout << "MindPal Network Assistant safe prototype\n"
              << "Commands:\n"
              << "  usage <before.csv> <after.csv>\n"
              << "  sqm <down_mbps> <up_mbps> <idle_latency_ms> <loaded_latency_ms>\n"
              << "  plan-cost <price_ex_vat_egp> <quota_gb>\n"
              << "\nCSV header: device,category,rx_bytes,tx_bytes,ps5\n"
              << "All router writes are intentionally absent; this build is read-only/dry-run.\n";
}

int main(int argc, char** argv) {
    try {
        if (argc < 2) { help(); return 0; }
        std::string command = argv[1];
        if (command == "usage" && argc == 4) usage_report(argv[2], argv[3]);
        else if (command == "sqm" && argc == 6) sqm_report(std::stod(argv[2]), std::stod(argv[3]), std::stod(argv[4]), std::stod(argv[5]));
        else if (command == "plan-cost" && argc == 4) plan_report(std::stod(argv[2]), std::stod(argv[3]));
        else { help(); return 2; }
    } catch (const std::exception& ex) {
        std::cerr << "error: " << ex.what() << '\n';
        return 1;
    }
    return 0;
}
