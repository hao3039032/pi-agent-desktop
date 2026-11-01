#![cfg(target_os = "linux")]

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const CHILD_TIMEOUT_MS: i32 = 5000;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(8);

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

// Child side: fixed-size pipe messages, bounded poll and async-signal-safe libc only.
unsafe fn child_exchange(read_fd: RawFd, write_fd: RawFd) -> bool {
    let pid = libc::getpid().to_ne_bytes();
    if libc::write(write_fd, pid.as_ptr().cast(), pid.len()) != pid.len() as isize {
        return false;
    }
    let mut pollfd = libc::pollfd {
        fd: read_fd,
        events: libc::POLLIN,
        revents: 0,
    };
    if libc::poll(&mut pollfd, 1, CHILD_TIMEOUT_MS) != 1 || pollfd.revents & libc::POLLIN == 0 {
        return false;
    }
    let mut nonce = [0u8; 32];
    if libc::read(read_fd, nonce.as_mut_ptr().cast(), nonce.len()) != nonce.len() as isize {
        return false;
    }
    if libc::write(write_fd, nonce.as_ptr().cast(), nonce.len()) != nonce.len() as isize {
        return false;
    }
    // This is the simulated production path before its ready point. No identity
    // proof is passed into it. Its own timeout protects all pre-injection failures.
    pollfd.revents = 0;
    libc::poll(&mut pollfd, 1, CHILD_TIMEOUT_MS);
    false
}

fn read_deadline(fd: RawFd, bytes: &mut [u8], timeout: Duration) -> io::Result<()> {
    let mut p = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let rc = unsafe { libc::poll(&mut p, 1, timeout.as_millis() as i32) };
    if rc != 1 || p.revents & libc::POLLIN == 0 {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "fixture pipe not readable",
        ));
    }
    let n = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
    if n != bytes.len() as isize {
        return Err(io::Error::other("short fixture message"));
    }
    Ok(())
}

fn signal(fd: RawFd, sig: i32) -> io::Result<()> {
    if unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd, sig, 0, 0) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

struct Cleanup {
    pidfd: Option<OwnedFd>,
    done: Receiver<()>,
    worker: Option<JoinHandle<()>>,
}
impl Cleanup {
    fn finish(&mut self) -> io::Result<()> {
        if self.worker.is_none() {
            return Ok(());
        }
        if let Some(fd) = &self.pidfd {
            if let Err(e) = signal(fd.as_raw_fd(), libc::SIGKILL) {
                if e.raw_os_error() != Some(libc::ESRCH) {
                    return Err(e);
                }
            }
        }
        self.done
            .recv_timeout(CLEANUP_TIMEOUT)
            .map_err(|e| io::Error::other(format!("worker cleanup: {e}")))?;
        self.worker
            .take()
            .unwrap()
            .join()
            .map_err(|_| io::Error::other("spawn worker panicked"))?;
        Ok(())
    }
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Err(e) = self.finish() {
            eprintln!(
                "FATAL: fixture cleanup unconfirmed: {e}; pidfd={:?}",
                self.pidfd.as_ref().map(AsRawFd::as_raw_fd)
            );
            // Do not continue the test process after losing track of a stopped child.
            std::process::abort();
        }
    }
}

fn run_fixture(reject_echo: bool) -> io::Result<()> {
    let (challenge_read, challenge_write) = pipe()?;
    let (response_read, response_write) = pipe()?;
    let cr = challenge_read.as_raw_fd();
    let cw = challenge_write.as_raw_fd();
    let rr = response_read.as_raw_fd();
    let rw = response_write.as_raw_fd();
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let mut cmd = Command::new("/bin/true");
        unsafe {
            cmd.pre_exec(move || {
                libc::close(cw);
                libc::close(rr);
                if child_exchange(cr, rw) {
                    Ok(())
                } else {
                    Err(io::Error::from_raw_os_error(libc::ECANCELED))
                }
            });
        }
        let result = cmd.spawn();
        // pre_exec always fails; nevertheless reap if the fixture ever unexpectedly execs.
        if let Ok(mut child) = result {
            let _ = child.wait();
        }
        let _ = tx.send(());
    });
    let mut cleanup = Cleanup {
        pidfd: None,
        done: rx,
        worker: Some(worker),
    };
    let mut pid_bytes = [0u8; std::mem::size_of::<libc::pid_t>()];
    read_deadline(rr, &mut pid_bytes, Duration::from_secs(2))?;
    // Fork has happened: close the child's ends in the parent, including the
    // copies whose raw numbers were captured by Command's pre_exec closure.
    drop(challenge_read);
    drop(response_write);
    let pid = libc::pid_t::from_ne_bytes(pid_bytes);
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
    if fd < 0 {
        let error = io::Error::last_os_error();
        cleanup.finish()?;
        if matches!(
            error.raw_os_error(),
            Some(libc::ENOSYS | libc::EINVAL | libc::EPERM | libc::EACCES)
        ) {
            eprintln!("SKIP: pidfd_open unavailable or denied: {error}; fault not injected");
            return Ok(());
        }
        return Err(error);
    }
    let candidate = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut nonce = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut nonce)?;
    // Write at most PIPE_BUF once, avoiding partial framing.
    let mut writer = File::from(challenge_write);
    writer.write_all(&nonce)?;
    let mut echo = [0u8; 32];
    read_deadline(rr, &mut echo, Duration::from_secs(2))?;
    if reject_echo {
        echo[0] ^= 1;
    }
    if echo != nonce {
        cleanup.finish()?;
        return if reject_echo {
            Ok(())
        } else {
            Err(io::Error::other("invalid post-pidfd challenge response"))
        };
    }
    if let Err(error) = signal(candidate.as_raw_fd(), 0) {
        cleanup.finish()?;
        if matches!(
            error.raw_os_error(),
            Some(libc::ENOSYS | libc::EINVAL | libc::EPERM | libc::EACCES)
        ) {
            eprintln!("SKIP: pidfd_send_signal unavailable or denied: {error}; fault not injected");
            return Ok(());
        }
        return Err(error);
    }
    cleanup.pidfd = Some(candidate);
    let bound = cleanup.pidfd.as_ref().unwrap().as_raw_fd();
    signal(bound, libc::SIGSTOP)?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            libc::waitid(
                libc::P_PIDFD,
                bound as _,
                &mut info,
                libc::WSTOPPED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { info.si_pid() } != 0 {
            if info.si_code != libc::CLD_STOPPED || unsafe { info.si_status() } != libc::SIGSTOP {
                return Err(io::Error::other("unexpected pidfd wait event"));
            }
            break;
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other("SIGSTOP not observed"));
        }
        thread::sleep(Duration::from_millis(5));
    }
    match cleanup.done.recv_timeout(Duration::from_millis(150)) {
        Err(mpsc::RecvTimeoutError::Timeout) => {}
        Ok(()) => {
            cleanup
                .worker
                .take()
                .unwrap()
                .join()
                .map_err(|_| io::Error::other("spawn worker panicked"))?;
            return Err(io::Error::other(
                "worker unexpectedly completed before deadline",
            ));
        }
        Err(e) => return Err(io::Error::other(format!("worker channel: {e}"))),
    }
    cleanup.finish()?;
    Ok(())
}

#[test]
fn stopped_before_ready_deadline_does_not_reclaim_spawn_worker() -> io::Result<()> {
    run_fixture(false)
}

#[test]
fn rejected_challenge_exits_without_signaling_unbound_candidate() -> io::Result<()> {
    run_fixture(true)
}
