# Phase 5 networking modules (spec for parallel implementers)

Written 2026-11-08 by the Bridge/API Engineer.

**What this is:** three **standalone** modules in the `aionui-mobile` crate. Each is a new file plus one `pub mod` line
in `lib.rs`; don't edit any other bridge file. I wire them into `service.rs`/`listener.rs` myself.

**Contract:** `docs/mobile-bridge/CONTRACT.md` §2 (the listener and the private-peer filter) and §7 (port, QR URLs,
mDNS).

**Where to work** (as for phase 4):
- Branch from `aiondx-dev` at **`fcb48848`** in your own worktree:
  ```
  git -C "<AionDX-impl>\upstream-aioncore" worktree add -b phase5-<module> "<AionDX-impl>\work-p5<x>" fcb48848
  ```
- Use your own `CARGO_TARGET_DIR` (`%LOCALAPPDATA%\aiondx-build\dev-target-p5<x>`) and
  `%USERPROFILE%\.cargo\bin\cargo.exe`.
- Format with `rustfmt --edition 2024`.
- Commit with `-c user.name/-c user.email`, then send the hash to the lead.
- **If you add a crate dependency, say which and why in your commit message.** A crates.io download is fine; a
  system install is not.
- **Approval gates apply:**
  - never create a firewall rule on this PC;
  - never bind a real LAN port in tests (use `127.0.0.1` / `::1` and port `0`);
  - never send real multicast from a test (use a loopback-only or injectable socket, or `#[ignore]` the one live test).

## A. `netinfo.rs`: local addresses for the pairing QR (§7)

Today `service.rs` puts only the primary address into the QR (`primary_lan_ip()`, a UDP route probe). Replace that
with real interface enumeration.

```rust
pub struct LocalAddress { pub ip: std::net::IpAddr, pub interface: String }

/// Every UP, non-loopback address on this PC that `peer_filter::is_private_peer` accepts. Order: RFC 1918 IPv4
/// first (Ethernet before Wi-Fi when the OS says which is which), then 100.64/10 (Tailscale), then link-local
/// IPv4, then IPv6 ULA, then IPv6 link-local. Duplicates removed.
pub fn private_addresses() -> Vec<LocalAddress>;

/// The QR's `u=` list for `port`: one URL per address; IPv6 bracketed, with the zone id for link-local
/// (`http://[fe80::1%25eth0]:47734`, the `%` percent-encoded as `%25`).
pub fn pairing_urls(addresses: &[LocalAddress], port: u16) -> Vec<String>;
```

- **Windows:** `GetAdaptersAddresses` (windows-sys feature `Win32_NetworkManagement_IpHelper`). Skip adapters whose
  `OperStatus` isn't up, and the loopback adapter.
- **Other platforms:** an empty list is acceptable (AionDX ships on Windows only), or the `if-addrs` crate if you
  prefer.
- **Tests:** `pairing_urls` formatting (v4, v6, link-local zone, dedupe, ordering) is pure; test it fully.
  `private_addresses()` gets one smoke test: it doesn't panic, and everything it returns passes
  `is_private_peer`.

## B. `mdns.rs`: `_aiondx._tcp` advertiser (§7)

```rust
pub struct MdnsAdvertiser { /* private */ }
impl MdnsAdvertiser {
    /// Advertises `AionDX-<first 4 hex of SHA-256(hostId)>._aiondx._tcp.local` on `port` with TXT
    /// `v=1` and `hid=<first 8 base64url chars of SHA-256(hostId)>`. Must never fail AionCore: errors are returned,
    /// and the caller logs them.
    pub fn start(host_id: &str, port: u16) -> Result<MdnsAdvertiser, String>;
    pub fn stop(self);   // sends goodbye packets where the library supports it
}
pub fn instance_name(host_id: &str) -> String;   // pure, testable
pub fn txt_records(host_id: &str) -> Vec<(String, String)>;   // pure, testable
```

- The `mdns-sd` crate is the expected choice; name it in the commit.
- **Advertise only on the private interfaces from module A.** If the library can't restrict interfaces, say so in the
  commit, and I'll decide whether that's acceptable.
- No other data goes in the TXT record: no host name and no user name. The phone matches on `hid` only.
- **Tests:** the pure functions; and start/stop without panicking, behind `#[ignore]` if it needs real multicast.

## C. `firewall.rs`: the Private-profile Windows Firewall rule (§2), as code only

**Do not run the add/remove commands on this PC.** That's an approval gate.

```rust
pub const RULE_NAME: &str = "AionDX mobile bridge";
pub struct FirewallPlan { pub program: String, pub args: Vec<String> }   // what would be executed

/// `netsh advfirewall firewall add rule name="AionDX mobile bridge" dir=in action=allow protocol=TCP
///  localport=<port> profile=private program="<exe>" enable=yes`
pub fn add_rule_plan(exe_path: &std::path::Path, port: u16) -> FirewallPlan;
pub fn remove_rule_plan() -> FirewallPlan;          // delete rule name="AionDX mobile bridge"
/// Read-only, needs no admin: `netsh advfirewall firewall show rule name="AionDX mobile bridge" verbose`.
pub fn show_rule_plan() -> FirewallPlan;
/// Parses `show rule` output: present? enabled? profile includes Private? matching port?
pub fn parse_show_rule(output: &str) -> RuleStatus;
pub struct RuleStatus { pub present: bool, pub enabled: bool, pub private_only: bool, pub port: Option<u16> }
```

- Adding the rule needs elevation. Phase 5 will run the add plan through the app's own `elevate.exe` from the
  desktop side, behind the user's switch. This module only builds and parses.
- **Tests:**
  - argument vectors exact, including paths with spaces;
  - `parse_show_rule` against captured `netsh` output in English. Running `show rule` on this PC is read-only and
    fine; capture a real "no rule" output that way. Don't add a rule to get the "present" sample: write it from
    Microsoft's documented format and note that in the test.
  - Note in the module doc that `netsh` output is localized; a non-English Windows may parse as "unknown", and that
    must give `present: false` with no panic.

## D. IPv6 on the listener: no parallel work

The listener binds IPv4 `0.0.0.0` today. I'll add a second `[::]` bind myself once module A lands, because it
touches `listener.rs`.
