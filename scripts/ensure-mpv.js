const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = "zhongfly/mpv-winbuild";
const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "mpv");
const MPV_EXE = path.join(VENDOR_DIR, "mpv.exe");
const DOWNLOAD_DIR = path.join(ROOT, "vendor", ".downloads");
const EXTRACT_DIR = path.join(ROOT, "vendor", ".mpv-extract");
const FETCH_TIMEOUT_MS = Number(process.env.WEMBY_MPV_FETCH_TIMEOUT_MS || 120000);

function log(message) {
  console.log(`[wemby] ${message}`);
}

function isOptionalRun() {
  return process.argv.includes("--optional");
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function cleanDir(target) {
  if (!fs.existsSync(target)) return;
  if (!isInside(path.join(ROOT, "vendor"), target)) {
    throw new Error(`Refusing to remove unexpected path: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

async function downloadFile(url, targetPath) {
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Wemby setup",
      "Accept": "application/octet-stream"
    }
  });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(await response.arrayBuffer()));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function findFileRecursive(root, fileName) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, fileName);
      if (found) return found;
    }
  }
  return null;
}

function selectAsset(assets) {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const exact = new RegExp(`^mpv-${arch}-\\d{8}-git-[a-z0-9]+\\.7z$`, "i");
  return assets.find((asset) => exact.test(asset.name))
    || assets.find((asset) => (
      asset.name.startsWith(`mpv-${arch}-`)
      && asset.name.endsWith(".7z")
      && !asset.name.includes("debug")
      && !asset.name.includes("dev")
      && !asset.name.includes("-v3-")
    ));
}

async function main() {
  if (process.env.WEMBY_SKIP_MPV_DOWNLOAD === "1") {
    log("Skipping mpv download because WEMBY_SKIP_MPV_DOWNLOAD=1.");
    return;
  }

  if (process.platform !== "win32") {
    log("Skipping bundled mpv setup on non-Windows platform.");
    return;
  }

  if (fs.existsSync(MPV_EXE)) {
    log(`Bundled mpv already exists: ${MPV_EXE}`);
    return;
  }

  log("Preparing bundled mpv...");
  const releaseResponse = await fetchWithTimeout(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      "User-Agent": "Wemby setup",
      "Accept": "application/vnd.github+json"
    }
  });
  if (!releaseResponse.ok) {
    throw new Error(`Could not fetch mpv release metadata: HTTP ${releaseResponse.status}`);
  }

  const release = await releaseResponse.json();
  const asset = selectAsset(release.assets || []);
  if (!asset?.browser_download_url) {
    throw new Error("Could not find a suitable Windows mpv build.");
  }

  cleanDir(EXTRACT_DIR);
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const archivePath = path.join(DOWNLOAD_DIR, asset.name);

  log(`Downloading ${asset.name}...`);
  await downloadFile(asset.browser_download_url, archivePath);

  log("Extracting mpv...");
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  execFileSync("tar", ["-xf", archivePath, "-C", EXTRACT_DIR], { stdio: "inherit", windowsHide: true });

  const extractedMpv = findFileRecursive(EXTRACT_DIR, "mpv.exe");
  if (!extractedMpv) {
    throw new Error("The mpv archive did not contain mpv.exe.");
  }

  cleanDir(VENDOR_DIR);
  fs.mkdirSync(path.dirname(VENDOR_DIR), { recursive: true });
  fs.cpSync(path.dirname(extractedMpv), VENDOR_DIR, { recursive: true });
  if (!fs.existsSync(MPV_EXE)) {
    throw new Error("mpv.exe was not copied into vendor/mpv.");
  }

  cleanDir(EXTRACT_DIR);
  log(`Bundled mpv is ready: ${MPV_EXE}`);
}

main().catch((error) => {
  console.error(`[wemby] Failed to prepare bundled mpv: ${error.message}`);
  if (isOptionalRun()) {
    console.error("[wemby] Continuing install; Wemby can still prepare mpv on first playback.");
    process.exit(0);
  }
  process.exit(1);
});
