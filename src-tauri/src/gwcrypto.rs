//! Gateway crypto shared by the desktop app and the headless server:
//! key derivation, constant-time compare and the AES-256-GCM frame channel.
//! See docs/MOBILE-PLAN.md for the protocol.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;


// ---------- crypto (pure, unit-tested) ----------

pub fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac key");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

pub fn device_key(pair_secret: &[u8]) -> [u8; 32] {
    hmac(pair_secret, &[b"supercharge-gw/device-key"])
}

pub fn session_key(device_key: &[u8], nc: &[u8], ns: &[u8]) -> [u8; 32] {
    hmac(device_key, &[b"supercharge-gw/session", nc, ns])
}

pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub struct Channel {
    cipher: Aes256Gcm,
    send_dir: u32,
    send_ctr: u64,
    recv_ctr: u64,
}

fn nonce(dir: u32, ctr: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..4].copy_from_slice(&dir.to_be_bytes());
    n[4..].copy_from_slice(&ctr.to_be_bytes());
    n
}

impl Channel {
    /// `server = true` seals with dir 2 and opens dir 1.
    pub fn new(sk: &[u8; 32], server: bool) -> Self {
        Self { cipher: Aes256Gcm::new_from_slice(sk).unwrap(), send_dir: if server { 2 } else { 1 }, send_ctr: 0, recv_ctr: 0 }
    }
    /// Frame = counter (8 bytes BE) | ciphertext+tag.
    pub fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        self.send_ctr += 1;
        let n = nonce(self.send_dir, self.send_ctr);
        let ct = self.cipher.encrypt(Nonce::from_slice(&n), plain).expect("encrypt");
        let mut out = self.send_ctr.to_be_bytes().to_vec();
        out.extend(ct);
        out
    }
    pub fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>, &'static str> {
        if frame.len() < 8 + 16 {
            return Err("short frame");
        }
        let ctr = u64::from_be_bytes(frame[..8].try_into().unwrap());
        if ctr <= self.recv_ctr {
            return Err("replayed frame");
        }
        let n = nonce(3 - self.send_dir, ctr);
        let pt = self.cipher.decrypt(Nonce::from_slice(&n), &frame[8..]).map_err(|_| "bad frame")?;
        self.recv_ctr = ctr;
        Ok(pt)
    }
}

