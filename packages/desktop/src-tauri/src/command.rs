use crate::MAX_FRAME;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
    sync::watch,
};

/// A helper's caller retains its prepared runtime until this physical join.
pub async fn execute(
    mut command: Command,
    mut canceled: watch::Receiver<bool>,
    progress: impl Fn(String) -> Result<(), String>,
    deadline: Option<Duration>,
) -> Result<serde_json::Value, String> {
    if *canceled.borrow() {
        return Err("Connection attempt cancelled".into());
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let mut output = child.stdout.take().expect("piped command stdout");
    let mut diagnostics = BufReader::new(child.stderr.take().expect("piped command stderr"));
    enum Completion {
        Result(Result<serde_json::Value, String>),
        Canceled,
    }
    let result = {
        let collect = async {
            let output = async {
                let mut data = Vec::new();
                (&mut output)
                    .take((MAX_FRAME + 1) as u64)
                    .read_to_end(&mut data)
                    .await
                    .map_err(|error| error.to_string())?;
                if data.len() > MAX_FRAME {
                    return Err("Connection command output exceeds limit".to_owned());
                }
                Ok(data)
            };
            let diagnostics = async {
                let mut tail = Vec::new();
                loop {
                    let mut line = Vec::new();
                    let count = (&mut diagnostics)
                        .take(8193)
                        .read_until(b'\n', &mut line)
                        .await
                        .map_err(|error| error.to_string())?;
                    if count == 0 {
                        return Ok(String::from_utf8_lossy(&tail).into_owned());
                    }
                    if count > 8192 {
                        return Err("Connection diagnostic line exceeds limit".to_owned());
                    }
                    if let Ok(event) = serde_json::from_slice::<serde_json::Value>(&line) {
                        if event["type"] == "progress" {
                            if let Some(message) = event["message"].as_str() {
                                progress(message.to_owned())?;
                            }
                            continue;
                        }
                    }
                    tail.extend_from_slice(&line);
                    if tail.len() > 8192 {
                        tail.drain(..tail.len() - 8192);
                    }
                }
            };
            let (data, diagnostics) = tokio::try_join!(output, diagnostics)?;
            let status = child.wait().await.map_err(|error| error.to_string())?;
            if !status.success() {
                return Err(format!("Server helper exited with {status}: {diagnostics}"));
            }
            serde_json::from_slice(&data).map_err(|error| error.to_string())
        };
        let expired = async {
            match deadline {
                Some(duration) => tokio::time::sleep(duration).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            result = collect => Completion::Result(result),
            _ = canceled.changed() => Completion::Canceled,
            _ = expired => Completion::Result(Err("Connection command exceeded its deadline".into())),
        }
    };
    let result = match result {
        Completion::Result(result) => result,
        Completion::Canceled => {
            child.stdin.take();
            // Preserve the output pipes during cooperative cleanup. Closing
            // them here can turn a final progress/result write into EPIPE.
            let retire = async {
                let mut output_sink = tokio::io::sink();
                let mut diagnostics_sink = tokio::io::sink();
                tokio::try_join!(
                    tokio::io::copy(&mut output, &mut output_sink),
                    tokio::io::copy(&mut diagnostics, &mut diagnostics_sink),
                    child.wait(),
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            };
            match tokio::time::timeout(Duration::from_secs(20), retire).await {
                Ok(status) => status,
                Err(_) => child.kill().await.map_err(|error| error.to_string()),
            }
            .and(Err("Connection attempt cancelled".into()))
        }
    };
    // Dropping a killed child only requests termination. Await it before the
    // caller releases guards, including malformed output and deadline failures.
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_none()
    {
        child.kill().await.map_err(|error| error.to_string())?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_bootstrap::{Cache, FileUse};
    use std::io::Write;

    #[test]
    fn oversized_fixture() {
        let Some(home) = std::env::var_os("HARNESS_OVERSIZED_HELPER_FIXTURE") else {
            return;
        };
        let cache = Cache::new(std::path::Path::new(&home)).expect("fixture home");
        let _usage = FileUse::shared(&cache.home, "command-fixture").expect("fixture use guard");
        std::io::stdout()
            .write_all(&vec![b'x'; MAX_FRAME + 1])
            .expect("oversized output");
        std::io::stdout().flush().expect("fixture output ready");
        loop {
            std::thread::park();
        }
    }

    #[tokio::test]
    async fn oversized_helper_exits_before_prepared_protection_is_released() {
        let root = tempfile::tempdir().expect("test directory");
        let cache = Cache::new(&root.path().join("home")).expect("test home");
        let usage = FileUse::shared(&cache.home, "command-fixture").expect("parent guard");
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args([
                "--exact",
                "command::tests::oversized_fixture",
                "--nocapture",
            ])
            .env("HARNESS_OVERSIZED_HELPER_FIXTURE", &cache.home);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let (_cancel, canceled) = watch::channel(false);
        let error = execute(command, canceled, |_| Ok(()), Some(Duration::from_secs(30)))
            .await
            .expect_err("oversized helper must fail");
        assert!(error.contains("output exceeds limit"), "{error}");
        assert!(
            FileUse::try_exclusive(&cache.home, "command-fixture")
                .unwrap()
                .is_none()
        );
        drop(usage);
        assert!(
            FileUse::try_exclusive(&cache.home, "command-fixture")
                .unwrap()
                .is_some(),
            "child guard must already be gone"
        );
    }

    #[test]
    fn cancellation_fixture() {
        let Some(home) = std::env::var_os("HARNESS_CANCEL_HELPER_FIXTURE") else {
            return;
        };
        let cache = Cache::new(std::path::Path::new(&home)).expect("fixture home");
        let _usage = FileUse::shared(&cache.home, "cancel-fixture").expect("fixture use guard");
        std::fs::write(cache.home.join("ready"), b"ready").expect("fixture readiness");
        std::io::copy(&mut std::io::stdin(), &mut std::io::sink()).expect("cancellation EOF");
        std::io::stdout()
            .write_all(&vec![b'x'; 256 * 1024])
            .expect("final output");
        for _ in 0..256 {
            std::io::stderr()
                .write_all(&[b'x'; 1024])
                .expect("final diagnostics");
        }
        std::fs::write(cache.home.join("completed"), b"completed").expect("cooperative completion");
    }

    #[tokio::test]
    async fn cancellation_drains_final_writes_until_the_helper_physically_exits() {
        let root = tempfile::tempdir().expect("test directory");
        let cache = Cache::new(&root.path().join("home")).expect("test home");
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args([
                "--exact",
                "command::tests::cancellation_fixture",
                "--nocapture",
            ])
            .env("HARNESS_CANCEL_HELPER_FIXTURE", &cache.home);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let (cancel, canceled) = watch::channel(false);
        let task = tokio::spawn(execute(
            command,
            canceled,
            |_| Ok(()),
            Some(Duration::from_secs(30)),
        ));
        tokio::time::timeout(Duration::from_secs(20), async {
            while !cache.home.join("ready").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("actual helper readiness");
        cancel.send(true).expect("cancel retained helper");
        assert!(task.await.unwrap().unwrap_err().contains("cancelled"));
        assert!(
            cache.home.join("completed").is_file(),
            "cleanup must finish without EPIPE"
        );
        assert!(
            FileUse::try_exclusive(&cache.home, "cancel-fixture")
                .unwrap()
                .is_some()
        );
    }
}
