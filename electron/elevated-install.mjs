import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

// Install a downloaded .deb without a terminal: one graphical password prompt
// from polkit, then the app reopens.
//
// electron-updater's own .deb path is not usable here (it runs `dpkg -i`,
// which resolves no dependencies), so apt-get does the install. What runs as
// root is the fixed script below, never text from the renderer. The staged
// file sits in a directory the person's own account can write, so root first
// copies it somewhere only root can touch and checks it against the SHA-512
// the update feed declared; a file swapped after the download is refused
// instead of installed.

/** pkexec is setuid root, so it is only trusted at its system location: a
 * `pkexec` earlier on PATH could be anything. */
export const PKEXEC = "/usr/bin/pkexec";
const SHELL = "/bin/sh";
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** `$1` is the staged .deb, `$2` its expected SHA-512 as lowercase hex. */
export const ELEVATED_INSTALL_SCRIPT = `set -eu
umask 077
export DEBIAN_FRONTEND=noninteractive
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cp -- "$1" "$dir/update.deb"
actual=$(sha512sum "$dir/update.deb" | cut -d ' ' -f 1)
if [ "$actual" != "$2" ]; then
  echo "the downloaded package does not match its checksum" >&2
  exit 65
fi
chmod 0755 "$dir"
chmod 0644 "$dir/update.deb"
apt-get install -y -o Dpkg::Options::=--force-confold "$dir/update.deb"
`;

/** pkexec's own exit codes: the authentication dialog was dismissed, or the
 * person could not be authorized (also: no polkit agent in this session). */
const PKEXEC_DISMISSED = 126;
const PKEXEC_NOT_AUTHORIZED = 127;
const CHECKSUM_MISMATCH = 65;

/** Whether this session can show a password prompt at all: pkexec is there
 * and a graphical session is. `OMB_UPDATE_INSTALL=terminal` opts out. */
export function canInstallElevated({
  platform = process.platform,
  env = process.env,
  pkexec = PKEXEC,
  access = accessSync,
} = {}) {
  if (platform !== "linux") return false;
  if (env.OMB_UPDATE_INSTALL === "terminal") return false;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  try {
    access(pkexec, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** electron-updater records the SHA-512 as base64 (a feed may also carry hex);
 * the script compares lowercase hex. Null when it is neither. */
export function sha512Hex(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^[0-9a-f]{128}$/i.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) return null;
  return Buffer.from(value, "base64").toString("hex");
}

function lastLine(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.at(-1)?.slice(0, 200) ?? "";
}

/** Run the install. Never throws; resolves { ok: true } or { ok: false,
 * reason, detail } where reason is one of:
 *   unverifiable  nothing safe to install (no file, not a .deb, no checksum)
 *   unavailable   pkexec is not there
 *   declined      the person closed the password prompt
 *   refused       polkit would not authorize it (or has no agent here)
 *   checksum      the file no longer matches what was downloaded
 *   failed        apt-get or the script failed; detail is its last line */
export function installPackageElevated({
  file,
  sha512,
  pkexec = PKEXEC,
  run = execFile,
  stat = lstatSync,
  timeout = INSTALL_TIMEOUT_MS,
} = {}) {
  const expected = sha512Hex(sha512);
  let regular = false;
  try {
    regular = typeof file === "string" && stat(file).isFile();
  } catch {
    regular = false;
  }
  if (typeof file !== "string" || !isAbsolute(file) || !file.endsWith(".deb") || !regular) {
    return Promise.resolve({
      ok: false,
      reason: "unverifiable",
      detail: "The downloaded package is no longer available. Try the update again.",
    });
  }
  if (!expected) {
    return Promise.resolve({
      ok: false,
      reason: "unverifiable",
      detail: "The update feed gave no checksum to verify the package against.",
    });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = run(
        pkexec,
        [SHELL, "-c", ELEVATED_INSTALL_SCRIPT, "sh", file, expected],
        { timeout, killSignal: "SIGTERM" },
        (error, _stdout, stderr) => {
          if (!error) return resolve({ ok: true });
          if (error.code === "ENOENT") {
            return resolve({ ok: false, reason: "unavailable", detail: "pkexec is not installed." });
          }
          if (error.code === PKEXEC_DISMISSED) {
            return resolve({ ok: false, reason: "declined", detail: "The password prompt was closed." });
          }
          if (error.code === PKEXEC_NOT_AUTHORIZED) {
            return resolve({ ok: false, reason: "refused", detail: "This session could not ask for administrator rights." });
          }
          if (error.code === CHECKSUM_MISMATCH) {
            return resolve({
              ok: false,
              reason: "checksum",
              detail: "The downloaded update did not match its checksum. Check again to download it fresh.",
            });
          }
          const reason = error.killed ? "The install took too long." : lastLine(stderr) || error.message;
          resolve({ ok: false, reason: "failed", detail: `The install did not finish: ${reason}`.slice(0, 240) });
        },
      );
    } catch (error) {
      resolve({ ok: false, reason: "unavailable", detail: String(error?.message ?? error) });
      return;
    }
    // Nothing is ever typed into the install.
    child?.stdin?.end?.();
  });
}
