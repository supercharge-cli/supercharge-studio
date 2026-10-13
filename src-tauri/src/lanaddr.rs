//! Which local IPv4 addresses to advertise to phones. Shared by the desktop app and the server.
//! Only real LAN interfaces (Wi-Fi/Ethernet) are listed; container bridges, VM/VPN tunnels and
//! link-local addresses never are, because a phone can't reach them and they bloat the QR code.

use std::net::Ipv4Addr;

/// At most this many addresses go into a pairing code.
pub const MAX: usize = 3;

/// Interface names that are never the phone's network.
pub fn is_virtual(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const P: &[&str] = &[
        "docker", "br-", "bridge", "veth", "virbr", "vnet", "vmnet", "vboxnet", "tun", "tap", "wg", "utun", "zt", "tailscale",
        "cni", "flannel", "cali", "weave", "podman", "lxc", "lxd", "incus", "kube", "ppp", "ham", "gif", "stf", "awdl", "llw", "anpi", "ap1",
    ];
    P.iter().any(|p| n.starts_with(p)) || n.contains("virtual") || n.contains("vethernet") || n.contains("hyper-v") || n.contains("wsl") || n.contains("vpn")
}

/// Docker's default address pools (172.17.0.0/16 .. 172.31.0.0/16) on a gateway-style .1 address.
fn looks_docker(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 172 && (17..=31).contains(&o[1]) && o[3] == 1
}

/// Real LAN interface names (Linux wl*/en*/eth*, macOS en*, Windows "Wi-Fi"/"Ethernet").
fn is_lan_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["wl", "en", "eth", "wi-fi", "wifi", "wlan", "ethernet", "local area connection"].iter().any(|p| n.starts_with(p))
}

/// Pick the addresses to advertise, best first. `route` is the default-route source address.
pub fn pick(ifaces: &[(String, Ipv4Addr)], route: Option<Ipv4Addr>) -> Vec<String> {
    let ok = |name: &str, ip: &Ipv4Addr| {
        !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() && !is_virtual(name) && !(looks_docker(ip) && !is_lan_name(name))
    };
    let mut scored: Vec<(u8, Ipv4Addr)> = Vec::new();
    for (name, ip) in ifaces {
        if !ok(name, ip) {
            continue;
        }
        let score = if Some(*ip) == route { 0 } else if is_lan_name(name) && ip.is_private() { 1 } else if ip.is_private() { 2 } else { 3 };
        scored.push((score, *ip));
    }
    // The route address counts only if it belongs to a usable interface (it can be a VPN tunnel).
    if ifaces.is_empty() {
        if let Some(r) = route.filter(|r| !r.is_loopback() && !r.is_unspecified() && !r.is_link_local()) {
            scored.push((0, r));
        }
    }
    scored.sort_by_key(|(s, _)| *s);
    let mut out: Vec<String> = Vec::new();
    for (_, ip) in scored {
        let s = ip.to_string();
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out.truncate(MAX);
    out
}

pub fn route_ip() -> Option<Ipv4Addr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v) if !v.is_loopback() && !v.is_unspecified() => Some(v),
        _ => None,
    }
}

/// Addresses for this machine, falling back to loopback so there is always one.
pub fn lan_ips() -> Vec<String> {
    let ifs: Vec<(String, Ipv4Addr)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(v) => Some((i.name, v)),
            _ => None,
        })
        .collect();
    let mut v = pick(&ifs, route_ip());
    if v.is_empty() {
        v.push("127.0.0.1".into());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn fedora_with_docker_lists_only_wifi() {
        let ifs = vec![
            ("lo".to_string(), ip("127.0.0.1")),
            ("wlp2s0".into(), ip("192.168.1.54")),
            ("br-1a2b3c".into(), ip("172.20.0.1")),
            ("br-4d5e6f".into(), ip("172.19.0.1")),
            ("docker0".into(), ip("172.17.0.1")),
            ("br-777".into(), ip("172.18.0.1")),
            ("virbr0".into(), ip("192.168.122.1")),
            ("vethab12".into(), ip("169.254.3.4")),
            ("tun0".into(), ip("10.8.0.2")),
        ];
        assert_eq!(pick(&ifs, Some(ip("192.168.1.54"))), vec!["192.168.1.54"]);
        // Even if the default route went through the VPN, the tunnel is not advertised.
        assert_eq!(pick(&ifs, Some(ip("10.8.0.2"))), vec!["192.168.1.54"]);
    }

    #[test]
    fn unknown_bridge_names_in_docker_ranges_are_dropped_but_real_lans_kept() {
        let ifs = vec![("mybridge".to_string(), ip("172.21.0.1")), ("eth0".into(), ip("172.16.5.20")), ("enp3s0".into(), ip("10.0.0.7"))];
        assert_eq!(pick(&ifs, Some(ip("10.0.0.7"))), vec!["10.0.0.7", "172.16.5.20"]);
    }

    #[test]
    fn capped_and_windows_names() {
        let ifs = vec![
            ("Wi-Fi".to_string(), ip("192.168.0.10")),
            ("vEthernet (WSL)".into(), ip("172.29.64.1")),
            ("Ethernet".into(), ip("10.1.1.2")),
            ("Ethernet 2".into(), ip("10.1.2.2")),
            ("Ethernet 3".into(), ip("10.1.3.2")),
        ];
        let v = pick(&ifs, Some(ip("192.168.0.10")));
        assert_eq!(v.len(), MAX);
        assert_eq!(v[0], "192.168.0.10");
        assert!(!v.iter().any(|s| s.starts_with("172.29")));
    }
}
