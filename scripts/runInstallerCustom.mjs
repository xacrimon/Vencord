/*
 * Custom variant of runInstaller.mjs.
 *
 * Installer v1.4.1 (2026-09-16) dropped the VencordInstaller.MacOS.zip release
 * asset in favour of a signed VencordInstaller.dmg, so the darwin branch of
 * upstream's runInstaller.mjs 404s. This fetches the dmg instead, mounts it and
 * runs the app bundle from it. Non-darwin platforms are handed to the upstream
 * script, which is still fine there.
*/

import "./checkNodeVersion.js";

import { execFileSync, execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const BASE_URL = "https://github.com/Vencord/Installer/releases/latest/download/";
const DMG_NAME = "VencordInstaller.dmg";
const APP_NAME = "VencordInstaller.app";

const BASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_DIR = join(BASE_DIR, "dist", "Installer");
const ETAG_FILE = join(FILE_DIR, "etag-dmg.txt");

if (process.platform !== "darwin") {
    await import("./runInstaller.mjs");
    process.exit(0);
}

async function ensureApp() {
    mkdirSync(FILE_DIR, { recursive: true });

    const appDir = join(FILE_DIR, APP_NAME);
    const binary = join(appDir, "Contents", "MacOS", "VencordInstaller");

    const etag = existsSync(binary) && existsSync(ETAG_FILE)
        ? readFileSync(ETAG_FILE, "utf-8")
        : null;

    console.log("Downloading " + DMG_NAME);

    const res = await fetch(BASE_URL + DMG_NAME, {
        headers: {
            "User-Agent": "Vencord (https://github.com/Vendicated/Vencord)",
            "If-None-Match": etag
        }
    });

    if (res.status === 304) {
        console.log("Up to date, not redownloading!");
        return binary;
    }
    if (!res.ok)
        throw new Error(`Failed to download installer: ${res.status} ${res.statusText}`);

    const dmgFile = join(FILE_DIR, DMG_NAME);
    writeFileSync(dmgFile, new Uint8Array(await res.arrayBuffer()));

    const mountPoint = mkdtempSync(join(tmpdir(), "VencordInstaller-"));

    console.log("Mounting " + DMG_NAME);
    execFileSync("hdiutil", ["attach", dmgFile, "-nobrowse", "-readonly", "-mountpoint", mountPoint], { stdio: "inherit" });

    try {
        rmSync(appDir, { recursive: true, force: true });
        // the repo lives on the OrbStack shared fs, which rejects xattrs/ACLs, so
        // copy the bundle without them. the signature is embedded in the Mach-O,
        // so it survives that just fine
        execFileSync("ditto", ["--norsrc", "--noextattr", "--noacl", "--noqtn", join(mountPoint, APP_NAME), appDir], { stdio: "inherit" });
    } finally {
        try {
            execSync(`hdiutil detach '${mountPoint}'`, { stdio: "inherit" });
        } catch { }
        rmSync(mountPoint, { recursive: true, force: true });
    }

    rmSync(dmgFile, { force: true });
    writeFileSync(ETAG_FILE, res.headers.get("etag") ?? "");

    console.log("Finished downloading!");

    return binary;
}

const installerBin = await ensureApp();

console.log("Now running Installer...");

const argStart = process.argv.indexOf("--");
const args = argStart === -1 ? [] : process.argv.slice(argStart + 1);

try {
    execFileSync(installerBin, args, {
        stdio: "inherit",
        env: {
            ...process.env,
            VENCORD_USER_DATA_DIR: BASE_DIR,
            VENCORD_DEV_INSTALL: "1"
        }
    });
} catch {
    console.error("Something went wrong. Please check the logs above.");
}
