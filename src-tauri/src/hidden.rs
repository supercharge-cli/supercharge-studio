//! Every child process the app starts goes through here so that, on Windows, it never
//! opens or flashes a console window (CREATE_NO_WINDOW). Use `hidden::std_cmd` /
//! `hidden::cmd` instead of `Command::new`; CI fails on a bare `Command::new`.
use std::ffi::OsStr;

/// Windows `CREATE_NO_WINDOW` process creation flag.
#[allow(dead_code)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A blocking `std::process::Command` that never shows a console window.
pub fn std_cmd<S: AsRef<OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program); // hidden-ok
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// An async `tokio::process::Command` that never shows a console window.
pub fn cmd<S: AsRef<OsStr>>(program: S) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program); // hidden-ok
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(test)]
mod tests {
    #[test]
    fn no_bare_command_new() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let mut bad = vec![];
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "rs") {
                for (i, l) in std::fs::read_to_string(&p).unwrap().lines().enumerate() {
                    if l.contains("Command::new(") && !l.contains("hidden-ok") && !l.contains("contains(") {
                        bad.push(format!("{}:{}", p.display(), i + 1));
                    }
                }
            }
        }
        assert!(bad.is_empty(), "use hidden::std_cmd/hidden::cmd instead of Command::new: {bad:?}");
    }
}
